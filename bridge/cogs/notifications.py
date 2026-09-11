"""Cog: route rendered GitHub events (render.py) to repo channels, deduping keyed
ones via live.py. Uses the announce channel if mapped, else the plain repo one."""

import logging
from typing import TYPE_CHECKING

import discord
from discord.ext import commands
from githubkit.exception import GitHubException

from bridge import render

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

log = logging.getLogger(__name__)

# The commit each sha names — what it was called and who wrote it — newest last. One
# commit is reported by a deploy and by each job it ran, and they all want the same
# names on the card.
_COMMITS_KEPT = 32


class Notifications(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        self._commits: dict[tuple[str, str], dict] = {}
        # Whatever render.py knows how to draw, we listen for — registering a
        # renderer is the whole of adding an event, with no second list to match.
        for event in render.RENDERERS:
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
            await self._resolve_commit(event, payload)
            rendered = render.render(event, payload, self)
            if rendered is not None:
                await self.route(payload["repository"]["full_name"], rendered)

        return handler

    async def _resolve_commit(self, event: str, payload: dict) -> None:
        """Attach the commit's message and author when the webhook didn't carry them, so
        the card says what shipped and who shipped it rather than `1ab46d1 on main`."""
        sha = render.pipeline_sha(event, payload)
        full_name = (payload.get("repository") or {}).get("full_name") or ""
        if render.commit_message(payload) or not sha or "/" not in full_name:
            return
        github = self.bot.github
        if github is None:
            return
        head = self._commits.get((full_name, sha))
        if head is None:
            owner, name = full_name.split("/", 1)
            try:
                resp = await github.rest.repos.async_get_commit(owner, name, sha)
            except GitHubException as exc:
                # The card still publishes, leading with the sha; see _pipeline_card.
                log.warning(
                    "could not resolve commit %s in %s: %s", sha[:7], full_name, exc
                )
                return
            commit = resp.parsed_data.commit
            user, git_author = resp.parsed_data.author, commit.author
            head = {
                "message": commit.message,
                # The login can be @mentioned; the git name is all a commit has when
                # its author has no account behind that email.
                "author": {
                    "name": git_author.name if git_author else None,
                    "login": user.login if user else None,
                },
            }
            self._commits[(full_name, sha)] = head
            if len(self._commits) > _COMMITS_KEPT:
                del self._commits[next(iter(self._commits))]
        payload["head_commit"] = head

    async def route(self, repo: str, rendered: render.Rendered) -> None:
        """Send to the repo's (announce or plain) channel; edit in place if keyed."""
        if self.bot.store is None:
            return
        channel_id = self.bot.store.channel_for(repo)
        channel = self.bot.get_channel(channel_id) if channel_id else None
        if not isinstance(channel, discord.TextChannel):
            return

        # Every render carries an embed; keyed ones (issue, a commit's pipeline) get
        # edited in place — merging ones adding a line rather than replacing the card.
        if rendered.embed is None:
            return
        if rendered.key is not None:
            await self.bot.live.publish(
                channel,
                rendered.key,
                rendered.content,
                rendered.embed,
                merge=rendered.merge,
            )
        else:
            await channel.send(content=rendered.content, embed=rendered.embed)


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Notifications(bot))
