"""Cog: GitHub-team -> Discord-role sync + repo/user mapping.

GitHub is the source of truth. `/sync roles` walks the org's teams, creates a
Discord role per team if missing, and reconciles membership (adds and removes)
from the identity links. Repos still map to channels by hand (`/map repo`) —
that grouping is a human decision GitHub can't infer. `/map user` links a GitHub
login to a Discord member. Everything persists to #bot-config via the store.
"""

from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

if TYPE_CHECKING:
    from bridge.bot import BridgeBot


class SyncResult:
    def __init__(self) -> None:
        self.created_roles: list[str] = []  # roles created this run
        self.deleted_roles: list[str] = []  # roles deleted (team gone from GitHub)
        self.added: list[str] = []  # "member -> role"
        self.removed: list[str] = []  # "member -> role"
        self.unmapped: set[str] = set()  # github logins with no discord link


class GithubSync(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot

    map = app_commands.Group(
        name="map",
        description="Wire GitHub teams, repos, and users to Discord.",
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
            if len(choices) >= 25:
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
            if len(choices) >= 25:
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

    @map.command(name="user", description="Link a GitHub user to a Discord member.")
    @app_commands.autocomplete(github_login=_member_choices)
    async def map_user(
        self,
        interaction: discord.Interaction,
        github_login: str,
        member: discord.Member,
    ) -> None:
        assert self.bot.store is not None
        assert self.bot.github is not None
        await self.bot.store.link_identity(github_login, member.id)

        # Enrich the confirmation with the GitHub profile (name + avatar). One
        # request, only for the chosen login — cheap, and this is where an image
        # can actually render (Discord autocomplete choices are text-only).
        embed = discord.Embed(title="Identity linked", color=0x2DA44E)
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
        description="Mirror GitHub teams: create roles, sync members, gate channels.",
    )
    async def sync_roles(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        result = await self.run_sync(interaction.guild)
        lines: list[str] = []
        if result.created_roles:
            lines.append(f"Created roles: {', '.join(result.created_roles)}")
        if result.deleted_roles:
            lines.append(
                f"Deleted roles (team gone): {', '.join(result.deleted_roles)}"
            )
        lines.append(
            f"Added {len(result.added)}, removed {len(result.removed)} role(s)."
        )
        for a in result.added:
            lines.append(f"  + {a}")
        for r in result.removed:
            lines.append(f"  − {r}")
        if result.unmapped:
            lines.append(
                "Unmapped GitHub logins (run /map user): "
                + ", ".join(sorted(result.unmapped))
            )
        await interaction.followup.send("\n".join(lines), ephemeral=True)

    async def _team_role(
        self, guild: discord.Guild, team_slug: str
    ) -> tuple[discord.Role, bool]:
        """The Discord role for a GitHub team, created and registered if missing.

        Returns (role, created).
        """
        assert self.bot.store is not None
        role_id = self.bot.store.team_to_role.get(team_slug)
        role = guild.get_role(role_id) if role_id else None
        # ponytail: if the registered role was deleted by hand, get_role returns
        # None and we just recreate it — self-healing, at the cost of losing that
        # role's manual tweaks. The next reconcile re-adds its members.
        if role is not None:
            return role, False
        role = await guild.create_role(name=team_slug, reason="github team sync")
        await self.bot.store.map_team(team_slug, role.id)
        return role, True

    async def run_sync(self, guild: discord.Guild | None) -> SyncResult:
        """GitHub is the source of truth: roles, membership, and channel access."""
        result = SyncResult()
        assert guild is not None
        assert self.bot.github is not None
        assert self.bot.store is not None
        gh, store, org = self.bot.github, self.bot.store, self.bot.config.org

        # repo full_name -> set of team roles that can see it (built as we go)
        repo_roles: dict[str, set[discord.Role]] = {}
        seen_teams: set[str] = set()

        async for team in gh.rest.paginate(gh.rest.teams.async_list, org=org):
            seen_teams.add(team.slug)
            role, created = await self._team_role(guild, team.slug)
            if created:
                result.created_roles.append(team.slug)

            # who *should* have this role, per GitHub
            want: set[int] = set()
            async for gh_member in gh.rest.paginate(
                gh.rest.teams.async_list_members_in_org, org=org, team_slug=team.slug
            ):
                discord_id = store.discord_id_for(gh_member.login)
                if discord_id is None:
                    result.unmapped.add(gh_member.login)
                else:
                    want.add(discord_id)

            # reconcile: add the missing, remove the extra (managed role only)
            have = {m.id for m in role.members}
            for discord_id in want - have:
                member = guild.get_member(discord_id)
                if member is not None:
                    await member.add_roles(role, reason=f"github team {team.slug}")
                    result.added.append(f"{member.display_name} → {role.name}")
            for discord_id in have - want:
                member = guild.get_member(discord_id)
                if member is not None:
                    await member.remove_roles(role, reason=f"left team {team.slug}")
                    result.removed.append(f"{member.display_name} → {role.name}")

            # remember which repos this team can access, for channel gating
            async for repo in gh.rest.paginate(
                gh.rest.teams.async_list_repos_in_org, org=org, team_slug=team.slug
            ):
                repo_roles.setdefault(repo.full_name, set()).add(role)

        # The org's actual repos, to detect deleted ones (repo_roles only has
        # repos some team can access, which isn't the same thing).
        org_repos: set[str] = set()
        async for repo in gh.rest.paginate(
            gh.rest.repos.async_list_for_org, org=org, type="all"
        ):
            org_repos.add(repo.full_name)

        await self._prune_orphans(guild, seen_teams, org_repos, result)
        await self._gate_channels(guild, repo_roles)
        return result

    async def _prune_orphans(
        self,
        guild: discord.Guild,
        seen_teams: set[str],
        seen_repos: set[str],
        result: SyncResult,
    ) -> None:
        """Delete roles for teams that no longer exist, and drop dead repo maps.

        GitHub is the source of truth: a team gone from GitHub means its managed
        role is deleted; a repo gone means its channel mapping is forgotten (the
        channel itself is left alone).
        """
        assert self.bot.store is not None
        for team_slug in list(self.bot.store.team_to_role):
            if team_slug in seen_teams:
                continue
            # Role may already be gone (deleted by hand) — either way, forget it.
            role = guild.get_role(self.bot.store.team_to_role[team_slug])
            if role is not None:
                await role.delete(reason=f"team {team_slug} removed on github")
                result.deleted_roles.append(team_slug)
            await self.bot.store.forget_team(team_slug)

        for repo in list(self.bot.store.repo_to_channel):
            if repo not in seen_repos:
                await self.bot.store.forget_repo(repo)

    async def _gate_channels(
        self, guild: discord.Guild, repo_roles: dict[str, set[discord.Role]]
    ) -> None:
        """Make each mapped channel visible only to roles of teams with access.

        Union: a role sees the channel if its team can access ANY repo mapped
        there. Only touches mapped channels and bot-managed team roles.
        """
        assert self.bot.store is not None
        managed = set(self.bot.store.team_to_role.values())

        # channel_id -> union of team roles that should see it
        channel_roles: dict[int, set[discord.Role]] = {}
        for repo, channel_id in self.bot.store.repo_to_channel.items():
            channel_roles.setdefault(channel_id, set()).update(
                repo_roles.get(repo, set())
            )

        for channel_id, roles in channel_roles.items():
            channel = guild.get_channel(channel_id)
            if not isinstance(channel, discord.TextChannel):
                continue
            await channel.set_permissions(
                guild.default_role, view_channel=False, reason="github access sync"
            )
            allowed = {r.id for r in roles}
            for role in roles:
                await channel.set_permissions(
                    role, view_channel=True, reason="github access sync"
                )
            # revoke access from managed roles that no longer qualify
            for overwrite_target in list(channel.overwrites):
                if (
                    isinstance(overwrite_target, discord.Role)
                    and overwrite_target.id in managed
                    and overwrite_target.id not in allowed
                ):
                    await channel.set_permissions(
                        overwrite_target, overwrite=None, reason="github access sync"
                    )


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(GithubSync(bot))
