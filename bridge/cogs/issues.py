"""Cog: turn a Discord conversation into a GitHub issue, with a human in the way.

`/issue` reads the messages you point it at, drafts an issue in a thread, and
waits. Nothing reaches GitHub until whoever asked clicks Submit — the agent has
no write tool at all, so that isn't a policy, it's the shape of the code.

The thread is the point: everyone in the conversation can watch the draft take
shape, but only the requester can act on it.
"""

import contextlib
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands
from discord.utils import MISSING
from githubkit.exception import GitHubException

from bridge import render
from bridge.cogs.notifications import Notifications
from bridge.agent import context, core, history, stream, threads, view, workspace
from bridge.agent.core import Session
from bridge.agent.tools import Deps
from bridge.agent.draft import IssueDraft, card_submitted, from_embed, preview
from bridge.render import GREEN, RED
from bridge.repo import short_name, split_repo

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

log = logging.getLogger(__name__)

DEFAULT_SPAN = 20  # messages read when you don't say how many
_MAX_SPAN = 100  # a message link reads to the end of the conversation, up to this
# Sessions kept in memory. Not a limit on open drafts — a thread we've forgotten
# rebuilds from its own messages — just how many we keep the read for.
_CACHED_SESSIONS = 8
_EXPIRED = "This draft expired — start a new `/issue`."
# What opens each kind of run, so a revision doesn't read as a first draft. The
# second is deliberately vague about the outcome: the agent decides whether it's
# revising the draft or just answering, and the line goes up before it has.
_DRAFTING = "🔎 reading the conversation..."
_REVISING = "💭 thinking..."
# Messages back we look for a thread's draft card. Deep enough to see past a
# conversation that ran on after the draft, shallow enough to be one fetch.
_CARD_SCAN = 50


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

    def candidates_for(self, channel: object) -> list[str]:
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
        repos = self.candidates_for(interaction.channel) if interaction.channel else []
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
        if self.bot.agent is None:
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
        assert self.bot.agent is not None

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

        candidates = [repo] if repo else self.candidates_for(channel)
        if not candidates:
            await interaction.followup.send(
                "No repo is mapped to this channel yet — run `/map repo` first.",
                ephemeral=True,
            )
            return

        thread = await threads.open_for(anchor, interaction.user, channel)
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
            self.bot.agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                workspace=workspace,
                linear=self.bot.linear_reader,
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
            for segment in stream.segments(reply):
                await thread.send(segment)
            return

        await threads.rename(thread, reply.title)

        await self.show(thread, reply, interaction.user.id, transcript.jump_url)

    async def _settle(
        self,
        work: DraftWorkspace,
        opening: discord.Message,
        error: str | None = None,
    ) -> None:
        """End a run's progress: collapse its card, then close out the opening line.

        On success what's left in the thread is one summary line, and the draft
        posts under it — so the thread reads in the order it happened rather than
        having the result edited back into its own announcement. A failed run has
        nothing to post under it, so the opening line carries the reason instead.
        """
        await work.collapse()
        if error is not None:
            with contextlib.suppress(discord.HTTPException):
                await opening.edit(content=f"⚠️ {error}")
            return
        with contextlib.suppress(discord.HTTPException):
            await opening.delete()

    async def show(
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

        Public because a mention can produce a draft too, and a draft has to be
        reviewable the same way however it got here — the same card, the same
        buttons, the same Submit as the only path to GitHub.
        """
        content = (
            f"Drafted from [this conversation](<{source_url}>)." if source_url else None
        )
        embed = preview(draft, note=self._assignee_note(draft))
        buttons = view.draft_view(author_id)
        if isinstance(target, discord.Message):
            await target.edit(content=content, embed=embed, view=buttons)
            return
        # A revision leaves the old card in the thread so the draft's history stays
        # readable, but only the newest one is a proposal — so at most one card in a
        # thread keeps live buttons, and there is no stale Submit to open a second
        # issue from a draft that has been superseded.
        await self._retire(target)
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
            f"`{draft.assignee}` isn't a mapped GitHub login — run `/map github`, "
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
        if not thread.name.startswith(threads.PREFIX):
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
        live = stream.Live(opening)
        try:
            open_draft.session.candidates(self.candidates_for(thread))
            reply = await open_draft.session.stream(
                open_draft.session.saying(feedback), live.feed
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("refine failed")
            await self._settle(open_draft.workspace, opening, core.explain(exc))
            return
        await open_draft.workspace.collapse()
        if isinstance(reply, IssueDraft):
            # The opening line was a placeholder for an answer that isn't coming;
            # the card below says everything it would have.
            with contextlib.suppress(discord.HTTPException):
                await opening.delete()
            await self.show(thread, reply, open_draft.session.owner_id)
            return
        await live.finish(reply)

    async def _resume(self, thread: discord.Thread, message: discord.Message) -> None:
        """Answer in a thread whose session we no longer hold.

        Everything a reply needs is in the thread: the conversation is its
        messages, the draft is its newest preview card, and who may steer it is
        the owner encoded in that card's buttons. So a restart costs a re-read
        rather than the conversation.
        """
        if self._unavailable() is not None or self.bot.store is None:
            return
        assert self.bot.agent is not None
        assert self.bot.github is not None
        card = await self._card(thread)
        if card is None:
            return  # no draft card: not a thread of ours to answer in
        owner_id = view.owner_of(card)
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
            self.bot.agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                workspace=workspace,
                linear=self.bot.linear_reader,
            ),
            requester=self._requester(message.author),
            owner_id=owner_id,
            history=past,
            draft=from_embed(card.embeds[0]),
        )
        live = stream.Live(opening)
        try:
            session.candidates(self.candidates_for(thread))
            reply = await session.stream(session.resuming(message.content), live.feed)
        except Exception as exc:  # noqa: BLE001 — a failed reply mustn't kill the cog
            log.exception("resumed reply failed in thread %s", thread.id)
            await self._settle(workspace, opening, core.explain(exc))
            return
        await workspace.collapse()
        # Hold the session from here on: the conversation is live again, and the
        # next message should not pay to rebuild what we now have.
        self._sessions[thread.id] = Draft(session, workspace)
        if isinstance(reply, IssueDraft):
            with contextlib.suppress(discord.HTTPException):
                await opening.delete()
            await self.show(thread, reply, owner_id)
            return
        await live.finish(reply)

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
        # The modal may have been open across the submit — a window the button guard
        # can't see, and re-showing the card here would put live buttons back on an
        # issue that already exists.
        if card_submitted(message):
            await interaction.followup.send(view.ALREADY_SUBMITTED, ephemeral=True)
            return
        draft = self.draft_for(interaction)
        if draft is None:
            await interaction.followup.send(_EXPIRED, ephemeral=True)
            return
        draft = draft.model_copy(update={"title": title, "body": body, "questions": []})
        if (session := self._session_for(interaction)) is not None:
            session.draft = draft
        await self.show(message, draft, interaction.user.id)

    async def submit(self, interaction: discord.Interaction) -> None:
        message = interaction.message
        if message is None:
            return
        # Belt and braces: the button already refused, but this is the call that
        # reaches GitHub, so it checks for itself. One draft, at most one issue.
        if card_submitted(message):
            await interaction.followup.send(view.ALREADY_SUBMITTED, ephemeral=True)
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

    async def _retire(self, channel: discord.abc.Messageable) -> None:
        """Take the buttons off the newest draft card in `channel`, if it has one.

        Best effort: the card we can't edit is worth less than the draft going up,
        so a failure here doesn't stop the new card from posting.
        """
        if not isinstance(channel, discord.Thread):
            return
        card = await self._card(channel)
        if card is None:
            return
        with contextlib.suppress(discord.HTTPException):
            await card.edit(view=None)

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


class DraftWorkspace(workspace.Workspace):
    """A draft's workspace: reads back in the channel its thread hangs off.

    The thread itself is the agent's own conversation and already reaches it as
    history; what it can't see is the discussion that came before the draft, which
    is in the parent channel above the thread's anchor.
    """

    async def earlier(self, limit: int) -> str:
        thread = self._channel
        if not isinstance(thread, discord.Thread):
            return await context.read_back(thread, self._store, limit=limit)
        # A forum channel holds posts rather than messages, so there is no
        # preceding discussion to read there.
        if not isinstance(thread.parent, discord.TextChannel):
            return ""
        return await context.read_back(
            thread.parent, self._store, limit=limit, before=thread.id
        )


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Issues(bot))
