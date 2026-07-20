"""Reconcile GitHub repo access into Discord roles + channel gating (engine only;
commands live in cogs/github_sync.py). Runs on startup and on /sync."""

from typing import TYPE_CHECKING

import discord

if TYPE_CHECKING:
    from githubkit import GitHub

    from bridge.store import Store


class SyncResult:
    def __init__(self) -> None:
        self.created_roles: list[int] = []
        self.deleted_roles: list[str] = []
        self.added: list[tuple[int, int]] = []  # (member id, role id)
        self.removed: list[tuple[int, int]] = []  # (member id, role id)
        self.unmapped: set[str] = set()  # github logins with no discord link


async def reconcile(
    gh: "GitHub", store: "Store", org: str, guild: discord.Guild
) -> SyncResult:
    """One access role per mapped repo, filled from GitHub, its channel gated to it."""
    result = SyncResult()
    owners = await _org_owners(gh, store, org, result)

    for repo, channel_id in list(store.repo_to_channel.items()):
        owner, name = repo.split("/", 1) if "/" in repo else (org, repo)
        role, created = await _access_role(store, guild, repo)
        if created:
            result.created_roles.append(role.id)

        want = set(owners)
        async for collab in gh.rest.paginate(
            gh.rest.repos.async_list_collaborators,
            owner=owner,
            repo=name,
            affiliation="all",
        ):
            discord_id = store.discord_id_for(collab.login)
            if discord_id:
                want.add(discord_id)
            else:
                result.unmapped.add(collab.login)

        await _reconcile_role(guild, role, repo, want, result)
        await _gate_channel(guild, channel_id, role)

    await _prune_orphans(store, guild, result)
    return result


async def _org_owners(
    gh: "GitHub", store: "Store", org: str, result: SyncResult
) -> set[int]:
    """Org owners reach every repo; the collaborators API doesn't always surface
    them per-repo, so resolve once and union into every access role."""
    owners: set[int] = set()
    async for admin in gh.rest.paginate(
        gh.rest.orgs.async_list_members, org=org, role="admin"
    ):
        discord_id = store.discord_id_for(admin.login)
        if discord_id:
            owners.add(discord_id)
        else:
            result.unmapped.add(admin.login)
    return owners


async def _access_role(
    store: "Store", guild: discord.Guild, repo: str
) -> tuple[discord.Role, bool]:
    """The `<repo> devs` access role, created and registered if missing."""
    role_id = store.repo_to_role.get(repo)
    role = guild.get_role(role_id) if role_id else None
    if role is not None:
        return role, False
    # ponytail: a hand-deleted role just gets recreated here (self-healing).
    role = await guild.create_role(
        name=f"{repo.split('/')[-1]} devs", reason="repo access sync"
    )
    await store.map_access_role(repo, role.id)
    return role, True


async def _reconcile_role(
    guild: discord.Guild,
    role: discord.Role,
    repo: str,
    want: set[int],
    result: SyncResult,
) -> None:
    have = {m.id for m in role.members}
    for discord_id in want - have:
        if member := guild.get_member(discord_id):
            await member.add_roles(role, reason=f"repo access {repo}")
            result.added.append((member.id, role.id))
    for discord_id in have - want:
        if member := guild.get_member(discord_id):
            await member.remove_roles(role, reason=f"lost access {repo}")
            result.removed.append((member.id, role.id))


async def _prune_orphans(
    store: "Store", guild: discord.Guild, result: SyncResult
) -> None:
    """Delete access roles for repos no longer mapped to a channel."""
    for repo in list(store.repo_to_role):
        if repo in store.repo_to_channel:
            continue
        if role := guild.get_role(store.repo_to_role[repo]):
            await role.delete(reason=f"repo {repo} no longer mapped")
            result.deleted_roles.append(role.name)
        await store.forget_access_role(repo)


async def _gate_channel(
    guild: discord.Guild, channel_id: int, role: discord.Role
) -> None:
    """Make the channel visible only to its repo's access role."""
    channel = guild.get_channel(channel_id)
    if not isinstance(channel, discord.TextChannel):
        return
    await channel.set_permissions(
        guild.default_role, view_channel=False, reason="repo access sync"
    )
    await channel.set_permissions(role, view_channel=True, reason="repo access sync")
