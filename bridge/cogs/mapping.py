"""Cog: the /map, /sync, /config command surface.

You map a repo to a channel by hand (`/map repo`) — that grouping is a human
decision GitHub can't infer. `/map github` and `/map linear` link a person's
account in each system to a Discord member; the member is the key those two meet
through, so one question about somebody can reach either side. `/sync roles` runs
the access reconciler (bridge/access.py), which fills each mapped repo's role from
GitHub and gates its channel. This cog is the Discord command layer only; the
reconciliation engine lives in AccessReconciler.

The subcommands are named after the system they map, so `/map github` rather than
the `/map user` it used to be: with a second person-mapping beside it, "user" said
which side only by historical accident. Lines already written to #bot-config
migrate themselves (see `bridge.store`).
"""

import time
from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

from bridge import access
from bridge.access import SyncResult
from bridge.linear import Node, nodes
from bridge.render import BLURPLE, GREEN

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

# Workspace members, for the `/map linear` picker and its confirmation. A
# workspace of tens of people fits in one page, so neither needs to paginate.
_MEMBERS = """
query Members {
  users(first: 100, includeDisabled: false) {
    nodes { name displayName email active avatarUrl }
  }
}
"""

MAX_CHOICES = 25  # Discord's own cap on an autocomplete response
_MEMBERS_TTL = 60.0  # seconds a fetched member list stays good for


class Mapping(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot
        self._members: tuple[float, list[Node]] | None = None

    map = app_commands.Group(
        name="map",
        description="Wire GitHub, Linear, and Discord to each other.",
        default_permissions=discord.Permissions(manage_guild=True),
    )
    sync = app_commands.Group(
        name="sync",
        description="Apply GitHub state to Discord now.",
        default_permissions=discord.Permissions(manage_guild=True),
    )

    # --- autocomplete helpers (backed by the GitHub API) ---

    async def _member_choices(
        self, _: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        assert self.bot.github is not None
        choices: list[app_commands.Choice[str]] = []
        async for user in self.bot.github.rest.paginate(
            self.bot.github.rest.orgs.async_list_members, org=self.bot.config.org
        ):
            if current.lower() in user.login.lower():
                choices.append(app_commands.Choice(name=user.login, value=user.login))
            if len(choices) >= MAX_CHOICES:
                break
        return choices

    async def _repo_choices(
        self, _: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        assert self.bot.github is not None
        choices: list[app_commands.Choice[str]] = []
        # type="all" is what surfaces private repos here; as the installation the
        # app already has access to them. (The default omits private ones.)
        async for repo in self.bot.github.rest.paginate(
            self.bot.github.rest.repos.async_list_for_org,
            org=self.bot.config.org,
            type="all",
        ):
            if current.lower() in repo.full_name.lower():
                choices.append(
                    app_commands.Choice(name=repo.full_name, value=repo.full_name)
                )
            if len(choices) >= MAX_CHOICES:
                break
        return choices

    async def _workspace_members(self) -> list[Node]:
        """Every workspace member, cached briefly.

        The picker asks on every keystroke and the confirmation asks again, all for
        a list of tens that barely moves; without this that is one round trip per
        character typed.
        """
        if self._members and time.monotonic() - self._members[0] < _MEMBERS_TTL:
            return self._members[1]
        if self.bot.linear is None:
            return []
        try:
            data = await self.bot.linear.query(_MEMBERS)
        except Exception:  # noqa: BLE001 - a broken picker beats a raised error
            return []
        members = nodes(data.get("users"))
        self._members = (time.monotonic(), members)
        return members

    async def _linear_choices(
        self, _: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        """Workspace members from Linear, matched on the name or the email.

        The value is the email, because that is what the mapping is keyed on and
        what Linear's own filters take. An autocomplete has three seconds and no
        way to report an error, so a failure comes back as no choices.
        """
        choices: list[app_commands.Choice[str]] = []
        for user in await self._workspace_members():
            name = str(user.get("name") or user.get("displayName") or "")
            email = str(user.get("email") or "")
            if not email:
                continue
            if current.lower() not in f"{name} {email}".lower():
                continue
            choices.append(
                app_commands.Choice(name=f"{name} · {email}"[:100], value=email)
            )
            if len(choices) >= MAX_CHOICES:
                break
        return choices

    # --- /map ---

    @map.command(name="repo", description="Map a GitHub repo to a Discord channel.")
    @app_commands.autocomplete(repo=_repo_choices)
    async def map_repo(
        self,
        interaction: discord.Interaction,
        repo: str,
        channel: discord.TextChannel,
    ) -> None:
        assert self.bot.store is not None
        await self.bot.store.map_repo(repo, channel.id)
        await interaction.response.send_message(
            f"Mapped repo `{repo}` → {channel.mention}.", ephemeral=True
        )

    @map.command(
        name="announce",
        description="Route a repo's announcements (releases, review, CI) to a channel.",
    )
    @app_commands.autocomplete(repo=_repo_choices)
    async def map_announce(
        self,
        interaction: discord.Interaction,
        repo: str,
        channel: discord.TextChannel,
    ) -> None:
        assert self.bot.store is not None
        await self.bot.store.map_announce(repo, channel.id)
        await interaction.response.send_message(
            f"Announcements for `{repo}` → {channel.mention}.", ephemeral=True
        )

    @map.command(name="github", description="Link a GitHub user to a Discord member.")
    @app_commands.autocomplete(github_login=_member_choices)
    async def map_github(
        self,
        interaction: discord.Interaction,
        github_login: str,
        member: discord.Member,
    ) -> None:
        assert self.bot.store is not None
        assert self.bot.github is not None
        await self.bot.store.link_github(github_login, member.id)

        # Enrich the confirmation with the GitHub profile (name + avatar). One
        # request, only for the chosen login — cheap, and this is where an image
        # can actually render (Discord autocomplete choices are text-only).
        embed = discord.Embed(title="GitHub identity linked", color=GREEN)
        try:
            resp = await self.bot.github.rest.users.async_get_by_username(github_login)
            user = resp.parsed_data
            embed.set_thumbnail(url=user.avatar_url)
            display = (
                f"{user.name} (`{github_login}`)" if user.name else f"`{github_login}`"
            )
            embed.description = f"[{display}]({user.html_url}) → {member.mention}"
        except Exception:  # noqa: BLE001
            # Unknown login or API hiccup: the link is saved, just show it plainly.
            embed.description = f"`{github_login}` → {member.mention}"
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @map.command(name="linear", description="Link a Linear member to a Discord member.")
    @app_commands.describe(linear_user="Pick from the workspace; stored by email.")
    @app_commands.autocomplete(linear_user=_linear_choices)
    async def map_linear(
        self,
        interaction: discord.Interaction,
        linear_user: str,
        member: discord.Member,
    ) -> None:
        assert self.bot.store is not None
        await self.bot.store.link_linear(linear_user, member.id)

        # Same shape as `/map github`: save first, then enrich, so a failure here
        # costs the picture and not the mapping. Unlike GitHub's, this lookup can
        # tell a typo from an API hiccup — and a mapping to an email Linear has
        # never heard of would only ever return empty listings, so it says so.
        embed = discord.Embed(title="Linear identity linked", color=GREEN)
        embed.description = f"`{linear_user}` → {member.mention}"
        found = await self._linear_member(linear_user)
        if found is None and self.bot.linear is not None:
            embed.add_field(
                name="⚠️",
                value=(
                    f"No workspace member has the email `{linear_user}`. The link "
                    "is saved, but it will match nothing until it is corrected — "
                    "run `/map linear` again and pick from the list."
                ),
                inline=False,
            )
        elif found is not None:
            name = str(found.get("name") or found.get("displayName") or linear_user)
            embed.description = f"**{name}** (`{linear_user}`) → {member.mention}"
            if avatar := found.get("avatarUrl"):
                embed.set_thumbnail(url=str(avatar))
            if not found.get("active"):
                embed.add_field(
                    name="Note",
                    value="This member is deactivated in Linear.",
                    inline=False,
                )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    async def _linear_member(self, email: str) -> Node | None:
        """The workspace member with this email, or None if there isn't one.

        None also covers "we couldn't ask", which the caller tells apart by
        checking the client: "no such member" and "could not check" are different
        things to put in front of somebody.
        """
        wanted = email.casefold()
        return next(
            (
                user
                for user in await self._workspace_members()
                if str(user.get("email") or "").casefold() == wanted
            ),
            None,
        )

    # --- /config ---

    @app_commands.command(
        name="config", description="Refresh the live config panel in #bot-config."
    )
    @app_commands.default_permissions(manage_guild=True)
    async def config(self, interaction: discord.Interaction) -> None:
        assert self.bot.store is not None
        await self.bot.store.refresh_panel()
        await interaction.response.send_message(
            "Config panel refreshed in #bot-config.", ephemeral=True
        )

    # --- /sync ---

    @sync.command(
        name="roles",
        description="Per mapped repo: fill its access role from GitHub, gate the channel.",
    )
    async def sync_roles(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        result = await self.run_sync(interaction.guild)
        await interaction.followup.send(embed=self._sync_embed(result), ephemeral=True)

    async def run_sync(self, guild: discord.Guild | None) -> SyncResult:
        """Reconcile GitHub access into Discord roles (startup + `/sync roles`)."""
        assert guild is not None
        assert self.bot.github is not None
        assert self.bot.store is not None
        return await access.reconcile(
            self.bot.github, self.bot.store, self.bot.config.org, guild
        )

    @staticmethod
    def _sync_embed(result: "SyncResult") -> discord.Embed:
        """Render a sync run as a tidy embed with real role/member mentions."""
        changed = bool(
            result.created_roles
            or result.deleted_roles
            or result.added
            or result.removed
        )
        embed = discord.Embed(
            title="🔄 Access sync",
            description=(
                f"**{len(result.added)}** added · **{len(result.removed)}** removed"
                if changed
                else "Everything already in sync — nothing to do."
            ),
            color=BLURPLE if changed else GREEN,
        )

        def field(name: str, lines: list[str]) -> None:
            if lines:  # Discord caps a field at 1024 chars; trim defensively.
                embed.add_field(name=name, value="\n".join(lines)[:1024], inline=False)

        field("Roles created", [f"<@&{rid}>" for rid in result.created_roles])
        field("Roles deleted", [f"`{name}`" for name in result.deleted_roles])
        field("Added", [f"<@{m}> → <@&{r}>" for m, r in result.added])
        field("Removed", [f"<@{m}> → <@&{r}>" for m, r in result.removed])
        if result.unmapped:
            field(
                "Unmapped — run `/map github`",
                [
                    f"[{login}](https://github.com/{login})"
                    for login in sorted(result.unmapped)
                ],
            )
        return embed


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(Mapping(bot))
