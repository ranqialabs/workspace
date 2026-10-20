// What one run cost, from DeepSeek's list prices in dollars per million tokens.
// A model with no price here shows no cost rather than a wrong one.
import type { Usage } from "./progress"

interface Price {
  input: number
  output: number
  /** A cached input token is billed at a few percent of a fresh one. */
  cached: number
}

const PRICES: Record<string, Price> = {
  "deepseek-flash": { input: 0.15, output: 0.6, cached: 0.003 },
  "deepseek-v4-flash": { input: 0.15, output: 0.6, cached: 0.003 },
  "deepseek-v4-flash-vision-exp": { input: 0.15, output: 0.6, cached: 0.003 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cached: 0.022 },
}

/** The run's cost in dollars, or undefined when the model's price is unknown. */
export function costOf(usage: Usage, model: string): number | undefined {
  const price = PRICES[model]
  if (price === undefined) return undefined
  // Cached tokens are part of the input count, at their own price.
  const cached = Math.min(usage.cachedTokens, usage.inputTokens)
  const fresh = usage.inputTokens - cached
  return (
    (fresh * price.input + cached * price.cached + usage.outputTokens * price.output) / 1_000_000
  )
}
