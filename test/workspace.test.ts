import { afterEach, expect, test } from "bun:test"

import { Workspace } from "../src/workspace"
import type { GitHub } from "../src/github/app"
import { memoryDatabase } from "./memory-database"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function workspace() {
  const storage = memoryDatabase()
  const ctx = { storage } as unknown as DurableObjectState
  const env = { GITHUB_ORG: "acme", DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g1" } as unknown as Env
  return new Workspace(ctx, env)
}

/** A Workspace whose storage also has the key-value half and the alarm, as the DO does. */
function queuedWorkspace() {
  const database = memoryDatabase()
  const kv = new Map<string, unknown>()
  const alarms: number[] = []
  const storage = {
    ...database,
    kv: {
      get: (key: string) => kv.get(key),
      put: (key: string, value: unknown) => {
        kv.set(key, value)
      },
      delete: (key: string) => {
        kv.delete(key)
      },
    },
    setAlarm: async (at: number) => {
      alarms.push(at)
    },
  }
  const ctx = { storage } as unknown as DurableObjectState
  const env = { GITHUB_ORG: "acme", DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g1" } as unknown as Env
  return { workspace: new Workspace(ctx, env), kv, alarms }
}

const opened = {
  action: "opened",
  issue: {
    number: 1,
    title: "Broken",
    html_url: "https://github.com/acme/web/issues/1",
    user: { login: "ana" },
  },
  repository: {
    name: "web",
    full_name: "acme/web",
    html_url: "https://github.com/acme/web",
    default_branch: "main",
  },
}

test("a redelivered webhook posts its card once", async () => {
  const posted: string[] = []
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      posted.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(Response.json({ id: "m1" }))
    },
    { preconnect: realFetch.preconnect },
  )
  const ws = workspace()
  ws.config.mapChannel("acme/web", "discord", "home", "c1")
  const delivery = { id: "d1", event: "issues", payload: opened }
  await ws.github(delivery)
  await ws.github(delivery)
  expect(posted).toEqual(["https://discord.com/api/v10/channels/c1/messages"])
})

test("an event bob ignores posts nothing", async () => {
  const ws = workspace()
  ws.config.mapChannel("acme/web", "discord", "home", "c1")
  await ws.github({ id: "d2", event: "star", payload: {} })
})

test("a command that changes the configuration refills Discord's access", async () => {
  const seen: string[] = []
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(String(input))
      const { pathname } = new URL(request.url)
      seen.push(`${request.method} ${pathname}`)
      if (request.method === "GET" && pathname === "/api/v10/guilds/g1/roles") {
        return Promise.resolve(
          Response.json([
            { id: "g1", name: "@everyone", managed: false },
            { id: "r1", name: "web devs", managed: false },
          ]),
        )
      }
      if (request.method === "GET" && pathname === "/api/v10/guilds/g1/members") {
        return Promise.resolve(Response.json([]))
      }
      if (request.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(Response.json({ id: "m1" }))
    },
    { preconnect: realFetch.preconnect },
  )
  const ws = workspace()
  ws.githubClient = () => Promise.resolve({} as GitHub)
  ws.config.mapChannel("acme/web", "discord", "home", "c1")
  ws.config.setAccessGroup("acme/web", "discord", "r1")

  const reply = await ws.command(
    { name: "unmap-repo", repo: "acme/web", purpose: "home" },
    "discord",
  )

  expect(reply.text).toContain("no home channel")
  expect(seen).toContain("DELETE /api/v10/guilds/g1/roles/r1")
  expect(ws.config.accessGroup("acme/web", "discord")).toBeUndefined()
})

test("a read-only command touches no other service", async () => {
  const seen: string[] = []
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      seen.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(Response.json({}))
    },
    { preconnect: realFetch.preconnect },
  )
  const ws = workspace()
  await ws.command({ name: "config" }, "discord")
  expect(seen).toEqual([])
})

test("a retro command hands the week to the alarm instead of the request", async () => {
  const { workspace: ws, kv, alarms } = queuedWorkspace()
  const reply = await ws.command({ name: "retro", period: "week", channel: "c1" }, "discord")
  expect(reply.text).toContain("Posting the weekly retro")
  expect(alarms.length).toBe(1)
  expect(kv.get("retro-jobs")).toEqual([{ period: "week", platform: "discord", channel: "c1" }])
})

test("the alarm posts a queued retro and clears the job", async () => {
  const { workspace: ws, kv } = queuedWorkspace()
  const github = {
    rest: { search: { issuesAndPullRequests: () => Promise.resolve({ data: { items: [] } }) } },
  } as unknown as GitHub
  ws.githubClient = () => Promise.resolve(github)
  const seen: string[] = []
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(String(input))
      seen.push(request.url)
      if (request.url.includes("api.github.com")) {
        return Promise.resolve(Response.json({ items: [], total_count: 0 }))
      }
      return Promise.resolve(Response.json({ id: "m1" }))
    },
    { preconnect: realFetch.preconnect },
  )
  const errors = console.error
  console.error = () => {}
  try {
    await ws.command({ name: "retro", period: "week", channel: "c1" }, "discord")
    await ws.alarm()
  } finally {
    console.error = errors
  }
  expect(kv.has("retro-jobs")).toBe(false)
  expect(seen.some((url) => url.endsWith("/channels/c1/messages"))).toBe(true)
})
