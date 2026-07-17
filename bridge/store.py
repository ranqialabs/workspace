"""All mappings, persisted to a single Discord channel.

The channel IS the store. Each mapping is one message, `TYPE key value`, so it
round-trips through channel history. On boot we replay the channel to rebuild
three in-memory dicts; commands append a line and update memory. Later lines win.

ponytail: a channel + three dicts. No database, no disk, no cost. Fine for tens
of entries; revisit with a real store if it ever reaches thousands.
"""

import re

import discord

from bridge.config import CONFIG_CHANNEL_NAME

# `identity itsmeale 123`, `team engineering 456`, `repo owner/name 789`
_LINE = re.compile(r"^(?P<kind>identity|team|repo)\s+(?P<key>\S+)\s+(?P<value>\d+)$")


class Store:
    def __init__(self, channel: discord.abc.Messageable) -> None:
        self._channel = channel
        self.identity: dict[str, int] = {}  # github login (casefold) -> discord id
        self.team_to_role: dict[str, int] = {}  # github team slug -> discord role id
        self.repo_to_channel: dict[str, int] = {}  # "owner/repo" -> discord channel

    async def load(self) -> None:
        """Rebuild the maps by replaying channel history (oldest first)."""
        for d in (self.identity, self.team_to_role, self.repo_to_channel):
            d.clear()
        async for message in self._channel.history(limit=None, oldest_first=True):
            m = _LINE.match(message.content.strip())
            if m:
                self._apply(m["kind"], m["key"], int(m["value"]))

    def _apply(self, kind: str, key: str, value: int) -> None:
        if kind == "identity":
            self.identity[key.casefold()] = value
        elif kind == "team":
            self.team_to_role[key] = value
        elif kind == "repo":
            self.repo_to_channel[key] = value

    async def _persist(self, kind: str, key: str, value: int) -> None:
        await self._channel.send(f"{kind} {key} {value}")
        self._apply(kind, key, value)

    async def link_identity(self, github_login: str, discord_id: int) -> None:
        await self._persist("identity", github_login, discord_id)

    async def map_team(self, team_slug: str, role_id: int) -> None:
        await self._persist("team", team_slug, role_id)

    async def map_repo(self, repo_full_name: str, channel_id: int) -> None:
        await self._persist("repo", repo_full_name, channel_id)

    def discord_id_for(self, github_login: str) -> int | None:
        return self.identity.get(github_login.casefold())


async def find_or_create_config_channel(guild: discord.Guild) -> discord.TextChannel:
    """The #bot-config channel, created (hidden from @everyone) if missing."""
    existing = discord.utils.get(guild.text_channels, name=CONFIG_CHANNEL_NAME)
    if existing is not None:
        return existing
    overwrites: dict[
        discord.Role | discord.Member | discord.Object, discord.PermissionOverwrite
    ] = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False),
    }
    return await guild.create_text_channel(CONFIG_CHANNEL_NAME, overwrites=overwrites)
