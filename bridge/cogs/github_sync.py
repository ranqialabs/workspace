"""Cog: interactive mapping sub-commands + GitHub-team -> Discord-role sync.

Commands are grouped: `/map team`, `/map repo`, `/map user`, and `/sync roles`.
You never type an ID — roles/channels are Discord mentions, and team/repo/user
names come from GitHub-API-backed autocomplete. Everything persists to
#bot-config via the store.
"""

from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

if TYPE_CHECKING:
    from bridge.bot import BridgeBot


class SyncResult:
    def __init__(self) -> None:
        self.added: list[str] = []  # "member -> role"
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

    async def _team_choices(
        self, _: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        assert self.bot.github is not None
        choices: list[app_commands.Choice[str]] = []
        async for team in self.bot.github.rest.paginate(
            self.bot.github.rest.teams.async_list, org=self.bot.config.org
        ):
            if current.lower() in team.slug.lower():
                choices.append(app_commands.Choice(name=team.slug, value=team.slug))
            if len(choices) >= 25:  # Discord's autocomplete cap
                break
        return choices

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
        # As the installation: lists every repo the app can reach, private too.
        # (repos.list_for_org would only surface public ones here.)
        async for repo in self.bot.github.rest.paginate(
            self.bot.github.rest.apps.async_list_repos_accessible_to_installation,
            map_func=lambda r: r.parsed_data.repositories,
        ):
            if current.lower() in repo.full_name.lower():
                choices.append(
                    app_commands.Choice(name=repo.full_name, value=repo.full_name)
                )
            if len(choices) >= 25:
                break
        return choices

    # --- /map ---

    @map.command(name="team", description="Map a GitHub team to a Discord role.")
    @app_commands.autocomplete(team=_team_choices)
    async def map_team(
        self, interaction: discord.Interaction, team: str, role: discord.Role
    ) -> None:
        assert self.bot.store is not None
        await self.bot.store.map_team(team, role.id)
        await interaction.response.send_message(
            f"Mapped team `{team}` → {role.mention}.", ephemeral=True
        )

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

    # --- /sync ---

    @sync.command(name="roles", description="Sync GitHub team membership to roles.")
    async def sync_roles(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        result = await self._run_sync(interaction.guild)
        lines = [f"Added {len(result.added)} role(s)."]
        if result.added:
            lines += [f"  • {a}" for a in result.added]
        if result.unmapped:
            lines.append(
                "Unmapped GitHub logins (run /map user): "
                + ", ".join(sorted(result.unmapped))
            )
        await interaction.followup.send("\n".join(lines), ephemeral=True)

    async def _run_sync(self, guild: discord.Guild | None) -> SyncResult:
        result = SyncResult()
        assert guild is not None
        assert self.bot.github is not None
        assert self.bot.store is not None
        org = self.bot.config.org

        for team_slug, role_id in self.bot.store.team_to_role.items():
            role = guild.get_role(role_id)
            if role is None:
                continue
            async for gh_member in self.bot.github.rest.paginate(
                self.bot.github.rest.teams.async_list_members_in_org,
                org=org,
                team_slug=team_slug,
            ):
                discord_id = self.bot.store.discord_id_for(gh_member.login)
                if discord_id is None:
                    result.unmapped.add(gh_member.login)
                    continue
                member = guild.get_member(discord_id)
                if member is not None and role not in member.roles:
                    await member.add_roles(role, reason=f"github team {team_slug}")
                    result.added.append(f"{member.display_name} -> {role.name}")
        return result


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(GithubSync(bot))
