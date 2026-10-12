// Discord messages as bob reads them, from the gateway or from a channel's
// history. Mentions arrive as `<@id>`; the agent reads names instead.
import { z } from "zod"

import type { ChatMessage } from "../chat/chat"

const User = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullish(),
  bot: z.boolean().optional(),
})

const Member = z.object({ nick: z.string().nullish() }).nullish()

export const DiscordMessage = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: User,
  member: Member,
  content: z.string(),
  timestamp: z.string(),
  mentions: z.array(User.extend({ member: Member })).default([]),
  referenced_message: z.object({ id: z.string(), author: z.object({ id: z.string() }) }).nullish(),
})

export type DiscordMessage = z.infer<typeof DiscordMessage>

export function nameOf(user: z.infer<typeof User>, member?: z.infer<typeof Member>): string {
  return member?.nick ?? user.global_name ?? user.username
}

/** The text with every `<@id>` turned into `@name`. */
export function readable(message: DiscordMessage): string {
  let text = message.content
  for (const user of message.mentions) {
    text = text.replaceAll(new RegExp(`<@!?${user.id}>`, "g"), `@${nameOf(user, user.member)}`)
  }
  return text.trim()
}

export function toChatMessage(message: DiscordMessage): ChatMessage {
  return {
    id: message.id,
    author: {
      id: message.author.id,
      name: nameOf(message.author, message.member),
      bot: message.author.bot ?? false,
    },
    text: readable(message),
    at: message.timestamp,
  }
}

/** Whether `bot` was mentioned, or replied to, in this message. */
export function addresses(message: DiscordMessage, bot: string): boolean {
  if (message.author.id === bot || message.author.bot === true) return false
  if (message.mentions.some((user) => user.id === bot)) return true
  return message.referenced_message?.author.id === bot
}
