// A client that keeps the global `fetch` as a method of itself breaks in
// Workers: the receiver becomes the client, and workerd refuses it with
// "Illegal invocation". The default fetcher has to call the global, not hold it.
import { afterEach, describe, expect, test } from "bun:test"

import { Sauron } from "../src/sauron/client"

const original = globalThis.fetch

/** What workerd's `fetch` does: any receiver but the global is an error. */
function strictFetch(this: unknown): Promise<Response> {
  if (this !== undefined) throw new TypeError("Illegal invocation: incorrect `this` reference")
  return Promise.resolve(new Response('{"results":{"A":{"frames":[]}}}'))
}

afterEach(() => {
  globalThis.fetch = original
})

describe("the default fetcher", () => {
  test("calls fetch with no receiver, the way Workers requires", async () => {
    globalThis.fetch = strictFetch as unknown as typeof fetch

    const sauron = new Sauron("https://sauron.test", "glsa_token")
    expect(await sauron.query("mimir", {}, { from: 1, to: 2 })).toEqual([])
  })
})
