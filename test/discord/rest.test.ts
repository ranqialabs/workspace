import { expect, test } from "bun:test"

import { DiscordChat, embed, messageBody } from "../../src/discord/messages"
import { DiscordError, DiscordRest } from "../../src/discord/rest"

function recorder(...responses: Response[]) {
  const seen: Request[] = []
  const fetcher = (request: Request) => {
    seen.push(request)
    const next = responses.shift()
    if (next === undefined) throw new Error("no response left")
    return Promise.resolve(next)
  }
  return { seen, fetcher }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

test("requests carry the bot token and a JSON body", async () => {
  const { seen, fetcher } = recorder(json({ id: "m1" }))
  const chat = new DiscordChat(new DiscordRest("t0ken", fetcher))
  expect(await chat.post("c1", { text: "hi" })).toEqual({ channel: "c1", id: "m1" })
  const [request] = seen
  expect(request?.url).toBe("https://discord.com/api/v10/channels/c1/messages")
  expect(request?.headers.get("authorization")).toBe("Bot t0ken")
  expect(await request?.json()).toMatchObject({ content: "hi", embeds: [] })
})

test("a rate limit is waited out and the request retried", async () => {
  const waits: number[] = []
  const { seen, fetcher } = recorder(json({ retry_after: 0.25 }, 429), json({ id: "m2" }))
  const rest = new DiscordRest("t", fetcher, (ms) => {
    waits.push(ms)
    return Promise.resolve()
  })
  expect(await rest.post("/x")).toEqual({ id: "m2" })
  expect(waits).toEqual([250])
  expect(seen).toHaveLength(2)
})

test("other failures name the status and the route", async () => {
  const { fetcher } = recorder(new Response("Missing Access", { status: 403 }))
  const error = await new DiscordRest("t", fetcher)
    .get("/guilds/1")
    .catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(DiscordError)
  expect(String(error)).toContain("Discord 403 on GET /guilds/1: Missing Access")
})

test("an edit sends no reply reference", async () => {
  const { seen, fetcher } = recorder(json({ id: "m1" }))
  await new DiscordChat(new DiscordRest("t", fetcher)).edit(
    { channel: "c", id: "m1" },
    { text: "x", replyTo: { channel: "c", id: "m0" } },
  )
  expect(seen[0]?.method).toBe("PATCH")
  expect(await seen[0]?.json()).not.toHaveProperty("message_reference")
})

test("a card becomes an embed within Discord's limits", () => {
  const drawn = embed({
    tone: "red",
    kicker: "❌ pipeline · web",
    title: "x".repeat(300),
    body: "line",
    fields: [{ name: "a", value: "b" }],
    footer: "acme/web",
    at: "2026-10-12T10:00:00Z",
  })
  expect(drawn.color).toBe(0xcf222e)
  expect(drawn.title).toHaveLength(256)
  expect(drawn.title.endsWith("…")).toBe(true)
  expect(drawn.fields).toEqual([{ name: "a", value: "b", inline: false }])
})

test("buttons go five to a row and a reply points at its message", () => {
  const buttons = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, label: `B${i}` }))
  const body = messageBody({ buttons, replyTo: { channel: "c", id: "m9" } })
  expect(body.components.map((row) => row.components.length)).toEqual([5, 1])
  expect(body.message_reference).toEqual({ message_id: "m9", fail_if_not_exists: false })
})
