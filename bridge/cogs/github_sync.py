"""Cog: identity linking and GitHub-team -> Discord-role sync."""

from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

from bridge import db

if TYPE_CHECKING:
    from bridge.bot import BridgeBot


class SyncResult:
    def __init__(self) -> None:
        self.added: list[str] = []  # "member -> role"
        self.unmapped: set[str] = set()  # github logins with no discord link


class GithubSync(commands.Cog):
    def __init__(self, bot: "BridgeBot") -> None:
        self.bot = bot

    def _is_admin(self, member: discord.Member) -> bool:
        return any(r.id == self.bot.config.admin_role_id for r in member.roles)

    async def _guard(self, interaction: discord.Interaction) -> bool:
        member = interaction.user
        if not isinstance(member, discord.Member) or not self._is_admin(member):
            await interaction.response.send_message(
                "You need the admin role to do that.", ephemeral=True
            )
            return False
        return True

    @app_commands.command(description="Link a GitHub login to a Discord member.")
    async def link(
        self,
        interaction: discord.Interaction,
        github_login: str,
        member: discord.Member,
    ) -> None:
        if not await self._guard(interaction):
            return
        db.link(github_login, member.id)
        await interaction.response.send_message(
            f"Linked `{github_login}` -> {member.mention}.", ephemeral=True
        )

    @app_commands.command(description="Sync GitHub team membership to Discord roles.")
    async def sync_roles(self, interaction: discord.Interaction) -> None:
        if not await self._guard(interaction):
            return
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
        org = self.bot.config.org

        for team_slug, role_id in self.bot.config.team_to_role.items():
            role = guild.get_role(role_id)
            if role is None:
                continue
            async for gh_member in self.bot.github.rest.paginate(
                self.bot.github.rest.teams.async_list_members_in_org,
                org=org,
                team_slug=team_slug,
            ):
                discord_id = db.discord_id_for(gh_member.login)
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
