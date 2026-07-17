"""Cog: post GitHub webhook events to the repo's Discord channel."""

from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bridge import db

if TYPE_CHECKING:
    from bridge.bot import BridgeBot


class Notifications(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        bot.webhook.register("pull_request", self.on_pull_request)
        bot.webhook.register("issues", self.on_issues)

    def _mention(self, github_login: str | None) -> str:
        if not github_login:
            return "someone"
        discord_id = db.discord_id_for(github_login)
        return f"<@{discord_id}>" if discord_id else f"`{github_login}`"

    async def _post(self, repo_full_name: str, message: str) -> None:
        channel_id = self.bot.config.repo_to_channel.get(repo_full_name)
        if channel_id is None:
            return
        channel = self.bot.get_channel(channel_id)
        if isinstance(channel, discord.abc.Messageable):
            await channel.send(message)

    async def on_pull_request(self, payload: dict) -> None:
        action = payload.get("action")
        pr = payload["pull_request"]
        repo = payload["repository"]["full_name"]

        if action == "opened":
            author = self._mention(pr["user"]["login"])
            await self._post(
                repo, f"📥 PR opened by {author}: **{pr['title']}**\n{pr['html_url']}"
            )
        elif action == "review_requested":
            reviewer = payload.get("requested_reviewer", {}).get("login")
            await self._post(
                repo,
                f"👀 {self._mention(reviewer)} — review requested on "
                f"**{pr['title']}**\n{pr['html_url']}",
            )

    async def on_issues(self, payload: dict) -> None:
        if payload.get("action") != "opened":
            return
        issue = payload["issue"]
        repo = payload["repository"]["full_name"]
        author = self._mention(issue["user"]["login"])
        await self._post(
            repo,
            f"🐛 Issue opened by {author}: **{issue['title']}**\n{issue['html_url']}",
        )


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Notifications(bot))
