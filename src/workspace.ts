// One Durable Object per GitHub org: the configuration, the news cards and,
// later, access. Its SQLite database is the single source of truth that the
// chat channels only show.
import { DurableObject } from "cloudflare:workers"

import { conversationName, type Origin } from "./agent/conversation"
import { explainFailure } from "./agent/prompt"
import type { Turn } from "./agent/session"
import { chats } from "./chat/platforms"
import { REPLY } from "./ui/replies"
import { type Command, type Result, run } from "./commands"
import { commandReply, type Reply } from "./ui/commands"
import { applyLines, readLines } from "./discord/legacy"
import { DiscordRest } from "./discord/rest"
import { credentials, type GitHub, installationClient } from "./github/app"
import { OrgDirectory } from "./github/directory"
import type { Delivery } from "./github/webhook"
import { Newsroom } from "./news/newsroom"
import { Reminders } from "./news/reminders"
import { changeFor, type Commit, commitOf } from "./news/stories"
import { Config, type Person, type Platform } from "./store/config"
import { migrate } from "./store/migrations"

const DELIVERIES = ["CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)"]
const DAY = 24 * 60 * 60 * 1000

export class Workspace extends DurableObject<Env> {
  readonly config: Config
  private readonly directory: OrgDirectory
  private readonly newsroom: Newsroom
  private readonly reminders: Reminders
  private client: Promise<GitHub> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    migrate(ctx.storage, "deliveries", DELIVERIES)
    this.config = new Config(ctx.storage)
    this.directory = new OrgDirectory(env.GITHUB_ORG, () => this.githubClient())
    this.newsroom = new Newsroom(ctx.storage, this.config, chats(env), (repo, sha) =>
      this.lookupCommit(repo, sha),
    )
    this.reminders = new Reminders(
      ctx.storage,
      this.newsroom,
      this.config,
      chats(env),
      env.TIMEZONE,
    )
  }

  /** The cron's tick: whatever is due. */
  async tick(): Promise<void> {
    await this.reminders.run()
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

  async command(command: Command, platform: Platform): Promise<Reply> {
    const result = await this.runCommand(command, platform)
    return commandReply(result, this.config, platform)
  }

  private async runCommand(command: Command, platform: Platform): Promise<Result> {
    if (command.name === "import" && platform === "discord" && this.env.DISCORD_TOKEN) {
      const lines = await readLines(new DiscordRest(this.env.DISCORD_TOKEN), command.channel)
      return { kind: "imported", channel: command.channel, counts: applyLines(this.config, lines) }
    }
    return run(command, platform, this.config, this.directory)
  }

  /**
   * "Why did it fail?" on a checks card: the agent answers in the card's
   * thread, as if whoever pressed had asked there.
   */
  async explain(id: number, platform: Platform, user: Turn["author"]): Promise<string | undefined> {
    const found = this.newsroom.byId(id)
    const card = found === undefined ? undefined : this.newsroom.card(found.key, platform)
    if (found?.story.kind !== "pipeline" || card === undefined) return REPLY.cardGone
    // A Slack thread hangs off the card; on Discord the channel is the conversation.
    const thread = platform === "slack" ? card.id : undefined
    const name = conversationName(platform, card.channel, thread)
    const origin: Origin = { platform, scope: [card.channel] }
    const turn: Turn = {
      channel: card.channel,
      thread,
      message: card.id,
      author: user,
      text: explainFailure(found.story),
    }
    await this.env.CONVERSATION.getByName(name).mention(name, origin, turn)
    return undefined
  }

  /** What a conversation needs from the configuration: its candidate repos and the people bob knows. */
  context(
    platform: Platform,
    scope: string[],
  ): { org: string; candidates: string[]; teammates: Person[] } {
    return {
      org: this.env.GITHUB_ORG,
      candidates: this.config.reposFor(platform, ...scope),
      teammates: this.config.people(),
    }
  }

  suggest(field: "repo" | "login", typed: string): Promise<string[]> {
    return field === "repo"
      ? this.directory.suggestRepos(typed)
      : this.directory.suggestMembers(typed)
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
