"""The dedup invariant: one live message per entity, under concurrency and restart.

Uses a FakeChannel (in-memory message list) so no Discord connection is needed.
The `send` coroutine yields control (`asyncio.sleep(0)`) to force the interleaving
that used to cause duplicates.
"""

import asyncio
import datetime as dt
from typing import Any

import discord
import pytest

from bridge.live import LiveMessages, _decode_key, stamp


class FakeMessage:
    def __init__(self, channel, author, embed, content, created_at):
        self.channel = channel
        self.author = author
        self.embeds = [embed] if embed else []
        self.content = content
        self.created_at = created_at
        self.edits = 0

    async def edit(self, *, content=None, embed=None):
        self.content = content
        self.embeds = [embed] if embed else []
        self.edits += 1


class FakeChannel:
    """Minimal stand-in for discord.TextChannel: send + history + guild.me."""

    def __init__(self):
        self.me = object()
        self.guild = type("G", (), {"me": self.me})()
        self.messages: list[FakeMessage] = []

    async def send(self, *, content=None, embed=None):
        await asyncio.sleep(0)  # force interleaving between concurrent publishers
        msg = FakeMessage(self, self.me, embed, content, discord.utils.utcnow())
        self.messages.append(msg)
        return msg

    async def history(self, *, limit):
        # newest first, like discord.py
        for msg in reversed(self.messages[-limit:]):
            yield msg


def _embed():
    return discord.Embed(title="issue #1").set_footer(text="owner/repo")


def test_marker_roundtrip_is_invisible():
    footer = stamp(_embed(), "issue:owner/repo:1").footer.text
    assert _decode_key(footer) == "issue:owner/repo:1"
    assert footer is not None and footer.startswith("owner/repo")  # visible untouched


@pytest.mark.asyncio
async def test_second_event_edits_not_duplicates():
    ch: Any = FakeChannel()
    live = LiveMessages()
    await live.publish(ch, "issue:owner/repo:1", None, _embed())
    await live.publish(ch, "issue:owner/repo:1", "ping", _embed())
    assert len(ch.messages) == 1
    assert ch.messages[0].edits == 1


@pytest.mark.asyncio
async def test_concurrent_events_same_entity_post_once():
    """The money test: two racing webhooks for one issue -> one message."""
    ch: Any = FakeChannel()
    live = LiveMessages()
    key = "issue:owner/repo:1"
    await asyncio.gather(
        live.publish(ch, key, None, _embed()),
        live.publish(ch, key, "ping", _embed()),
    )
    assert len(ch.messages) == 1  # without the per-key lock this is 2


@pytest.mark.asyncio
async def test_different_entities_get_their_own_message():
    ch: Any = FakeChannel()
    live = LiveMessages()
    await live.publish(ch, "issue:owner/repo:1", None, _embed())
    await live.publish(ch, "issue:owner/repo:2", None, _embed())
    assert len(ch.messages) == 2


@pytest.mark.asyncio
async def test_survives_restart_via_channel_scan():
    """A fresh LiveMessages (empty state) still finds the live message in the channel."""
    ch: Any = FakeChannel()
    await LiveMessages().publish(ch, "issue:owner/repo:1", None, _embed())
    # simulate a restart: brand-new instance, no memory of the prior post
    await LiveMessages().publish(ch, "issue:owner/repo:1", "update", _embed())
    assert len(ch.messages) == 1
    assert ch.messages[0].edits == 1


@pytest.mark.asyncio
async def test_stale_message_posts_anew():
    ch: Any = FakeChannel()
    live = LiveMessages(ttl=dt.timedelta(seconds=1))
    await live.publish(ch, "issue:owner/repo:1", None, _embed())
    # backdate the existing message past the TTL window
    ch.messages[0].created_at = discord.utils.utcnow() - dt.timedelta(hours=2)
    await live.publish(ch, "issue:owner/repo:1", "update", _embed())
    assert len(ch.messages) == 2  # too old to edit -> fresh post
