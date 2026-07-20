"""One edited-in-place message per entity (issue, deploy).

No in-memory index (that raced webhooks and vanished on restart). Each keyed
message hides its entity key in the embed footer — zero-width, like store.py's
panel marker — so we find it by scanning channel history. The channel is the
truth; a per-key asyncio.Lock serialises locate-then-post against concurrent
aiohttp webhooks.
"""

import asyncio
import datetime as dt

import discord

_TTL = dt.timedelta(seconds=3600)  # edit in place only this long after posting
_SCAN_LIMIT = 50  # messages back to search for an entity's live message

_SENTINEL = "⁣"  # zero-width; marks the start of the encoded key in the footer
_SHIFT = 0xE0000  # tag/PUA plane — codepoints here render as nothing


def _encode_key(key: str) -> str:
    return _SENTINEL + "".join(chr(_SHIFT + ord(c)) for c in key)


def _decode_key(footer_text: str | None) -> str | None:
    if not footer_text or _SENTINEL not in footer_text:
        return None
    encoded = footer_text.split(_SENTINEL, 1)[1]
    return "".join(chr(ord(c) - _SHIFT) for c in encoded)


def stamp(embed: discord.Embed, key: str) -> discord.Embed:
    """Append the invisible entity key to the embed's (visible) footer text."""
    visible = embed.footer.text or ""
    embed.set_footer(text=visible + _encode_key(key), icon_url=embed.footer.icon_url)
    return embed


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
    ) -> None:
        """Edit this entity's fresh live message if it exists, else post one.
        Serialised per key so concurrent webhooks can't both post."""
        stamp(embed, key)
        async with self._lock_for(key):
            existing = await self._locate(channel, key)
            if existing is not None:
                await existing.edit(content=content, embed=embed)
                return
            # send() rejects content=None; pass only what we have.
            await channel.send(content=content or None, embed=embed)

    async def _locate(
        self, channel: discord.TextChannel, key: str
    ) -> discord.Message | None:
        """The fresh live message for this key, found by scanning channel history."""
        cutoff = discord.utils.utcnow() - self._ttl
        me = channel.guild.me
        async for message in channel.history(limit=self._scan_limit):
            if message.created_at < cutoff:
                break  # older than the freshness window; nothing fresh beyond here
            if message.author != me or not message.embeds:
                continue
            if _decode_key(message.embeds[0].footer.text) == key:
                return message
        return None
