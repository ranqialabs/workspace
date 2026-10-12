// Nudges for work that waits on someone. A review asked for more than a day
// ago gets one reminder per day, in a reply under the pull request's card, on
// working days and hours only. The cron calls this every five minutes; the
// table keeps it from saying the same thing twice.
import type { Chat } from "../chat/chat"
import { mentionsFor } from "../chat/mentions"
import type { Config } from "../store/config"
import { migrate } from "../store/migrations"
import type { SqlDatabase } from "../store/sql"
import { workingHours } from "../time"
import { reviewReminder } from "../ui/news"
import type { Newsroom } from "./newsroom"
import { storyKey } from "./stories"

const STEPS = [
  `CREATE TABLE reminders (
    key TEXT NOT NULL,
    login TEXT NOT NULL,
    reminded_at INTEGER NOT NULL,
    PRIMARY KEY (key, login)
  )`,
]

const DAY = 24 * 60 * 60 * 1000

export class Reminders {
  constructor(
    private readonly db: SqlDatabase,
    private readonly newsroom: Newsroom,
    private readonly config: Config,
    private readonly chats: Chat[],
    private readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {
    migrate(db, "reminders", STEPS)
  }

  async run(): Promise<void> {
    const now = this.now()
    if (!workingHours(now, this.timeZone)) return
    for (const pull of this.newsroom.stories("pull")) {
      if (pull.status !== "open") continue
      const key = storyKey("pull", pull.repo.fullName, pull.number)
      for (const review of pull.reviews) {
        if (review.verdict !== "requested" || review.requestedAt === undefined) continue
        const waiting = now - Date.parse(review.requestedAt)
        if (waiting < DAY || this.remindedWithin(key, review.login, now - DAY)) continue
        await this.remind(key, review.login, waiting, pull.title, pull.number)
        this.db.sql.exec(
          `INSERT INTO reminders (key, login, reminded_at) VALUES (?, ?, ?)
           ON CONFLICT (key, login) DO UPDATE SET reminded_at = excluded.reminded_at`,
          key,
          review.login,
          now,
        )
      }
    }
  }

  private remindedWithin(key: string, login: string, since: number): boolean {
    return (
      this.db.sql
        .exec(
          "SELECT 1 FROM reminders WHERE key = ? AND login = ? AND reminded_at > ?",
          key,
          login,
          since,
        )
        .toArray().length > 0
    )
  }

  private async remind(
    key: string,
    login: string,
    waiting: number,
    title: string,
    number: number,
  ): Promise<void> {
    for (const chat of this.chats) {
      const card = this.newsroom.card(key, chat.platform)
      const mention = mentionsFor(this.config, chat.platform).person(login)
      // Without a card to answer or a way to notify them, a reminder is noise.
      if (card === undefined || mention === undefined) continue
      const text = reviewReminder(mention, title, number, waiting)
      await chat.post(card.channel, { text, replyTo: card }).catch((error: unknown) => {
        console.error("review reminder failed", error)
      })
    }
  }
}
