// Discord's gateway protocol: identify, heartbeat, resume. Messages and
// mentions only arrive over this socket. The Durable Object around it owns the
// timing: it calls tick() on every alarm, which sends the heartbeat and
// reconnects when Discord stopped acknowledging them.
import { z } from "zod"

export const GATEWAY_URL = "wss://gateway.discord.gg"
const QUERY = "?v=10&encoding=json"

const GUILDS = 1 << 0
const GUILD_MESSAGES = 1 << 9
const MESSAGE_CONTENT = 1 << 15
export const INTENTS = GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT

const Op = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const

/** Close codes after which reconnecting would fail the same way. */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])

const Frame = z.object({
  op: z.number(),
  d: z.unknown().optional(),
  s: z.number().nullish(),
  t: z.string().nullish(),
})

const Hello = z.object({ heartbeat_interval: z.number() })
const Ready = z.object({
  session_id: z.string(),
  resume_gateway_url: z.string(),
  user: z.object({ id: z.string() }),
  application: z.object({ id: z.string() }),
})

/** What survives the Durable Object being evicted, so a restart resumes. */
export interface Resumable {
  sessionId: string
  resumeUrl: string
  seq: number | null
}

/** The subset of a WebSocket the session uses. */
export interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(type: "close", listener: (event: { code: number }) => void): void
}

export interface SessionHooks {
  open(url: string): Promise<Socket>
  load(): Resumable | undefined
  save(state: Resumable | undefined): void
  /** When the next tick should come, in ms from now. */
  schedule(delay: number): void
  ready(ids: { user: string; application: string }): Promise<void>
  dispatch(event: string, data: unknown): Promise<void>
}

export class GatewaySession {
  private socket: Socket | undefined
  private interval = 41_250
  private acked = true
  private stopped = false

  constructor(
    private readonly token: string,
    private readonly hooks: SessionHooks,
  ) {}

  get connected(): boolean {
    return this.socket !== undefined
  }

  /** Called on every alarm: heartbeat, or reconnect when the last one went unanswered. */
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.socket === undefined) {
      await this.connect()
      return
    }
    if (!this.acked) {
      // A zombie connection: Discord asks for a non-1000 close so the session can resume.
      this.drop(4000)
      await this.connect()
      return
    }
    this.heartbeat()
    this.hooks.schedule(this.interval)
  }

  private async connect(): Promise<void> {
    const saved = this.hooks.load()
    const socket = await this.hooks.open((saved?.resumeUrl ?? GATEWAY_URL) + QUERY)
    this.socket = socket
    this.acked = true
    socket.addEventListener("message", (event) => {
      if (this.socket === socket && typeof event.data === "string") void this.receive(event.data)
    })
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.closed(event.code)
    })
  }

  private async receive(raw: string): Promise<void> {
    const frame = Frame.safeParse(JSON.parse(raw))
    if (!frame.success) return
    const { op, d, s, t } = frame.data
    if (typeof s === "number") this.remember(s)

    switch (op) {
      case Op.hello:
        this.interval = Hello.parse(d).heartbeat_interval
        this.greet()
        // Discord asks for the first heartbeat after a random part of the interval.
        this.hooks.schedule(Math.floor(this.interval * Math.random()))
        return
      case Op.heartbeat:
        this.heartbeat()
        return
      case Op.heartbeatAck:
        this.acked = true
        return
      case Op.reconnect:
        this.drop(4000)
        this.hooks.schedule(0)
        return
      case Op.invalidSession:
        if (d !== true) this.hooks.save(undefined)
        this.drop(d === true ? 4000 : 1000)
        this.hooks.schedule(1000 + Math.floor(4000 * Math.random()))
        return
      case Op.dispatch:
        await this.dispatched(t ?? "", d, s ?? null)
        return
      default:
    }
  }

  private async dispatched(event: string, data: unknown, seq: number | null): Promise<void> {
    if (event === "READY") {
      const ready = Ready.parse(data)
      this.hooks.save({ sessionId: ready.session_id, resumeUrl: ready.resume_gateway_url, seq })
      await this.hooks.ready({ user: ready.user.id, application: ready.application.id })
      return
    }
    await this.hooks.dispatch(event, data)
  }

  /** Identify on a fresh connection, resume where a saved session left off. */
  private greet(): void {
    const saved = this.hooks.load()
    if (saved === undefined) {
      this.send(Op.identify, {
        token: this.token,
        intents: INTENTS,
        properties: { os: "cloudflare", browser: "bob", device: "bob" },
      })
      return
    }
    this.send(Op.resume, { token: this.token, session_id: saved.sessionId, seq: saved.seq })
  }

  private heartbeat(): void {
    this.acked = false
    this.send(Op.heartbeat, this.hooks.load()?.seq ?? null)
  }

  private remember(seq: number): void {
    const saved = this.hooks.load()
    if (saved !== undefined) this.hooks.save({ ...saved, seq })
  }

  private closed(code: number): void {
    this.socket = undefined
    if (FATAL.has(code)) {
      this.stopped = true
      console.error(`discord gateway closed with ${code}; check the token and intents`)
      return
    }
    this.hooks.schedule(1000)
  }

  private drop(code: number): void {
    const socket = this.socket
    this.socket = undefined
    socket?.close(code, "reconnecting")
  }

  private send(op: number, d: unknown): void {
    this.socket?.send(JSON.stringify({ op, d }))
  }
}
