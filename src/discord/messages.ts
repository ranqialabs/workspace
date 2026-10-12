// Shared messages as Discord embeds and components. Discord reads Markdown
// natively, so the card's text passes through; only its limits need care.
import type { Card, Tone } from "../ui/card"
import { z } from "zod"

import type { Button, Chat, ChatMessage, MessageRef, Outgoing, ReadOptions } from "../chat/chat"
import { DiscordMessage, toChatMessage } from "./inbound"
import type { DiscordRest } from "./rest"

const CONTENT_LIMIT = 2000

export const COLORS: Record<Tone, number> = {
  green: 0x2da44e,
  grey: 0x6e7681,
  blue: 0x0969da,
  red: 0xcf222e,
  purple: 0x8250df,
  brand: 0x5865f2,
}

const STYLES: Record<NonNullable<Button["style"]>, number> = {
  primary: 1,
  secondary: 2,
  danger: 4,
}

export function cut(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…"
}

export interface Embed {
  color: number
  author: { name: string; url?: string }
  title: string
  url?: string
  description?: string
  fields?: { name: string; value: string; inline: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

export function embed(card: Card): Embed {
  return {
    color: COLORS[card.tone],
    author: { name: cut(card.kicker, 256), url: card.kickerUrl },
    title: cut(card.title, 256),
    url: card.url,
    description: card.body === undefined ? undefined : cut(card.body, 4096),
    fields: card.fields?.slice(0, 25).map((field) => ({
      name: cut(field.name, 256),
      value: cut(field.value, 1024),
      inline: field.inline ?? false,
    })),
    footer: card.footer === undefined ? undefined : { text: cut(card.footer, 2048) },
    timestamp: card.at,
  }
}

export function components(buttons: Button[] | undefined) {
  if (buttons === undefined || buttons.length === 0) return []
  const rows = []
  for (let start = 0; start < buttons.length; start += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(start, start + 5).map((button) => ({
        type: 2,
        style: STYLES[button.style ?? "secondary"],
        label: cut(button.label, 80),
        custom_id: button.id,
      })),
    })
  }
  return rows
}

/** The JSON body for a message, as Discord's create and edit endpoints take it. */
export function messageBody(message: Outgoing) {
  return {
    content: cut(message.text ?? "", CONTENT_LIMIT),
    embeds: (message.cards ?? []).slice(0, 10).map(embed),
    components: components(message.buttons),
    allowed_mentions: { parse: ["users", "roles"] },
    message_reference:
      message.replyTo === undefined
        ? undefined
        : { message_id: message.replyTo.id, fail_if_not_exists: false },
  }
}

export class DiscordChat implements Chat {
  readonly platform = "discord"

  constructor(private readonly rest: DiscordRest) {}

  /** Text past Discord's 2000 characters goes out as several messages; cards ride on the last. */
  async post(channel: string, message: Outgoing): Promise<MessageRef> {
    const parts = split(message.text ?? "", CONTENT_LIMIT)
    const last = parts.length - 1
    let ref: MessageRef = { channel, id: "" }
    for (const [index, text] of parts.entries()) {
      const part: Outgoing = {
        text,
        replyTo: index === 0 ? message.replyTo : undefined,
        cards: index === last ? message.cards : undefined,
        buttons: index === last ? message.buttons : undefined,
      }
      const sent = await this.rest.post(`/channels/${channel}/messages`, messageBody(part))
      ref = { channel, id: messageId(sent) }
    }
    return ref
  }

  async edit(ref: MessageRef, message: Outgoing): Promise<void> {
    const { message_reference: _, ...body } = messageBody(message)
    await this.rest.patch(`/channels/${ref.channel}/messages/${ref.id}`, body)
  }

  async read(channel: string, options: ReadOptions): Promise<ChatMessage[]> {
    const query = new URLSearchParams({ limit: String(Math.min(options.limit, 100)) })
    if (options.before !== undefined) query.set("before", options.before)
    const raw = await this.rest.get(`/channels/${channel}/messages?${query.toString()}`)
    const messages = z.array(DiscordMessage).parse(raw)
    return messages.map(toChatMessage).toReversed()
  }
}

/**
 * `text` in pieces of at most `limit` characters, cut at a line break where
 * one is near so code blocks and lists stay readable. Empty text is one empty
 * piece, so a message of cards alone still goes out.
 */
export function split(text: string, limit: number): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit)
    const at = newline > limit / 2 ? newline : limit
    pieces.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, "")
  }
  pieces.push(rest)
  return pieces
}

function messageId(sent: unknown): string {
  if (typeof sent === "object" && sent !== null && "id" in sent && typeof sent.id === "string") {
    return sent.id
  }
  throw new Error("Discord answered a new message without its id")
}
