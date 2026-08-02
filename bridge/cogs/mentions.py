"""Cog: @mention the bot and it answers, like anyone else in the channel.

The slash commands are for asking the bridge to do a specific thing. This is for
talking to it: you mention it, it reads what it needs, and it either answers or
proposes an issue. Which of those happens is the agent's call, not a keyword match
here — `/issue` exists for when you want to be explicit.

What it reads is deliberately small to start with. A mention that replies to a
message gets that message and the mention; one that doesn't gets the last few
messages, just to orient. Everything beyond that the agent asks for itself with
`read_conversation`, because only it knows whether "isso" needs five messages of
context or fifty.

The GitHub boundary is the same one `/issue` has: a proposed issue arrives as a
draft card with buttons, and only a human pressing Submit files anything.
"""

import contextlib
import logging
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bridge.agent import context, core, stream, threads, workspace
from pydantic_ai import UserContent
from bridge.agent.core import Deps, Session
from bridge.agent.draft import IssueDraft
from bridge.cogs.issues import Issues
from bridge.store import Store

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

log = logging.getLogger(__name__)

# Messages of channel context a mention starts with when it isn't a reply. Small
# on purpose: it is there to orient the agent, which then reads back as far as it
# decides it needs to.
_SEED = 8
_THINKING = "💭 thinking..."


class MentionWorkspace(workspace.Workspace):
    """A mention's workspace: reads back in the channel it was mentioned in.

    Bounded by the mention itself rather than by "now": what the agent may read is
    the conversation that led up to the request, and a message posted since is not
    part of what was asked.
    """

    def __init__(
        self,
        store: Store,
        guild: discord.Guild,
        channel: discord.abc.Messageable,
        anchor: discord.Message,
    ) -> None:
        super().__init__(store, guild, channel)
        self._anchor = anchor

    async def earlier(self, limit: int) -> str:
        return await context.read_back(
            self._channel, self._store, limit=limit, before=self._anchor
        )


class Mentions(commands.Cog):
    """Answers a mention. Owns no state: every run reads what it needs."""

    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        """Answer when we're mentioned, and stay out of the way otherwise.

        This fires for every message in the server, so the order of these tests
        matters: the cheap local ones first, and nothing that costs a fetch until
        we know the message is for us.
        """
        me = self.bot.user
        if message.author.bot or me is None:
            return  # our own answers mention people; never answer ourselves
        if me not in message.mentions:
            return
        channel = message.channel
        # A draft thread is the issues cog's conversation and it answers there
        # without being mentioned; both replying would say the same thing twice.
        if isinstance(channel, discord.Thread) and channel.name.startswith(
            threads.PREFIX
        ):
            return
        if not (asked := _asked(message, me)):
            return  # a bare mention with nothing in it isn't a question
        await self._answer(message, asked)

    async def _answer(self, message: discord.Message, asked: str) -> None:
        """Read, run, and stream the answer back under the mention."""
        issues = self.bot.get_cog("Issues")
        store = self.bot.store
        if (
            store is None
            or self.bot.github is None
            or self.bot.agent is None
            or not isinstance(issues, Issues)
            or message.guild is None
        ):
            return

        placeholder = await message.reply(_THINKING, mention_author=False)
        work = MentionWorkspace(store, message.guild, message.channel, message)
        session = Session(
            self.bot.agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                candidates=issues.candidates_for(message.channel),
                workspace=work,
            ),
            requester=context.speaker(
                message.author, store.login_for(message.author.id)
            ),
            owner_id=message.author.id,
        )
        live = stream.Live(placeholder)
        try:
            prompt = await self._prompt(message, asked, store, issues)
            reply = await session.stream(prompt, live.feed)
        except Exception as exc:  # noqa: BLE001 — a failed answer mustn't kill the cog
            log.exception("mention run failed in channel %s", message.channel.id)
            await work.collapse()
            with contextlib.suppress(discord.HTTPException):
                await placeholder.edit(content=f"⚠️ {core.explain(exc)}", embed=None)
            return
        # The card and the answer share one channel's edit budget, so the card
        # folds into its summary line before the answer takes over the placeholder.
        await work.collapse()

        if isinstance(reply, IssueDraft):
            await self._propose(message, placeholder, reply, issues)
            return
        await live.finish(reply)

    async def _propose(
        self,
        message: discord.Message,
        placeholder: discord.Message,
        draft: IssueDraft,
        issues: Issues,
    ) -> None:
        """Put a draft up for review, in a thread hung off the request.

        An issue is work, so it gets a thread of its own rather than a card
        halfway up a busy channel — and the thread is then a conversation the
        issues cog carries on in.
        """
        thread = await threads.open_for(message, message.author)
        if thread is None:
            # No thread to be had (permissions, or a channel that can't hold one).
            # The draft still has to be reviewable, so it goes right here.
            await issues.show(message.channel, draft, message.author.id)
            with contextlib.suppress(discord.HTTPException):
                await placeholder.delete()
            return
        await threads.rename(thread, draft.title)
        with contextlib.suppress(discord.HTTPException):
            await placeholder.edit(
                content=f"📝 drafted in {thread.mention}", embed=None
            )
        await issues.show(thread, draft, message.author.id, message.jump_url)

    async def _prompt(
        self,
        message: discord.Message,
        asked: str,
        store: Store,
        issues: Issues,
    ) -> list[UserContent]:
        """What the agent starts with: the request, and a little context.

        A reply is a deliberate pointer, so it gets the message it points at and
        nothing else. Without one there is nothing to point at, so the last few
        messages stand in until the agent reads further back itself.
        """
        replied = await _replied_to(message)
        if replied is not None:
            seed = await context.collect(
                message.channel, store, limit=2, anchor=replied
            )
        else:
            seed = await context.collect(message.channel, store, limit=_SEED)
        return core.asked_prompt(
            seed,
            candidates=issues.candidates_for(message.channel),
            asked=asked,
            requester=context.speaker(
                message.author, store.login_for(message.author.id)
            ),
            pointed_at=replied is not None,
        )


def _asked(message: discord.Message, me: discord.ClientUser) -> str:
    """The request, with the mention of us taken out of it.

    Left in, the model reads its own id as part of the question; taken out, what
    remains is what a person would have said to a colleague.
    """
    text = message.content
    for form in (f"<@{me.id}>", f"<@!{me.id}>"):
        text = text.replace(form, " ")
    return " ".join(text.split())


async def _replied_to(message: discord.Message) -> discord.Message | None:
    """The message this one replies to, if it replies to one we can read."""
    ref = message.reference
    if ref is None or ref.message_id is None:
        return None
    if isinstance(ref.resolved, discord.Message):
        return ref.resolved  # already in the payload; no fetch needed
    with contextlib.suppress(discord.HTTPException):
        return await message.channel.fetch_message(ref.message_id)
    return None


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Mentions(bot))
