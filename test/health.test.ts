import { expect, test } from "bun:test"

import worker from "../src/index"

test("the health route answers", async () => {
  const response = worker.fetch(new Request("https://bob.test/health"))
  expect(await response.text()).toBe("ok")
})
