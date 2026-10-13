// What Slack sends bob: events, slash commands and button presses, all signed
// with the app's signing secret. Nothing is read before the signature checks
// out and the timestamp is recent, so a captured request cannot be replayed.
import { z } from "zod"

import type { Command } from "../commands"

const MAX_SKEW_SECONDS = 5 * 60

export async function signatureMatches(
  secret: string,
  body: string,
  timestamp: string | null,
  signature: string | null,
  now: number = Date.now(),
): Promise<boolean> {
  if (timestamp === null || signature === null || !signature.startsWith("v0=")) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false
  const hex = signature.slice(3)
  if (!/^[0-9a-f]{64}$/.test(hex)) return false
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const signed = new TextEncoder().encode(`v0:${timestamp}:${body}`)
  return crypto.subtle.verify("HMAC", key, Uint8Array.fromHex(hex), signed)
}

/** Reads a request's body once its signature is good; a Response to send back otherwise. */
export async function readSigned(request: Request, secret: string): Promise<string | Response> {
  const body = await request.text()
  const ok = await signatureMatches(
    secret,
    body,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature"),
  )
  return ok ? body : new Response("bad signature", { status: 401 })
}

export const Mention = z.object({
  type: z.literal("app_mention"),
  user: z.string(),
  text: z.string(),
  ts: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
})

export type Mention = z.infer<typeof Mention>

export const EventEnvelope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_verification"), challenge: z.string() }),
  z.object({
    type: z.literal("event_callback"),
    event_id: z.string(),
    event: z.looseObject({ type: z.string() }),
    authorizations: z.array(z.object({ user_id: z.string() })).default([]),
  }),
])

export const BlockActions = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string(), name: z.string().optional(), username: z.string().optional() }),
  actions: z.array(z.object({ action_id: z.string() })),
  response_url: z.string().optional(),
})

export const SlashCommand = z.object({
  command: z.string(),
  text: z.string().default(""),
  user_id: z.string(),
  channel_id: z.string(),
  response_url: z.string(),
})

export type SlashCommand = z.infer<typeof SlashCommand>

const CHANNEL = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/
const USER = /^<@([UW][A-Z0-9]+)(?:\|([^>]*))?>$/

/**
 * `/bob` text as a command. Slack escapes channels and users in a command's
 * text when the manifest asks it to, so they arrive as `<#C…|name>` and
 * `<@U…|name>`; a bare channel defaults to the one the command ran in.
 */
export function toCommand(command: SlashCommand): Command | undefined {
  const words = command.text.trim().split(/\s+/).filter(Boolean)
  const [verb, kind, first, second] = words
  if (verb === "config" || verb === undefined) return { name: "config" }
  if (verb === "connect") {
    return { name: "connect", service: kind, channel: command.channel_id, user: command.user_id }
  }
  if (verb === "disconnect")
    return kind === undefined ? undefined : { name: "disconnect", service: kind }
  if (verb === "retro") {
    return { name: "retro", period: kind === "week" ? "week" : "day", channel: command.channel_id }
  }
  if (verb === "map" && kind === "retro") {
    const channel = first === undefined ? command.channel_id : CHANNEL.exec(first)?.[1]
    return channel === undefined ? undefined : { name: "map-place", place: "retro", channel }
  }
  if (verb === "unmap" && kind === "retro") return { name: "unmap-place", place: "retro" }

  if (verb === "map" && (kind === "repo" || kind === "announce") && first !== undefined) {
    const channel = second === undefined ? command.channel_id : CHANNEL.exec(second)?.[1]
    if (channel === undefined) return undefined
    return {
      name: "map-repo",
      repo: first,
      channel,
      purpose: kind === "repo" ? "home" : "announce",
    }
  }
  if (verb === "map" && (kind === "github" || kind === "linear") && first !== undefined) {
    const user = USER.exec(second ?? "")
    if (user?.[1] === undefined) return undefined
    return { name: "map-person", account: kind, value: first, user: user[1], userName: user[2] }
  }
  if (verb === "unmap" && kind === "repo" && first !== undefined) {
    return { name: "unmap-repo", repo: first, purpose: second === "announce" ? "announce" : "home" }
  }
  if (verb === "unmap" && (kind === "github" || kind === "linear")) {
    const user = USER.exec(first ?? "")?.[1]
    return user === undefined ? undefined : { name: "unmap-person", account: kind, user }
  }
  return undefined
}

/** Whether a command changes the configuration, which only workspace admins may do. */
export function changes(command: Command): boolean {
  return command.name !== "config" && command.name !== "retro" && command.name !== "connect"
}
