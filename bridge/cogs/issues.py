"""Cog: turn a Discord conversation into a GitHub issue, with a human in the way.

`/issue` reads the messages you point it at, drafts an issue in a thread, and
waits. Nothing reaches GitHub until whoever asked clicks Submit — the agent has
no write tool at all, so that isn't a policy, it's the shape of the code.

The thread is the point: everyone in the conversation can watch the draft take
shape, but only the requester can act on it.
"""

import asyncio
import contextlib
import logging
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands
from discord.utils import MISSING
from githubkit.exception import GitHubException
from pydantic_ai import ToolCallPart, ToolReturnPart

from bridge import render
from bridge.cogs.notifications import Notifications
from bridge.agent import context, core, history, progress, view
from bridge.agent.core import Deps, Session
from bridge.agent.draft import IssueDraft, from_embed, preview
from bridge.render import GREEN, RED
from bridge.repo import short_name, split_repo
from bridge.store import Store

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

log = logging.getLogger(__name__)

DEFAULT_SPAN = 20  # messages read when you don't say how many
_MAX_SPAN = 100  # a message link reads to the end of the conversation, up to this
# Sessions kept in memory. Not a limit on open drafts — a thread we've forgotten
# rebuilds from its own messages — just how many we keep the read for.
_CACHED_SESSIONS = 8
# Seconds between edits of anything we're updating live. Discord buckets message
# edits per channel at roughly 5 per 5s and discord.py queues instead of raising,
# so overrunning doesn't fail loudly — it just makes every later edit late. This
# leaves room for a webhook notification landing in the same channel mid-run.
_DRAW_EVERY = 1.2
_EXPIRED = "This draft expired — start a new `/issue`."
# What opens each kind of run, so a revision doesn't read as a first draft. The
# second is deliberately vague about the outcome: the agent decides whether it's
# revising the draft or just answering, and the line goes up before it has.
_DRAFTING = "🔎 reading the conversation..."
_REVISING = "💭 thinking..."
# Discord's own ceiling on a message. The agent is told to be brief, so this is a
# backstop against a wall of text, not the usual case.
_MAX_MESSAGE = 2000
# Messages back we look for a thread's draft card. Deep enough to see past a
# conversation that ran on after the draft, shallow enough to be one fetch.
_CARD_SCAN = 50
# The owner id every draft button carries, matching `agent/view.py`'s template.
_OWNER = re.compile(r"issue:\w+:(?P<author>\d+)")
# Every draft thread is named from this, so the name is enough to recognise one
# after a restart — no fetch, and no state we'd have to have kept.
_THREAD_PREFIX = "issue"


def _owner_of(card: discord.Message) -> int | None:
    """Who may steer the draft on `card`, read off its own buttons.

    The requester's id already rides in every button's custom_id so a click
    survives a restart (see `agent/view.py`); that makes the card the record of
    who owns the draft, and there is no second place for it to disagree with.
    """
    for row in card.components:
        for item in getattr(row, "children", ()):
            custom_id = getattr(item, "custom_id", None) or ""
            if (m := _OWNER.match(custom_id)) is not None:
                return int(m["author"])
    return None


@dataclass
class Draft:
    """One open draft: the agent session, and the Discord side it reports to.

    Paired because they share a lifetime exactly — the workspace posts the run's
    progress into the thread, and a refine restarts it for the next run.
    """

    session: Session
    workspace: "DraftWorkspace"


class Issues(commands.Cog):
    """Implements view.Actions — the buttons call back into these methods."""

    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        # Live drafts, thread id -> session. A cache, not the record: a thread we
        # have no entry for is rebuilt from its own messages, so losing this
        # costs a re-read rather than the conversation.
        self._sessions: dict[int, Draft] = {}
        self.draft_from_message = app_commands.ContextMenu(
            name="Draft issue from here",
            callback=self._context_menu,
        )
        bot.tree.add_command(self.draft_from_message)

    async def cog_unload(self) -> None:
        self.bot.tree.remove_command(
            self.draft_from_message.name, type=self.draft_from_message.type
        )

    def _candidates(self, channel: object) -> list[str]:
        """The repos a channel could be about; the agent may pick no other.

        Falls back to every mapped repo, so an unmapped channel still drafts as
        long as the server has mapped something. Takes `object` because the only
        common ground between a Messageable and a concrete channel is that both
        may or may not carry `id` and `parent_id`.
        """
        store = self.bot.store
        if store is None:
            return []
        return store.repos_for_channel(
            getattr(channel, "id", 0), getattr(channel, "parent_id", None)
        )

    async def _mapped_repo_choices(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        """Mapped repos only — an unmapped one has no channel to announce into.

        Ordered so the channel's own repos come first, since that is usually the
        one being asked for.
        """
        repos = self._candidates(interaction.channel) if interaction.channel else []
        return [
            app_commands.Choice(name=repo, value=repo)
            for repo in repos
            if current.lower() in repo.lower()
        ][:25]

    # --- /issue ---

    @app_commands.command(
        name="issue",
        description="Draft a GitHub issue from this conversation, then review it.",
    )
    @app_commands.describe(
        prompt="What the issue is about — steers the draft. Optional.",
        since_message="Read from this message onwards. Right-click → Copy Link.",
        last="How many messages to read (default 20). Ignored with a message link.",
        repo="Force the target repo instead of inferring it from the channel.",
    )
    @app_commands.autocomplete(repo=_mapped_repo_choices)
    async def issue(
        self,
        interaction: discord.Interaction,
        prompt: str | None = None,
        since_message: str | None = None,
        last: app_commands.Range[int, 1, 100] = DEFAULT_SPAN,
        repo: str | None = None,
    ) -> None:
        # The agent takes tens of seconds; ack now or the interaction expires.
        await interaction.response.defer(ephemeral=True, thinking=True)
        if (problem := self._unavailable()) is not None:
            await interaction.followup.send(problem, ephemeral=True)
            return
        assert interaction.guild is not None

        anchor: discord.Message | None = None
        if since_message is not None:
            anchor = await context.resolve_message(interaction.guild, since_message)
            if anchor is None:
                await interaction.followup.send(
                    "I need a message link from this server — right-click the "
                    "message → Copy Message Link. A bare message id won't do.",
                    ephemeral=True,
                )
                return

        channel = anchor.channel if anchor is not None else interaction.channel
        if not isinstance(channel, discord.abc.Messageable):
            await interaction.followup.send(
                "Run this in a channel I can read.", ephemeral=True
            )
            return

        await self._start(
            interaction,
            channel,
            anchor=anchor,
            # A link says "start here"; how far it runs is the conversation's
            # business, not a number the requester should have to guess.
            span=_MAX_SPAN if anchor else last,
            repo=repo,
            prompt=prompt,
        )

    async def _context_menu(
        self, interaction: discord.Interaction, message: discord.Message
    ) -> None:
        """Right-click a message -> draft from it, after asking what it's about.

        A modal rather than a straight run: the interaction hasn't been answered
        yet, so opening one is free, and steering the draft up front beats
        refining it afterwards.
        """
        if (problem := self._unavailable()) is not None:
            await interaction.response.send_message(problem, ephemeral=True)
            return
        await interaction.response.send_modal(view.PromptModal(self, message))

    async def start_from_menu(
        self,
        interaction: discord.Interaction,
        message: discord.Message,
        prompt: str | None,
    ) -> None:
        """Continue the context-menu flow once the modal has the prompt."""
        if (problem := self._unavailable()) is not None:
            await interaction.followup.send(problem, ephemeral=True)
            return
        await self._start(
            interaction,
            message.channel,
            anchor=message,
            span=_MAX_SPAN,  # picking a message means "from here on", same as a link
            repo=None,
            prompt=prompt,
        )

    def _unavailable(self) -> str | None:
        """Why we can't draft right now, if we can't."""
        if self.bot.issue_agent is None:
            return "Issue drafting is switched off — no model configured."
        if self.bot.store is None or self.bot.github is None:
            return "Still starting up; try again in a moment."
        self._evict()
        return None

    def _evict(self) -> None:
        """Keep the session cache bounded, oldest first.

        Nothing is lost by dropping one: the thread still holds the conversation
        and its card, so the next message there rebuilds. That's why this evicts
        instead of refusing to start — a cap on remembering is not a cap on how
        many drafts may be open.
        """
        for thread_id in list(self._sessions):
            if self.bot.get_channel(thread_id) is None:
                del self._sessions[thread_id]
        while len(self._sessions) > _CACHED_SESSIONS:
            self._sessions.pop(next(iter(self._sessions)))

    # --- the draft run ---

    async def _start(
        self,
        interaction: discord.Interaction,
        channel: discord.abc.Messageable,
        *,
        anchor: discord.Message | None,
        span: int,
        repo: str | None,
        prompt: str | None = None,
    ) -> None:
        assert self.bot.store is not None
        assert self.bot.github is not None
        assert self.bot.issue_agent is not None

        transcript = await context.collect(
            channel, self.bot.store, limit=span, anchor=anchor
        )
        if transcript.is_empty():
            await interaction.followup.send(
                "I couldn't read any conversation there. If this is the first time, "
                "check that the Message Content intent is enabled.",
                ephemeral=True,
            )
            return

        candidates = [repo] if repo else self._candidates(channel)
        if not candidates:
            await interaction.followup.send(
                "No repo is mapped to this channel yet — run `/map repo` first.",
                ephemeral=True,
            )
            return

        thread = await self._thread(channel, anchor, interaction.user)
        if thread is None:
            await interaction.followup.send(
                "I couldn't open a thread here — check my permissions.", ephemeral=True
            )
            return
        await interaction.followup.send(
            f"Drafting in {thread.mention}.", ephemeral=True
        )

        opening = await thread.send(_DRAFTING)
        assert interaction.guild is not None
        workspace = DraftWorkspace(self.bot.store, interaction.guild, thread)
        session = Session(
            self.bot.issue_agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                workspace=workspace,
            ),
            requester=self._requester(interaction.user),
            owner_id=interaction.user.id,
        )
        self._sessions[thread.id] = Draft(session, workspace)
        try:
            reply = await session.start(transcript, candidates, prompt=prompt)
        except Exception as exc:  # noqa: BLE001 — a failed draft mustn't kill the cog
            log.exception("issue draft failed in thread %s", thread.id)
            del self._sessions[thread.id]
            await self._settle(workspace, opening, core.explain(exc))
            return

        await self._settle(workspace, opening)
        # `/issue` asks for a draft, so prose here means the agent had something to
        # say instead — usually that it needs more to go on. Say it and let them
        # answer in the thread rather than dropping it for a card we don't have.
        if not isinstance(reply, IssueDraft):
            await thread.send(reply[:_MAX_MESSAGE])
            return

        # Named once, from the first draft: a rename is a system line in the
        # thread, so re-titling on every refine would bury the conversation.
        try:
            await thread.edit(name=f"{_THREAD_PREFIX}: {reply.title}"[:100])
        except discord.HTTPException:
            log.debug("could not rename draft thread %s", thread.id, exc_info=True)

        await self._show(thread, reply, interaction.user.id, transcript.jump_url)

    async def _thread(
        self,
        channel: discord.abc.Messageable,
        anchor: discord.Message | None,
        author: discord.User | discord.Member,
    ) -> discord.Thread | None:
        """A thread to draft in: hung off the anchor message when there is one, so
        the conversation and its issue stay visibly connected."""
        name = f"{_THREAD_PREFIX} · {author.display_name}"[:100]
        try:
            if anchor is not None and isinstance(anchor.channel, discord.TextChannel):
                return await anchor.create_thread(name=name, auto_archive_duration=1440)
            if isinstance(channel, discord.TextChannel):
                return await channel.create_thread(
                    name=name,
                    auto_archive_duration=1440,
                    type=discord.ChannelType.public_thread,
                )
            if isinstance(channel, discord.Thread):
                return channel  # already in a thread; draft right here
        except discord.Forbidden, discord.HTTPException:
            log.exception("could not create a draft thread")
        return None

    async def _settle(
        self,
        workspace: "DraftWorkspace",
        opening: discord.Message,
        error: str | None = None,
    ) -> None:
        """End a run's progress: collapse its cards, then close out the opening line.

        On success what's left in the thread is one summary line, and the draft
        posts under it — so the thread reads in the order it happened rather than
        having the result edited back into its own announcement. A failed run has
        nothing to post under it, so the opening line carries the reason instead.
        """
        await workspace.collapse()
        if error is not None:
            with contextlib.suppress(discord.HTTPException):
                await opening.edit(content=f"⚠️ {error}")
            return
        with contextlib.suppress(discord.HTTPException):
            await opening.delete()

    async def _show(
        self,
        target: discord.Message | discord.abc.Messageable,
        draft: IssueDraft,
        author_id: int,
        source_url: str | None = None,
    ) -> None:
        """Put the draft and its buttons up, in place or as a new message.

        A message means replace it (an inline edit keeps the card where the
        reader already is); a channel means post one. Either way the card is also
        the draft's storage once the session is gone, read back off its embed.
        """
        content = (
            f"Drafted from [this conversation](<{source_url}>)." if source_url else None
        )
        embed = preview(draft, note=self._assignee_note(draft))
        buttons = view.draft_view(author_id)
        if isinstance(target, discord.Message):
            await target.edit(content=content, embed=embed, view=buttons)
            return
        await target.send(content=content, embed=embed, view=buttons)

    def _assignee_note(self, draft: IssueDraft) -> str | None:
        """Warn if the proposed assignee isn't a login we have mapped.

        Rare, since the agent resolves names through `teammates`: this catches a
        draft recovered from an older card, or a mapping removed since.
        """
        store = self.bot.store
        if draft.assignee is None or store is None:
            return None
        if store.discord_id_for(draft.assignee) is not None:
            return None
        return (
            f"`{draft.assignee}` isn't a mapped GitHub login — run `/map user`, "
            "then say who to assign. GitHub may reject the assignment as it is."
        )

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        """A draft thread is a conversation: talking in it revises, or asks.

        Only the requester — the thread is public, and anyone else in it is
        commenting on the draft, not steering it. Who that is comes off the
        thread's own draft card, so it outlives us.
        """
        if message.author.bot or not message.content.strip():
            return
        thread = message.channel
        if not isinstance(thread, discord.Thread) or thread.archived:
            return  # submit and discard archive the thread; that draft is done
        # This fires on every message in the server, so the cheap tests come
        # first: a name check and an in-memory lookup, no fetch on the path that
        # says "not us".
        if not thread.name.startswith(_THREAD_PREFIX):
            return
        open_draft = self._sessions.get(thread.id)
        if open_draft is not None:
            if message.author.id != open_draft.session.owner_id:
                return
            await self._revise(thread, open_draft, message.content)
            return
        # A draft thread we hold no session for — we restarted, or it predates
        # this process. The conversation is still in the thread, so rebuild it
        # from there rather than telling them we lost it.
        await self._resume(thread, message)

    # --- view.Actions ---

    async def _revise(
        self, thread: discord.Thread, open_draft: Draft, feedback: str
    ) -> None:
        """Answer them, or revise the draft — whichever they asked for.

        A revision posts a new card and leaves the old one where it is: the thread
        is the record of how the issue got its shape, and editing it away loses
        that. An answer posts as an ordinary message and touches no card.
        """
        opening = await thread.send(_REVISING)
        open_draft.workspace.restart(thread)
        try:
            reply = await open_draft.session.refine(feedback, self._candidates(thread))
        except Exception as exc:  # noqa: BLE001
            log.exception("refine failed")
            await self._settle(open_draft.workspace, opening, core.explain(exc))
            return
        await self._settle(open_draft.workspace, opening)
        if isinstance(reply, IssueDraft):
            await self._show(thread, reply, open_draft.session.owner_id)
            return
        await thread.send(reply[:_MAX_MESSAGE])

    async def _resume(self, thread: discord.Thread, message: discord.Message) -> None:
        """Answer in a thread whose session we no longer hold.

        Everything a reply needs is in the thread: the conversation is its
        messages, the draft is its newest preview card, and who may steer it is
        the owner encoded in that card's buttons. So a restart costs a re-read
        rather than the conversation.
        """
        if self._unavailable() is not None or self.bot.store is None:
            return
        assert self.bot.issue_agent is not None
        assert self.bot.github is not None
        card = await self._card(thread)
        if card is None:
            return  # no draft card: not a thread of ours to answer in
        owner_id = _owner_of(card)
        if owner_id is None or message.author.id != owner_id:
            return
        assert thread.guild is not None
        assert self.bot.user is not None

        opening = await thread.send(_REVISING)
        workspace = DraftWorkspace(self.bot.store, thread.guild, thread)
        past = await history.rebuild(
            thread, self.bot.store, bot_user_id=self.bot.user.id
        )
        session = Session(
            self.bot.issue_agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                workspace=workspace,
            ),
            requester=self._requester(message.author),
            owner_id=owner_id,
            history=past,
            draft=from_embed(card.embeds[0]),
        )
        try:
            reply = await session.resume(message.content, self._candidates(thread))
        except Exception as exc:  # noqa: BLE001 — a failed reply mustn't kill the cog
            log.exception("resumed reply failed in thread %s", thread.id)
            await self._settle(workspace, opening, core.explain(exc))
            return
        await self._settle(workspace, opening)
        # Hold the session from here on: the conversation is live again, and the
        # next message should not pay to rebuild what we now have.
        self._sessions[thread.id] = Draft(session, workspace)
        if isinstance(reply, IssueDraft):
            await self._show(thread, reply, owner_id)
            return
        await thread.send(reply[:_MAX_MESSAGE])

    async def _card(self, thread: discord.Thread) -> discord.Message | None:
        """The newest draft preview card in `thread`, if it still has one."""
        async for message in thread.history(limit=_CARD_SCAN):
            if (
                self.bot.user is not None
                and message.author.id == self.bot.user.id
                and message.embeds
                and from_embed(message.embeds[0]) is not None
            ):
                return message
        return None

    async def apply_edit(
        self, interaction: discord.Interaction, title: str, body: str
    ) -> None:
        """Take the human's text verbatim — no model round trip."""
        message = interaction.message
        if message is None:
            return
        draft = self.draft_for(interaction)
        if draft is None:
            await interaction.followup.send(_EXPIRED, ephemeral=True)
            return
        draft = draft.model_copy(update={"title": title, "body": body, "questions": []})
        if (session := self._session_for(interaction)) is not None:
            session.draft = draft
        await self._show(message, draft, interaction.user.id)

    async def submit(self, interaction: discord.Interaction) -> None:
        message = interaction.message
        if message is None:
            return
        draft = self.draft_for(interaction)
        if draft is None:
            await interaction.followup.send(_EXPIRED, ephemeral=True)
            return
        assert self.bot.github is not None

        owner, name = split_repo(draft.repo, self.bot.config.org)
        try:
            resp = await self.bot.github.rest.issues.async_create(
                owner,
                name,
                title=draft.title,
                body=f"{draft.body}\n\n---\n"
                f"Drafted from a Discord thread: {message.jump_url}",
                labels=list(draft.labels),
                assignees=[draft.assignee] if draft.assignee else [],
            )
        except GitHubException as exc:
            log.exception("creating issue in %s failed", draft.repo)
            await message.edit(
                embed=discord.Embed(
                    title="Couldn't create the issue",
                    description=f"GitHub said: `{exc}`\n\nThe draft is unchanged; "
                    "fix the problem and press Submit again.",
                    color=RED,
                ),
                view=view.draft_view(interaction.user.id),
            )
            return

        issue = resp.parsed_data
        # The card stays: it's what the thread was for, and the issue it describes
        # now exists. Only the buttons go, and the footer stops saying "not
        # submitted yet" — a live Submit here would open a second issue.
        await self._close(
            message,
            embed=preview(draft, note=self._assignee_note(draft), submitted=True),
        )
        await message.channel.send(f"✅ [#{issue.number}]({issue.html_url}) created.")
        await self._archive(message.channel)
        await self._announce(draft.repo, issue.number, issue.html_url, draft.title)

    async def cancel(self, interaction: discord.Interaction) -> None:
        message = interaction.message
        if message is None:
            return
        # Nothing was created, so the draft has nothing left to say: the card goes.
        await self._close(message, content="🗑️ Draft discarded.", embed=None)
        await self._archive(message.channel)

    async def _close(
        self,
        message: discord.Message,
        *,
        content: str = MISSING,
        embed: discord.Embed | None,
    ) -> None:
        """Drop the draft's session and take its buttons away.

        What's left of the card is the caller's call — submit keeps the preview,
        discard replaces it — but either way the draft stops being actionable.
        Content defaults to MISSING rather than None so submit keeps the "drafted
        from this conversation" link; None would clear it.
        """
        self._sessions.pop(message.channel.id, None)
        await message.edit(content=content, embed=embed, view=None)

    async def _archive(self, channel: discord.abc.Messageable) -> None:
        """An archived thread is what stops `on_message` treating a draft as live."""
        if isinstance(channel, discord.Thread):
            await channel.edit(archived=True)

    # --- helpers ---

    def _requester(self, user: discord.User | discord.Member) -> str:
        """Who is driving the draft, named exactly as the transcript names them —
        without that the agent has no referent for "assign it to me"."""
        store = self.bot.store
        return context.speaker(user, store.login_for(user.id) if store else None)

    def _session_for(self, interaction: discord.Interaction) -> Session | None:
        channel = interaction.channel
        open_draft = self._sessions.get(channel.id) if channel is not None else None
        return open_draft.session if open_draft is not None else None

    def draft_for(self, interaction: discord.Interaction) -> IssueDraft | None:
        """The live draft, or the one recovered from its own preview card.

        Sessions live in memory, so a restart loses them while the buttons keep
        working; the card is the fallback store.
        """
        session = self._session_for(interaction)
        if session is not None and session.draft is not None:
            return session.draft
        message = interaction.message
        if message is None or not message.embeds:
            return None
        return from_embed(message.embeds[0])

    async def _announce(self, repo: str, number: int, url: str, title: str) -> None:
        """Post the new issue's card in the repo channel, ahead of the webhook.

        Keyed like the renderer keys it, so the `issues.opened` webhook landing a
        moment later edits this card instead of posting a second one.
        """
        notifications = self.bot.get_cog("Notifications")
        if not isinstance(notifications, Notifications):
            return
        embed = discord.Embed(title=f"#{number} · {title}", url=url, color=GREEN)
        embed.set_author(name=f"🐛 issue · {short_name(repo)}")
        embed.set_footer(text=repo)
        await notifications.route(
            repo, render.Rendered(None, embed, render.issue_key(repo, number))
        )


@dataclass
class _Step:
    """One tool call being watched, and its answer once there is one."""

    part: ToolCallPart
    result: ToolReturnPart | None = None


class DraftWorkspace:
    """What one draft's agent may ask of Discord — `core.Workspace`.

    Holds the store and guild rather than the cog, so what a tool call can reach
    is what this class names. Both are read at call time: a `/map user` run while
    a draft is open reaches the next revision.

    Progress is one message, edited: a line per call, appended as the run goes.
    A card per call meant posting and deleting a dozen messages, which made the
    channel dance and spent its edit budget on scaffolding. One message costs one
    request per update, holds still, and collapses to a single line at the end.
    """

    _steps: list[_Step]
    _message: discord.Message | None
    _last_drawn: float
    _started: float

    def __init__(
        self, store: Store, guild: discord.Guild, thread: discord.abc.Messageable
    ) -> None:
        self._store = store
        self._guild = guild
        # Serialises the read-modify-draw of the card, so two tool events landing
        # together can't both render a half-updated line list.
        self._lock = asyncio.Lock()
        self.restart(thread)

    def restart(self, thread: discord.abc.Messageable) -> None:
        """Watch a fresh run: a new card, and its own count.

        Defines the per-run state in one place, so the constructor and a refine
        start from the same slate. The previous run's card has already been
        collapsed, so there is nothing here to clean up.
        """
        self._thread = thread
        self._steps = []
        self._message = None
        # Far enough in the past that the first call draws immediately.
        self._last_drawn = 0.0
        self._started = time.monotonic()

    def teammates(self) -> dict[str, str]:
        return self._store.teammates(self._guild)

    async def on_step(self, part: ToolCallPart) -> None:
        """Note a call that has just gone out, and show it."""
        async with self._lock:
            self._steps.append(_Step(part))
            # Always draw a new call, whatever the clock says: this is the one
            # update that tells the reader the agent moved on to something else.
            await self._draw(force=True)

    async def on_result(self, call_id: str, part: ToolReturnPart) -> None:
        """Fill in the line of the call this answers.

        By id, not by position: tools run concurrently, so the answer that lands
        first isn't the call that was made first.
        """
        async with self._lock:
            step = next(
                (s for s in self._steps if s.part.tool_call_id == call_id), None
            )
            if step is None:
                return
            step.result = part
            await self._draw()

    async def _draw(self, *, force: bool = False) -> None:
        """Put the current lines on the card, within the edit budget.

        Discord buckets message edits per channel (~5 per 5s) and discord.py
        queues rather than raising, so overrunning doesn't fail — it just makes
        every later edit late, including the answer streaming under this. Hence a
        floor between draws. Called with the lock held.
        """
        now = time.monotonic()
        if not force and now - self._last_drawn < _DRAW_EVERY:
            return
        self._last_drawn = now
        embed = progress.card([progress.line(s.part, s.result) for s in self._steps])
        with contextlib.suppress(discord.HTTPException):
            if self._message is None:
                self._message = await self._thread.send(embed=embed)
            else:
                await self._message.edit(embed=embed)

    async def collapse(self) -> None:
        """End the run: replace the card with the one line that outlives it.

        The lines go because their detail was about watching a run, not about the
        issue — what survives them is how much ground the agent covered. Safe to
        call twice: a failed run collapses before it reports the failure.
        """
        async with self._lock:
            if not self._steps:
                return  # nothing was watched, so there is nothing to summarise
            steps, self._steps = self._steps, []
            message, self._message = self._message, None
            called = [s.part.tool_name for s in steps]
            line = progress.summarise(called, elapsed=time.monotonic() - self._started)
            # Edited into place rather than deleted and reposted: the card is
            # already where the reader is looking, and one request beats two.
            try:
                if message is not None:
                    await message.edit(content=f"-# {line}", embed=None)
                else:
                    await self._thread.send(f"-# {line}")
            except discord.HTTPException:
                log.debug("could not post the run summary", exc_info=True)


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Issues(bot))
