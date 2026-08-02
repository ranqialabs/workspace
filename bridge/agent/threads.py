"""Opening the thread a draft gets reviewed in.

Here rather than in a cog because both ways in need it and neither owns it: a
`/issue` run opens one from the command, and a mention opens one when the agent
decides the request is work rather than a question.

The name matters beyond looking right: every draft thread starts with `PREFIX`,
which is how a thread is recognised as one of ours after a restart — no fetch,
and no state we would have had to keep.
"""

import logging

import discord

log = logging.getLogger(__name__)

PREFIX = "issue"
_KEEP_ALIVE = 1440  # minutes before Discord archives it on its own


def named(title: str) -> str:
    """A draft thread's name, once there is a draft to name it after."""
    return f"{PREFIX}: {title}"[:100]


async def open_for(
    anchor: discord.Message | None,
    author: discord.User | discord.Member,
    channel: discord.abc.Messageable | None = None,
) -> discord.Thread | None:
    """A thread to work in, or None if this channel can't have one.

    Hung off `anchor` when there is one, so the conversation and the issue it
    produced stay visibly connected. Already inside a thread, that thread is the
    answer — nesting isn't a thing Discord does.
    """
    name = f"{PREFIX} · {author.display_name}"[:100]
    where = channel if channel is not None else (anchor.channel if anchor else None)
    try:
        if anchor is not None and isinstance(anchor.channel, discord.TextChannel):
            return await anchor.create_thread(
                name=name, auto_archive_duration=_KEEP_ALIVE
            )
        if isinstance(where, discord.TextChannel):
            return await where.create_thread(
                name=name,
                auto_archive_duration=_KEEP_ALIVE,
                type=discord.ChannelType.public_thread,
            )
        if isinstance(where, discord.Thread):
            return where  # already in a thread; work right here
    except discord.Forbidden, discord.HTTPException:
        log.exception("could not create a draft thread")
    return None


async def rename(thread: discord.Thread, title: str) -> None:
    """Name the thread after its draft, once, and never mind if it fails.

    Once because a rename is a system line in the thread, so re-titling on every
    revision would bury the conversation it is meant to label.
    """
    try:
        await thread.edit(name=named(title))
    except discord.HTTPException:
        log.debug("could not rename draft thread %s", thread.id, exc_info=True)
