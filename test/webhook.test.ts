import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import { readDelivery, signatureMatches } from "../src/github/webhook"

const secret = "hush"
const body = JSON.stringify({ action: "opened" })
const sign = (text: string, key = secret) =>
  "sha256=" + createHmac("sha256", key).update(text).digest("hex")

test("a body signed with the secret matches", async () => {
  expect(await signatureMatches(secret, body, sign(body))).toBe(true)
})

test("another secret, another body or no header does not", async () => {
  expect(await signatureMatches(secret, body, sign(body, "other"))).toBe(false)
  expect(await signatureMatches(secret, body + " ", sign(body))).toBe(false)
  expect(await signatureMatches(secret, body, null)).toBe(false)
  expect(await signatureMatches(secret, body, "sha1=abc")).toBe(false)
})

test("a signed delivery comes out with its event and payload", async () => {
  const request = new Request("https://bob.test/github/webhook", {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": "issues",
      "x-github-delivery": "d1",
    },
  })
  expect(await readDelivery(request, secret)).toEqual({
    id: "d1",
    event: "issues",
    payload: { action: "opened" },
  })
})

test("an unsigned delivery is refused before it is parsed", async () => {
  const request = new Request("https://bob.test/github/webhook", {
    method: "POST",
    body: "not json",
  })
  const result = await readDelivery(request, secret)
  expect(result instanceof Response && result.status).toBe(401)
})
