// What bob cannot derive from GitHub: which channel follows which repo, and who
// each GitHub login and Linear email is on Discord and Slack.
import { migrate } from "./migrations"
import type { SqlDatabase } from "./sql"

export type Platform = "discord" | "slack"

// `home` gets the notifications and gates access; `announce` takes the
// notifications instead when set, so several repos can share one feed.
export type Purpose = "home" | "announce"

export type Account = "github" | "linear"

/** A channel for the whole org rather than one repo. */
export type Place = "retro"

export interface Person {
  id: number
  name: string | null
  github: string | null
  linear: string | null
  discord: string | null
  slack: string | null
}

type PersonRow = {
  id: number
  name: string | null
  github: string | null
  linear: string | null
  discord: string | null
  slack: string | null
}

export interface ChannelMapping {
  repo: string
  platform: Platform
  purpose: Purpose
  channel: string
}

const STEPS = [
  `CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT,
    github TEXT UNIQUE COLLATE NOCASE,
    linear TEXT UNIQUE COLLATE NOCASE,
    discord TEXT UNIQUE,
    slack TEXT UNIQUE
  )`,
  `CREATE TABLE channels (
    repo TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('discord', 'slack')),
    purpose TEXT NOT NULL CHECK (purpose IN ('home', 'announce')),
    channel TEXT NOT NULL,
    PRIMARY KEY (repo, platform, purpose)
  )`,
  `CREATE TABLE access_groups (
    repo TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('discord', 'slack')),
    group_id TEXT NOT NULL,
    PRIMARY KEY (repo, platform)
  )`,
  `CREATE TABLE places (
    place TEXT NOT NULL CHECK (place IN ('retro')),
    platform TEXT NOT NULL CHECK (platform IN ('discord', 'slack')),
    channel TEXT NOT NULL,
    PRIMARY KEY (place, platform)
  )`,
]

const FIELDS = ["name", "github", "linear", "discord", "slack"] as const

export class Config {
  constructor(private readonly db: SqlDatabase) {
    migrate(db, "config", STEPS)
  }

  /**
   * Ties an account to whoever holds `chatId` on `platform`.
   *
   * The account moves rather than being copied: a login belongs to one person,
   * so linking it again takes it off whoever had it. When the account's current
   * holder has no `platform` user yet, the two rows are the same person seen
   * from two chats and they merge, so mapping on Discord and on Slack meets in
   * one person.
   */
  link(platform: Platform, chatId: string, account: Account, value: string, name?: string): Person {
    return this.db.transactionSync(() => {
      const holder = this.personBy(account, value)
      let person = this.personBy(platform, chatId)
      if (holder !== undefined && holder.id !== person?.id) {
        if (holder[platform] === null && person === undefined) {
          person = holder
        } else if (
          holder[platform] === null &&
          person !== undefined &&
          !conflicts(holder, person)
        ) {
          this.merge(holder, person)
        } else {
          this.set(holder.id, account, null)
        }
      }
      if (person === undefined) {
        this.db.sql.exec(`INSERT INTO people (${platform}) VALUES (?)`, chatId)
        person = this.personBy(platform, chatId)
        if (person === undefined) throw new Error("the person just inserted is missing")
      }
      this.set(person.id, platform, chatId)
      this.set(person.id, account, value)
      if (name !== undefined) this.set(person.id, "name", name)
      this.prune()
      const linked = this.personBy(platform, chatId)
      if (linked === undefined) throw new Error("the linked person is missing")
      return linked
    })
  }

  /** Drops one account from a person; a person left with nothing is deleted. */
  unlink(platform: Platform, chatId: string, account: Account): void {
    const person = this.personBy(platform, chatId)
    if (person === undefined) return
    this.set(person.id, account, null)
    this.prune()
  }

  /** Remembers what a chat calls someone, for the agent and the panel. */
  rename(platform: Platform, chatId: string, name: string): void {
    this.db.sql.exec(`UPDATE people SET name = ? WHERE ${platform} = ?`, name, chatId)
  }

  personBy(field: Account | Platform, value: string): Person | undefined {
    const row = this.db.sql.exec<PersonRow>(`SELECT * FROM people WHERE ${field} = ?`, value).next()
    return row.done ? undefined : row.value
  }

  people(): Person[] {
    return this.db.sql
      .exec<PersonRow>(
        "SELECT * FROM people ORDER BY coalesce(name, github, linear) COLLATE NOCASE",
      )
      .toArray()
  }

  mapChannel(repo: string, platform: Platform, purpose: Purpose, channel: string): void {
    this.db.sql.exec(
      `INSERT INTO channels (repo, platform, purpose, channel) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo, platform, purpose) DO UPDATE SET channel = excluded.channel`,
      repo,
      platform,
      purpose,
      channel,
    )
  }

  unmapChannel(repo: string, platform: Platform, purpose: Purpose): void {
    this.db.sql.exec(
      "DELETE FROM channels WHERE repo = ? AND platform = ? AND purpose = ?",
      repo,
      platform,
      purpose,
    )
  }

  channels(platform?: Platform): ChannelMapping[] {
    const query = "SELECT repo, platform, purpose, channel FROM channels"
    const order = " ORDER BY repo, platform, purpose"
    return platform === undefined
      ? this.db.sql
          .exec<ChannelRow>(query + order)
          .toArray()
          .map(toMapping)
      : this.db.sql
          .exec<ChannelRow>(`${query} WHERE platform = ?${order}`, platform)
          .toArray()
          .map(toMapping)
  }

  homeChannel(repo: string, platform: Platform): string | undefined {
    return this.channel(repo, platform, "home")
  }

  /** Where a repo's news goes on `platform`: its announce channel, else its home. */
  newsChannel(repo: string, platform: Platform): string | undefined {
    return this.channel(repo, platform, "announce") ?? this.channel(repo, platform, "home")
  }

  /**
   * Repos a conversation in `channel` could be about, most specific first.
   *
   * A channel that is some repo's home settles it; otherwise every repo with a
   * home on this platform is a candidate, so a caller can reject anything else.
   */
  reposFor(platform: Platform, ...channels: string[]): string[] {
    const homes = this.channels(platform).filter((m) => m.purpose === "home")
    const here = homes.filter((m) => channels.includes(m.channel)).map((m) => m.repo)
    return here.length > 0 ? here : [...new Set(homes.map((m) => m.repo))]
  }

  accessGroup(repo: string, platform: Platform): string | undefined {
    const row = this.db.sql
      .exec<{ group_id: string }>(
        "SELECT group_id FROM access_groups WHERE repo = ? AND platform = ?",
        repo,
        platform,
      )
      .next()
    return row.done ? undefined : row.value.group_id
  }

  accessGroups(platform: Platform): { repo: string; group: string }[] {
    return this.db.sql
      .exec<{ repo: string; group_id: string }>(
        "SELECT repo, group_id FROM access_groups WHERE platform = ? ORDER BY repo",
        platform,
      )
      .toArray()
      .map((row) => ({ repo: row.repo, group: row.group_id }))
  }

  setAccessGroup(repo: string, platform: Platform, group: string): void {
    this.db.sql.exec(
      `INSERT INTO access_groups (repo, platform, group_id) VALUES (?, ?, ?)
       ON CONFLICT (repo, platform) DO UPDATE SET group_id = excluded.group_id`,
      repo,
      platform,
      group,
    )
  }

  forgetAccessGroup(repo: string, platform: Platform): void {
    this.db.sql.exec("DELETE FROM access_groups WHERE repo = ? AND platform = ?", repo, platform)
  }

  private channel(repo: string, platform: Platform, purpose: Purpose): string | undefined {
    const row = this.db.sql
      .exec<{ channel: string }>(
        "SELECT channel FROM channels WHERE repo = ? AND platform = ? AND purpose = ?",
        repo,
        platform,
        purpose,
      )
      .next()
    return row.done ? undefined : row.value.channel
  }

  private set(id: number, field: (typeof FIELDS)[number], value: string | null): void {
    this.db.sql.exec(`UPDATE people SET ${field} = ? WHERE id = ?`, value, id)
  }

  private merge(from: Person, into: Person): void {
    this.db.sql.exec("DELETE FROM people WHERE id = ?", from.id)
    for (const field of FIELDS) {
      if (into[field] === null && from[field] !== null) this.set(into.id, field, from[field])
    }
  }

  setPlace(place: Place, platform: Platform, channel: string): void {
    this.db.sql.exec(
      `INSERT INTO places (place, platform, channel) VALUES (?, ?, ?)
       ON CONFLICT (place, platform) DO UPDATE SET channel = excluded.channel`,
      place,
      platform,
      channel,
    )
  }

  forgetPlace(place: Place, platform: Platform): void {
    this.db.sql.exec("DELETE FROM places WHERE place = ? AND platform = ?", place, platform)
  }

  place(place: Place, platform: Platform): string | undefined {
    const row = this.db.sql
      .exec<{ channel: string }>(
        "SELECT channel FROM places WHERE place = ? AND platform = ?",
        place,
        platform,
      )
      .next()
    return row.done ? undefined : row.value.channel
  }

  // Someone with neither a login nor an email is nobody the agent can name.
  private prune(): void {
    this.db.sql.exec("DELETE FROM people WHERE github IS NULL AND linear IS NULL")
  }
}

type ChannelRow = { repo: string; platform: string; purpose: string; channel: string }

function toMapping(row: ChannelRow): ChannelMapping {
  return {
    repo: row.repo,
    platform: row.platform === "slack" ? "slack" : "discord",
    purpose: row.purpose === "announce" ? "announce" : "home",
    channel: row.channel,
  }
}

function conflicts(a: Person, b: Person): boolean {
  return FIELDS.some(
    (field) => field !== "name" && a[field] !== null && b[field] !== null && a[field] !== b[field],
  )
}
