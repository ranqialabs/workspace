// One run of the agent: the conversation so far, a new turn, and the tools.
// It ends one of two ways, and the model picks: prose when it is answering, or
// a call to `propose_issue` when it was asked for an issue. That call files
// nothing. It records a draft and ends the run; Submit is a human's click.
import {
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
} from "ai"

import { IssueDraft } from "./draft"
import { INSTRUCTIONS } from "./instructions"
import type { Usage } from "./progress"

const MAX_STEPS = 30

export type Reply =
  | { kind: "answer"; text: string }
  | { kind: "draft"; draft: IssueDraft; text: string }

export interface RunEvents {
  toolStarted?(id: string, name: string, input: unknown): void
  toolFinished?(id: string, error?: unknown): void
  text?(soFar: string): void
}

export interface RunInput {
  model: LanguageModel
  tools: ToolSet
  history: ModelMessage[]
  turn: string
  /** Repos a draft may go to. Empty means any repo the org has. */
  candidates: string[]
  extraInstructions?: string
  signal?: AbortSignal
  events?: RunEvents
}

export interface RunResult {
  reply: Reply
  /** The turn and everything the model said and called, to append to history. */
  messages: ModelMessage[]
  usage: Usage
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  let proposed: IssueDraft | undefined
  const propose = tool({
    description:
      "Propose a GitHub issue for a human to review and submit. Use this only when asked for an issue; it files nothing.",
    inputSchema: IssueDraft,
    execute(draft) {
      const { candidates } = input
      if (candidates.length > 0 && !candidates.includes(draft.repo)) {
        throw new Error(
          `\`${draft.repo}\` isn't one of the candidates. Choose from: ${candidates.map((c) => `\`${c}\``).join(", ")}`,
        )
      }
      proposed = draft
      return Promise.resolve("The draft is on screen for a human to review. Stop here.")
    },
  })
  const tools: ToolSet = { ...input.tools, propose_issue: propose }
  const drafted: StopCondition<ToolSet> = () => proposed !== undefined

  const turn: ModelMessage = { role: "user", content: input.turn }
  const instructions = [INSTRUCTIONS, input.extraInstructions].filter(Boolean).join("\n\n")
  const result = streamText({
    model: input.model,
    instructions,
    messages: [...input.history, turn],
    tools,
    stopWhen: [drafted, stepCountIs(MAX_STEPS)],
    abortSignal: input.signal,
  })

  let text = ""
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        text += part.text
        input.events?.text?.(text)
        break
      case "tool-call":
        input.events?.toolStarted?.(part.toolCallId, part.toolName, part.input)
        break
      case "tool-result":
        input.events?.toolFinished?.(part.toolCallId)
        break
      case "tool-error":
        input.events?.toolFinished?.(part.toolCallId, part.error)
        break
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      default:
        break
    }
  }

  const [response, usage, finalText] = await Promise.all([
    result.response,
    result.usage,
    result.text,
  ])
  const reply: Reply =
    proposed === undefined
      ? { kind: "answer", text: finalText.trim() || text.trim() }
      : { kind: "draft", draft: proposed, text: finalText.trim() }
  return {
    reply,
    messages: [turn, ...response.messages],
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    },
  }
}
