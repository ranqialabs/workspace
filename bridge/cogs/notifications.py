"""Cog: post GitHub webhook events to Discord.

This cog owns the plumbing — registering webhook events, resolving mentions from
the store, and sending to the right channel. What each message *looks like* lives
in bridge/render.py (pure functions, one per event).

Two destinations per repo: the plain notifications channel (`/map repo`) and an
optional announcements channel (`/map announce`). If a repo has no announce
channel, everything falls back to its repo channel.
"""

import time
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bridge import render

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

# Events we render; each is registered to the same generic handler.
_EVENTS = (
    "issues",
    "pull_request",
    "pull_request_review",
    "check_suite",
    "status",
    "deployment_status",
)

# A live message (issue/deploy) is edited in place only while it's still fresh:
# recent and still the last thing in the channel. Older than this → post anew.
_LIVE_TTL_SECONDS = 3600


class Notifications(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        # entity key -> (channel_id, message_id, last_touch_epoch). In memory only:
        # losing it on restart just means the next update posts a fresh message,
        # which is the same fallback we want when a message goes stale anyway.
        self._live: dict[str, tuple[int, int, float]] = {}
        for event in _EVENTS:
            bot.webhook.register(event, self._make_handler(event))

    # --- Mentions protocol (render.py calls back into these) ---

    def user(self, github_login: str | None) -> str:
        if not github_login or self.bot.store is None:
            return "someone" if not github_login else f"`{github_login}`"
        discord_id = self.bot.store.discord_id_for(github_login)
        return f"<@{discord_id}>" if discord_id else f"`{github_login}`"

    def role(self, repo_full_name: str) -> str | None:
        """The `@<repo> devs` role mention, if that repo has an access role."""
        if self.bot.store is None:
            return None
        role_id = self.bot.store.repo_to_role.get(repo_full_name)
        return f"<@&{role_id}>" if role_id else None

    # --- routing & sending ---

    def _make_handler(self, event: str):
        async def handler(payload: dict) -> None:
            result = render.render(event, payload, self)
            if result is None:
                return
            await self._announce(payload["repository"]["full_name"], result)

        return handler

    async def _announce(self, repo: str, rendered: render.Rendered) -> None:
        """Post the message, or edit the entity's live one if it's still fresh."""
        if self.bot.store is None:
            return
        channel_id = self.bot.store.repo_to_announce.get(
            repo
        ) or self.bot.store.repo_to_channel.get(repo)
        if channel_id is None:
            return
        channel = self.bot.get_channel(channel_id)
        if not isinstance(channel, discord.TextChannel):
            return

        if rendered.key and await self._try_edit(channel, rendered):
            return
        message = await self._send(channel, rendered)
        if message is not None and rendered.key is not None:
            self._live[rendered.key] = (channel.id, message.id, time.time())

    async def _try_edit(
        self, channel: discord.TextChannel, rendered: render.Rendered
    ) -> bool:
        """Edit the live message for this key if it's fresh and still the last
        message in the channel. Returns True if it did; False to post anew."""
        assert rendered.key is not None
        live = self._live.get(rendered.key)
        if live is None:
            return False
        chan_id, message_id, touched = live
        if chan_id != channel.id or time.time() - touched > _LIVE_TTL_SECONDS:
            return False
        if channel.last_message_id != message_id:
            return False  # someone spoke after it — don't reach back up
        try:
            await channel.get_partial_message(message_id).edit(
                content=rendered.content, embed=rendered.embed
            )
        except discord.HTTPException:
            return False  # deleted/unreachable — fall through to a fresh post
        self._live[rendered.key] = (chan_id, message_id, time.time())
        return True

    @staticmethod
    async def _send(
        channel: discord.TextChannel, rendered: render.Rendered
    ) -> discord.Message | None:
        # send() rejects embed=None, so only pass what we have.
        kwargs: dict = {}
        if rendered.content is not None:
            kwargs["content"] = rendered.content
        if rendered.embed is not None:
            kwargs["embed"] = rendered.embed
        return await channel.send(**kwargs) if kwargs else None


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Notifications(bot))
