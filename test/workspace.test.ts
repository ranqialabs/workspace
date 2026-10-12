import { afterEach, expect, test } from "bun:test"

import { Workspace } from "../src/workspace"
import { memoryDatabase } from "./memory-database"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function workspace() {
  const storage = memoryDatabase()
  const ctx = { storage } as unknown as DurableObjectState
  const env = { GITHUB_ORG: "acme", DISCORD_TOKEN: "t" } as unknown as Env
  return new Workspace(ctx, env)
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
