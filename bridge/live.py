"""One edited-in-place message per entity (issue, deploy, a commit's pipeline).

No in-memory index (that raced webhooks and vanished on restart). Each keyed
message hides its entity key in the embed footer — zero-width, like store.py's
panel marker — so we find it by scanning channel history. The channel is the
truth; a per-key asyncio.Lock serialises locate-then-post against concurrent
aiohttp webhooks.

An entity whose state *replaces* what came before (an issue) publishes plainly.
One that *accumulates* names how it folds (`render.Merge`): a commit's checks and
deploys grow a line per step, a reviewer's comments add up to a count.
"""

import asyncio
import datetime as dt
from collections.abc import Callable

import discord

from bridge.render import (
    BLUE,
    FAILED,
    GREEN,
    PASSED,
    RED,
    RUNNING,
    Merge,
    decode,
    encode,
    headlined,
    merge_review,
    merge_step_name,
    step_key,
)

_TTL = dt.timedelta(seconds=3600)  # edit in place only this long after posting
_SCAN_LIMIT = 50  # messages back to search for an entity's live message
# How long a merging card keeps absorbing steps. A push's checks and deploys land
# within a couple of minutes; past this the next step starts a fresh card rather
# than reopening one you've already scrolled past and read as finished.
_MERGE_WINDOW = dt.timedelta(minutes=10)


def stamp(embed: discord.Embed, payload: str) -> discord.Embed:
    """Hide `payload` after the embed's visible footer text."""
    visible = embed.footer.text or ""
    embed.set_footer(text=visible + encode(payload), icon_url=embed.footer.icon_url)
    return embed


def merge_into(into: discord.Embed, previous: discord.Embed) -> discord.Embed:
    """Fold `previous`'s steps into `into`, oldest first and without duplicating.

    A step's key identifies it, so one reporting again (queued, then deployed)
    overwrites its own line and keeps its place. `into` holds the newest step, so
    its fields win on a clash — except its headline, which it keeps only if it
    brought one, since not every event knows what the commit was called.
    """
    if headlined(previous) and not headlined(into):
        into.title, into.description = previous.title, previous.description
    fresh = {step_key(f.name or ""): f for f in into.fields}
    into.clear_fields()
    for field in previous.fields:
        newer = fresh.pop(step_key(field.name or ""), field)
        name = merge_step_name(newer.name or "", field.name or "")
        into.add_field(name=name, value=newer.value, inline=newer.inline)
    for field in fresh.values():  # steps not on the previous card, in arrival order
        into.add_field(name=field.name, value=field.value, inline=field.inline)
    _reverdict(into)
    return into


def _reverdict(card: discord.Embed) -> None:
    """Colour and headline the card from the steps it now carries.

    Read off the merged list, not carried forward, so a re-run that turns its own
    failed step green clears the red — while a failure still standing keeps the
    card red however many later steps pass.
    """
    icons = [(field.value or " ")[0] for field in card.fields]
    if FAILED in icons:
        icon, color = FAILED, RED
    elif RUNNING in icons:
        icon, color = RUNNING, BLUE
    else:
        icon, color = PASSED, GREEN
    card.color = discord.Color(color)
    # The headline leads with the same icon, so restate it from the whole card
    # rather than leaving the last step's verdict standing for all of them.
    if (author := card.author.name) and author[0] in (PASSED, FAILED, RUNNING):
        card.set_author(name=icon + author[1:], url=card.author.url)


_FOLD: dict[Merge, Callable[[discord.Embed, discord.Embed], discord.Embed]] = {
    Merge.PIPELINE: merge_into,
    Merge.REVIEW: merge_review,
}


class LiveMessages:
    def __init__(self, ttl: dt.timedelta = _TTL, scan_limit: int = _SCAN_LIMIT) -> None:
        self._ttl = ttl
        self._scan_limit = scan_limit
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    async def publish(
        self,
        channel: discord.TextChannel,
        key: str,
        content: str | None,
        embed: discord.Embed,
        *,
        merge: Merge = Merge.NONE,
    ) -> None:
        """Edit this entity's fresh live message if it exists, else post one.
        Serialised per key so concurrent webhooks can't both post.

        A merging `merge` keeps what the live message already summarised instead of
        replacing it, each kind in its own way (`_FOLD`) — and only looks back
        `_MERGE_WINDOW`, so a finished card isn't reopened much later.
        """
        stamp(embed, key)
        fold = _FOLD.get(merge)
        async with self._lock_for(key):
            ttl = min(self._ttl, _MERGE_WINDOW) if fold else self._ttl
            existing = await self._locate(channel, key, ttl)
            if existing is not None:
                if fold and existing.embeds:
                    fold(embed, existing.embeds[0])
                await existing.edit(content=content, embed=embed)
                return
            # send() rejects content=None; pass only what we have.
            await channel.send(content=content or None, embed=embed)

    async def _locate(
        self, channel: discord.TextChannel, key: str, ttl: dt.timedelta | None = None
    ) -> discord.Message | None:
        """The fresh live message for this key, found by scanning channel history."""
        cutoff = discord.utils.utcnow() - (ttl or self._ttl)
        me = channel.guild.me
        async for message in channel.history(limit=self._scan_limit):
            if message.created_at < cutoff:
                break  # older than the freshness window; nothing fresh beyond here
            if message.author != me or not message.embeds:
                continue
            if decode(message.embeds[0].footer.text) == key:
                return message
        return None
