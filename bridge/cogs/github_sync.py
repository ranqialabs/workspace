"""Cog: interactive mapping commands + GitHub-team -> Discord-role sync.

You never type an ID. Roles/channels come from native Discord mentions; team
slugs and repo names come from GitHub-API-backed autocomplete. All mappings are
persisted to #bot-config via the store.
"""

from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

if TYPE_CHECKING:
    from bridge.bot import BridgeBot

# Only members with "Manage Server" can run these — no admin role id needed.
_admin = app_commands.checks.has_permissions(manage_guild=True)


class SyncResult:
    def __init__(self) -> None:
        self.added: list[str] = []  # "member -> role"
        self.unmapped: set[str] = set()  # github logins with no discord link


class GithubSync(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot

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

    async def _repo_choices(
        self, _: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        assert self.bot.github is not None
        choices: list[app_commands.Choice[str]] = []
        async for repo in self.bot.github.rest.paginate(
            self.bot.github.rest.repos.async_list_for_org, org=self.bot.config.org
        ):
            if current.lower() in repo.full_name.lower():
                choices.append(
                    app_commands.Choice(name=repo.full_name, value=repo.full_name)
                )
            if len(choices) >= 25:
                break
        return choices

    # --- commands ---

    @app_commands.command(description="Link a GitHub login to a Discord member.")
    @_admin
    async def link(
        self,
        interaction: discord.Interaction,
        github_login: str,
        member: discord.Member,
    ) -> None:
        assert self.bot.store is not None
        await self.bot.store.link_identity(github_login, member.id)
        await interaction.response.send_message(
            f"Linked `{github_login}` → {member.mention}.", ephemeral=True
        )

    @app_commands.command(description="Map a GitHub team to a Discord role.")
    @_admin
    @app_commands.autocomplete(team=_team_choices)
    async def map_team(
        self, interaction: discord.Interaction, team: str, role: discord.Role
    ) -> None:
        assert self.bot.store is not None
        await self.bot.store.map_team(team, role.id)
        await interaction.response.send_message(
            f"Mapped team `{team}` → {role.mention}.", ephemeral=True
        )

    @app_commands.command(description="Map a GitHub repo to a Discord channel.")
    @_admin
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

    @app_commands.command(description="Sync GitHub team membership to Discord roles.")
    @_admin
    async def sync_roles(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        result = await self._run_sync(interaction.guild)
        lines = [f"Added {len(result.added)} role(s)."]
        if result.added:
            lines += [f"  • {a}" for a in result.added]
        if result.unmapped:
            lines.append(
                "Unmapped GitHub logins (run /link): "
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
