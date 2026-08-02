"""Cog: turn a Discord conversation into a GitHub issue, with a human in the way.

`/issue` reads the messages you point it at, drafts an issue in a thread, and
waits. Nothing reaches GitHub until whoever asked clicks Submit — the agent has
no write tool at all, so that isn't a policy, it's the shape of the code.

The thread is the point: everyone in the conversation can watch the draft take
shape, but only the requester can act on it.
"""

import asyncio
import logging
from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands
from githubkit.exception import GitHubException

from bridge import render
from bridge.cogs.notifications import Notifications
from bridge.issue import agent, context, view
from bridge.issue.agent import Deps, Session
from bridge.issue.draft import IssueDraft, from_embed, preview
from bridge.render import GREEN, RED
from bridge.repo import split_repo

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

log = logging.getLogger(__name__)

DEFAULT_SPAN = 20  # messages read when you don't say how many
_MAX_SPAN = 100  # `since` reads to the end of the conversation, up to this
_CARD_SCAN = 20  # messages searched in a thread for the draft card
_MAX_SESSIONS = 3  # concurrent drafts; each holds images + agent history in RAM
_STEP_LINES = 6  # tool calls shown while the agent works
_EXPIRED = "This draft expired — start a new `/issue`."


class Issues(commands.Cog):
    """Implements view.Actions — the buttons call back into these methods."""

    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        self._sessions: dict[int, Session] = {}  # thread id -> live draft
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
        since="Read from this message onwards. Right-click → Copy Message Link.",
        from_message="Read the messages *before* this one. Right-click → Copy Link.",
        last="How many messages to read (default 20). Ignored with `since`.",
        repo="Force the target repo instead of inferring it from the channel.",
    )
    @app_commands.autocomplete(repo=_mapped_repo_choices)
    async def issue(
        self,
        interaction: discord.Interaction,
        prompt: str | None = None,
        since: str | None = None,
        from_message: str | None = None,
        last: app_commands.Range[int, 1, 100] = DEFAULT_SPAN,
        repo: str | None = None,
    ) -> None:
        # The agent takes tens of seconds; ack now or the interaction expires.
        await interaction.response.defer(ephemeral=True, thinking=True)
        if (problem := self._unavailable()) is not None:
            await interaction.followup.send(problem, ephemeral=True)
            return
        assert interaction.guild is not None

        link = since or from_message
        anchor: discord.Message | None = None
        if link is not None:
            anchor = await context.resolve_message(interaction.guild, link)
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
            span=_MAX_SPAN if since else last,
            repo=repo,
            prompt=prompt,
            forward=since is not None,
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
            span=DEFAULT_SPAN,
            repo=None,
            prompt=prompt,
        )

    def _unavailable(self) -> str | None:
        """Why we can't draft right now, if we can't."""
        if self.bot.issue_agent is None:
            return "Issue drafting is switched off — no model configured."
        if self.bot.store is None or self.bot.github is None:
            return "Still starting up; try again in a moment."
        # A deleted thread never submits or discards, so its session would hold a
        # slot forever.
        for thread_id in list(self._sessions):
            if self.bot.get_channel(thread_id) is None:
                del self._sessions[thread_id]
        if len(self._sessions) >= _MAX_SESSIONS:
            return (
                f"{_MAX_SESSIONS} drafts are already open. "
                "Submit or discard one of them first."
            )
        return None

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
        forward: bool = False,
    ) -> None:
        assert self.bot.store is not None
        assert self.bot.github is not None
        assert self.bot.issue_agent is not None

        transcript = await context.collect(
            channel, self.bot.store, limit=span, anchor=anchor, forward=forward
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

        status = await thread.send("🔎 reading the conversation…")
        session = Session(
            self.bot.issue_agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                on_step=_progress(status),
            ),
            requester=self._requester(interaction.user),
        )
        self._sessions[thread.id] = session
        try:
            draft = await session.start(transcript, candidates, prompt=prompt)
        except Exception as exc:  # noqa: BLE001 — a failed draft mustn't kill the cog
            log.exception("issue draft failed in thread %s", thread.id)
            del self._sessions[thread.id]
            await status.edit(content=f"⚠️ {agent.explain(exc)}")
            return

        await self._show(status, draft, interaction.user.id, transcript.jump_url)

    async def _thread(
        self,
        channel: discord.abc.Messageable,
        anchor: discord.Message | None,
        author: discord.User | discord.Member,
    ) -> discord.Thread | None:
        """A thread to draft in: hung off the anchor message when there is one, so
        the conversation and its issue stay visibly connected."""
        name = f"issue · {author.display_name}"[:100]
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

    async def _show(
        self,
        status: discord.Message,
        draft: IssueDraft,
        author_id: int,
        source_url: str | None = None,
    ) -> None:
        """Replace the progress line with the draft and its buttons."""
        note = self._assignee_note(draft)
        await status.edit(
            content=f"Drafted from [this conversation](<{source_url}>)."
            if source_url
            else None,
            embed=preview(draft, note=note),
            view=view.draft_view(author_id),
        )
        await self._retitle(status.channel, draft.title)

    @staticmethod
    async def _retitle(channel: discord.abc.Messageable, title: str) -> None:
        """Name the thread after the issue it is drafting, so a list of open
        drafts reads as a list of issues rather than a column of one name."""
        if not isinstance(channel, discord.Thread) or channel.name == title[:100]:
            return
        try:
            await channel.edit(name=title[:100])
        except discord.HTTPException:
            log.debug("could not rename draft thread %s", channel.id, exc_info=True)

    def _assignee_note(self, draft: IssueDraft) -> str | None:
        """Warn if the proposed assignee isn't someone we know about."""
        store = self.bot.store
        if draft.assignee is None or store is None:
            return None
        if store.discord_id_for(draft.assignee) is not None:
            return None
        return (
            f"`{draft.assignee}` isn't linked to a Discord member "
            "(`/map user`); GitHub may reject the assignment."
        )

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        """A draft thread is a conversation: the requester talking in it revises.

        Only the requester — the thread is public, and anyone else in it is
        commenting on the draft, not steering it.
        """
        if message.author.bot or not message.content.strip():
            return
        if not isinstance(message.channel, discord.Thread):
            return
        owner = await self._owner_of(message.channel)
        if owner is None or message.author.id != owner:
            return
        session = self._sessions.get(message.channel.id)
        if session is None:
            # The card outlives the process that drafted it, so a thread can look
            # live while the history behind it is gone. Say so, rather than
            # swallowing what they typed.
            await message.reply(
                "I've lost the thread of this draft (I restarted). Use the buttons "
                "above, or start a new `/issue`.",
                mention_author=False,
            )
            return
        await self._revise(message.channel, session, message.content, owner)

    # --- view.Actions ---

    async def refine(self, interaction: discord.Interaction, feedback: str) -> None:
        live = await self._live(interaction)
        if live is None:
            return
        message, session = live
        if isinstance(message.channel, discord.Thread):
            await self._revise(message.channel, session, feedback, interaction.user.id)

    async def _revise(
        self,
        thread: discord.Thread,
        session: Session,
        feedback: str,
        author_id: int,
    ) -> None:
        """Run a revision and post the result as a new message in the thread.

        The old card is left where it is: the thread is the record of how the
        issue got its shape, and editing it away loses that.
        """
        status = await thread.send("✍️ revising…")
        session.report_to(_progress(status))
        try:
            draft = await session.refine(feedback, self._candidates(thread))
        except Exception as exc:  # noqa: BLE001
            log.exception("refine failed")
            await status.edit(content=f"⚠️ {agent.explain(exc)}")
            return
        await self._show(status, draft, author_id)

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
        self._sessions.pop(message.channel.id, None)
        await message.edit(
            content=f"✅ [#{issue.number}]({issue.html_url}) created.",
            embed=None,
            view=None,
        )
        await self._announce(draft.repo, issue.number, issue.html_url, draft.title)
        if isinstance(message.channel, discord.Thread):
            await message.channel.edit(archived=True)

    async def cancel(self, interaction: discord.Interaction) -> None:
        message = interaction.message
        if message is None:
            return
        self._sessions.pop(message.channel.id, None)
        await message.edit(content="🗑️ Draft discarded.", embed=None, view=None)
        if isinstance(message.channel, discord.Thread):
            await message.channel.edit(archived=True)

    # --- helpers ---

    async def _owner_of(self, thread: discord.Thread) -> int | None:
        """Who may steer this draft, read off the buttons under its card.

        The card is the only copy that survives a restart, so keeping a second
        one in memory would just be a copy that can go stale.
        """
        async for message in thread.history(limit=_CARD_SCAN, oldest_first=True):
            for row in message.components:
                for item in getattr(row, "children", ()):
                    _, _, author = (getattr(item, "custom_id", "") or "").partition(
                        "issue:approve:"
                    )
                    if author.isdigit():
                        return int(author)
        return None

    def _requester(self, user: discord.User | discord.Member) -> str:
        """Who is driving the draft, with their GitHub login when we know it —
        without it the agent has no referent for "assign it to me"."""
        store = self.bot.store
        login = store.login_for(user.id) if store else None
        return f"{user.display_name} (@{login})" if login else user.display_name

    def _session_for(self, interaction: discord.Interaction) -> Session | None:
        channel = interaction.channel
        return self._sessions.get(channel.id) if channel is not None else None

    async def _live(
        self, interaction: discord.Interaction
    ) -> tuple[discord.Message, Session] | None:
        """The draft's message and its session, or an apology and None."""
        message = interaction.message
        session = self._session_for(interaction)
        if message is None or session is None:
            await interaction.followup.send(_EXPIRED, ephemeral=True)
            return None
        return message, session

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
        embed.set_author(name=f"🐛 issue · {repo.rpartition('/')[2]}")
        embed.set_footer(text=repo)
        await notifications.route(
            repo, render.Rendered(None, embed, render.issue_key(repo, number))
        )


def _progress(status: discord.Message):
    """A callback that shows the agent's last few tool calls in `status`.

    A step that arrives while an edit is in flight is dropped rather than queued:
    Discord rate-limits edits, and a busy agent would otherwise stack up frames
    that are stale by the time they render. The next step redraws the full tail.
    """
    steps: list[str] = []
    lock = asyncio.Lock()

    async def on_step(step: str) -> None:
        steps.append(step)
        if lock.locked():
            return
        async with lock:
            body = "\n".join(f"· {s}" for s in steps[-_STEP_LINES:])
            try:
                await status.edit(content=f"🔎 working…\n```\n{body}\n```")
            except discord.HTTPException:
                pass  # a dropped progress edit is not worth failing the run over

    return on_step


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Issues(bot))
