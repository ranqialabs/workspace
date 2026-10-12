// The Durable Object behind one conversation, named `<platform>:<channel>:<thread>`.
// It answers RPC from the Discord gateway and from Slack's events, and wires
// the platform, GitHub, the model and the Workspace's configuration into a
// Session, which does the work.
import { createOpenAI } from "@ai-sdk/openai"
import { DurableObject } from "cloudflare:workers"
import { z } from "zod"

import type { Chat } from "../chat/chat"
import { credentials, type GitHub, installationClient } from "../github/app"
import type { Platform } from "../store/config"
import { chats } from "../workspace"
import { type Action, Session, type Turn } from "./session"

/** Where a conversation happens, beyond the channel it answers in. */
export interface Origin {
  platform: Platform
  /** The channels whose repo mappings settle where a draft may go: the channel and, for a thread, its parent. */
  scope: string[]
  /** A link back to the conversation, for the issue body. */
  link?: string
}

export function conversationName(platform: Platform, channel: string, thread?: string): string {
  return `${platform}:${channel}:${thread ?? ""}`
}

export interface Press {
  action: Action
  target: number
  conversation: string
}

const ACTION = z.enum(["stop", "submit", "discard"])

/** A button id from `Session`, or undefined for one that is not bob's. */
export function parsePress(id: string): Press | undefined {
  const [prefix, action, target, ...rest] = id.split(":")
  const parsed = ACTION.safeParse(action)
  const conversation = rest.join(":")
  if (prefix !== "bob" || !parsed.success || !/^\d+$/.test(target ?? "") || conversation === "") {
    return undefined
  }
  return { action: parsed.data, target: Number(target), conversation }
}

export class Conversation extends DurableObject<Env> {
  private session: Session | undefined
  private client: Promise<GitHub> | undefined

  /** Someone called bob here. Returns once the ask is stored; the answer follows. */
  mention(name: string, origin: Origin, turn: Turn): void {
    this.ctx.storage.kv.put("origin", origin)
    const work = this.sessionFor(name, origin).mention(turn)
    this.ctx.waitUntil(work.catch((error: unknown) => console.error("conversation failed", error)))
  }

  press(
    name: string,
    action: Action,
    target: number,
    user: Turn["author"],
  ): Promise<string | undefined> {
    const origin = this.ctx.storage.kv.get<Origin>("origin")
    if (origin === undefined) return Promise.resolve("This conversation is gone.")
    return this.sessionFor(name, origin).press(action, target, user)
  }

  private sessionFor(name: string, origin: Origin): Session {
    this.session ??= new Session(this.ctx.storage, {
      name,
      chat: this.chat(origin.platform),
      github: () => this.github(),
      model: () => {
        const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY })
        return openai(this.env.AGENT_MODEL)
      },
      surroundings: async () => {
        const stored = this.ctx.storage.kv.get<Origin>("origin") ?? origin
        const workspace = this.env.WORKSPACE.getByName(this.env.GITHUB_ORG)
        const context = await workspace.context(stored.platform, stored.scope)
        return { ...context, link: stored.link }
      },
    })
    return this.session
  }

  private chat(platform: Platform): Chat {
    const chat = chats(this.env).find((candidate) => candidate.platform === platform)
    if (chat === undefined) throw new Error(`${platform} is not configured`)
    return chat
  }

  private github(): Promise<GitHub> {
    this.client ??= installationClient(credentials(this.env)).catch((error: unknown) => {
      this.client = undefined
      throw error
    })
    return this.client
  }
}
