// Turns a Discord message that calls bob into a turn for its conversation. A
// thread's conversation is the thread; its parent channel's repo mapping still
// settles where a draft may go, so the parent is looked up once and kept.
import { z } from "zod"

import { conversationName, type Origin } from "../agent/conversation"
import type { Turn } from "../agent/session"
import { addresses, type DiscordMessage, nameOf, readable } from "./inbound"
import type { DiscordRest } from "./rest"

const THREAD_TYPES = new Set([10, 11, 12])

const Channel = z.object({ type: z.number(), parent_id: z.string().nullish() })

export interface Routed {
  name: string
  origin: Origin
  turn: Turn
}

export class DiscordRouter {
  private readonly parents = new Map<string, string | undefined>()

  constructor(private readonly rest: DiscordRest) {}

  async route(message: DiscordMessage, bot: string): Promise<Routed | undefined> {
    if (!addresses(message, bot)) return undefined
    const channel = message.channel_id
    const parent = await this.parentOf(channel)
    const text = readable({
      ...message,
      content: message.content.replaceAll(new RegExp(`<@!?${bot}>`, "g"), ""),
    })
    const guild = message.guild_id ?? "@me"
    return {
      name: conversationName("discord", channel),
      origin: {
        platform: "discord",
        scope: parent === undefined ? [channel] : [channel, parent],
        link: `https://discord.com/channels/${guild}/${channel}`,
      },
      turn: {
        channel,
        message: message.id,
        author: { id: message.author.id, name: nameOf(message.author, message.member) },
        text: text === "" ? "(no text, just the mention)" : text,
      },
    }
  }

  private async parentOf(channel: string): Promise<string | undefined> {
    if (this.parents.has(channel)) return this.parents.get(channel)
    const found = Channel.parse(await this.rest.get(`/channels/${channel}`))
    const parent = THREAD_TYPES.has(found.type) ? (found.parent_id ?? undefined) : undefined
    this.parents.set(channel, parent)
    return parent
  }
}
