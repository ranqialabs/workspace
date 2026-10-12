// The Durable Object that keeps bob's Discord gateway connection. An open
// outbound socket keeps a Durable Object in memory for at most fifteen
// minutes; the heartbeat alarm, every forty seconds or so, keeps it there for
// good. Only one instance exists, named "discord".
import { DurableObject } from "cloudflare:workers"

import { migrate } from "../store/migrations"
import { COMMANDS } from "./commands"
import { DiscordRest } from "./rest"
import { GatewaySession, type Resumable, type Socket } from "./session"

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    migrate(ctx.storage, "gateway", SCHEMA)
    const token = env.DISCORD_TOKEN
    if (token === undefined || token === "") return
    const rest = new DiscordRest(token)
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
      async ready({ application }) {
        const guild = env.DISCORD_GUILD_ID
        const route =
          guild === undefined || guild === ""
            ? `/applications/${application}/commands`
            : `/applications/${application}/guilds/${guild}/commands`
        await rest.put(route, COMMANDS)
      },
      dispatch: () => Promise.resolve(),
    })
  }

  /** Connects if nothing is connected; the cron calls it so a deploy reconnects. */
  async start(): Promise<void> {
    if (this.session?.connected === false) await this.session.tick()
  }

  override async alarm(): Promise<void> {
    await this.session?.tick()
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
