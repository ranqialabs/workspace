// Every emoji bob shows, in one place. A card's kind emoji says what it is
// about and never changes with its state; colour says the state, on the
// embed's bar in Discord and as a dot in Slack, which has no bar. A line in a
// list starts with a mark saying how that one thing went.
import type { Tone } from "./card"

export const KIND = {
  issue: "🐛",
  pull: "🔀",
  checks: "🚦",
  deploy: "🚀",
  bob: "🤖",
  draft: "📝",
  config: "⚙️",
} as const

export const MARK = {
  done: "✅",
  failed: "❌",
  waiting: "⏳",
  warning: "⚠️",
  comment: "💬",
} as const

/** Slack's stand-in for the colour bar; the brand colour needs no dot. */
export const DOT: Record<Tone, string> = {
  green: "🟢",
  purple: "🟣",
  red: "🔴",
  blue: "🔵",
  grey: "⚪",
  brand: "",
}

/** The mark for a three-way outcome: undefined means it is still going. */
export function outcomeMark(ok: boolean | undefined): string {
  if (ok === undefined) return MARK.waiting
  return ok ? MARK.done : MARK.failed
}

/** The tone for a three-way outcome, to match `outcomeMark`. */
export function outcomeTone(ok: boolean | undefined): Tone {
  if (ok === undefined) return "blue"
  return ok ? "green" : "red"
}
