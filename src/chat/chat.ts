// What bob needs from a chat platform to post news and talk. Discord and
// Slack each implement it; everything above this line is shared.
import type { Platform } from "../store/config"
import type { Card } from "./card"

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

export interface Outgoing {
  text?: string
  cards?: Card[]
  buttons?: Button[]
  /** Answer in the thread of this message (Slack) or as a reply to it (Discord). */
  replyTo?: MessageRef
}

export interface Chat {
  readonly platform: Platform
  post(channel: string, message: Outgoing): Promise<MessageRef>
  edit(ref: MessageRef, message: Outgoing): Promise<void>
}
