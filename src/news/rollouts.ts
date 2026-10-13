// bob's own deploys, announced in its repo's home channel for a few minutes:
// long enough to see how long a commit took to reach Discord, short enough
// not to clutter the channel. The posts are kept until they are deleted, so a
// restart in between still cleans them up.
import type { Chat } from "../chat/chat"
import type { Config } from "../store/config"
import { migrate } from "../store/migrations"
import type { SqlDatabase } from "../store/sql"
import { type Rollout, rolloutCard } from "../ui/rollout"

const STEPS = [
  `CREATE TABLE rollout_notices (
    platform TEXT NOT NULL,
    channel TEXT NOT NULL,
    id TEXT NOT NULL,
    delete_at INTEGER NOT NULL,
    PRIMARY KEY (platform, channel, id)
  )`,
]

/** What the gateway knows about a version when it first runs it. */
export interface DeployedVersion {
  /** The version's tag, the commit's sha when the deploy set it. */
  tag: string
  uploadedAt: number
  liveAt: number
  /** When the version's changed slash commands reached Discord. */
  commandsAt?: number
}

export const NOTICE_LIFETIME = 5 * 60 * 1000

export class Rollouts {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: Config,
    private readonly chats: Chat[],
  ) {
    migrate(db, "rollouts", STEPS)
  }

  /** Posts the notice in `repo`'s home on each platform. */
  async announce(repo: string, rollout: Rollout, now: number): Promise<void> {
    const card = rolloutCard(rollout, NOTICE_LIFETIME)
    for (const chat of this.chats) {
      const channel = this.config.homeChannel(repo, chat.platform)
      if (channel === undefined) continue
      const ref = await chat.post(channel, { cards: [card] })
      this.db.sql.exec(
        "INSERT OR REPLACE INTO rollout_notices (platform, channel, id, delete_at) VALUES (?, ?, ?, ?)",
        chat.platform,
        ref.channel,
        ref.id,
        now + NOTICE_LIFETIME,
      )
    }
  }

  /**
   * Deletes the notices that are due. One that fails stays for the next sweep,
   * unless it is a day overdue, when it most likely is gone already.
   */
  async sweep(now: number): Promise<void> {
    const due = this.db.sql
      .exec<{ platform: string; channel: string; id: string; delete_at: number }>(
        "SELECT platform, channel, id, delete_at FROM rollout_notices WHERE delete_at <= ?",
        now,
      )
      .toArray()
    for (const notice of due) {
      const chat = this.chats.find((candidate) => candidate.platform === notice.platform)
      const ref = { channel: notice.channel, id: notice.id }
      const gone = await (chat?.delete(ref) ?? Promise.resolve()).then(
        () => true,
        (error: unknown) => {
          console.error("deleting a deploy notice failed", error)
          return now - notice.delete_at > 24 * 60 * 60 * 1000
        },
      )
      if (!gone) continue
      this.db.sql.exec(
        "DELETE FROM rollout_notices WHERE platform = ? AND channel = ? AND id = ?",
        notice.platform,
        notice.channel,
        notice.id,
      )
    }
  }

  /** When the next notice is due, for the alarm. */
  nextSweep(): number | undefined {
    const row = this.db.sql
      .exec<{ at: number | null }>("SELECT min(delete_at) AS at FROM rollout_notices")
      .one()
    return row.at ?? undefined
  }
}
