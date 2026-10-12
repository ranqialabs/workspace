import { describe, expect, test } from "bun:test"

import { SlackApi } from "../../src/slack/api"
import { cardBlocks, messageBody, mrkdwn } from "../../src/slack/blocks"
import { SlackChat } from "../../src/slack/chat"
import { type SlackBackend, handleSlack } from "../../src/slack/handle"
import { signatureMatches, type SlashCommand, toCommand } from "../../src/slack/inbound"

const SECRET = "shh"
const NOW = 1_760_000_000_000

async function sign(body: string, timestamp = String(NOW / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  )
  return `v0=${new Uint8Array(mac).toHex()}`
}

/** A Slack API answering from a table by method, recording each call's form. */
function fakeApi(
  answers: Record<string, object>,
  calls: { method: string; form: URLSearchParams }[] = [],
) {
  return new SlackApi("xoxb", async (request) => {
    const method = new URL(request.url).pathname.slice("/api/".length)
    calls.push({ method, form: new URLSearchParams(await request.text()) })
    return Response.json({ ok: true, ...answers[method] })
  })
}

const users = {
  "users.info": {
    user: { id: "U1", name: "ana", is_admin: false, profile: { display_name: "Ana" } },
  },
}

describe("mrkdwn", () => {
  test("bold, links and headings become Slack's, and text is escaped", () => {
    expect(mrkdwn("## Plan\n**fix** [#7](https://x/7) when a < b & c")).toBe(
      "*Plan*\n*fix* <https://x/7|#7> when a &lt; b &amp; c",
    )
  })

  test("mentions and channels pass through untouched", () => {
    expect(mrkdwn("ping <@U123> in <#C9|dev> <!here>")).toBe("ping <@U123> in <#C9|dev> <!here>")
  })

  test("a card is its kicker, linked title, body, fields and footer", () => {
    const blocks = cardBlocks({
      tone: "green",
      kicker: "🐛 Open issue in web",
      title: "Login <loops>",
      url: "https://x/7",
      body: "**now**",
      fields: [{ name: "Assignee", value: "<@U1>" }],
      footer: "opened",
    })
    expect(blocks).toEqual([
      { type: "context", elements: [{ type: "mrkdwn", text: "🟢 🐛 Open issue in web" }] },
      { type: "section", text: { type: "mrkdwn", text: "*<https://x/7|Login &lt;loops&gt;>*" } },
      { type: "section", text: { type: "mrkdwn", text: "*now*" } },
      { type: "section", fields: [{ type: "mrkdwn", text: "*Assignee*\n<@U1>" }] },
      { type: "context", elements: [{ type: "mrkdwn", text: "opened" }] },
    ])
  })

  test("an answer goes as a markdown block, with buttons after it", () => {
    const body = messageBody({ text: "**hi**", buttons: [{ id: "bob:stop:0:x", label: "Stop" }] })
    expect(body.text).toBe("**hi**")
    expect(body.blocks[0]).toEqual({ type: "markdown", text: "**hi**" })
    expect(body.blocks[1]).toMatchObject({
      type: "actions",
      elements: [{ action_id: "bob:stop:0:x" }],
    })
  })
})

describe("signatures", () => {
  test("a fresh, correctly signed body passes", async () => {
    const body = "token=x"
    const ts = String(NOW / 1000)
    expect(await signatureMatches(SECRET, body, ts, await sign(body), NOW)).toBe(true)
    expect(await signatureMatches(SECRET, "tampered", ts, await sign(body), NOW)).toBe(false)
  })

  test("an old timestamp is refused even with a good signature", async () => {
    const old = String(NOW / 1000 - 600)
    expect(await signatureMatches(SECRET, "b", old, await sign("b", old), NOW)).toBe(false)
  })
})

const slash = (text: string): SlashCommand => ({
  command: "/bob",
  text,
  user_id: "U1",
  channel_id: "C1",
  response_url: "https://hooks/x",
})

describe("/bob", () => {
  test("map repo defaults to the channel it runs in", () => {
    expect(toCommand(slash("map repo acme/web"))).toEqual({
      name: "map-repo",
      repo: "acme/web",
      channel: "C1",
      purpose: "home",
    })
    expect(toCommand(slash("map announce acme/web <#C2|news>"))).toMatchObject({
      channel: "C2",
      purpose: "announce",
    })
  })

  test("people come as escaped mentions", () => {
    expect(toCommand(slash("map github ana-gh <@U7|ana>"))).toEqual({
      name: "map-person",
      account: "github",
      value: "ana-gh",
      user: "U7",
      userName: "ana",
    })
    expect(toCommand(slash("unmap linear <@U7>"))).toEqual({
      name: "unmap-person",
      account: "linear",
      user: "U7",
    })
  })

  test("nothing, or config, shows the config; anything else is unknown", () => {
    expect(toCommand(slash(""))).toEqual({ name: "config" })
    expect(toCommand(slash("map github ana-gh"))).toBeUndefined()
    expect(toCommand(slash("dance"))).toBeUndefined()
  })
})

function setup(answers: Record<string, object> = users) {
  const work: Promise<unknown>[] = []
  const responded: { url: string; body: object }[] = []
  const seen: unknown[] = []
  const backend: SlackBackend = {
    mention: (name, origin, turn) => Promise.resolve(void seen.push({ name, origin, turn })),
    command: (command) => Promise.resolve({ text: `ran ${command.name}` }),
    press: (press, user) => Promise.resolve(`${press.action} by ${user.name}`),
  }
  const run = async (kind: "events" | "commands" | "interactions", body: string, headers = {}) => {
    const request = new Request("https://bob.test", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": await sign(body, String(Math.floor(Date.now() / 1000))),
        ...headers,
      },
    })
    const response = await handleSlack(kind, {
      request,
      secret: SECRET,
      chat: new SlackChat(fakeApi(answers)),
      backend,
      waitUntil: (promise) => work.push(promise),
      respond: (url, sent) => Promise.resolve(void responded.push({ url, body: sent })),
    })
    await Promise.all(work)
    return response
  }
  return { run, responded, seen }
}

describe("handler", () => {
  test("Slack's URL check gets its challenge back", async () => {
    const { run } = setup()
    const response = await run(
      "events",
      JSON.stringify({ type: "url_verification", challenge: "c" }),
    )
    expect(await response.json()).toEqual({ challenge: "c" })
  })

  test("a mention becomes a turn in its thread's conversation, without bob's own mention", async () => {
    const { run, seen } = setup()
    const event = {
      type: "event_callback",
      event_id: "E1",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UBOT> where is login?",
        ts: "17.5",
        channel: "C1",
      },
    }
    await run("events", JSON.stringify(event))
    expect(seen).toEqual([
      {
        name: "slack:C1:17.5",
        origin: { platform: "slack", scope: ["C1"], link: "https://slack.com/archives/C1/p175" },
        turn: {
          channel: "C1",
          thread: "17.5",
          message: "17.5",
          author: { id: "U1", name: "Ana" },
          text: "where is login?",
        },
      },
    ])
  })

  test("a retried event is acknowledged and not run twice", async () => {
    const { run, seen } = setup()
    await run("events", JSON.stringify({ type: "event_callback" }), { "x-slack-retry-num": "1" })
    expect(seen).toEqual([])
  })

  test("only admins change mappings; the reply goes to the response URL", async () => {
    const { run, responded } = setup()
    const form = new URLSearchParams({
      command: "/bob",
      text: "map repo acme/web",
      user_id: "U1",
      channel_id: "C1",
      response_url: "https://hooks/1",
    })
    await run("commands", form.toString())
    expect(responded[0]).toMatchObject({
      url: "https://hooks/1",
      body: {
        response_type: "ephemeral",
        text: "Only workspace admins can change bob's mappings.",
      },
    })
    form.set("text", "config")
    await run("commands", form.toString())
    expect(responded[1]?.body).toMatchObject({ text: "ran config" })
  })

  test("a button press reaches its conversation and the answer is private", async () => {
    const { run, responded } = setup()
    const payload = {
      type: "block_actions",
      user: { id: "U1" },
      actions: [{ action_id: "bob:discard:2:slack:C1:17.5" }],
      response_url: "https://hooks/2",
    }
    await run("interactions", new URLSearchParams({ payload: JSON.stringify(payload) }).toString())
    expect(responded).toEqual([
      {
        url: "https://hooks/2",
        body: { response_type: "ephemeral", replace_original: false, text: "discard by Ana" },
      },
    ])
  })

  test("an unsigned request is refused", async () => {
    const { run } = setup()
    const response = await run("events", "{}", { "x-slack-signature": "v0=00" })
    expect(response.status).toBe(401)
  })
})

describe("chat", () => {
  test("posts in the thread it replies to and returns the message's ts", async () => {
    const calls: { method: string; form: URLSearchParams }[] = []
    const chat = new SlackChat(
      fakeApi({ "chat.postMessage": { ts: "18.1", channel: "C1" } }, calls),
    )
    const ref = await chat.post("C1", { text: "hi", replyTo: { channel: "C1", id: "17.5" } })
    expect(ref).toEqual({ channel: "C1", id: "18.1" })
    expect(calls[0]?.form.get("thread_ts")).toBe("17.5")
    expect(JSON.parse(calls[0]?.form.get("blocks") ?? "[]")).toEqual([
      { type: "markdown", text: "hi" },
    ])
  })

  test("reads a thread back oldest first, with names for people and mentions", async () => {
    const chat = new SlackChat(
      fakeApi({
        ...users,
        "conversations.replies": {
          messages: [
            { ts: "1.0", user: "U1", text: "ask <@U1>" },
            { ts: "2.0", bot_id: "B1", username: "bob", text: "answer" },
            { ts: "3.0", user: "U1", text: "the mention itself" },
          ],
        },
      }),
    )
    const messages = await chat.read("C1", { thread: "1.0", before: "3.0", limit: 10 })
    expect(messages.map((m) => [m.author.name, m.author.bot, m.text])).toEqual([
      ["Ana", false, "ask @Ana"],
      ["bob", true, "answer"],
    ])
  })
})
