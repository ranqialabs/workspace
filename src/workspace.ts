// One Durable Object per GitHub org: the configuration, the news cards and,
// later, access. Its SQLite database is the single source of truth that the
// chat channels only show.
import { DurableObject } from "cloudflare:workers"

import type { Chat } from "./chat/chat"
import { DiscordChat } from "./discord/messages"
import { DiscordRest } from "./discord/rest"
import { credentials, type GitHub, installationClient } from "./github/app"
import type { Delivery } from "./github/webhook"
import { Newsroom } from "./news/newsroom"
import { changeFor, type Commit, commitOf } from "./news/stories"
import { Config } from "./store/config"
import { migrate } from "./store/migrations"

const DELIVERIES = ["CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)"]
const DAY = 24 * 60 * 60 * 1000

export class Workspace extends DurableObject<Env> {
  readonly config: Config
  private readonly newsroom: Newsroom
  private client: Promise<GitHub> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    migrate(ctx.storage, "deliveries", DELIVERIES)
    this.config = new Config(ctx.storage)
    this.newsroom = new Newsroom(ctx.storage, this.config, chats(env), (repo, sha) =>
      this.lookupCommit(repo, sha),
    )
  }

  /** A verified webhook delivery. GitHub redelivers on timeouts, so each id counts once. */
  async github(delivery: Delivery): Promise<void> {
    const sql = this.ctx.storage.sql
    const seen = sql.exec("SELECT 1 FROM deliveries WHERE id = ?", delivery.id).toArray()
    if (delivery.id !== "" && seen.length > 0) return
    if (delivery.id !== "") {
      sql.exec("INSERT INTO deliveries (id, received_at) VALUES (?, ?)", delivery.id, Date.now())
      sql.exec("DELETE FROM deliveries WHERE received_at < ?", Date.now() - DAY)
    }
    const change = changeFor(delivery.event, delivery.payload)
    if (change === undefined) return
    await this.newsroom.publish(change)
    this.newsroom.prune()
  }

  githubClient(): Promise<GitHub> {
    this.client ??= installationClient(credentials(this.env)).catch((error: unknown) => {
      this.client = undefined
      throw error
    })
    return this.client
  }

  private async lookupCommit(repo: string, sha: string): Promise<Commit | undefined> {
    const [owner = "", name = ""] = repo.split("/")
    const github = await this.githubClient()
    const { data } = await github.rest.repos.getCommit({ owner, repo: name, ref: sha })
    return commitOf(data.commit.message, data.author?.login, data.commit.author?.name)
  }
}

/** The platforms this deployment has credentials for. */
export function chats(env: Env): Chat[] {
  const enabled: Chat[] = []
  if (env.DISCORD_TOKEN) enabled.push(new DiscordChat(new DiscordRest(env.DISCORD_TOKEN)))
  return enabled
}
