// Keeps Discord's access in step with GitHub: one role per repo mapped to a
// home channel, holding the repo's collaborators and the org's admins, with the
// channel visible only to that role. It runs when a new version starts and
// after a command changes the configuration, so a mapped channel keeps the
// access rules of its repo.
import { z } from "zod"

import type { GitHub } from "../github/app"
import type { Config } from "../store/config"
import type { DiscordRest } from "./rest"

// Discord's bitfields: View Channel on a role overwrite, and the overwrite type
// that targets a role rather than one member.
const VIEW_CHANNEL = 1 << 10
const ROLE = 0

const GuildRole = z.object({ id: z.string(), name: z.string(), managed: z.boolean() })
const Member = z.object({ user: z.object({ id: z.string() }), roles: z.array(z.string()) })
const Guild = z.object({ id: z.string() })

type GuildRole = z.infer<typeof GuildRole>

export interface AccessChange {
  created: string[]
  deleted: string[]
  added: { user: string; role: string }[]
  removed: { user: string; role: string }[]
}

export interface AccessInput {
  config: Config
  github: GitHub
  rest: DiscordRest
  /** The guild whose roles and channels are the mirror. */
  guild: string
  org: string
}

/** The guild access sync works in: the configured one, else the bot's only guild. */
export async function guildOf(
  rest: DiscordRest,
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured !== undefined && configured !== "") return configured
  const guilds = z.array(Guild).parse(await rest.get("/users/@me/guilds"))
  return guilds[0]?.id
}

/** Brings every mapped repo's role and channel in line with GitHub. */
export async function reconcileAccess(input: AccessInput): Promise<AccessChange> {
  const { config, github, rest, guild, org } = input
  const change: AccessChange = { created: [], deleted: [], added: [], removed: [] }
  const roles = await guildRoles(rest, guild)
  const members = await guildMembers(rest, guild)

  const homes = new Map<string, string>()
  for (const mapping of config.channels("discord")) {
    if (mapping.purpose === "home") homes.set(mapping.repo, mapping.channel)
  }
  // Org admins reach every repo; the collaborators API doesn't always surface
  // them per repo, so they are resolved once and unioned into every role.
  const admins = homes.size === 0 ? [] : discordIds(await orgAdmins(github, org), config)
  for (const [repo, channel] of homes) {
    try {
      const role = await ensureRole(config, rest, guild, repo, roles, change)
      const collaborators = await collaboratorsOf(github, org, repo)
      const want = new Set([...admins, ...discordIds(collaborators, config)])
      await fill(rest, guild, role, want, members, change)
      await gate(rest, guild, channel, role.id)
    } catch (error) {
      // One broken repo (a deleted channel, an install without access) must not
      // keep the rest of the guild unsynced; the next run tries again.
      console.error(`access sync failed for ${repo}`, error)
    }
  }

  await prune(config, rest, guild, new Set(homes.keys()), roles, change)
  return change
}

/** The repo's access role, created and registered if the mapping or the role is gone. */
async function ensureRole(
  config: Config,
  rest: DiscordRest,
  guild: string,
  repo: string,
  roles: Map<string, GuildRole>,
  change: AccessChange,
): Promise<GuildRole> {
  const mapped = config.accessGroup(repo, "discord")
  const known = mapped === undefined ? undefined : roles.get(mapped)
  if (known !== undefined) return known

  const name = `${basename(repo)} devs`
  // A role the Python bob created has no mapping here after an import that
  // missed it; adopting it by name beats leaving a duplicate behind.
  const named = [...roles.values()].find((role) => !role.managed && role.name === name)
  if (named !== undefined) {
    config.setAccessGroup(repo, "discord", named.id)
    return named
  }

  const created = GuildRole.parse(await rest.post(`/guilds/${guild}/roles`, { name }))
  roles.set(created.id, created)
  config.setAccessGroup(repo, "discord", created.id)
  change.created.push(created.name)
  return created
}

/** Adds whoever gained access and removes whoever lost it. */
async function fill(
  rest: DiscordRest,
  guild: string,
  role: GuildRole,
  want: Set<string>,
  members: Map<string, Set<string>>,
  change: AccessChange,
): Promise<void> {
  const have = new Set<string>()
  for (const [id, held] of members) if (held.has(role.id)) have.add(id)

  for (const id of [...want].toSorted()) {
    if (!members.has(id) || have.has(id)) continue
    await rest.put(`/guilds/${guild}/members/${id}/roles/${role.id}`)
    members.get(id)?.add(role.id)
    change.added.push({ user: id, role: role.name })
  }
  for (const id of [...have].toSorted()) {
    if (want.has(id)) continue
    await rest.delete(`/guilds/${guild}/members/${id}/roles/${role.id}`)
    members.get(id)?.delete(role.id)
    change.removed.push({ user: id, role: role.name })
  }
}

/** Makes the channel visible to its access role and to nobody else. */
async function gate(
  rest: DiscordRest,
  guild: string,
  channel: string,
  role: string,
): Promise<void> {
  // @everyone's role id is the guild id. Both overwrites are replaced, not
  // merged, and per-member overwrites are left as they are.
  await rest.put(`/channels/${channel}/permissions/${guild}`, {
    type: ROLE,
    allow: "0",
    deny: String(VIEW_CHANNEL),
  })
  await rest.put(`/channels/${channel}/permissions/${role}`, {
    type: ROLE,
    allow: String(VIEW_CHANNEL),
    deny: "0",
  })
}

/** Deletes the roles of repos no longer mapped to a channel. */
async function prune(
  config: Config,
  rest: DiscordRest,
  guild: string,
  mapped: Set<string>,
  roles: Map<string, GuildRole>,
  change: AccessChange,
): Promise<void> {
  for (const { repo, group } of config.accessGroups("discord")) {
    if (mapped.has(repo)) continue
    const role = roles.get(group)
    if (role !== undefined && !role.managed) {
      await rest.delete(`/guilds/${guild}/roles/${role.id}`)
      change.deleted.push(role.name)
    }
    config.forgetAccessGroup(repo, "discord")
  }
}

async function guildRoles(rest: DiscordRest, guild: string): Promise<Map<string, GuildRole>> {
  const listed = z.array(GuildRole).parse(await rest.get(`/guilds/${guild}/roles`))
  return new Map(listed.map((role) => [role.id, role]))
}

/** Every member and the roles they hold, a thousand ids at a time. */
async function guildMembers(rest: DiscordRest, guild: string): Promise<Map<string, Set<string>>> {
  const members = new Map<string, Set<string>>()
  let after = "0"
  for (;;) {
    const query = new URLSearchParams({ limit: "1000", after })
    const page = z
      .array(Member)
      .parse(await rest.get(`/guilds/${guild}/members?${query.toString()}`))
    for (const member of page) members.set(member.user.id, new Set(member.roles))
    const last = page.at(-1)
    if (page.length < 1000 || last === undefined) return members
    after = last.user.id
  }
}

async function orgAdmins(github: GitHub, org: string): Promise<string[]> {
  const admins = await github.paginate(github.rest.orgs.listMembers, {
    org,
    role: "admin",
    per_page: 100,
  })
  return admins.map((admin) => admin.login)
}

async function collaboratorsOf(github: GitHub, org: string, repo: string): Promise<string[]> {
  const slash = repo.indexOf("/")
  const owner = slash === -1 ? org : repo.slice(0, slash)
  const name = slash === -1 ? repo : repo.slice(slash + 1)
  const collaborators = await github.paginate(github.rest.repos.listCollaborators, {
    owner,
    repo: name,
    affiliation: "all",
    per_page: 100,
  })
  return collaborators.map((collaborator) => collaborator.login)
}

/** The Discord ids of the logins someone has mapped; a login nobody mapped is skipped. */
function discordIds(logins: string[], config: Config): string[] {
  const ids: string[] = []
  for (const login of logins) {
    const id = config.personBy("github", login)?.discord
    if (id !== undefined && id !== null) ids.push(id)
  }
  return ids
}

function basename(repo: string): string {
  return repo.split("/").at(-1) ?? repo
}
