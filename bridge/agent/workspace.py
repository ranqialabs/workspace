"""What a run may ask of Discord, and how it reports back — `tools.Workspace`.

One class rather than one per entry point, because the reporting side is the same
wherever a run came from: a card that accumulates a line per tool call, edited in
place, and at the end summarised into a line the caller places. What differs is
only *where to read back from* when the agent asks for more context, so that is
the one method a subclass fills in.

Held apart from the cogs so that what a tool call can reach is what this module
names, and so both cogs get the same pacing without one importing the other.
"""

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass

import discord
from pydantic_ai import ToolCallPart, ToolReturnPart

from bridge.agent import progress
from bridge.agent.spend import Spend
from bridge.agent.stream import EDIT_EVERY
from bridge.store import Store

log = logging.getLogger(__name__)


@dataclass
class _Step:
    """One tool call being watched, and its answer once there is one."""

    part: ToolCallPart
    result: ToolReturnPart | None = None


class Workspace:
    """Reports one run's progress into a Discord channel.

    Progress is one message, edited: a line per call, appended as the run goes.
    A card per call meant posting and deleting a dozen messages, which made the
    channel dance and spent its edit budget on scaffolding.
    """

    def __init__(
        self, store: Store, guild: discord.Guild, channel: discord.abc.Messageable
    ) -> None:
        self._store = store
        self._guild = guild
        # Serialises the read-modify-draw of the card, so two tool events landing
        # together can't both render a half-updated line list.
        self._lock = asyncio.Lock()
        self.restart(channel)

    def restart(self, channel: discord.abc.Messageable) -> None:
        """Watch a fresh run: a new card, and its own count.

        Defines the per-run state in one place, so the constructor and a second
        run start from the same slate. The previous run's card has already been
        collapsed, so there is nothing here to clean up.
        """
        self._channel = channel
        self._steps: list[_Step] = []
        self._message: discord.Message | None = None
        # Far enough in the past that the first call draws immediately.
        self._last_drawn = 0.0
        self._started = time.monotonic()
        # Whether this run has already been closed out. Held rather than inferred
        # from the steps: a run that called no tool still has a summary worth
        # returning once, and "no steps left" cannot tell that from a second call.
        self._collapsed = False

    def people(self) -> list[dict[str, str]]:
        return self._store.people(self._guild)

    async def earlier(self, limit: int) -> str:
        """Where `read_conversation` reads from. Subclasses say where that is.

        Raises rather than returning "": an empty answer is indistinguishable
        from "there is nothing earlier", so a subclass that forgot to override
        this would have the agent conclude the conversation started at the
        request — silently, and only visible as a worse answer.
        """
        raise NotImplementedError

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

        Called with the lock held.
        """
        now = time.monotonic()
        if not force and now - self._last_drawn < EDIT_EVERY:
            return
        self._last_drawn = now
        embed = progress.card([progress.line(s.part, s.result) for s in self._steps])
        with contextlib.suppress(discord.HTTPException):
            if self._message is None:
                self._message = await self._channel.send(embed=embed)
            else:
                await self._message.edit(embed=embed)

    async def collapse(self, spend: Spend | None, *, carried: bool) -> str:
        """End the run: retire the card, and give back the line that outlives it.

        The lines go because their detail was about watching a run, not about its
        result — what survives them is how much ground the agent covered and what it
        spent. Returns "" when there is nothing worth saying, and on a second call,
        so a failed run can come here before reporting the failure.

        `carried` says the caller has prose to append the line to, which is where it
        belongs: one message in the channel rather than two. Without it the line
        stays in the card's place, for a run whose result is a card and so has no
        subtext line to hold it. Either way the card costs one request — an edit or
        a delete — so the flag chooses how that request is spent, not how many.
        """
        async with self._lock:
            if self._collapsed:
                return ""
            self._collapsed = True
            steps, self._steps = self._steps, []
            card, self._message = self._message, None
            line = (
                progress.summarise(
                    [s.part.tool_name for s in steps],
                    elapsed=time.monotonic() - self._started,
                    spend=spend,
                )
                if steps or spend is not None
                else ""  # nothing was watched and nothing was spent
            )
            await self._retire(card, "" if carried else line)
            return line

    async def _retire(self, card: discord.Message | None, line: str) -> None:
        """Put `line` where the card was, or take the card away if there is none.

        Edited rather than deleted and reposted: the card is already where the
        reader is looking, and one request beats two.
        """
        try:
            if card is None:
                if line:
                    await self._channel.send(f"-# {line}")
            elif line:
                await card.edit(content=f"-# {line}", embed=None)
            else:
                await card.delete()
        except discord.HTTPException:
            log.debug("could not close out the progress card", exc_info=True)
