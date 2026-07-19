"""All mappings, persisted to a single Discord channel.

The channel IS the store. Each mapping is one message, `kind [key](url) <mention>`
— human-readable and clickable, yet still machine-parseable (see `_LINE`) — so it
round-trips through channel history. On boot we replay the channel to rebuild
three in-memory dicts; commands append a line and update memory. Later lines win.

ponytail: a channel + three dicts. No database, no disk, no cost. Fine for tens
of entries; revisit with a real store if it ever reaches thousands.
"""

import re

import discord

from bridge.config import CONFIG_CHANNEL_NAME

# Lines are human-readable: the key is a markdown link, the value a Discord
# mention — both clickable in #bot-config. We parse the label out of `[label](…)`
# and the snowflake out of the mention (`<@id>`, `<#id>`, or `<@&id>`; the kind
# says which). Examples:
#   identity [octocat](https://github.com/octocat) <@123>
#   repo [owner/name](https://github.com/owner/name) <#789>
#   announce [owner/name](https://github.com/owner/name) <#790>
#   access [owner/name](https://github.com/owner/name) <@&456>
_LINE = re.compile(
    r"^(?P<kind>identity|repo|announce|access)\s+"
    r"\[(?P<key>[^\]]+)\]\([^)]*\)\s+"
    r"<(?:@&|@|#)(?P<value>\d+)>$"
)
# Legacy plain form (`kind key 123`) — still parsed, then rewritten to the rich
# form on load so old #bot-config history migrates itself.
_LEGACY = re.compile(
    r"^(?P<kind>identity|repo|announce|access)\s+(?P<key>\S+)\s+(?P<value>\d+)$"
)


# Marks the bot's own live status panel so we can find and edit it instead of
# posting a new one each time (no flooding).
_PANEL_MARKER = "​"  # zero-width space in the embed footer


class Store:
    def __init__(self, channel: discord.TextChannel) -> None:
        self._channel = channel
        self.identity: dict[str, int] = {}  # github login (casefold) -> discord id
        self.repo_to_channel: dict[str, int] = {}  # "owner/repo" -> discord channel
        self.repo_to_announce: dict[str, int] = {}  # "owner/repo" -> announce chan
        self.repo_to_role: dict[str, int] = {}  # "owner/repo" -> access role id
        # (kind, key) -> the message that persists it, so we can delete it
        self._messages: dict[tuple[str, str], discord.Message] = {}
        self._panel: discord.Message | None = None  # the live config panel

    async def load(self) -> None:
        """Rebuild the maps by replaying channel history (oldest first).

        Anything that isn't a config line or the status panel is noise (stray
        commands, Discord notices) and gets deleted — this channel is ours.
        """
        for d in (
            self.identity,
            self.repo_to_channel,
            self.repo_to_announce,
            self.repo_to_role,
        ):
            d.clear()
        self._messages.clear()
        async for message in self._channel.history(limit=None, oldest_first=True):
            content = message.content.strip()
            m = _LINE.match(content) or _LEGACY.match(content)
            if m:
                kind, key, value = m["kind"], m["key"], int(m["value"])
                # Migrate legacy plain lines to the rich form in place.
                new = self._format_line(kind, key, value)
                if content != new:
                    await message.edit(content=new)
                self._apply(kind, key, value)
                self._messages[kind, key] = message
            elif self._is_panel(message):
                self._panel = message
            else:
                await message.delete()

    def _is_panel(self, message: discord.Message) -> bool:
        return (
            message.author == self._channel.guild.me
            and bool(message.embeds)
            and message.embeds[0].footer.text == _PANEL_MARKER
        )

    def _apply(self, kind: str, key: str, value: int) -> None:
        if kind == "identity":
            self.identity[key.casefold()] = value
        elif kind == "repo":
            self.repo_to_channel[key] = value
        elif kind == "announce":
            self.repo_to_announce[key] = value
        elif kind == "access":
            self.repo_to_role[key] = value

    def _forget(self, kind: str, key: str) -> None:
        if kind == "identity":
            self.identity.pop(key.casefold(), None)
        elif kind == "repo":
            self.repo_to_channel.pop(key, None)
        elif kind == "announce":
            self.repo_to_announce.pop(key, None)
        elif kind == "access":
            self.repo_to_role.pop(key, None)

    @staticmethod
    def _format_line(kind: str, key: str, value: int) -> str:
        """A human-readable, clickable line: `kind [key](url) <mention>`.

        The key links to GitHub (a user or a repo); the value is the matching
        Discord mention (member, channel, or role). Parsed back by `_LINE`.
        """
        url = f"https://github.com/{key}"  # login or owner/repo — both valid
        mention = {
            "identity": f"<@{value}>",
            "repo": f"<#{value}>",
            "announce": f"<#{value}>",
        }.get(kind, f"<@&{value}>")
        return f"{kind} [{key}]({url}) {mention}"

    async def _persist(self, kind: str, key: str, value: int) -> None:
        # Drop the old line first so a re-map leaves one live message, not two.
        old = self._messages.pop((kind, key), None)
        if old is not None:
            await old.delete()
        self._messages[kind, key] = await self._channel.send(
            self._format_line(kind, key, value)
        )
        self._apply(kind, key, value)
        await self.refresh_panel()

    async def _unpersist(self, kind: str, key: str) -> None:
        """Forget a mapping: delete its message and drop it from memory."""
        message = self._messages.pop((kind, key), None)
        if message is not None:
            await message.delete()
        self._forget(kind, key)
        await self.refresh_panel()

    async def link_identity(self, github_login: str, discord_id: int) -> None:
        await self._persist("identity", github_login, discord_id)

    async def map_repo(self, repo_full_name: str, channel_id: int) -> None:
        await self._persist("repo", repo_full_name, channel_id)

    async def map_announce(self, repo_full_name: str, channel_id: int) -> None:
        await self._persist("announce", repo_full_name, channel_id)

    async def map_access_role(self, repo_full_name: str, role_id: int) -> None:
        await self._persist("access", repo_full_name, role_id)

    async def forget_repo(self, repo_full_name: str) -> None:
        await self._unpersist("repo", repo_full_name)

    async def forget_access_role(self, repo_full_name: str) -> None:
        await self._unpersist("access", repo_full_name)

    def discord_id_for(self, github_login: str) -> int | None:
        return self.identity.get(github_login.casefold())

    # --- live config panel ---

    def render_panel(self) -> discord.Embed:
        """A single embed reflecting the current mappings, mentions and all."""
        embed = discord.Embed(
            title="⚙️ Bridge configuration",
            description="Live view of every GitHub → Discord mapping.",
            color=0x5865F2,
        )
        embed.set_footer(text=_PANEL_MARKER)

        repos = "\n".join(
            f"`{repo}` → <#{channel_id}>"
            + (f" 📣 <#{ann}>" if (ann := self.repo_to_announce.get(repo)) else "")
            + (f" <@&{role}>" if (role := self.repo_to_role.get(repo)) else "")
            for repo, channel_id in sorted(self.repo_to_channel.items())
        )
        embed.add_field(
            name=f"Repos → Channels ({len(self.repo_to_channel)})",
            value=repos or "*none — `/map repo`*",
            inline=False,
        )

        users = "\n".join(
            f"`{login}` → <@{discord_id}>"
            for login, discord_id in sorted(self.identity.items())
        )
        embed.add_field(
            name=f"Linked users ({len(self.identity)})",
            value=users or "*none — `/map user`*",
            inline=False,
        )
        return embed

    async def refresh_panel(self) -> None:
        """Edit the existing panel in place, or post it once if missing."""
        embed = self.render_panel()
        if self._panel is not None:
            try:
                await self._panel.edit(embed=embed)
                return
            except discord.NotFound:
                self._panel = None  # someone deleted it; fall through and repost
        self._panel = await self._channel.send(embed=embed)


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
