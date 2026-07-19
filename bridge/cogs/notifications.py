"""Cog: post GitHub webhook events to Discord.

Two destinations per repo: the plain notifications channel (`/map repo`) and an
optional announcements channel (`/map announce`) for the events worth surfacing —
new issues, PRs ready for review, submitted reviews, and the main branch's CI
result. If a repo has no announce channel, announcements fall back to its repo
channel, so a single mapping still gets everything.
"""

from typing import TYPE_CHECKING

import discord
from discord.ext import commands

if TYPE_CHECKING:
    from bridge.bot import BridgeBot


class Notifications(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        bot.webhook.register("issues", self.on_issues)
        bot.webhook.register("pull_request", self.on_pull_request)
        bot.webhook.register("pull_request_review", self.on_review)
        bot.webhook.register("check_suite", self.on_check_suite)

    def _mention(self, github_login: str | None) -> str:
        if not github_login or self.bot.store is None:
            return "someone" if not github_login else f"`{github_login}`"
        discord_id = self.bot.store.discord_id_for(github_login)
        return f"<@{discord_id}>" if discord_id else f"`{github_login}`"

    async def _send(self, channel_id: int | None, message: str) -> None:
        if channel_id is None:
            return
        channel = self.bot.get_channel(channel_id)
        if isinstance(channel, discord.abc.Messageable):
            await channel.send(message)

    async def _announce(self, repo: str, message: str) -> None:
        """Announcements: the announce channel, or the repo channel if unmapped."""
        if self.bot.store is None:
            return
        channel_id = self.bot.store.repo_to_announce.get(
            repo
        ) or self.bot.store.repo_to_channel.get(repo)
        await self._send(channel_id, message)

    async def on_issues(self, payload: dict) -> None:
        if payload.get("action") != "opened":
            return
        issue = payload["issue"]
        repo = payload["repository"]["full_name"]
        author = self._mention(issue["user"]["login"])
        await self._announce(
            repo,
            f"🐛 Issue opened by {author}: **{issue['title']}**\n{issue['html_url']}",
        )

    async def on_pull_request(self, payload: dict) -> None:
        action = payload.get("action")
        pr = payload["pull_request"]
        repo = payload["repository"]["full_name"]

        # "Ready for review" = opened as non-draft, or a draft flipped to ready.
        ready = (action == "opened" and not pr.get("draft")) or (
            action == "ready_for_review"
        )
        if ready:
            author = self._mention(pr["user"]["login"])
            await self._announce(
                repo,
                f"📥 PR ready for review by {author}: **{pr['title']}**\n{pr['html_url']}",
            )

    async def on_review(self, payload: dict) -> None:
        if payload.get("action") != "submitted":
            return
        review = payload["review"]
        pr = payload["pull_request"]
        repo = payload["repository"]["full_name"]
        # Ping the PR author — the review is aimed at them.
        author = self._mention(pr["user"]["login"])
        reviewer = self._mention(review["user"]["login"])
        state = review.get("state", "").lower()
        icon = {"approved": "✅", "changes_requested": "🔴"}.get(state, "💬")
        verb = {
            "approved": "approved",
            "changes_requested": "requested changes on",
        }.get(state, "reviewed")
        await self._announce(
            repo,
            f"{icon} {reviewer} {verb} {author}'s PR **{pr['title']}**\n{pr['html_url']}",
        )

    async def on_check_suite(self, payload: dict) -> None:
        """The aggregate CI result for a commit on the default branch."""
        if payload.get("action") != "completed":
            return
        suite = payload["check_suite"]
        repo = payload["repository"]
        # Only the main line matters here; ignore branch/PR check suites.
        if suite.get("head_branch") != repo.get("default_branch"):
            return

        conclusion = suite.get("conclusion")
        # Only success/failure are worth a line; skip neutral/cancelled/etc.
        if conclusion == "success":
            icon, word = "✅", "passed"
        elif conclusion == "failure":
            icon, word = "❌", "failed"
        else:
            return

        sha = suite.get("head_sha", "")[:7]
        # ponytail: check_suite carries the git commit author (a name, not a
        # GitHub login), so we can't reliably @mention — show the name as text.
        name = (suite.get("head_commit") or {}).get("author", {}).get(
            "name"
        ) or "someone"
        url = f"{repo['html_url']}/commit/{suite.get('head_sha', '')}"
        await self._announce(
            repo["full_name"],
            f"{icon} main checks {word} — `{sha}` by {name}\n{url}",
        )


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Notifications(bot))
