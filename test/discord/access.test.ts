import { describe, expect, test } from "bun:test"

import type { GitHub } from "../../src/github/app"
import { Config } from "../../src/store/config"
import { guildOf, reconcileAccess } from "../../src/discord/access"
import { DiscordRest } from "../../src/discord/rest"
import { memoryDatabase } from "../memory-database"

interface Guild {
  roles: { id: string; name: string; managed: boolean }[]
  members: { id: string; roles: string[] }[]
}

interface Call {
  method: string
  path: string
  body?: unknown
}

const json = (body: unknown) => Response.json(body)
const done = () => new Response(null, { status: 204 })

/** Discord's REST API with roles and members kept in memory. */
function fakeDiscord(guild: Guild) {
  const calls: Call[] = []
  let created = 0
  const fetcher = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    const path = pathname.replace(/^\/api\/v10/, "")
    const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text()
    const body = text === "" ? undefined : JSON.parse(text)
    calls.push({ method: request.method, path, body })

    if (/^\/guilds\/[^/]+\/roles$/.test(path)) {
      if (request.method === "GET") return json(guild.roles)
      const name = (body as { name: string }).name
      const role = { id: `role${(created += 1)}`, name, managed: false }
      guild.roles.push(role)
      return json(role)
    }
    const role = /^\/guilds\/[^/]+\/roles\/([^/]+)$/.exec(path)
    if (role !== null && request.method === "DELETE") {
      guild.roles = guild.roles.filter((candidate) => candidate.id !== role[1])
      return done()
    }
    if (/^\/guilds\/[^/]+\/members$/.test(path)) {
      const members = guild.members.map((member) => ({
        user: { id: member.id },
        roles: member.roles,
      }))
      return json(members)
    }
    const held = /^\/guilds\/[^/]+\/members\/([^/]+)\/roles\/([^/]+)$/.exec(path)
    if (held !== null) {
      const member = guild.members.find((candidate) => candidate.id === held[1])
      if (member !== undefined && request.method === "PUT") member.roles.push(String(held[2]))
      if (member !== undefined && request.method === "DELETE") {
        member.roles = member.roles.filter((id) => id !== held[2])
      }
      return done()
    }
    if (/^\/channels\/[^/]+\/permissions\/[^/]+$/.test(path)) return done()
    return new Response(`nothing answers ${request.method} ${path}`, { status: 404 })
  }
  return { guild, calls, fetcher }
}

const endpoint = (route: string) => Object.assign(() => Promise.resolve(), { route })

/** An Octokit whose two paged endpoints answer from the lists given. */
function fakeGitHub(admins: string[], collaborators: Record<string, string[]>): GitHub {
  const rest = {
    orgs: { listMembers: endpoint("orgs.listMembers") },
    repos: { listCollaborators: endpoint("repos.listCollaborators") },
  }
  const paginate = (from: { route: string }, params: Record<string, unknown>) => {
    const logins =
      from.route === "orgs.listMembers"
        ? admins
        : (collaborators[`${String(params.owner)}/${String(params.repo)}`] ?? [])
    return Promise.resolve(logins.map((login) => ({ login })))
  }
  return { rest, paginate } as unknown as GitHub
}

function config() {
  return new Config(memoryDatabase())
}

const guildId = "g1"
const everyone = { id: guildId, name: "@everyone", managed: false }

describe("access sync", () => {
  test("a mapped repo gets a role from GitHub and a channel only it can see", async () => {
    const c = config()
    c.mapChannel("acme/web", "discord", "home", "c1")
    c.link("discord", "1", "github", "ana")
    c.link("discord", "2", "github", "boss")
    const { guild, calls, fetcher } = fakeDiscord({
      roles: [everyone],
      members: [
        { id: "1", roles: [] },
        { id: "2", roles: [] },
        { id: "3", roles: [] },
      ],
    })

    const change = await reconcileAccess({
      config: c,
      github: fakeGitHub(["boss"], { "acme/web": ["ana", "zed"] }),
      rest: new DiscordRest("t", fetcher),
      guild: guildId,
      org: "acme",
    })

    expect(c.accessGroup("acme/web", "discord")).toBe("role1")
    expect(change.created).toEqual(["web devs"])
    expect(change.added).toEqual([
      { user: "1", role: "web devs" },
      { user: "2", role: "web devs" },
    ])
    expect(guild.roles.map((role) => role.name)).toEqual(["@everyone", "web devs"])
    expect(guild.members.find((member) => member.id === "3")?.roles).toEqual([])
    expect(calls.filter((call) => call.path.startsWith("/channels/c1/permissions/"))).toEqual([
      {
        method: "PUT",
        path: "/channels/c1/permissions/g1",
        body: { type: 0, allow: "0", deny: "1024" },
      },
      {
        method: "PUT",
        path: "/channels/c1/permissions/role1",
        body: { type: 0, allow: "1024", deny: "0" },
      },
    ])
  })

  test("a role the Python bob made is adopted, and someone who lost access is removed", async () => {
    const c = config()
    c.mapChannel("acme/web", "discord", "home", "c1")
    c.link("discord", "1", "github", "ana")
    const { guild, fetcher } = fakeDiscord({
      roles: [everyone, { id: "r9", name: "web devs", managed: false }],
      members: [
        { id: "1", roles: ["r9"] },
        { id: "2", roles: ["r9"] },
      ],
    })

    const change = await reconcileAccess({
      config: c,
      github: fakeGitHub(["ana"], { "acme/web": ["ana"] }),
      rest: new DiscordRest("t", fetcher),
      guild: guildId,
      org: "acme",
    })

    expect(c.accessGroup("acme/web", "discord")).toBe("r9")
    expect(change.created).toEqual([])
    expect(change.removed).toEqual([{ user: "2", role: "web devs" }])
    expect(guild.members.find((member) => member.id === "2")?.roles).toEqual([])
  })

  test("a repo no longer mapped loses its role", async () => {
    const c = config()
    c.setAccessGroup("acme/old", "discord", "r7")
    const { calls, fetcher } = fakeDiscord({
      roles: [everyone, { id: "r7", name: "old devs", managed: false }],
      members: [],
    })

    const change = await reconcileAccess({
      config: c,
      github: fakeGitHub([], {}),
      rest: new DiscordRest("t", fetcher),
      guild: guildId,
      org: "acme",
    })

    expect(change.deleted).toEqual(["old devs"])
    expect(c.accessGroup("acme/old", "discord")).toBeUndefined()
    expect(calls).toContainEqual({
      method: "DELETE",
      path: `/guilds/${guildId}/roles/r7`,
      body: undefined,
    })
  })
})

describe("guild", () => {
  test("the configured guild wins", async () => {
    const rest = new DiscordRest("t", () => Promise.resolve(Response.json([])))
    expect(await guildOf(rest, "g1")).toBe("g1")
  })

  test("without one, the bot's only guild answers", async () => {
    const seen: string[] = []
    const rest = new DiscordRest("t", (request) => {
      seen.push(request.url)
      return Promise.resolve(Response.json([{ id: "g2" }, { id: "g3" }]))
    })
    expect(await guildOf(rest, "")).toBe("g2")
    expect(seen).toEqual(["https://discord.com/api/v10/users/@me/guilds"])
  })
})
