// Slash commands, buttons and autocomplete reach bob over HTTP as
// interactions. Discord signs each one with the application's Ed25519 key.
import { z } from "zod"

import type { Command } from "../commands"

export async function signatureMatches(
  publicKey: string,
  body: string,
  signature: string | null,
  timestamp: string | null,
): Promise<boolean> {
  if (signature === null || timestamp === null) return false
  if (!/^[0-9a-f]{128}$/.test(signature) || !/^[0-9a-f]{64}$/.test(publicKey)) return false
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.fromHex(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  )
  const signed = new TextEncoder().encode(timestamp + body)
  return crypto.subtle.verify("Ed25519", key, Uint8Array.fromHex(signature), signed)
}

export const InteractionType = {
  ping: 1,
  command: 2,
  component: 3,
  autocomplete: 4,
  modalSubmit: 5,
} as const

export const ResponseType = {
  pong: 1,
  message: 4,
  deferredMessage: 5,
  deferredUpdate: 6,
  autocomplete: 8,
} as const

export const EPHEMERAL = 64

const SUBCOMMAND = 1

interface Option {
  name: string
  type: number
  value?: string | number | boolean
  focused?: boolean
  options?: Option[]
}

const option: z.ZodType<Option> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.number(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    focused: z.boolean().optional(),
    options: z.array(option).optional(),
  }),
)

const user = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullish(),
})

export const Interaction = z.object({
  id: z.string(),
  application_id: z.string(),
  type: z.number(),
  token: z.string(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  member: z.object({ user }).optional(),
  user: user.optional(),
  data: z
    .object({
      name: z.string().optional(),
      options: z.array(option).optional(),
      custom_id: z.string().optional(),
      resolved: z.object({ users: z.record(z.string(), user).optional() }).optional(),
    })
    .optional(),
})

export type Interaction = z.infer<typeof Interaction>

/** The subcommand that was run and its options by name. */
function optionsOf(interaction: Interaction): { sub?: string; values: Map<string, Option> } {
  const top = interaction.data?.options ?? []
  const [first] = top
  if (first?.type === SUBCOMMAND) {
    return { sub: first.name, values: new Map((first.options ?? []).map((o) => [o.name, o])) }
  }
  return { values: new Map(top.map((o) => [o.name, o])) }
}

function textOption(values: Map<string, Option>, name: string): string | undefined {
  const value = values.get(name)?.value
  return typeof value === "string" ? value : undefined
}

/** The admin command an interaction names, or undefined when its options are incomplete. */
export function toCommand(interaction: Interaction): Command | undefined {
  const name = interaction.data?.name
  const { sub, values } = optionsOf(interaction)
  const repo = textOption(values, "repo")
  const channel = textOption(values, "channel")
  const member = textOption(values, "member")

  if (name === "config") return { name: "config" }

  if (name === "map") {
    if (sub === "repo" || sub === "announce") {
      if (repo === undefined || channel === undefined) return undefined
      const purpose = sub === "repo" ? "home" : "announce"
      return { name: "map-repo", repo, channel, purpose }
    }
    if (sub === "github" || sub === "linear") {
      const value = textOption(values, sub === "github" ? "login" : "email")
      if (value === undefined || member === undefined) return undefined
      const resolved = interaction.data?.resolved?.users?.[member]
      const userName = resolved?.global_name ?? resolved?.username
      return { name: "map-person", account: sub, value, user: member, userName }
    }
  }

  if (name === "unmap") {
    if (sub === "repo" && repo !== undefined) {
      const purpose = values.get("announce")?.value === true ? "announce" : "home"
      return { name: "unmap-repo", repo, purpose }
    }
    if ((sub === "github" || sub === "linear") && member !== undefined) {
      return { name: "unmap-person", account: sub, user: member }
    }
  }

  return undefined
}

/** The option being typed into, for autocomplete. */
export function focused(interaction: Interaction): { name: string; value: string } | undefined {
  const { values } = optionsOf(interaction)
  const typing = [...values.values()].find((candidate) => candidate.focused === true)
  if (typing === undefined) return undefined
  return { name: typing.name, value: String(typing.value ?? "") }
}
