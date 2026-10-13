// One Durable Object per GitHub org: the configuration, the news cards and,
// later, access. Its SQLite database is the single source of truth that the
// chat channels only show.
import { DurableObject } from "cloudflare:workers"

import { conversationName, type Origin } from "./agent/conversation"
import { explainFailure } from "./agent/prompt"
import type { Turn } from "./agent/session"
import { modelFor } from "./agent/model"
import { mentionsFor } from "./chat/mentions"
import { chats } from "./chat/platforms"
import { collect, productionDeploys, type Retro } from "./retro/collect"
import { type PeriodKind, periodAt } from "./retro/period"
import { faces } from "./retro/faces"
import { peopleStats } from "./retro/stats"
import { localTime } from "./time"
import { FONTS } from "./ui/fonts"
import { png } from "./ui/render"
import { RETRO_IMAGE, retroAlt, retroCard } from "./ui/retro"
import { retroImage, WIDTH } from "./ui/retro-image"
import { code } from "./ui/text"
import { REPLY } from "./ui/replies"
import { type Command, type Result, run } from "./commands"
import { commandReply, type Reply } from "./ui/commands"
import { applyLines, readLines } from "./discord/legacy"
import { DiscordRest } from "./discord/rest"
import { credentials, type GitHub, installationClient } from "./github/app"
import { OrgDirectory } from "./github/directory"
import type { Delivery } from "./github/webhook"
import { Newsroom } from "./news/newsroom"
import { Releases } from "./news/releases"
import { Reminders } from "./news/reminders"
import { changeFor, type Commit, commitOf } from "./news/stories"
import { Config, type Person, type Platform } from "./store/config"
import { migrate } from "./store/migrations"

const DELIVERIES = ["CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)"]
const DAY = 24 * 60 * 60 * 1000
const RETRO_HOUR = 18

export class Workspace extends DurableObject<Env> {
  readonly config: Config
  private readonly directory: OrgDirectory
  private readonly newsroom: Newsroom
  private readonly reminders: Reminders
  private readonly releases: Releases
  private client: Promise<GitHub> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    migrate(ctx.storage, "deliveries", DELIVERIES)
    this.config = new Config(ctx.storage)
    this.directory = new OrgDirectory(env.GITHUB_ORG, () => this.githubClient())
    this.newsroom = new Newsroom(ctx.storage, this.config, chats(env), (repo, sha) =>
      this.lookupCommit(repo, sha),
    )
    this.releases = new Releases(ctx.storage, this.newsroom, chats(env), {
      github: () => this.githubClient(),
      model: () => modelFor(env),
    })
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
    const results = await Promise.allSettled([this.reminders.run(), this.retroIfDue()])
    const failed = results.find((result) => result.status === "rejected")
    if (failed !== undefined) throw failed.reason
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
    const published = await this.newsroom.publish(change)
    this.newsroom.prune()
    // Release notes are extra: their failure must not fail the delivery.
    await this.releases.after(published).catch((error: unknown) => {
      console.error("release notes failed", error)
    })
  }

  async command(command: Command, platform: Platform): Promise<Reply> {
    const result = await this.runCommand(command, platform)
    return commandReply(result, this.config, platform)
  }

  private async runCommand(command: Command, platform: Platform): Promise<Result> {
    if (command.name === "import") {
      if (platform !== "discord" || !this.env.DISCORD_TOKEN) return { kind: "discord-only" }
      const lines = await readLines(new DiscordRest(this.env.DISCORD_TOKEN), command.channel)
      return { kind: "imported", channel: command.channel, counts: applyLines(this.config, lines) }
    }
    if (command.name === "retro") {
      await this.postRetro(command.period, [{ platform, channel: command.channel }], false)
      return { kind: "retro-posted", channel: command.channel, period: command.period }
    }
    return run(command, platform, this.config, this.directory)
  }

  /**
   * Gathers a retro and posts it to each target. The cron skips a day where
   * nothing was merged, closed or deployed; someone asking always gets one.
   */
  private async postRetro(
    kind: PeriodKind,
    targets: { platform: Platform; channel: string }[],
    skipQuiet: boolean,
  ): Promise<void> {
    const period = periodAt(kind, Date.now(), this.env.TIMEZONE)
    const people = this.config.people()
    const logins = people.flatMap((person) => person.github ?? [])
    const repos = [...new Set(this.config.channels().map((mapping) => mapping.repo))]
    const retro = await collect(
      await this.githubClient(),
      this.env.GITHUB_ORG,
      logins,
      repos,
      period,
      productionDeploys(this.newsroom.stories("pipeline"), period),
    )
    const quiet = retro.merged.length + retro.closed.length + retro.deploys.length === 0
    if (skipQuiet && quiet) return
    const image = await this.retroPicture(retro, people)
    const attachment =
      image === undefined ? undefined : { name: RETRO_IMAGE, data: image, alt: retroAlt(retro) }
    for (const target of targets) {
      const chat = chats(this.env).find((candidate) => candidate.platform === target.platform)
      if (chat === undefined) continue
      const card = retroCard(retro, this.personLabel(target.platform), attachment !== undefined)
      await chat.post(target.channel, { cards: [card], attachment })
    }
  }

  /** The numbers as a picture; the text card stands alone if drawing fails. */
  private async retroPicture(retro: Retro, people: Person[]): Promise<Uint8Array | undefined> {
    try {
      const shown = peopleStats(retro).map((person) => person.login)
      const tree = retroImage(retro, await faces(shown, people))
      return await png(tree, WIDTH, FONTS)
    } catch (error) {
      console.error("retro image failed", error)
      return undefined
    }
  }

  /** On Discord a mention in a card notifies no one; Slack's would, so it gets a name. */
  private personLabel(platform: Platform): (login: string) => string {
    const mentions = mentionsFor(this.config, platform)
    return (login) => {
      if (platform === "discord") return mentions.person(login) ?? code(login)
      return this.config.personBy("github", login)?.name ?? code(login)
    }
  }

  /** On working days at 18:00 the retro goes out: the week's on Friday, the day's otherwise. */
  private async retroIfDue(): Promise<void> {
    const now = localTime(Date.now(), this.env.TIMEZONE)
    if (now.weekday < 1 || now.weekday > 5 || now.hour < RETRO_HOUR) return
    if (this.ctx.storage.kv.get<string>("retro-posted") === now.date) return
    // Marked first: a failing retro is retried tomorrow, not every five minutes.
    this.ctx.storage.kv.put("retro-posted", now.date)
    const targets = (["discord", "slack"] as const).flatMap((platform) => {
      const channel = this.config.place("retro", platform)
      return channel === undefined ? [] : [{ platform, channel }]
    })
    if (targets.length === 0) return
    await this.postRetro(now.weekday === 5 ? "week" : "day", targets, true)
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
