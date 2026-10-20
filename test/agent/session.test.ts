import { describe, expect, test } from "bun:test"

import { recentTurns, Session, type Turn } from "../../src/agent/session"
import { Sauron } from "../../src/sauron/client"
import type { Person } from "../../src/store/config"
import { FakeChat } from "../fake-chat"
import { memoryDatabase } from "../memory-database"
import { type Calls, fakeGitHub } from "./github"
import { calls, HANG, says, scripted } from "./model"

const ana = { id: "u1", name: "Ana" }
const beto = { id: "u2", name: "Beto" }

const draft = {
  title: "fix: login loops",
  body: "It loops.",
  repo: "acme/web",
  labels: ["bug"],
  assignee: "ana-gh",
  confidence: "high",
  questions: [],
}

function turn(message: string, text: string, author = ana): Turn {
  return { channel: "c", message, author, text }
}

function setup(model: ReturnType<typeof scripted>, sauron?: Sauron) {
  const chat = new FakeChat("discord")
  const github: Calls = []
  const teammates: Person[] = [
    { id: 1, name: "Ana", github: "ana-gh", linear: null, discord: "u1", slack: null },
  ]
  const session = new Session(memoryDatabase(), {
    name: "discord:c:",
    chat,
    modelId: "deepseek-v4-flash",
    model: () => model,
    sauron: () => sauron,
    github: () =>
      Promise.resolve(
        fakeGitHub(
          { "issues.create": { number: 41, html_url: "https://github.com/acme/web/issues/41" } },
          github,
        ),
      ),
    surroundings: () =>
      Promise.resolve({
        org: "acme",
        candidates: ["acme/web"],
        teammates,
        link: "https://discord.com/channels/g/c",
      }),
  })
  return { chat, github, session }
}

/** The Stop, File issue or Discard button's id on the last message that has one. */
function button(chat: FakeChat, label: string): { action: string; target: number } {
  const all = [...chat.posts, ...chat.edits.values()].flatMap((message) => message.buttons ?? [])
  const found = all.findLast((candidate) => candidate.label === label)
  if (found === undefined) throw new Error(`no ${label} button`)
  const [, action = "", target = "0"] = found.id.split(":")
  return { action, target: Number(target) }
}

describe("answering", () => {
  test("a mention gets one message, the recent messages, then the answer in it", async () => {
    const model = scripted(says("It's in `auth.ts`."))
    const { chat, session } = setup(model)
    chat.history = [
      {
        id: "m0",
        author: { id: "u2", name: "Beto", bot: false },
        text: "login is broken",
        at: "2026-10-12T10:00:00Z",
      },
    ]
    await session.mention(turn("q1", "where is login?"))

    // One message for the whole run: posted while it thinks, edited into the answer.
    expect(chat.posts).toHaveLength(1)
    expect(chat.posts[0]?.text).toBe("💭 Thinking…")
    expect(chat.posts[0]?.buttons?.map((b) => b.label)).toEqual(["Stop"])
    const done = chat.edits.get("m1")
    expect(done?.buttons).toBeUndefined()
    expect(done?.cards).toBeUndefined()
    expect(done?.text).toStartWith("It's in `auth.ts`.\n\n✅")
    expect(done?.text).toContain("tokens")
    expect(chat.log).toContain("read c before q1")
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("Beto: login is broken")
  })

  test("the next turn carries the history and does not read the channel again", async () => {
    const model = scripted(says("First."), says("Second."))
    const { chat, session } = setup(model)
    await session.mention(turn("q1", "one"))
    await session.mention(turn("q2", "two"))
    expect(chat.log.filter((line) => line.startsWith("read"))).toHaveLength(1)
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(prompt).toContain("First.")
    expect(prompt).toContain("Ana: two")
  })

  test("a mention during a run is queued and answered next", async () => {
    const gate = Promise.withResolvers<void>()
    const model = scripted({ after: gate.promise, chunks: says("A.") }, says("B."))
    const { chat, session } = setup(model)
    const first = session.mention(turn("q1", "one"))
    await Bun.sleep(5)
    await session.mention(turn("q2", "two", beto))
    expect(chat.log).toContain(
      "post c/m2 ↩q2 ⏳ Queued. I'll answer this right after the current one.",
    )
    gate.resolve()
    await first
    expect(model.requests).toBe(2)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Beto: two")
    expect(chat.log.at(-1)).toStartWith("edit c/m3 B.")
  })

  test("only the person who asked can stop the run", async () => {
    const model = scripted(HANG)
    const { chat, session } = setup(model)
    const run = session.mention(turn("q1", "go"))
    await Bun.sleep(5)
    const stop = button(chat, "Stop")
    expect(await session.press("stop", stop.target, beto)).toBe("Only Ana can stop this answer.")
    expect(await session.press("stop", stop.target, ana)).toBeUndefined()
    await run
    expect(chat.edits.get("m1")?.text).toBe("⚪ Stopped by Ana")
    expect(await session.press("stop", 0, ana)).toBe("Nothing is running here.")
  })
})

describe("drafts", () => {
  test("a draft gets File issue and Discard, and File issue files it as drafted", async () => {
    const model = scripted(calls("c1", "propose_issue", draft))
    const { chat, github, session } = setup(model)
    await session.mention(turn("q1", "abre uma issue"))

    const submit = button(chat, "File issue")
    expect(await session.press("submit", submit.target, beto)).toBe(
      "Only whoever asked for this draft can file or discard it.",
    )
    expect(await session.press("submit", submit.target, ana)).toBeUndefined()

    expect(github[0]).toEqual({
      method: "issues.create",
      params: {
        owner: "acme",
        repo: "web",
        title: "fix: login loops",
        body: "It loops.\n\n---\nDiscussed in https://discord.com/channels/g/c",
        labels: ["bug"],
        assignees: ["ana-gh"],
      },
    })
    expect(chat.edits.get("m2")?.cards?.[0]).toMatchObject({ kicker: "📝 Filed as #41 in web" })
    expect(chat.log.at(-1)).toBe(
      "post c/m3 ↩m2 ✅ Filed [#41](https://github.com/acme/web/issues/41) in web.",
    )
    expect(await session.press("submit", submit.target, ana)).toBe("This draft was already filed.")
  })

  test("a revised draft replaces the open one, which loses its buttons", async () => {
    const model = scripted(
      calls("c1", "propose_issue", draft),
      calls("c2", "propose_issue", { ...draft, title: "fix: login loops on Safari" }),
    )
    const { chat, session } = setup(model)
    await session.mention(turn("q1", "abre uma issue"))
    await session.mention(turn("q2", "it's only Safari"))
    expect(chat.edits.get("m2")).toMatchObject({
      buttons: [],
      cards: [{ kicker: "📝 Replaced draft for web" }],
    })
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("An issue draft is open")
  })

  test("Discard closes the draft without touching GitHub", async () => {
    const model = scripted(calls("c1", "propose_issue", draft))
    const { chat, github, session } = setup(model)
    await session.mention(turn("q1", "abre uma issue"))
    expect(await session.press("discard", button(chat, "Discard").target, ana)).toBeUndefined()
    expect(github).toEqual([])
    expect(chat.edits.get("m2")?.cards?.[0]).toMatchObject({ kicker: "📝 Discarded draft for web" })
  })
})

test("history is cut at a turn, so a tool call keeps its result", () => {
  const messages = [
    { role: "user" as const, content: "a" },
    { role: "assistant" as const, content: "b" },
    { role: "user" as const, content: "c" },
    { role: "tool" as const, content: [] },
  ]
  expect(recentTurns(messages, 1)).toEqual(messages.slice(2))
  expect(recentTurns(messages, 5)).toEqual(messages)
})

/** The tools and system prompt of the model's first request. */
function seen(model: ReturnType<typeof scripted>): { tools: string[]; system: string } {
  const [request] = model.doStreamCalls
  const system = request?.prompt.find((message) => message.role === "system")
  return {
    tools: (request?.tools ?? []).map((one) => one.name),
    system: typeof system?.content === "string" ? system.content : "",
  }
}

describe("Sauron", () => {
  test("with a token the model gets the Sauron tools and how to use them", async () => {
    const model = scripted(says("ok"))
    const { session } = setup(model, new Sauron("https://sauron.test", "glsa_token"))
    await session.mention(turn("q1", "is mary slow?"))
    const { tools, system } = seen(model)
    expect(tools).toEqual(expect.arrayContaining(["query_metrics", "query_logs", "query_sql"]))
    expect(tools).toContain("read_file")
    expect(system).toContain("Sauron (sauron.ranqia.io)")
  })

  test("without one they stay out", async () => {
    const model = scripted(says("ok"))
    const { session } = setup(model)
    await session.mention(turn("q1", "is mary slow?"))
    const { tools, system } = seen(model)
    expect(tools).not.toContain("query_metrics")
    expect(system).not.toContain("Sauron")
  })
})
