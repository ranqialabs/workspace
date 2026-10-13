// The Durable Object that keeps bob's Discord gateway connection. An open
// outbound socket keeps a Durable Object in memory for at most fifteen
// minutes; the heartbeat alarm, every forty seconds or so, keeps it there for
// good. Only one instance exists, named "discord".
import { DurableObject } from "cloudflare:workers"
import { z } from "zod"

import { migrate } from "../store/migrations"
import { COMMANDS } from "./commands"
import { DiscordMessage } from "./inbound"
import { DiscordRest } from "./rest"
import { DiscordRouter } from "./route"
import { GatewaySession, type Resumable, type Socket } from "./session"

const Application = z.object({ id: z.string() })

const SCHEMA = [
  `CREATE TABLE session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    session_id TEXT NOT NULL,
    resume_url TEXT NOT NULL,
    seq INTEGER
  )`,
]

export class Gateway extends DurableObject<Env> {
  private readonly session: GatewaySession | undefined
  private readonly rest: DiscordRest | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    migrate(ctx.storage, "gateway", SCHEMA)
    const token = env.DISCORD_TOKEN
    if (token === undefined || token === "") return
    const rest = new DiscordRest(token)
    this.rest = rest
    const router = new DiscordRouter(rest)
    const sql = ctx.storage.sql
    this.session = new GatewaySession(token, {
      open: openSocket,
      load() {
        const [row] = sql
          .exec<{ session_id: string; resume_url: string; seq: number | null }>(
            "SELECT session_id, resume_url, seq FROM session",
          )
          .toArray()
        return row === undefined
          ? undefined
          : { sessionId: row.session_id, resumeUrl: row.resume_url, seq: row.seq }
      },
      save(state: Resumable | undefined) {
        sql.exec("DELETE FROM session")
        if (state === undefined) return
        sql.exec(
          "INSERT INTO session (id, session_id, resume_url, seq) VALUES (1, ?, ?, ?)",
          state.sessionId,
          state.resumeUrl,
          state.seq,
        )
      },
      schedule(delay) {
        void ctx.storage.setAlarm(Date.now() + delay)
      },
      ready: async ({ user, application }) => {
        // A resumed session gets no READY, so the ids have to outlive the instance.
        ctx.storage.kv.put("bot", user)
        ctx.storage.kv.put("application", application)
        await this.registerCommands(true)
      },
      dispatch: async (event, data) => {
        const bot = ctx.storage.kv.get<string>("bot")
        if (event !== "MESSAGE_CREATE" || bot === undefined) return
        const message = DiscordMessage.safeParse(data)
        if (!message.success) return
        const routed = await router.route(message.data, bot)
        if (routed === undefined) return
        await env.CONVERSATION.getByName(routed.name).mention(
          routed.name,
          routed.origin,
          routed.turn,
        )
      },
    })
  }

  /**
   * Connects if nothing is connected; the cron calls it so a deploy reconnects
   * even when no alarm is set.
   */
  async start(): Promise<void> {
    if (this.session?.connected === false) await this.session.tick()
    await this.registerCommands(false)
  }

  /** Overwrites the slash commands when they changed since the last time, or when `always`. */
  private async registerCommands(always: boolean): Promise<void> {
    const rest = this.rest
    if (rest === undefined) return
    const wanted = JSON.stringify(COMMANDS)
    if (!always && this.ctx.storage.kv.get<string>("commands") === wanted) return
    let application = this.ctx.storage.kv.get<string>("application")
    if (application === undefined) {
      application = Application.parse(await rest.get("/applications/@me")).id
      this.ctx.storage.kv.put("application", application)
    }
    const guild = this.env.DISCORD_GUILD_ID
    const route =
      guild === undefined || guild === ""
        ? `/applications/${application}/commands`
        : `/applications/${application}/guilds/${guild}/commands`
    await rest.put(route, COMMANDS)
    this.ctx.storage.kv.put("commands", wanted)
  }

  /**
   * The heartbeat. A deploy keeps the alarm, so this is also the first thing
   * new code runs here: checking the slash commands now brings a changed one
   * to Discord within a heartbeat instead of at the next cron.
   */
  override async alarm(): Promise<void> {
    await this.session?.tick()
    // A failure here must not fail the heartbeat; the cron tries again.
    await this.registerCommands(false).catch((error: unknown) => {
      console.error("registering the slash commands failed", error)
    })
  }
}

async function openSocket(url: string): Promise<Socket> {
  const response = await fetch(url.replace(/^wss:/, "https:"), {
    headers: { upgrade: "websocket" },
  })
  const socket = response.webSocket
  if (socket === null) throw new Error(`Discord's gateway refused the upgrade: ${response.status}`)
  socket.accept()
  return socket
}
