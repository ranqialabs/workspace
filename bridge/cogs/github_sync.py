"""Cog: repo-access -> Discord-role sync + repo/user mapping.

GitHub is the source of truth. You map a repo to a channel by hand (`/map repo`)
— that grouping is a human decision GitHub can't infer. `/sync roles` then, per
mapped repo, creates an access role, fills it with everyone who can *effectively*
see that repo on GitHub (team members and direct collaborators alike, via the
collaborators API), and gates the channel to that role. Teams don't matter here:
what counts is who can reach the repo. `/map user` links a GitHub login to a
Discord member. Everything persists to #bot-config via the store.
"""

from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

if TYPE_CHECKING:
    from bridge.bot import BridgeBot


class SyncResult:
    def __init__(self) -> None:
        self.created_roles: list[int] = []  # role ids created this run
        self.deleted_roles: list[str] = []  # role names deleted (repo unmapped/gone)
        self.added: list[tuple[int, int]] = []  # (member id, role id)
        self.removed: list[tuple[int, int]] = []  # (member id, role id)
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
        description="Per mapped repo: fill its access role from GitHub, gate the channel.",
    )
    async def sync_roles(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        result = await self.run_sync(interaction.guild)
        await interaction.followup.send(embed=self._sync_embed(result), ephemeral=True)

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
            color=0x5865F2 if changed else 0x2DA44E,
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
                "Unmapped — run `/map user`",
                [
                    f"[{login}](https://github.com/{login})"
                    for login in sorted(result.unmapped)
                ],
            )
        return embed

    async def _access_role(
        self, guild: discord.Guild, repo: str
    ) -> tuple[discord.Role, bool]:
        """The access role for a mapped repo, created and registered if missing.

        Returns (role, created). Named `<repo> devs` (repo name only, no owner) —
        a collective noun that reads naturally when you @mention it.
        """
        assert self.bot.store is not None
        role_id = self.bot.store.repo_to_role.get(repo)
        role = guild.get_role(role_id) if role_id else None
        # ponytail: if the registered role was deleted by hand, get_role returns
        # None and we just recreate it — self-healing. Next reconcile re-adds its
        # members.
        if role is not None:
            return role, False
        name = f"{repo.split('/')[-1]} devs"
        role = await guild.create_role(name=name, reason="repo access sync")
        await self.bot.store.map_access_role(repo, role.id)
        return role, True

    async def run_sync(self, guild: discord.Guild | None) -> SyncResult:
        """GitHub is the source of truth: one access role per mapped repo, filled
        with everyone who can effectively see the repo, and the channel gated to it.
        """
        result = SyncResult()
        assert guild is not None
        assert self.bot.github is not None
        assert self.bot.store is not None
        gh, store, org = self.bot.github, self.bot.store, self.bot.config.org

        for repo, channel_id in list(store.repo_to_channel.items()):
            owner, name = repo.split("/", 1) if "/" in repo else (org, repo)
            role, created = await self._access_role(guild, repo)
            if created:
                result.created_roles.append(role.id)

            # who *should* have this role: everyone with effective access to the
            # repo — team members and direct collaborators alike.
            want: set[int] = set()
            async for collab in gh.rest.paginate(
                gh.rest.repos.async_list_collaborators,
                owner=owner,
                repo=name,
                affiliation="all",
            ):
                discord_id = store.discord_id_for(collab.login)
                if discord_id is None:
                    result.unmapped.add(collab.login)
                else:
                    want.add(discord_id)

            # reconcile membership: add the missing, remove the extra
            have = {m.id for m in role.members}
            for discord_id in want - have:
                member = guild.get_member(discord_id)
                if member is not None:
                    await member.add_roles(role, reason=f"repo access {repo}")
                    result.added.append((member.id, role.id))
            for discord_id in have - want:
                member = guild.get_member(discord_id)
                if member is not None:
                    await member.remove_roles(role, reason=f"lost access {repo}")
                    result.removed.append((member.id, role.id))

            await self._gate_channel(guild, channel_id, role)

        await self._prune_orphans(guild, result)
        return result

    async def _prune_orphans(self, guild: discord.Guild, result: SyncResult) -> None:
        """Delete access roles for repos no longer mapped to a channel.

        A repo dropped from `/map repo` means its access role is deleted (the
        channel itself is left alone).
        """
        assert self.bot.store is not None
        for repo in list(self.bot.store.repo_to_role):
            if repo in self.bot.store.repo_to_channel:
                continue
            role = guild.get_role(self.bot.store.repo_to_role[repo])
            if role is not None:
                await role.delete(reason=f"repo {repo} no longer mapped")
                result.deleted_roles.append(role.name)
            await self.bot.store.forget_access_role(repo)

    async def _gate_channel(
        self, guild: discord.Guild, channel_id: int, role: discord.Role
    ) -> None:
        """Make the channel visible only to its repo's access role."""
        channel = guild.get_channel(channel_id)
        if not isinstance(channel, discord.TextChannel):
            return
        await channel.set_permissions(
            guild.default_role, view_channel=False, reason="repo access sync"
        )
        await channel.set_permissions(
            role, view_channel=True, reason="repo access sync"
        )


async def setup(bot: "BridgeBot") -> None:
    await bot.add_cog(GithubSync(bot))
