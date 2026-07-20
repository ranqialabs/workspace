"""Cog: route rendered GitHub events (render.py) to repo channels, deduping keyed
ones via live.py. Uses the announce channel if mapped, else the plain repo one."""

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
    "deployment_status",
)


class Notifications(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        for event in _EVENTS:
            bot.webhook.register(event, self._event_handler(event))

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

    # --- routing ---

    def _event_handler(self, event: str):
        async def handler(payload: dict) -> None:
            rendered = render.render(event, payload, self)
            if rendered is not None:
                await self._route(payload["repository"]["full_name"], rendered)

        return handler

    async def _route(self, repo: str, rendered: render.Rendered) -> None:
        """Send to the repo's (announce or plain) channel; edit in place if keyed."""
        if self.bot.store is None:
            return
        channel_id = self.bot.store.repo_to_announce.get(
            repo
        ) or self.bot.store.repo_to_channel.get(repo)
        channel = self.bot.get_channel(channel_id) if channel_id else None
        if not isinstance(channel, discord.TextChannel):
            return

        # Every render carries an embed; keyed ones (issue/deploy) get edited in place.
        if rendered.embed is None:
            return
        if rendered.key is not None:
            await self.bot.live.publish(
                channel, rendered.key, rendered.content, rendered.embed
            )
        else:
            await channel.send(content=rendered.content, embed=rendered.embed)


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Notifications(bot))
