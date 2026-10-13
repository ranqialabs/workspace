import { expect, test } from "bun:test"

import { faces } from "../../src/retro/faces"

test("a face keeps its initial when the avatar does not load", async () => {
  const found = await faces(["ana", "beto"], [], (request) =>
    Promise.resolve(
      request.url.includes("/ana.png")
        ? new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } })
        : new Response("not found", { status: 404 }),
    ),
  )
  expect(found.get("ana")?.avatar).toBe("data:image/png;base64,CQ==")
  expect(found.get("beto")?.avatar).toBeUndefined()
})
