// Turns webhook changes into cards on every platform that follows the repo.
// A story's card is edited in place while it is fresh and posted again once
// it has scrolled out of sight; a ping on an edited card goes out as a reply,
// because neither platform notifies anyone from an edit.
import type { Chat, MessageRef } from "../chat/chat"
import { mentionsFor } from "../chat/mentions"
import type { Config, Platform } from "../store/config"
import { migrate } from "../store/migrations"
import type { SqlDatabase } from "../store/sql"
import { draw, newsButtons, pingText } from "../ui/news"
import { type Change, type Commit, type Ping, pipelineVerdict, type Story } from "./stories"
import type { Narrator } from "./voice"

const STEPS = [
  `CREATE TABLE stories (
    key TEXT PRIMARY KEY,
    story TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE cards (
    key TEXT NOT NULL,
    platform TEXT NOT NULL,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (key, platform)
  )`,
]

const MINUTE = 60_000
// A push's checks and deploys land within minutes; a later step gets a new card
// rather than reopening one already read as finished.
const FRESH: Record<Story["kind"], number> = {
  issue: 60 * MINUTE,
  pull: 60 * MINUTE,
  pipeline: 10 * MINUTE,
}
const KEPT = 30 * 24 * 60 * MINUTE

export type CommitLookup = (repo: string, sha: string) => Promise<Commit | undefined>

/** A story before and after a change, for whatever reacts to news. */
export interface Published {
  previous: Story | undefined
  story: Story
}

export interface NewsroomOptions {
  now?: () => number
  /** Writes the line that talks to whoever is pinged; without one the card says nothing extra. */
  narrate?: Narrator
}

export class Newsroom {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly narrate: Narrator

  constructor(
    private readonly db: SqlDatabase,
    private readonly config: Config,
    private readonly chats: Chat[],
    private readonly lookupCommit: CommitLookup,
    options: NewsroomOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.narrate = options.narrate ?? (() => Promise.resolve(undefined))
    migrate(db, "news", STEPS)
  }

  /** Applies a change and brings its cards up to date; one story at a time. */
  publish(change: Change): Promise<Published> {
    const previous = this.locks.get(change.key) ?? Promise.resolve()
    const next = previous.then(() => this.publishNow(change))
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(change.key, settled)
    void settled.then(() => {
      if (this.locks.get(change.key) === settled) this.locks.delete(change.key)
    })
    return next
  }

  story(key: string): Story | undefined {
    const row = this.db.sql
      .exec<{ story: string }>("SELECT story FROM stories WHERE key = ?", key)
      .next()
    if (row.done) return undefined
    const story: Story = JSON.parse(row.value.story)
    return story
  }

  /** A story by its number in storage, which its card's buttons carry. */
  byId(id: number): { key: string; story: Story } | undefined {
    const row = this.db.sql
      .exec<{ key: string; story: string }>("SELECT key, story FROM stories WHERE rowid = ?", id)
      .next()
    if (row.done) return undefined
    const story: Story = JSON.parse(row.value.story)
    return { key: row.value.key, story }
  }

  card(key: string, platform: Platform): (MessageRef & { postedAt: number }) | undefined {
    const row = this.db.sql
      .exec<{ channel: string; message: string; posted_at: number }>(
        "SELECT channel, message, posted_at FROM cards WHERE key = ? AND platform = ?",
        key,
        platform,
      )
      .next()
    if (row.done) return undefined
    return { channel: row.value.channel, id: row.value.message, postedAt: row.value.posted_at }
  }

  /** Forgets stories nobody has touched in a month. */
  prune(): void {
    const cutoff = this.now() - KEPT
    this.db.sql.exec(
      "DELETE FROM cards WHERE key IN (SELECT key FROM stories WHERE updated_at < ?)",
      cutoff,
    )
    this.db.sql.exec("DELETE FROM stories WHERE updated_at < ?", cutoff)
  }

  /** Every story of one kind, for the reminders and the retro. */
  stories<K extends Story["kind"]>(kind: K): Extract<Story, { kind: K }>[] {
    const rows = this.db.sql.exec<{ story: string }>("SELECT story FROM stories").toArray()
    return rows
      .map((row): Story => JSON.parse(row.story))
      .filter((story): story is Extract<Story, { kind: K }> => story.kind === kind)
  }

  private async publishNow(change: Change): Promise<Published> {
    const previous = this.story(change.key)
    const applied = change.apply(previous)
    const story = applied.story
    if (story.kind === "pipeline" && story.commit === undefined) {
      story.commit = await this.lookupCommit(story.repo.fullName, story.sha).catch(() => undefined)
    }
    const ping = [...applied.ping, ...brokeMain(previous, story)]
    this.db.sql.exec(
      `INSERT INTO stories (key, story, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET story = excluded.story, updated_at = excluded.updated_at`,
      change.key,
      JSON.stringify(story),
      this.now(),
    )
    const id = this.db.sql
      .exec<{ id: number }>("SELECT rowid AS id FROM stories WHERE key = ?", change.key)
      .one().id
    // One sentence for every platform: the people pinged are the same on each.
    const note =
      ping.length === 0 || !this.followed(story)
        ? undefined
        : await this.line(story, previous, ping)
    const results = await Promise.allSettled(
      this.chats.map((chat) => this.show(chat, change.key, id, story, note, ping)),
    )
    const failed = results.find((result) => result.status === "rejected")
    if (failed !== undefined) throw failed.reason
    return { previous, story }
  }

  private async show(
    chat: Chat,
    key: string,
    id: number,
    story: Story,
    note: string | undefined,
    ping: Ping[],
  ): Promise<void> {
    const channel = this.config.newsChannel(story.repo.fullName, chat.platform)
    if (channel === undefined) return
    const mentions = mentionsFor(this.config, chat.platform)
    const notify = pingText(ping, mentions)
    // The line speaks to whoever was pinged, so a card that pings no one keeps it out.
    const card = draw(story, mentions, notify === undefined ? undefined : note)
    const buttons = newsButtons(story, id)
    const live = this.card(key, chat.platform)
    const fresh =
      live !== undefined &&
      live.channel === channel &&
      this.now() - live.postedAt < FRESH[story.kind]
    if (fresh) {
      // Discord notifies whoever is mentioned in an edit to, so the ping rides
      // on the card itself: no second message to read. Slack tells no one
      // about an edit, so there the ping has to be a message of its own.
      await chat.edit(live, {
        text: chat.notifiesOnEdit ? notify : undefined,
        cards: [card],
        buttons,
      })
      if (notify !== undefined && !chat.notifiesOnEdit) {
        await chat.post(channel, { text: notify, replyTo: live })
      }
      return
    }
    const posted = await chat.post(channel, { text: notify, cards: [card], buttons })
    this.db.sql.exec(
      `INSERT INTO cards (key, platform, channel, message, posted_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key, platform) DO UPDATE SET
         channel = excluded.channel, message = excluded.message, posted_at = excluded.posted_at`,
      key,
      chat.platform,
      posted.channel,
      posted.id,
      this.now(),
    )
  }

  /** Whether any platform follows this repo, so a sentence is worth writing. */
  private followed(story: Story): boolean {
    return this.chats.some(
      (chat) => this.config.newsChannel(story.repo.fullName, chat.platform) !== undefined,
    )
  }

  /** The model's line for the people being pinged; a failed call costs the card only its sentence. */
  private async line(
    story: Story,
    previous: Story | undefined,
    ping: Ping[],
  ): Promise<string | undefined> {
    const pinged = ping.flatMap((target) => ("login" in target ? [target.login] : []))
    try {
      return await this.narrate({ story, previous, pinged })
    } catch (error) {
      console.error("news note failed", error)
      return undefined
    }
  }
}

/**
 * The commit's author, when this change is what turned the default branch red.
 * Pipelines are only followed on the default branch, so any failure is one.
 */
function brokeMain(previous: Story | undefined, story: Story): Ping[] {
  if (story.kind !== "pipeline" || pipelineVerdict(story) !== false) return []
  if (previous?.kind === "pipeline" && pipelineVerdict(previous) === false) return []
  const login = story.commit?.login
  return login === undefined ? [] : [{ login }]
}
