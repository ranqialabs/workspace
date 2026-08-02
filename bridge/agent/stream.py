"""An answer arriving token by token, into a Discord message.

Discord has no streaming: the only way to show text as it's written is to edit
the same message repeatedly. Edits are bucketed per channel at roughly 5 per 5s,
and discord.py *queues* on the bucket rather than raising, so overrunning doesn't
fail loudly — it makes every later edit late, including the ones after the run,
and the live effect it was meant to create disappears.

So the model's chunks and Discord's edits are deliberately decoupled: deltas are
accumulated as fast as they arrive, and the message is edited on a wall-clock
floor. The final text is always written, whatever the clock says, so a stream
that ends mid-window still lands complete.
"""

import logging
import time

import discord

log = logging.getLogger(__name__)

# Seconds between edits; ~4 per 5s, inside Discord's bucket. Shared with
# `workspace`, which paces its progress card by the same floor: the card and the
# answer streaming under it spend one channel's edit budget between them.
EDIT_EVERY = 1.2
_MAX_MESSAGE = 2000  # Discord's own ceiling on message content
_CUT = "\n-# ...(truncated)"


def clip(text: str) -> str:
    """`text` inside Discord's message ceiling, saying so when it was cut."""
    if len(text) <= _MAX_MESSAGE:
        return text
    return text[: _MAX_MESSAGE - len(_CUT)] + _CUT


class Live:
    """One message being written into as an answer streams.

    Fed whole snapshots rather than deltas, because a Discord edit replaces the
    message: the answer so far is exactly what an edit needs, and accumulating
    deltas ourselves would only be a second copy to keep in step. Never raises —
    a dropped frame costs one repaint, and a failed repaint must not take the run
    down with it.
    """

    def __init__(self, message: discord.Message) -> None:
        self._message = message
        self._text = ""
        # The placeholder is already on screen, so hold the floor before the
        # first repaint rather than spending an edit on the first snapshot.
        self._last = time.monotonic()
        self._shown = ""

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
        body = clip(text)
        if body == self._shown and not force:
            return  # nothing new to show; don't spend an edit saying so
        self._last = time.monotonic()
        self._shown = body
        try:
            await self._message.edit(content=body, embed=None)
        except discord.HTTPException:
            log.debug("could not repaint the streaming answer", exc_info=True)
