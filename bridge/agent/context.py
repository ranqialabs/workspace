"""Discord conversation -> transcript the model can read.

Attachments come back as bytes, not CDN links: Discord signs its URLs with an
expiry, so handing one to the model's fetcher works until it silently doesn't.

No LLM and no Discord writes here — that keeps this module testable without
either, which matters in a repo with no test suite.
"""

import asyncio
import re
from dataclasses import dataclass, field

import discord

from bridge.store import Store

_LINK = re.compile(r"https://(?:\w+\.)?discord\.com/channels/(\d+)/(\d+)/(\d+)")

_MAX_MESSAGES = 100  # also Discord's page size, so one fetch covers the cap
_MAX_TRANSCRIPT = 200_000  # chars of conversation we send to the model
_MAX_IMAGE = 4 * 1024 * 1024  # skip anything bigger; the model won't need it
_MAX_TEXT_ATTACHMENT = 100_000  # chars per text/log file


@dataclass
class Transcript:
    """A conversation, flattened for the model."""

    text: str
    images: list[tuple[bytes, str]] = field(default_factory=list)  # (data, media_type)
    jump_url: str | None = None  # the anchor message, linked from the issue body

    def is_empty(self) -> bool:
        return not self.text.strip() and not self.images


async def resolve_message(guild: discord.Guild, link: str) -> discord.Message | None:
    """Fetch the message a link points at, or None if it isn't reachable."""
    m = _LINK.search(link.strip())
    if m is None:
        return None
    guild_id, channel_id, message_id = (int(g) for g in m.groups())
    if guild_id != guild.id:
        return None  # another server; we have no business reading it
    # get_channel_or_thread, not get_channel — links into threads are common and
    # get_channel returns None for them.
    channel = guild.get_channel_or_thread(channel_id)
    if not isinstance(channel, discord.abc.Messageable):
        return None
    try:
        return await channel.fetch_message(message_id)
    except discord.NotFound, discord.Forbidden:
        return None


def speaker(user: discord.User | discord.Member, login: str | None) -> str:
    """How a person is named to the model, wherever they turn up.

    One formatter on purpose: the prompt tells the agent that the requester is
    the person it's talking to, and it can only match them to their lines in the
    transcript if both are written the same way.
    """
    return f"{user.display_name} (@{login})" if login else user.display_name


async def _attachments(
    message: discord.Message,
) -> tuple[list[str], list[tuple[bytes, str]]]:
    """Text attachments inlined, image attachments as bytes."""
    notes: list[str] = []
    images: list[tuple[bytes, str]] = []
    for a in message.attachments:
        kind = a.content_type or ""
        if kind.startswith("image/"):
            if a.size <= _MAX_IMAGE:
                images.append((await a.read(), kind.split(";")[0]))
            else:
                notes.append(f"[image too large to read: {a.filename}]")
        elif kind.startswith("text/") or kind.startswith("application/json"):
            text = (await a.read()).decode("utf-8", "replace")
            body = text[:_MAX_TEXT_ATTACHMENT]
            # Say so in-band: a model that can't see the cut will answer from the
            # part it got as though that were the whole file.
            cut = (
                f"\n[...truncated: {len(text)} chars total, first "
                f"{_MAX_TEXT_ATTACHMENT} shown]"
                if len(text) > _MAX_TEXT_ATTACHMENT
                else ""
            )
            notes.append(f"<file name={a.filename}>\n{body}{cut}\n</file>")
        else:
            notes.append(f"[attachment: {a.filename} ({kind or 'unknown type'})]")
    return notes, images


async def read_back(
    channel: discord.abc.Messageable,
    store: Store,
    *,
    limit: int,
    before: int | discord.Message | None = None,
) -> str:
    """The `limit` human messages before `before`, oldest first, as plain text.

    What `read_conversation` is: the agent arrives with a small seed and decides
    for itself how far back it has to read to know what "isso" refers to. Text
    rather than a `Transcript` because this answers a tool call — attachments and
    images belong to the seed, which is built once and sent with the prompt.
    """
    limit = max(1, min(limit, _MAX_MESSAGES))
    collected: list[discord.Message] = []
    # A snowflake works as well as a message here, which is what lets a thread
    # read the channel it hangs off from its own id.
    cutoff = (
        discord.Object(id=before)
        if isinstance(before, int)
        else before  # a Message, or None for "from the newest"
    )
    async for message in channel.history(
        limit=min(limit * 2, _MAX_MESSAGES), before=cutoff
    ):
        if message.author.bot or not message.content.strip():
            continue
        collected.append(message)
        if len(collected) >= limit:
            break
    collected.reverse()  # history() is newest-first; flip to reading order

    lines = [
        f"{speaker(m.author, store.login_for(m.author.id))}: {m.content}"
        for m in collected
    ]
    text = "\n\n".join(lines)
    if len(text) > _MAX_TRANSCRIPT:
        text = "[...earlier messages trimmed...]\n\n" + text[-_MAX_TRANSCRIPT:]
    return text


async def collect(
    channel: discord.abc.Messageable,
    store: Store,
    *,
    limit: int,
    anchor: discord.Message | None = None,
) -> Transcript:
    """Human messages, oldest first.

    From `anchor` onwards when there is one — pointing at where a discussion
    started beats counting how many messages it ran for. Otherwise the last
    `limit` messages in the channel.

    Bots are skipped — otherwise the bridge's own notification cards read as
    conversation and the model drafts issues about them.
    """
    limit = max(1, min(limit, _MAX_MESSAGES))
    collected: list[discord.Message] = []
    if anchor is not None:
        collected.append(anchor)
    async for message in channel.history(
        # Headroom for the bots we drop, capped at one page — a second costs a
        # round trip for messages we'd discard anyway.
        limit=min(limit * 2, _MAX_MESSAGES),
        after=anchor.created_at if anchor else None,
    ):
        if message.author.bot:
            continue
        collected.append(message)
        if len(collected) >= limit:
            break
    if anchor is None:
        collected.reverse()  # no anchor means newest-first; flip to reading order

    # Every attachment is a separate CDN round trip; serially they dominate the
    # wait before the model even starts.
    fetched = await asyncio.gather(*(_attachments(m) for m in collected))

    lines: list[str] = []
    images: list[tuple[bytes, str]] = []
    for message, (notes, imgs) in zip(collected, fetched, strict=True):
        images.extend(imgs)
        body = "\n".join(filter(None, [message.content, *notes]))
        if body.strip():
            login = store.login_for(message.author.id)
            lines.append(f"{speaker(message.author, login)}: {body}")

    text = "\n\n".join(lines)
    if len(text) > _MAX_TRANSCRIPT:
        if anchor is not None:  # the anchor is the point; keep it, drop the tail
            text = text[:_MAX_TRANSCRIPT] + "\n\n[...later messages trimmed...]"
        else:  # no anchor, so the recent turns are what matter
            text = "[...earlier messages trimmed...]\n\n" + text[-_MAX_TRANSCRIPT:]

    linked = anchor or (collected[-1] if collected else None)
    return Transcript(
        text=text, images=images, jump_url=linked.jump_url if linked else None
    )
