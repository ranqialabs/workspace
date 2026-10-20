// The Durable Object behind one conversation, named `<platform>:<channel>:<thread>`.
// It answers RPC from the Discord gateway and from Slack's events, and wires
// the platform, GitHub, the model and the Workspace's configuration into a
// Session, which does the work.
import { modelFor } from "./model"
import { Sauron, SAURON_URL } from "../sauron/client"
import { DurableObject } from "cloudflare:workers"

import { credentials, type GitHub, installationClient } from "../github/app"
import type { Platform } from "../store/config"
import { chatFor } from "../chat/platforms"
import type { ConversationAction } from "../chat/press"
import { Session, type Turn } from "./session"

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
    action: ConversationAction,
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
      chat: chatFor(this.env, origin.platform),
      modelId: this.env.AGENT_MODEL,
      github: () => this.github(),
      model: () => {
        const model = modelFor(this.env)
        if (model === undefined) throw new Error("DEEPSEEK_API_KEY is not set")
        return model
      },
      sauron: () =>
        this.env.SAURON_TOKEN === undefined || this.env.SAURON_TOKEN === ""
          ? undefined
          : new Sauron(this.env.SAURON_URL ?? SAURON_URL, this.env.SAURON_TOKEN),
      services: () => {
        const services = this.env.SERVICES.getByName(this.env.GITHUB_ORG)
        return {
          catalog: () => services.catalog(),
          call: (service, tool, args) => services.call(service, tool, args),
          authorize: (service, requester) => services.authorize(service, requester),
        }
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

  private github(): Promise<GitHub> {
    this.client ??= installationClient(credentials(this.env)).catch((error: unknown) => {
      this.client = undefined
      throw error
    })
    return this.client
  }
}
