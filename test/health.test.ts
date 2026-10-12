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

test("the cron leaves the Discord gateway alone without a token", async () => {
  const started: string[] = []
  const gateway = { getByName: (name: string) => ({ start: () => void started.push(name) }) }
  await worker.scheduled({} as ScheduledController, { GATEWAY: gateway } as unknown as Env)
  expect(started).toEqual([])
  const withToken = { GATEWAY: gateway, DISCORD_TOKEN: "t" } as unknown as Env
  await worker.scheduled({} as ScheduledController, withToken)
  expect(started).toEqual(["discord"])
})
