import { expect, test } from "bun:test"

import worker from "../src/index"

const env = {} as Env
const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

test("the health route answers", async () => {
  const response = await worker.fetch(new Request("https://bob.test/health"), env, ctx)
  expect(await response.text()).toBe("ok")
})

test("anything else is not found", async () => {
  const response = await worker.fetch(new Request("https://bob.test/nope"), env, ctx)
  expect(response.status).toBe(404)
})

test("a platform without its secrets answers as if it were not there", async () => {
  for (const path of ["/discord/interactions", "/slack/events", "/slack/commands"]) {
    const request = new Request(`https://bob.test${path}`, { method: "POST", body: "{}" })
    const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env, ctx)
    expect(response.status).toBe(404)
  }
})

test("the cron ticks the Workspace, and starts the Discord gateway only with a token", async () => {
  const calls: string[] = []
  const WORKSPACE = {
    getByName: (name: string) => ({ tick: () => void calls.push(`tick ${name}`) }),
  }
  const GATEWAY = {
    getByName: (name: string) => ({ start: () => void calls.push(`start ${name}`) }),
  }
  const base = { WORKSPACE, GATEWAY, GITHUB_ORG: "acme" }
  await worker.scheduled({} as ScheduledController, base as unknown as Env)
  expect(calls).toEqual(["tick acme"])
  await worker.scheduled(
    {} as ScheduledController,
    { ...base, DISCORD_TOKEN: "t" } as unknown as Env,
  )
  expect(calls).toEqual(["tick acme", "tick acme", "start discord"])
})
