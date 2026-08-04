"""All mappings, persisted to a single Discord channel.

The channel IS the store. Each mapping is one message, `kind [key](url) <mention>`
— human-readable and clickable, yet still machine-parseable (see `_LINE`) — so it
round-trips through channel history. On boot we replay the channel to rebuild
four in-memory dicts; commands append a line and update memory. Later lines win.

A person can be mapped on two sides — `github` and `linear` — and the Discord
member is the key they meet through: that is what lets one question ("what is
Fulana working on") reach either system. Neither side implies the other, so a
half-mapped person is normal rather than broken.

ponytail: a channel + four dicts. No database, no disk, no cost. Fine for tens
of entries; revisit with a real store if it ever reaches thousands.
"""

import re

import discord

from bridge.config import CONFIG_CHANNEL_NAME
from bridge.render import BLURPLE

# Lines are human-readable: the key is a markdown link, the value a Discord
# mention — both clickable in #bot-config. We parse the label out of `[label](...)`
# and the snowflake out of the mention (`<@id>`, `<#id>`, or `<@&id>`; the kind
# says which). Examples:
#   github [octocat](https://github.com/octocat) <@123>
#   linear [ana@ranqia.com](mailto:ana@ranqia.com) <@123>
#   repo [owner/name](https://github.com/owner/name) <#789>
#   announce [owner/name](https://github.com/owner/name) <#790>
#   access [owner/name](https://github.com/owner/name) <@&456>
#
# `identity` is the old name for `github`, kept here so existing history parses.
# It is never written: `_format_line` spells it `github`, so `load` rewrites each
# old line in place the same way it migrates a `_LEGACY` one.
_LINE = re.compile(
    r"^(?P<kind>github|identity|linear|repo|announce|access)\s+"
    r"\[(?P<key>[^\]]+)\]\([^)]*\)\s+"
    r"<(?:@&|@|#)(?P<value>\d+)>$"
)
# Legacy plain form (`kind key 123`) — still parsed, then rewritten to the rich
# form on load so old #bot-config history migrates itself. `linear` is absent on
# purpose: no plain-form Linear history exists, and accepting one would turn a
# stray `linear foo 123` message into a mapping instead of deleting it as noise.
_LEGACY = re.compile(
    r"^(?P<kind>github|identity|repo|announce|access)\s+(?P<key>\S+)\s+(?P<value>\d+)$"
)


# Marks the bot's own live status panel so we can find and edit it instead of
# posting a new one each time (no flooding).
_PANEL_MARKER = "​"  # zero-width space in the embed footer


class Store:
    def __init__(self, channel: discord.TextChannel) -> None:
        self._channel = channel
        self.github: dict[str, int] = {}  # github login (casefold) -> discord id
        self.linear: dict[str, int] = {}  # linear email (casefold) -> discord id
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
            self.github,
            self.linear,
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
                # Migrate legacy plain lines, and `identity` lines, to the form
                # `_format_line` writes — in place, so the history stays one
                # message per mapping instead of growing a copy per rename.
                new = self._format_line(kind, key, value)
                if content != new:
                    await message.edit(content=new)
                self._apply(kind, key, value)
                # Keyed by what the line now says, so a re-map finds this message.
                self._messages[self._canonical(kind), key] = message
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

    @staticmethod
    def _canonical(kind: str) -> str:
        """The name a kind is stored and written under.

        Only `identity` moves: it was what `github` used to be called. Folding it
        here rather than at each reader means the migration is one line, and a
        line read as `identity` is keyed, applied and rewritten as `github` — so
        a later `/map github` for the same login finds the old message to replace
        instead of leaving two live lines behind.
        """
        return "github" if kind == "identity" else kind

    def _apply(self, kind: str, key: str, value: int) -> None:
        kind = self._canonical(kind)
        if kind == "github":
            self.github[key.casefold()] = value
        elif kind == "linear":
            self.linear[key.casefold()] = value
        elif kind == "repo":
            self.repo_to_channel[key] = value
        elif kind == "announce":
            self.repo_to_announce[key] = value
        elif kind == "access":
            self.repo_to_role[key] = value

    def _forget(self, kind: str, key: str) -> None:
        kind = self._canonical(kind)
        if kind == "github":
            self.github.pop(key.casefold(), None)
        elif kind == "linear":
            self.linear.pop(key.casefold(), None)
        elif kind == "repo":
            self.repo_to_channel.pop(key, None)
        elif kind == "announce":
            self.repo_to_announce.pop(key, None)
        elif kind == "access":
            self.repo_to_role.pop(key, None)

    @classmethod
    def _format_line(cls, kind: str, key: str, value: int) -> str:
        """A human-readable, clickable line: `kind [key](url) <mention>`.

        The key links to wherever it names — a GitHub user or repo, or a Linear
        member by the email that identifies them there — and the value is the
        matching Discord mention (member, channel, or role). Parsed back by
        `_LINE`.

        A Linear member gets `mailto:` rather than a linear.app profile URL: that
        URL needs the workspace slug and the member's uuid, neither of which this
        line carries, and a link the reader can actually use beats one built from
        a setting nobody wants to configure.

        Every `kind` that names a person must appear in the mention dict. The
        default is a *role* mention, so a missing kind renders `<@&id>` and
        `_LINE` reads it back as a role id — the one silent corruption this file
        allows.

        The GitHub kinds must keep formatting byte-identically, because `load`
        rewrites any line whose formatted form differs from what the channel
        says: a cosmetic change here would edit every message in #bot-config on
        the next boot.
        """
        kind = cls._canonical(kind)
        url = (
            f"mailto:{key}"
            if kind == "linear"
            else f"https://github.com/{key}"  # login or owner/repo — both valid
        )
        mention = {
            "github": f"<@{value}>",
            "linear": f"<@{value}>",
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

    async def link_github(self, github_login: str, discord_id: int) -> None:
        await self._persist("github", github_login, discord_id)

    async def link_linear(self, email: str, discord_id: int) -> None:
        """Link a Linear member, by the email that identifies them there.

        The email rather than their uuid: it is what reads on the line in
        #bot-config, and it is what Linear's own filters take, so a stored key
        goes straight into a query. A changed email is one re-run of the command;
        a stale uuid would fail by returning nothing, which reads as "she has no
        work".
        """
        await self._persist("linear", email, discord_id)

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
        return self.github.get(github_login.casefold())

    def discord_id_for_linear(self, email: str) -> int | None:
        return self.linear.get(email.casefold())

    def login_for(self, discord_id: int) -> str | None:
        """The GitHub login linked to a Discord member, if `/map github` ran.

        Scans rather than keeping an inverted dict: the mapping mutates at runtime
        and there are only ever tens of entries.
        """
        return self._key_for(self.github, discord_id)

    def linear_email_for(self, discord_id: int) -> str | None:
        """The Linear member linked to a Discord member, if `/map linear` ran."""
        return self._key_for(self.linear, discord_id)

    @staticmethod
    def _key_for(mapping: dict[str, int], discord_id: int) -> str | None:
        """The key a Discord member is mapped under, scanning for the same reason
        `login_for` does: tens of entries, and they move at runtime."""
        return next(
            (key for key, mapped in mapping.items() if mapped == discord_id), None
        )

    def people(self, guild: discord.Guild) -> list[dict[str, str]]:
        """Everyone we have any mapping for, as the three names they go by.

        The Discord member is the key: a GitHub login and a Linear email meet
        only through the person they both belong to, so this walks the members we
        know and fills in whichever legs exist. Somebody mapped on one side and
        not the other still appears with the other blank — that gap is itself the
        answer to "how do I reach her in Linear".

        Names the members rather than handing out bare handles: a first name in a
        conversation only reaches an account through the name beside it. A member
        who has left keeps their handles, named by whichever one we have — the
        mapping still points at real accounts.
        """
        members = sorted(set(self.github.values()) | set(self.linear.values()))
        rows: list[dict[str, str]] = []
        for discord_id in members:
            github = self.login_for(discord_id) or ""
            linear = self.linear_email_for(discord_id) or ""
            member = guild.get_member(discord_id)
            rows.append(
                {
                    "name": member.display_name if member else (github or linear),
                    "github": github,
                    "linear": linear,
                }
            )
        return sorted(rows, key=lambda row: row["name"].casefold())

    def channel_for(self, repo_full_name: str) -> int | None:
        """Where a repo's news goes: its announce channel, else its plain one."""
        return self.repo_to_announce.get(repo_full_name) or self.repo_to_channel.get(
            repo_full_name
        )

    def repos_for_channel(
        self, channel_id: int, parent_id: int | None = None
    ) -> list[str]:
        """Repos this channel could be about, most specific first.

        A channel mapped to one repo settles it; otherwise every mapped repo is a
        candidate, so a caller can reject anything outside the list.
        """
        here = [
            repo
            for repo, mapped in self.repo_to_channel.items()
            if mapped in {channel_id, parent_id}
        ]
        return here or sorted(self.repo_to_channel)

    # --- live config panel ---

    def render_panel(self) -> discord.Embed:
        """A single embed reflecting the current mappings, mentions and all."""
        embed = discord.Embed(
            title="⚙️ Bridge configuration",
            description="Live view of every mapping between GitHub, Linear and Discord.",
            color=BLURPLE,
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

        # Named by the side each one maps, now that there are two of them:
        # "Linked users" no longer says which account it means.
        users = "\n".join(
            f"`{login}` → <@{discord_id}>"
            for login, discord_id in sorted(self.github.items())
        )
        embed.add_field(
            name=f"GitHub users ({len(self.github)})",
            value=users or "*none — `/map github`*",
            inline=False,
        )

        members = "\n".join(
            f"`{email}` → <@{discord_id}>"
            for email, discord_id in sorted(self.linear.items())
        )
        embed.add_field(
            name=f"Linear members ({len(self.linear)})",
            value=members or "*none — `/map linear`*",
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
