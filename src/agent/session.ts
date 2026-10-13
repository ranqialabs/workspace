// One conversation with bob: a Discord channel or thread, or a Slack thread.
// It keeps the whole history the model saw, tool calls included, runs one
// answer at a time and queues whatever arrives meanwhile, and holds the drafts
// a human may submit. The Durable Object around it only wires the platform in.
import { type LanguageModel, type ModelMessage, modelMessageSchema, tool, type ToolSet } from "ai"
import { z } from "zod"

import type { Card } from "../ui/card"
import type { Button, Chat, MessageRef } from "../chat/chat"
import { Throttled } from "../chat/throttle"
import type { GitHub } from "../github/app"
import type { Person } from "../store/config"
import { migrate } from "../store/migrations"
import type { SqlDatabase } from "../store/sql"
import { IssueDraft } from "./draft"
import { draftCard, type DraftState } from "../ui/draft"
import { BUTTON, REPLY } from "../ui/replies"
import { type ConversationAction, pressId } from "../chat/press"
import { cut } from "../ui/text"
import { Progress } from "./progress"
import { progressCard, type RunStatus } from "../ui/progress"
import { type Ask, turnText } from "./prompt"
import { runAgent } from "./run"
import type { Sauron } from "../sauron/client"
import { GITHUB_INSTRUCTIONS, githubTools } from "./tools/github"
import { SAURON_INSTRUCTIONS, sauronTools } from "./tools/sauron"

const SCHEMA = [
  `CREATE TABLE place (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel TEXT NOT NULL,
    thread TEXT
  )`,
  "CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)",
  "CREATE TABLE pending (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, ask TEXT NOT NULL)",
  `CREATE TABLE drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester TEXT NOT NULL,
    draft TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'proposed',
    card_channel TEXT NOT NULL,
    card_id TEXT NOT NULL,
    issue_number INTEGER,
    issue_url TEXT
  )`,
]

const SEED_MESSAGES = 8
// The model reads this much of the history back on each turn; older turns stay
// stored but out of the prompt.
const HISTORY_TURNS = 20
const LIVE_EDIT_MS = 1500

export interface Turn {
  /** Where bob answers: a Discord channel or thread, or a Slack channel. */
  channel: string
  /** Slack's thread; unset on Discord, where a thread is a channel. */
  thread?: string
  /** The message that called bob. */
  message: string
  author: { id: string; name: string }
  text: string
}

export interface Surroundings {
  org: string
  candidates: string[]
  teammates: Person[]
  /** The conversation's link, for the issue body. */
  link?: string
}

export interface SessionDeps {
  name: string
  chat: Chat
  github(): Promise<GitHub>
  model(): LanguageModel
  surroundings(): Promise<Surroundings>
  /** Grafana, when bob has a token for it; without one the Sauron tools stay out. */
  sauron?(): Sauron | undefined
}

const AskRow = z.object({
  author: z.object({ id: z.string(), name: z.string() }),
  text: z.string(),
})

type DraftRow = {
  id: number
  requester: string
  draft: string
  state: string
  card_channel: string
  card_id: string
  issue_number: number | null
  issue_url: string | null
}

export class Session {
  private running: { controller: AbortController; requester: Ask["author"] } | undefined

  constructor(
    private readonly db: SqlDatabase,
    private readonly deps: SessionDeps,
  ) {
    migrate(db, "conversation", SCHEMA)
  }

  get busy(): boolean {
    return this.running !== undefined
  }

  /** Someone called bob. Starts a run, or queues the ask behind the one running. */
  async mention(turn: Turn): Promise<void> {
    this.db.sql.exec(
      "INSERT INTO place (id, channel, thread) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING",
      turn.channel,
      turn.thread ?? null,
    )
    const ask: Ask = { author: turn.author, text: turn.text }
    this.db.sql.exec(
      "INSERT INTO pending (message, ask) VALUES (?, ?)",
      turn.message,
      JSON.stringify(ask),
    )
    if (this.running !== undefined) {
      await this.deps.chat.post(turn.channel, {
        text: REPLY.queued,
        replyTo: this.replyRef(turn.message),
      })
      return
    }
    await this.drain()
  }

  /** A button press. Returns what to tell the presser, privately, if anything. */
  async press(
    action: ConversationAction,
    target: number,
    user: Ask["author"],
  ): Promise<string | undefined> {
    if (action === "stop") return this.stop(user)
    const row = this.draftRow(target)
    if (row === undefined) return REPLY.draftGone
    if (row.requester !== user.id) return REPLY.notYourDraft
    if (row.state !== "proposed") return REPLY.draftEnded(row.state)
    const draft = IssueDraft.parse(JSON.parse(row.draft))
    if (action === "discard") {
      this.setState(row.id, "discarded")
      await this.showDraft(row, draft, { kind: "discarded" })
      return undefined
    }
    return this.submit(row, draft)
  }

  private stop(user: Ask["author"]): string | undefined {
    if (this.running === undefined) return REPLY.nothingRunning
    if (this.running.requester.id !== user.id) return REPLY.notYourRun(this.running.requester.name)
    this.running.controller.abort(new StopError(user.name))
    return undefined
  }

  private async drain(): Promise<void> {
    for (;;) {
      const rows = this.db.sql
        .exec<{ seq: number; message: string; ask: string }>(
          "SELECT seq, message, ask FROM pending ORDER BY seq",
        )
        .toArray()
      const last = rows.at(-1)
      if (last === undefined) return
      this.db.sql.exec("DELETE FROM pending WHERE seq <= ?", last.seq)
      const asks = rows.map((row) => AskRow.parse(JSON.parse(row.ask)))
      await this.answer(asks, rows[0]?.message ?? last.message, last.message)
    }
  }

  private async answer(asks: Ask[], firstMessage: string, lastMessage: string): Promise<void> {
    const requester = asks.at(-1)?.author ?? { id: "", name: "someone" }
    const controller = new AbortController()
    this.running = { controller, requester }
    const { chat } = this.deps
    const place = this.place()
    const progress = new Progress()
    const stop: Button = { id: this.buttonId("stop", 0), label: BUTTON.stop, style: "secondary" }
    const card = await chat.post(place.channel, {
      cards: [progressCard(progress.steps, { kind: "thinking" })],
      buttons: [stop],
      replyTo: this.replyRef(lastMessage),
    })
    const live = new Throttled<Card>(
      (shown) => chat.edit(card, { cards: [shown], buttons: [stop] }),
      LIVE_EDIT_MS,
    )

    try {
      const [surroundings, github] = await Promise.all([
        this.deps.surroundings(),
        this.deps.github(),
      ])
      const history = this.history()
      const seed =
        history.length === 0
          ? await chat.read(place.channel, {
              thread: place.thread,
              before: firstMessage,
              limit: SEED_MESSAGES,
            })
          : []
      const open = this.openDraft()
      const sauron = this.deps.sauron?.()
      const result = await runAgent({
        model: this.deps.model(),
        tools: this.tools(github, surroundings, place, sauron),
        history,
        turn: turnText({ asks, candidates: surroundings.candidates, seed, draft: open?.draft }),
        candidates: surroundings.candidates,
        extraInstructions:
          sauron === undefined
            ? GITHUB_INSTRUCTIONS
            : `${GITHUB_INSTRUCTIONS}\n\n${SAURON_INSTRUCTIONS}`,
        signal: controller.signal,
        events: {
          toolStarted(id, name, input) {
            progress.started(id, name, input)
            live.update(progressCard(progress.steps, { kind: "working" }))
          },
          toolFinished(id, error) {
            progress.finished(id, error)
            live.update(progressCard(progress.steps, { kind: "working" }))
          },
        },
      })
      this.remember(result.messages)
      const status: RunStatus = { kind: result.reply.kind === "draft" ? "drafted" : "answered" }
      await live.settle()
      await chat.edit(card, { cards: [progressCard(progress.steps, status, result.usage)] })

      if (result.reply.kind === "answer") {
        await chat.post(place.channel, {
          text: result.reply.text || REPLY.noAnswer,
          replyTo: this.replyRef(lastMessage),
        })
      } else {
        await this.propose(result.reply.draft, requester, result.reply.text, lastMessage)
      }
    } catch (error) {
      let status: RunStatus = { kind: "stopped", by: stoppedBy(controller.signal) }
      if (!controller.signal.aborted) {
        console.error("agent run failed", error)
        status = { kind: "failed", reason: explain(error) }
      }
      await live.settle()
      await chat.edit(card, { cards: [progressCard(progress.steps, status)] })
    } finally {
      this.running = undefined
    }
  }

  private async propose(
    draft: IssueDraft,
    requester: Ask["author"],
    note: string,
    replyTo: string,
  ): Promise<void> {
    const place = this.place()
    for (const old of this.proposedDrafts()) {
      this.setState(old.id, "superseded")
      const previous = IssueDraft.parse(JSON.parse(old.draft))
      await this.showDraft(old, previous, { kind: "superseded" })
    }
    this.db.sql.exec(
      "INSERT INTO drafts (requester, draft, card_channel, card_id) VALUES (?, ?, ?, '')",
      requester.id,
      JSON.stringify(draft),
      place.channel,
    )
    const id = this.db.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id
    const card = await this.deps.chat.post(place.channel, {
      text: note || undefined,
      cards: [draftCard(draft, { kind: "proposed", requester: requester.name })],
      buttons: this.draftButtons(id),
      replyTo: this.replyRef(replyTo),
    })
    this.db.sql.exec("UPDATE drafts SET card_id = ? WHERE id = ?", card.id, id)
  }

  private async submit(row: DraftRow, draft: IssueDraft): Promise<string | undefined> {
    const [owner = "", repo = ""] = draft.repo.split("/")
    const { link } = await this.deps.surroundings()
    const github = await this.deps.github()
    const body = link === undefined ? draft.body : `${draft.body}\n\n---\nDiscussed in ${link}`
    try {
      const { data } = await github.rest.issues.create({
        owner,
        repo,
        title: draft.title,
        body,
        labels: draft.labels,
        assignees: draft.assignee === null ? [] : [draft.assignee],
      })
      this.db.sql.exec(
        "UPDATE drafts SET state = 'submitted', issue_number = ?, issue_url = ? WHERE id = ?",
        data.number,
        data.html_url,
        row.id,
      )
      await this.showDraft(row, draft, {
        kind: "filed",
        number: data.number,
        url: data.html_url,
      })
      await this.deps.chat.post(row.card_channel, {
        text: REPLY.filed(data.number, data.html_url, draft.repo),
        replyTo: this.replyRef(row.card_id),
      })
      return undefined
    } catch (error) {
      return REPLY.githubRefused(explain(error))
    }
  }

  private tools(
    github: GitHub,
    surroundings: Surroundings,
    place: Place,
    sauron: Sauron | undefined,
  ): ToolSet {
    const { chat } = this.deps
    return {
      ...githubTools(github, surroundings.org),
      ...(sauron === undefined ? {} : sauronTools(sauron)),
      teammates: tool({
        description:
          "The people bob knows: their names and GitHub and Linear accounts. The `github` field is what `assignee` takes.",
        inputSchema: z.object({}),
        execute: () =>
          Promise.resolve(
            surroundings.teammates.map(({ name, github: login, linear }) => ({
              name,
              github: login,
              linear,
            })),
          ),
      }),
      read_conversation: tool({
        description:
          "Earlier messages of this conversation, newest last. Pass the oldest id you have as `before` to read further back.",
        inputSchema: z.object({
          before: z.string().describe("A message id; only messages older than it come back"),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        execute: async ({ before, limit }) => {
          const messages = await chat.read(place.channel, { thread: place.thread, before, limit })
          return messages.map(({ id, author, text, at }) => ({ id, author: author.name, text, at }))
        },
      }),
    }
  }

  private draftButtons(id: number): Button[] {
    return [
      { id: this.buttonId("submit", id), label: BUTTON.file, style: "primary" },
      { id: this.buttonId("discard", id), label: BUTTON.discard, style: "danger" },
    ]
  }

  private async showDraft(row: DraftRow, draft: IssueDraft, state: DraftState): Promise<void> {
    const ref: MessageRef = { channel: row.card_channel, id: row.card_id }
    await this.deps.chat.edit(ref, { cards: [draftCard(draft, state)], buttons: [] })
  }

  /** `bob:<action>:<target>:<conversation>`; the platform routes it back here. */
  private buttonId(action: ConversationAction, target: number): string {
    return pressId(action, target, this.deps.name)
  }

  private replyRef(message: string): MessageRef {
    const place = this.place()
    return { channel: place.channel, id: place.thread ?? message }
  }

  private place(): Place {
    const row = this.db.sql
      .exec<{ channel: string; thread: string | null }>("SELECT channel, thread FROM place")
      .one()
    return { channel: row.channel, thread: row.thread ?? undefined }
  }

  private history(): ModelMessage[] {
    const rows = this.db.sql
      .exec<{ message: string }>("SELECT message FROM history ORDER BY seq")
      .toArray()
    const messages = rows.map((row) => modelMessageSchema.parse(JSON.parse(row.message)))
    return recentTurns(messages, HISTORY_TURNS)
  }

  private remember(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.db.sql.exec("INSERT INTO history (message) VALUES (?)", JSON.stringify(message))
    }
  }

  private openDraft(): { id: number; draft: IssueDraft } | undefined {
    const row = this.proposedDrafts().at(-1)
    return row === undefined
      ? undefined
      : { id: row.id, draft: IssueDraft.parse(JSON.parse(row.draft)) }
  }

  private proposedDrafts(): DraftRow[] {
    return this.db.sql
      .exec<DraftRow>("SELECT * FROM drafts WHERE state = 'proposed' ORDER BY id")
      .toArray()
  }

  private draftRow(id: number): DraftRow | undefined {
    return this.db.sql.exec<DraftRow>("SELECT * FROM drafts WHERE id = ?", id).toArray()[0]
  }

  private setState(id: number, state: string): void {
    this.db.sql.exec("UPDATE drafts SET state = ? WHERE id = ?", state, id)
  }
}

interface Place {
  channel: string
  thread?: string
}

class StopError extends Error {
  constructor(readonly by: string) {
    super(`stopped by ${by}`)
  }
}

function stoppedBy(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  return reason instanceof StopError ? reason.by : "someone"
}

/** The last `turns` user turns and everything after them, so a cut never splits a tool call from its result. */
export function recentTurns(messages: ModelMessage[], turns: number): ModelMessage[] {
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue
    seen += 1
    if (seen === turns) return messages.slice(index)
  }
  return messages
}

/** One readable line for a failure, without the request dumps providers attach. */
export function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return cut(message.split("\n")[0] ?? "", 300)
}
