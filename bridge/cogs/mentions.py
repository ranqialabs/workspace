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

One run per channel at a time. Two people mentioning us at once used to start two
runs that answered over each other and spent the same channel's edit budget
twice, so a channel with a run in flight queues what arrives instead: the run
finishes, and what was said meanwhile becomes the next turn of the same
conversation. Which is also why it reads better — the queued turn keeps the
history the first one built, rather than starting cold from a fresh seed.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bridge.agent import context, core, history, stream, threads, workspace
from pydantic_ai import UserContent
from bridge.agent.core import Session
from bridge.agent.tools import Deps
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
_QUEUED = "💭 queued..."
# Messages back to look for a line of our own, deciding whether a thread is one
# we're working in. One page, so the check costs at most a single fetch.
_THREAD_SCAN = 50


@dataclass
class _Conversation:
    """A channel's run in flight, and what came in while it was running.

    Keyed by channel rather than by person: the run holds one channel's edit
    budget and answers into one channel's scrollback, so that is the thing there
    can only be one of. Two people talking to us in the same channel are one
    conversation as far as this is concerned, which is also how it reads to them.
    """

    # Held, not read: asyncio keeps only a weak reference to a running task, so
    # dropping this one would let a run be collected mid-answer. Cancellation is
    # out of scope, so nothing else needs it.
    task: asyncio.Task[None]
    # Messages waiting for the current run to finish, oldest first. Their text is
    # not flattened here: the drain needs the message itself to reply to it, to
    # name who spoke, and to read its images.
    queued: list[tuple[discord.Message, str]] = field(default_factory=list)
    # The session the run built, handed to the drained turn so it inherits the
    # history rather than reading the channel again from scratch.
    session: Session | None = None
    work: "MentionWorkspace | None" = None


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
    """Answers a mention, one run per channel at a time.

    State is what is running where (`_active`) and which threads we've spoken in
    (`_threads`, so an unaddressed line there costs no fetch after the first). A
    run still reads its own context — no conversation is cached between runs.
    """

    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        self._active: dict[int, _Conversation] = {}
        # Threads we've said something in, so every line there is ours to answer.
        # Positives only, and rebuilt by a read after a restart, so it is a cache
        # rather than a record — losing it costs one history fetch.
        self._threads: set[int] = set()

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        """Answer when we're spoken to, and stay out of the way otherwise.

        This fires for every message in the server, so the order of these tests
        matters: the cheap local ones first, and nothing that costs a fetch until
        we know the message is for us.
        """
        me = self.bot.user
        if message.author.bot or me is None:
            return  # our own answers mention people; never answer ourselves
        channel = message.channel
        # A draft thread is the issues cog's conversation and it answers there
        # without being mentioned; both replying would say the same thing twice.
        if isinstance(channel, discord.Thread) and channel.name.startswith(
            threads.PREFIX
        ):
            return
        if not await self._directed_at_us(message, me):
            return
        if not (asked := _asked(message, me)):
            return  # a bare mention with nothing in it isn't a question
        # A run already holding this channel takes the turn as queued work; only
        # an idle channel starts one. The lookup and the claim in `_start` run
        # without an await between them, so two messages can't both find the
        # channel idle however they interleave above.
        if (live := self._active.get(channel.id)) is not None:
            await self._enqueue(live, message, asked)
            return
        self._start(message, asked)

    async def _directed_at_us(
        self, message: discord.Message, me: discord.ClientUser
    ) -> bool:
        """Whether this message is talking to us.

        In an ordinary channel we only answer when named: a mention, or a reply to
        something we said. Anything else is the channel's own conversation, and
        answering it would be us talking over people.

        A thread we're already working in is different — see below. (Draft threads
        never reach here: they belong to the issues cog.)

        Ordered so the free tests come first and the one fetch is last, on the
        narrowest path: a mention is local, a reply is usually already in the
        payload, and only an unaddressed line in a thread we don't yet recognise
        reads history.
        """
        if me in message.mentions:
            return True  # named outright; free and the common case
        # A reply to something we said is addressed to us wherever it happens.
        replied = await history.replied_to(message)
        if replied is not None and replied.author.id == me.id:
            return True
        if not isinstance(message.channel, discord.Thread):
            return False  # an ordinary channel only counts when we're named
        # In a thread we're working in, every line counts: it was opened for one
        # thing and we're a participant, so making someone re-mention us on each
        # line of a back-and-forth reads as pedantic. A thread we're mid-run in is
        # known locally; otherwise ask the thread whether we've spoken in it, and
        # remember a yes — that answer only ever goes from false to true.
        if message.channel.id in self._active or message.channel.id in self._threads:
            return True
        if await _we_spoke_in(message.channel, me):
            self._threads.add(message.channel.id)
            return True
        return False

    def _start(self, message: discord.Message, asked: str) -> None:
        """Claim this channel and answer on a task of its own.

        Registered before the task is scheduled, not inside it: a second message
        arriving in the same channel has to find the claim already there, and a
        task doesn't begin running until this handler yields.
        """
        channel_id = message.channel.id
        task = asyncio.create_task(self._run(message, asked))
        self._active[channel_id] = _Conversation(task=task)
        # Discarded on purpose: `_run` reports its own failures and always clears
        # the registry, so a done callback would have nothing left to do.
        task.add_done_callback(lambda _: self._active.pop(channel_id, None))

    async def _enqueue(
        self, live: _Conversation, message: discord.Message, asked: str
    ) -> None:
        """Hold a turn until the run in flight is done with the channel."""
        live.queued.append((message, asked))
        # Says the message was seen, which a silent wait doesn't. One send, not a
        # per-turn edit loop: the answer is what they're waiting for.
        with contextlib.suppress(discord.HTTPException):
            await message.reply(_QUEUED, mention_author=False)

    async def _run(self, message: discord.Message, asked: str) -> None:
        """One channel's conversation: the first turn, then whatever queued up.

        The loop is what makes queueing worth more than a lock. Each drained turn
        reuses the session the last one built, so the agent keeps the files it
        already read and the answers it already gave — a follow-up costs a turn,
        not a whole fresh run.
        """
        await self._answer(message, asked)
        while (live := self._active.get(message.channel.id)) is not None:
            if not live.queued:
                return
            queued, live.queued = live.queued, []
            # Everything that piled up during one run goes in as one turn: three
            # people asking three things while we were busy is one thing to
            # answer, and answering them one run each would flood right back.
            await self._continue(live, queued)

    async def _continue(
        self, live: _Conversation, queued: list[tuple[discord.Message, str]]
    ) -> None:
        """Answer the turns that arrived during the last run, on its session."""
        session, work, store = live.session, live.work, self.bot.store
        last = queued[-1][0]
        if session is None or work is None or store is None:
            # The first run died before it had a session (no store, no agent, or
            # it raised on the way up). Nothing to continue, so this turn starts
            # its own conversation rather than being dropped.
            await self._answer(last, queued[-1][1])
            return
        placeholder = await last.reply(_THINKING, mention_author=False)
        work.restart(last.channel)
        live_out = stream.Live(placeholder)
        try:
            session.candidates(self._candidates_for(last.channel))
            reply = await session.stream(_said(queued, store, session), live_out.feed)
        except Exception as exc:  # noqa: BLE001 — a failed turn mustn't kill the cog
            log.exception("queued mention failed in channel %s", last.channel.id)
            failed = await work.collapse(session.spend, carried=True)
            with contextlib.suppress(discord.HTTPException):
                await placeholder.edit(
                    content=_reason(core.explain(exc), failed), embed=None
                )
            return
        summary = await work.collapse(
            session.spend, carried=not isinstance(reply, IssueDraft)
        )
        if isinstance(reply, IssueDraft):
            issues = self.bot.get_cog("Issues")
            if isinstance(issues, Issues):
                await self._propose(last, placeholder, reply, issues)
            return
        await live_out.finish(reply, summary)

    def _candidates_for(self, channel: discord.abc.Messageable) -> list[str]:
        issues = self.bot.get_cog("Issues")
        return issues.candidates_for(channel) if isinstance(issues, Issues) else []

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
        # Replying to an answer of ours continues that exchange, so the chain it
        # hangs off comes back as history. Without one, the seed is all there is.
        assert self.bot.user is not None
        past = await history.rebuild_chain(message, store, bot_user_id=self.bot.user.id)
        session = Session(
            self.bot.agent,
            Deps(
                github=self.bot.github,
                org=self.bot.config.org,
                candidates=issues.candidates_for(message.channel),
                workspace=work,
                linear=self.bot.linear_reader,
            ),
            requester=context.speaker(
                message.author, store.login_for(message.author.id)
            ),
            owner_id=message.author.id,
            history=past,
        )
        # Published for the drain: a turn that queued up behind this run continues
        # this session instead of building a cold one.
        if (held := self._active.get(message.channel.id)) is not None:
            held.session, held.work = session, work
        live = stream.Live(placeholder)
        try:
            prompt = await self._prompt(
                message, asked, store, issues, continuing=bool(past)
            )
            reply = await session.stream(prompt, live.feed)
        except Exception as exc:  # noqa: BLE001 — a failed answer mustn't kill the cog
            log.exception("mention run failed in channel %s", message.channel.id)
            failed = await work.collapse(session.spend, carried=True)
            with contextlib.suppress(discord.HTTPException):
                await placeholder.edit(
                    content=_reason(core.explain(exc), failed), embed=None
                )
            return
        # The card and the answer share one channel's edit budget, so the card
        # comes down before the answer takes over the placeholder. A draft has no
        # prose to carry the summary, so there the line stays in the card's place.
        summary = await work.collapse(
            session.spend, carried=not isinstance(reply, IssueDraft)
        )

        if isinstance(reply, IssueDraft):
            await self._propose(message, placeholder, reply, issues)
            return
        await live.finish(reply, summary)

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
        *,
        continuing: bool,
    ) -> list[UserContent]:
        """What the agent starts with: the request, and a little context.

        A reply is a deliberate pointer, so it gets the message it points at and
        nothing else. Without one there is nothing to point at, so the last few
        messages stand in until the agent reads further back itself.

        `continuing` means the chain already came back as history, so a seed here
        would be the same text twice.
        """
        replied = await history.replied_to(message)
        if continuing:
            seed = context.Transcript(text="", jump_url=message.jump_url)
        elif replied is not None:
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
            continuing=continuing,
        )


async def _we_spoke_in(thread: discord.Thread, me: discord.ClientUser) -> bool:
    """Whether we've said anything in this thread.

    What separates a thread we're working in from one that merely exists. Read off
    the thread rather than remembered, so it still holds after a restart — and
    bounded, because a thread where we haven't spoken in its first page of replies
    is not a thread we're in.
    """
    try:
        async for message in thread.history(limit=_THREAD_SCAN):
            if message.author.id == me.id:
                return True
    except discord.HTTPException:
        return False  # can't tell; better silent than answering a stranger's thread
    return False


def _reason(explained: str, summary: str) -> str:
    """A failed run's message: why it failed, and what it spent getting there.

    A run that died to a retry storm or a usage limit is exactly the one whose cost
    is worth knowing, so the footnote goes on the failure too rather than only on
    the answers.
    """
    return f"⚠️ {explained}" + (f"\n-# {summary}" if summary else "")


def _said(
    queued: list[tuple[discord.Message, str]], store: Store, session: Session
) -> str:
    """The queued turns as one thing said, named so the agent knows who spoke.

    Named per line because a channel is several people: folding three turns into
    one unattributed block would have the agent answer them as though one person
    had asked all three, and "me" in the third would point at the wrong person.

    Through `session.saying` so a turn is spelled the same way wherever it comes
    from, and named by `context.speaker` like anywhere else a person reaches the
    model.
    """
    return "\n\n".join(
        session.saying(
            asked, context.speaker(message.author, store.login_for(message.author.id))
        )
        for message, asked in queued
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


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Mentions(bot))
