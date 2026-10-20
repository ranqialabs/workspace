// A language model that plays back scripted responses, one per request.
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"

const usage = {
  inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

export type Chunk = Record<string, unknown> & { type: string }

function finish(reason: "stop" | "tool-calls"): Chunk {
  return { type: "finish", finishReason: { unified: reason, raw: undefined }, usage }
}

export function says(text: string): Chunk[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ]
}

/** Reasoning before the answer, as a thinking model streams it. */
export function thinks(thought: string, text: string): Chunk[] {
  return [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: thought },
    { type: "reasoning-end", id: "r" },
    ...says(text),
  ]
}

export function calls(id: string, name: string, input: object): Chunk[] {
  return [
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    finish("tool-calls"),
  ]
}

/** A script that never answers; the request fails only when the run is aborted. */
export const HANG = "hang"

/**
 * A model that answers each request with the next script, and counts the
 * requests. A script can be a promise to wait for before streaming.
 */
export function scripted(
  ...scripts: (Chunk[] | typeof HANG | { after: Promise<unknown>; chunks: Chunk[] })[]
): MockLanguageModelV4 & { requests: number } {
  let requests = 0
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const script = scripts[requests] ?? says("(out of script)")
      requests += 1
      if (script === HANG) {
        return new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason as Error))
        })
      }
      if (!Array.isArray(script)) {
        await script.after
        return { stream: simulateReadableStream({ chunks: script.chunks }) as never }
      }
      return { stream: simulateReadableStream({ chunks: script }) as never }
    },
  })
  return Object.defineProperty(model, "requests", { get: () => requests }) as never
}
