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
from bridge.issue import context, view
from bridge.issue.agent import Deps, Session
from bridge.issue.draft import IssueDraft, from_embed, preview
from bridge.render import GREEN, RED
from bridge.repo import split_repo

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

log = logging.getLogger(__name__)

DEFAULT_SPAN = 20  # messages read when you don't say how many
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
        from_message="Link to the message to draft from (its thread of conversation).",
        last="How many messages to read back (default 20).",
        repo="Force the target repo instead of inferring it from the channel.",
    )
    @app_commands.autocomplete(repo=_mapped_repo_choices)
    async def issue(
        self,
        interaction: discord.Interaction,
        prompt: str | None = None,
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

        anchor: discord.Message | None = None
        if from_message is not None:
            anchor = await context.resolve_message(interaction.guild, from_message)
            if anchor is None:
                await interaction.followup.send(
                    "That doesn't look like a message link in this server.",
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
            interaction, channel, anchor=anchor, span=last, repo=repo, prompt=prompt
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

        status = await thread.send("🔎 reading the conversation…")
        session = Session(
            self.bot.issue_agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                on_step=_progress(status),
            ),
        )
        self._sessions[thread.id] = session
        try:
            draft = await session.start(transcript, candidates, prompt=prompt)
        except Exception:  # noqa: BLE001 — model/network failure shouldn't kill the cog
            log.exception("issue draft failed in thread %s", thread.id)
            del self._sessions[thread.id]
            await status.edit(content="⚠️ The draft failed. Try `/issue` again.")
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

    # --- view.Actions ---

    async def refine(self, interaction: discord.Interaction, feedback: str) -> None:
        live = await self._live(interaction)
        if live is None:
            return
        message, session = live
        candidates = self._candidates(message.channel)
        await message.edit(content="✍️ revising…", embed=None, view=None)
        session.report_to(_progress(message))
        try:
            draft = await session.refine(feedback, candidates)
        except Exception:  # noqa: BLE001
            log.exception("refine failed")
            await message.edit(content="⚠️ The revision failed.")
            return
        await self._show(message, draft, interaction.user.id)

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
