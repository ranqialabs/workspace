"""Cog: post GitHub webhook events to Discord.

This cog owns the plumbing — registering webhook events, resolving mentions from
the store, and sending to the right channel. What each message *looks like* lives
in bridge/render.py (pure functions, one per event).

Two destinations per repo: the plain notifications channel (`/map repo`) and an
optional announcements channel (`/map announce`). If a repo has no announce
channel, everything falls back to its repo channel.
"""

from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bridge import render

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

# Events we render; each is registered to the same generic handler.
_EVENTS = ("issues", "pull_request", "pull_request_review", "check_suite")


class Notifications(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
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
        """Send to the announce channel, or the repo channel if unmapped."""
        if self.bot.store is None:
            return
        channel_id = self.bot.store.repo_to_announce.get(
            repo
        ) or self.bot.store.repo_to_channel.get(repo)
        if channel_id is None:
            return
        channel = self.bot.get_channel(channel_id)
        if not isinstance(channel, discord.abc.Messageable):
            return
        # send() rejects embed=None, so only pass what we have.
        kwargs: dict = {}
        if rendered.content is not None:
            kwargs["content"] = rendered.content
        if rendered.embed is not None:
            kwargs["embed"] = rendered.embed
        if kwargs:
            await channel.send(**kwargs)


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Notifications(bot))
