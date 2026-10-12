// The language model behind the agent and the retro, from `AGENT_MODEL`.
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"

/** Undefined without an OpenAI key: the retro then lists titles as they are. */
export function modelFor(env: Env): LanguageModel | undefined {
  if (!env.OPENAI_API_KEY) return undefined
  return createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.AGENT_MODEL)
}
