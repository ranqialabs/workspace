"""An answer arriving token by token, into Discord messages.

Discord has no streaming: the only way to show text as it's written is to edit
the same message repeatedly. Edits are bucketed per channel at roughly 5 per 5s,
and discord.py *queues* on the bucket rather than raising, so overrunning doesn't
fail loudly — it makes every later edit late, including the ones after the run,
and the live effect it was meant to create disappears.

So the model's chunks and Discord's edits are deliberately decoupled: deltas are
accumulated as fast as they arrive, and the message is edited on a wall-clock
floor. The final text is always written, whatever the clock says, so a stream
that ends mid-window still lands complete.

An answer can also outgrow the 2.000-char ceiling, so a `Live` is a run of
messages: the last is being written into, the ones before it are sealed. Sealing
is one-way, so a boundary already on screen never moves under the reader and a
spill costs one send rather than a repaint of everything above it.
"""

import logging
import time

import discord

log = logging.getLogger(__name__)

# Seconds between edits; ~4 per 5s, inside Discord's bucket. Shared with
# `workspace`, which paces its progress card by the same floor: the card and the
# answer streaming under it spend one channel's edit budget between them.
EDIT_EVERY = 1.2
MAX_MESSAGE = 2000  # Discord's own ceiling on message content
# How far back a break may be looked for before taking the hard cut instead: far
# enough to clear a paragraph, short enough that unbroken text (a base64 blob, a
# wide table) doesn't leave most of a message empty.
_LOOKBACK = 400
_BREAKS = ("\n\n", "\n", " ")  # widest first
_OPENING = "-# ..."  # what a spilled message says until the same paint fills it


def segments(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """`text` cut into pieces that each fit `limit`, at natural breaks.

    A split, not a clip: the whole text survives. Empty text gives no segments,
    so a caller with nothing to say sends nothing rather than an empty message
    Discord would reject.
    """
    rest = text.strip()
    out: list[str] = []
    while len(rest) > limit:
        cut = _break_at(rest, limit)
        out.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        out.append(rest)
    return out


def _break_at(text: str, limit: int) -> int:
    """Where to cut `text` so the first piece fits `limit`, preferring prose."""
    window = text[:limit]
    for mark in _BREAKS:
        cut = window.rfind(mark)
        if cut > limit - _LOOKBACK:
            return cut + len(mark)
    return limit  # unbroken text: cut at the ceiling rather than not at all


class Live:
    """An answer being written into Discord as it streams.

    Fed whole snapshots rather than deltas, because a Discord edit replaces the
    message: the answer so far is exactly what an edit needs, and accumulating
    deltas ourselves would only be a second copy to keep in step. Never raises —
    a dropped frame costs one repaint, and a failed repaint must not take the run
    down with it.

    `_sealed` is the text the closed messages carry between them: an answer is
    only appended to, so that prefix is settled and only the tail is repainted.
    """

    def __init__(self, message: discord.Message) -> None:
        self._written = [message]
        self._text = ""
        # The placeholder is already on screen, so hold the floor before the
        # first repaint rather than spending an edit on the first snapshot.
        self._last = time.monotonic()
        self._shown = ""
        self._sealed = ""
        self._closed = 0  # messages sealed, so `_written[_closed]` is the open one

    async def feed(self, answer: str) -> None:
        """Take the answer so far, and repaint if the floor has passed."""
        self._text = answer
        if time.monotonic() - self._last < EDIT_EVERY:
            return
        await self._paint(self._text)

    async def finish(self, text: str | None = None) -> str:
        """Write the final text, whatever the clock says, and return it.

        `text` overrides the last snapshot, so the caller can show the validated
        output rather than whatever the stream happened to end on.
        """
        final = text if text is not None else self._text
        self._text = final
        # A run that produced no text at all still has to say something: an empty
        # edit is rejected by Discord, and a bare placeholder reads as a hang.
        await self._paint(final.strip() or "(no answer)", force=True)
        return final

    async def _paint(self, text: str, *, force: bool = False) -> None:
        """Show `text`, spilling into further messages where it doesn't fit.

        The validated text `finish` paints can differ from what streamed, so the
        sealed prefix is trusted only while the new text still starts with it;
        when it doesn't, the run is rewritten from the top.
        """
        if not text.startswith(self._sealed):
            self._sealed = ""
            self._shown = ""
            self._closed = 0
        body = text[len(self._sealed) :].strip()
        while len(body) > MAX_MESSAGE:
            head = body[: _break_at(body, MAX_MESSAGE)]
            if not await self._seal(head.rstrip()):
                return  # the spill failed; keep what's on screen over a bad cut
            body = body[len(head) :].lstrip()
        if body == self._shown and not force:
            return  # nothing new to show; don't spend an edit saying so
        self._last = time.monotonic()
        self._shown = body
        await self._edit(self._written[self._closed], body)
        await self._retire()

    async def _retire(self) -> None:
        """Drop messages left over from a longer answer this one replaced."""
        while len(self._written) > self._closed + 1:
            stale = self._written.pop()
            try:
                await stale.delete()
            except discord.HTTPException:
                log.debug("could not drop a superseded answer message")
                self._written.append(stale)
                return

    async def _seal(self, head: str) -> bool:
        """Close the open message off at `head` and open the next one.

        Refills a message already written before sending a new one, so a repaint
        after a diverging `finish` reuses the run instead of piling up below it.
        """
        await self._edit(self._written[self._closed], head)
        self._sealed += head
        self._shown = ""
        self._last = time.monotonic()
        self._closed += 1
        if self._closed < len(self._written):
            return True  # a message from an earlier paint is free to take the rest
        previous = self._written[-1]
        try:
            # A reply rather than a send: `history.rebuild_chain` walks these
            # references, and a tail floating free would break the chain right
            # where someone is most likely to reply — the last thing we said.
            self._written.append(await previous.reply(_OPENING, mention_author=False))
        except discord.HTTPException:
            log.debug("could not open a message for the rest of the answer")
            self._closed -= 1
            return False
        return True

    async def _edit(self, message: discord.Message, body: str) -> None:
        try:
            await message.edit(content=body, embed=None)
        except discord.HTTPException:
            log.debug("could not repaint the streaming answer", exc_info=True)
