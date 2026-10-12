import { beforeAll, describe, expect, test } from "bun:test"

import type { Command } from "../../src/commands"
import { type Backend, handleInteraction } from "../../src/discord/handle"
import { type Interaction, signatureMatches, toCommand } from "../../src/discord/interactions"
import { DiscordRest } from "../../src/discord/rest"

let keys: CryptoKeyPair
let publicKey: string

beforeAll(async () => {
  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  if (!("privateKey" in generated)) throw new Error("Ed25519 should make a key pair")
  keys = generated
  const raw = (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer
  publicKey = new Uint8Array(raw).toHex()
})

async function signed(body: object, timestamp = "1700000000"): Promise<Request> {
  const text = JSON.stringify(body)
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(timestamp + text),
  )
  return new Request("https://bob.test/discord/interactions", {
    method: "POST",
    body: text,
    headers: {
      "x-signature-ed25519": new Uint8Array(signature).toHex(),
      "x-signature-timestamp": timestamp,
    },
  })
}

function interaction(type: number, data?: object): Interaction {
  return { id: "i1", application_id: "app", type, token: "tok", data }
}

function sub(name: string, subcommand: string, options: object[]) {
  return interaction(2, { name, options: [{ type: 1, name: subcommand, options }] })
}

function rest(patched: { url: string; body: unknown }[]) {
  return new DiscordRest("t", async (request) => {
    patched.push({ url: request.url, body: await request.json() })
    return Response.json({ id: "m" })
  })
}

describe("signatures", () => {
  test("a body signed with the app's key passes", async () => {
    const request = await signed({ type: 1 })
    const ok = await signatureMatches(
      publicKey,
      await request.text(),
      request.headers.get("x-signature-ed25519"),
      "1700000000",
    )
    expect(ok).toBe(true)
  })

  test("a changed timestamp fails", async () => {
    const request = await signed({ type: 1 })
    const ok = await signatureMatches(
      publicKey,
      await request.text(),
      request.headers.get("x-signature-ed25519"),
      "1700000001",
    )
    expect(ok).toBe(false)
  })

  test("missing or malformed headers fail without throwing", async () => {
    expect(await signatureMatches(publicKey, "{}", null, "1")).toBe(false)
    expect(await signatureMatches(publicKey, "{}", "zz", "1")).toBe(false)
  })
})

describe("commands", () => {
  test("map repo and map announce name a purpose", () => {
    const options = [
      { type: 3, name: "repo", value: "acme/web" },
      { type: 7, name: "channel", value: "c1" },
    ]
    expect(toCommand(sub("map", "repo", options))).toEqual({
      name: "map-repo",
      repo: "acme/web",
      channel: "c1",
      purpose: "home",
    })
    expect(toCommand(sub("map", "announce", options))).toMatchObject({ purpose: "announce" })
  })

  test("map github takes the member's display name from the resolved users", () => {
    const command = toCommand({
      ...sub("map", "github", [
        { type: 3, name: "login", value: "ana" },
        { type: 6, name: "member", value: "U1" },
      ]),
    })
    expect(command).toEqual({
      name: "map-person",
      account: "github",
      value: "ana",
      user: "U1",
      userName: undefined,
    })
    const withName = sub("map", "linear", [
      { type: 3, name: "email", value: "ana@acme.dev" },
      { type: 6, name: "member", value: "U1" },
    ])
    withName.data = {
      ...withName.data,
      resolved: { users: { U1: { id: "U1", username: "ana", global_name: "Ana" } } },
    }
    expect(toCommand(withName)).toMatchObject({ account: "linear", userName: "Ana" })
  })

  test("unmap repo forgets the home channel unless asked for announce", () => {
    const repo = { type: 3, name: "repo", value: "acme/web" }
    expect(toCommand(sub("unmap", "repo", [repo]))).toMatchObject({ purpose: "home" })
    expect(
      toCommand(sub("unmap", "repo", [repo, { type: 5, name: "announce", value: true }])),
    ).toMatchObject({ purpose: "announce" })
  })

  test("a command with options missing is not a command", () => {
    expect(toCommand(sub("map", "repo", [{ type: 3, name: "repo", value: "x" }]))).toBeUndefined()
    expect(toCommand(interaction(2, { name: "nope" }))).toBeUndefined()
  })
})

describe("handler", () => {
  const ran: Command[] = []
  const backend: Backend = {
    command(command) {
      ran.push(command)
      return Promise.resolve({ text: "done" })
    },
    suggest: (field, typed) => Promise.resolve([`${field}:${typed}`]),
  }

  test("an unsigned request is refused", async () => {
    const request = new Request("https://bob.test", { method: "POST", body: "{}" })
    const response = await handleInteraction(request, publicKey, backend, rest([]), () => {})
    expect(response.status).toBe(401)
  })

  test("Discord's ping gets a pong", async () => {
    const response = await handleInteraction(
      await signed(interaction(1)),
      publicKey,
      backend,
      rest([]),
      () => {},
    )
    expect(await response.json()).toEqual({ type: 1 })
  })

  test("autocomplete offers what the backend suggests for the focused field", async () => {
    const body = interaction(4, {
      name: "map",
      options: [
        { type: 1, name: "repo", options: [{ type: 3, name: "repo", value: "we", focused: true }] },
      ],
    })
    const response = await handleInteraction(
      await signed(body),
      publicKey,
      backend,
      rest([]),
      () => {},
    )
    expect(await response.json()).toEqual({
      type: 8,
      data: { choices: [{ name: "repo:we", value: "repo:we" }] },
    })
  })

  test("a command is deferred, then its reply fills in the original message", async () => {
    const patched: { url: string; body: unknown }[] = []
    const pending: Promise<unknown>[] = []
    const response = await handleInteraction(
      await signed(interaction(2, { name: "config" })),
      publicKey,
      backend,
      rest(patched),
      (work) => pending.push(work),
    )
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } })
    await Promise.all(pending)
    expect(ran.at(-1)).toEqual({ name: "config" })
    expect(patched[0]?.url).toBe("https://discord.com/api/v10/webhooks/app/tok/messages/@original")
    expect(patched[0]?.body).toMatchObject({ content: "done" })
  })

  test("a failing command says so instead of leaving Discord spinning", async () => {
    const patched: { url: string; body: unknown }[] = []
    const pending: Promise<unknown>[] = []
    const failing: Backend = { ...backend, command: () => Promise.reject(new Error("boom")) }
    const original = console.error
    console.error = () => {}
    await handleInteraction(
      await signed(interaction(2, { name: "config" })),
      publicKey,
      failing,
      rest(patched),
      (work) => pending.push(work),
    )
    await Promise.all(pending)
    console.error = original
    expect(patched[0]?.body).toMatchObject({ content: expect.stringContaining("went wrong") })
  })
})
