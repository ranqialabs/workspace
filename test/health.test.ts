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
