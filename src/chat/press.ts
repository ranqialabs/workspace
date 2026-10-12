// What a button press asks for. A button's id names the action, its target and
// the conversation that owns it, `bob:submit:12:slack:C1:1700.01`, so either
// platform routes a press back to the right object. A news card's buttons
// belong to no conversation yet, `bob:explain:7`, and go to the Workspace.
import { z } from "zod"

const CONVERSATION_ACTION = z.enum(["stop", "submit", "discard"])
const NEWS_ACTION = z.enum(["explain"])

export type ConversationAction = z.infer<typeof CONVERSATION_ACTION>
export type NewsAction = z.infer<typeof NEWS_ACTION>

export type Press =
  | { action: ConversationAction; target: number; conversation: string }
  | { action: NewsAction; target: number }

export function pressId(action: ConversationAction, target: number, conversation: string): string
export function pressId(action: NewsAction, target: number): string
export function pressId(action: string, target: number, conversation?: string): string {
  return conversation === undefined
    ? `bob:${action}:${target}`
    : `bob:${action}:${target}:${conversation}`
}

/** A button id from `pressId`, or undefined for one that is not bob's. */
export function parsePress(id: string): Press | undefined {
  const [prefix, action, target, ...rest] = id.split(":")
  if (prefix !== "bob" || !/^\d+$/.test(target ?? "")) return undefined
  const conversation = rest.join(":")
  const news = NEWS_ACTION.safeParse(action)
  if (news.success && rest.length === 0) return { action: news.data, target: Number(target) }
  const owned = CONVERSATION_ACTION.safeParse(action)
  if (!owned.success || conversation === "") return undefined
  return { action: owned.data, target: Number(target), conversation }
}
