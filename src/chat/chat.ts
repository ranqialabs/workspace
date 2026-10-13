// What bob needs from a chat platform to post news and talk. Discord and
// Slack each implement it; everything above this line is shared.
import type { Platform } from "../store/config"
import type { Card } from "../ui/card"

/** A message bob posted: Slack calls the id a `ts`, Discord a snowflake. */
export interface MessageRef {
  channel: string
  id: string
}

export interface Button {
  id: string
  label: string
  style?: "primary" | "secondary" | "danger"
}

/** A file sent with a message; a card shows it by naming it in `image`. */
export interface Attachment {
  name: string
  data: Uint8Array
  /** What the image shows, for people who can't see it. */
  alt: string
}

export interface Outgoing {
  text?: string
  attachment?: Attachment
  cards?: Card[]
  buttons?: Button[]
  /** Answer in the thread of this message (Slack) or as a reply to it (Discord). */
  replyTo?: MessageRef
}

/** A message someone wrote, as the agent reads it back. */
export interface ChatMessage {
  id: string
  author: { id: string; name: string; bot: boolean }
  text: string
  /** ISO 8601. */
  at: string
}

export interface ReadOptions {
  /** Slack's thread; Discord threads are channels of their own. */
  thread?: string
  /** Only messages older than this one. */
  before?: string
  limit: number
}

export interface Chat {
  readonly platform: Platform
  post(channel: string, message: Outgoing): Promise<MessageRef>
  edit(ref: MessageRef, message: Outgoing): Promise<void>
  /** Messages before `before`, oldest first. */
  read(channel: string, options: ReadOptions): Promise<ChatMessage[]>
}
