import { describe, expect, test } from "bun:test"

import { addresses, DiscordMessage, toChatMessage } from "../../src/discord/inbound"
import { DiscordChat } from "../../src/discord/messages"
import { split } from "../../src/ui/text"
import { DiscordRest } from "../../src/discord/rest"
import { DiscordRouter } from "../../src/discord/route"

const BOT = "900"

function message(extra: object = {}): DiscordMessage {
  return DiscordMessage.parse({
    id: "1",
    channel_id: "c",
    author: { id: "10", username: "ana", global_name: "Ana Lima" },
    content: "<@900> what does <@!11> own?",
    timestamp: "2026-10-12T10:00:00Z",
    mentions: [
      { id: BOT, username: "bob", bot: true },
      { id: "11", username: "beto", member: { nick: "Beto" } },
    ],
    ...extra,
  })
}

describe("reading a message", () => {
  test("mentions read as names, nicknames first", () => {
    expect(toChatMessage(message())).toMatchObject({
      author: { id: "10", name: "Ana Lima", bot: false },
      text: "@bob what does @Beto own?",
    })
  })

  test("bob answers a mention and a reply to it, and never itself or another bot", () => {
    expect(addresses(message(), BOT)).toBe(true)
    const reply = message({
      content: "and this?",
      mentions: [],
      referenced_message: { id: "0", author: { id: BOT } },
    })
    expect(addresses(reply, BOT)).toBe(true)
    expect(addresses(message({ content: "hi", mentions: [] }), BOT)).toBe(false)
    expect(addresses(message({ author: { id: "12", username: "ci", bot: true } }), BOT)).toBe(false)
  })
})

describe("long text", () => {
  test("splits at a line break near the limit", () => {
    const text = `${"a".repeat(8)}\n${"b".repeat(4)}`
    expect(split(text, 10)).toEqual(["aaaaaaaa", "bbbb"])
  })

  test("a line longer than the limit is cut where it must be", () => {
    expect(split("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)])
  })

  test("only the first piece replies and only the last carries the cards", async () => {
    const bodies: Record<string, unknown>[] = []
    let next = 0
    const rest = new DiscordRest("t", async (request) => {
      bodies.push(await request.json())
      next += 1
      return Response.json({ id: `m${next}` })
    })
    const chat = new DiscordChat(rest)
    const ref = await chat.post("c", {
      text: "y".repeat(2500),
      cards: [{ tone: "grey", kicker: "k", title: "t" }],
      replyTo: { channel: "c", id: "1" },
    })
    expect(ref).toEqual({ channel: "c", id: "m2" })
    expect(bodies.map((body) => [body.message_reference !== undefined, body.embeds])).toEqual([
      [true, []],
      [false, [expect.objectContaining({ title: "t" })]],
    ])
  })
})

function fakeRouter(channels: Record<string, object>) {
  const asked: string[] = []
  const rest = new DiscordRest("t", (request) => {
    const id = new URL(request.url).pathname.split("/").at(-1) ?? ""
    asked.push(id)
    return Promise.resolve(Response.json(channels[id] ?? { type: 0 }))
  })
  return { asked, router: new DiscordRouter(rest) }
}

describe("routing", () => {
  test("a mention in a thread is that thread's conversation, scoped to its parent too", async () => {
    const { asked, router: discord } = fakeRouter({ c: { type: 11, parent_id: "p" } })
    const routed = await discord.route(message({ guild_id: "g" }), BOT)
    expect(routed).toEqual({
      name: "discord:c:",
      origin: {
        platform: "discord",
        scope: ["c", "p"],
        link: "https://discord.com/channels/g/c",
      },
      turn: {
        channel: "c",
        message: "1",
        author: { id: "10", name: "Ana Lima" },
        text: "what does @Beto own?",
      },
    })
    await discord.route(message({ id: "2" }), BOT)
    expect(asked).toEqual(["c"])
  })

  test("a message that does not call bob goes nowhere", async () => {
    const { asked, router: discord } = fakeRouter({})
    expect(await discord.route(message({ content: "hi", mentions: [] }), BOT)).toBeUndefined()
    expect(asked).toEqual([])
  })
})
