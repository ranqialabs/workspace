// The language model behind the agent, the retro and the news notes, from
// `AGENT_MODEL`. DeepSeek V4 thinks on its own, so the run gets the model's
// reasoning streamed back without asking for it.
import { createDeepSeek } from "@ai-sdk/deepseek"
import type { LanguageModel } from "ai"

/** Undefined without a DeepSeek key: the retro then lists titles as they are. */
export function modelFor(env: Env): LanguageModel | undefined {
  if (!env.DEEPSEEK_API_KEY) return undefined
  return createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY })(env.AGENT_MODEL)
}
