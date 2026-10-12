import { describe, expect, test } from "bun:test"
import { simulateReadableStream, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"

import { Progress } from "../../src/agent/progress"
import { runAgent } from "../../src/agent/run"

const usage = {
  inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

type Chunk = Record<string, unknown> & { type: string }

function finish(reason: "stop" | "tool-calls"): Chunk {
  return { type: "finish", finishReason: { unified: reason, raw: undefined }, usage }
}

function says(text: string): Chunk[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ]
}

function calls(id: string, name: string, input: object): Chunk[] {
  return [
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    finish("tool-calls"),
  ]
}

/** A model that answers each request with the next script, and counts the requests. */
function scripted(...scripts: Chunk[][]): MockLanguageModelV4 & { requests: number } {
  let requests = 0
  const model = new MockLanguageModelV4({
    doStream: () => {
      const chunks = scripts[requests] ?? says("(out of script)")
      requests += 1
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) as never })
    },
  })
  return Object.defineProperty(model, "requests", { get: () => requests }) as never
}

const draft = {
  title: "fix: login loops",
  body: "It loops.",
  repo: "acme/web",
  labels: ["bug"],
  assignee: null,
  confidence: "high",
  questions: [],
}

const lookup = tool({
  description: "Looks a thing up",
  inputSchema: z.object({ path: z.string() }),
  execute: ({ path }) => Promise.resolve(`contents of ${path}`),
})

describe("runAgent", () => {
  test("prose is an answer, and the turn starts the new history", async () => {
    const model = scripted(says("It's in `auth.ts`."))
    const result = await runAgent({
      model,
      tools: {},
      history: [],
      turn: "where is login?",
      candidates: [],
    })
    expect(result.reply).toEqual({ kind: "answer", text: "It's in `auth.ts`." })
    expect(result.messages[0]).toEqual({ role: "user", content: "where is login?" })
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 40 })
  })

  test("each tool call is reported when it starts and when it ends", async () => {
    const model = scripted(calls("c1", "read_file", { path: "auth.ts" }), says("Found it."))
    const progress = new Progress()
    const result = await runAgent({
      model,
      tools: { read_file: lookup },
      history: [],
      turn: "read auth",
      candidates: [],
      events: {
        toolStarted: (id, name, input) => progress.started(id, name, input),
        toolFinished: (id, error) => progress.finished(id, error),
      },
    })
    expect(result.reply.kind).toBe("answer")
    expect(progress.card("done").body).toBe("📄 reading `auth.ts`")
  })

  test("a draft for a repo outside the candidates goes back to the model to fix", async () => {
    const model = scripted(
      calls("c1", "propose_issue", { ...draft, repo: "acme/other" }),
      calls("c2", "propose_issue", draft),
      says("never reached"),
    )
    const progress = new Progress()
    const result = await runAgent({
      model,
      tools: {},
      history: [],
      turn: "file it",
      candidates: ["acme/web"],
      events: {
        toolStarted: (id, name, input) => progress.started(id, name, input),
        toolFinished: (id, error) => progress.finished(id, error),
      },
    })
    expect(result.reply).toMatchObject({ kind: "draft", draft: { repo: "acme/web" } })
    expect(model.requests).toBe(2)
    expect(progress.card("done").body).toContain("isn't one of the candidates")
  })

  test("an aborted run stops with the abort reason", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stopped by ana"))
    const run = runAgent({
      model: scripted(says("too late")),
      tools: {},
      history: [],
      turn: "hi",
      candidates: [],
      signal: controller.signal,
    })
    const outcome = await run.then(
      () => "finished",
      () => "aborted",
    )
    expect(outcome).toBe("aborted")
  })
})
