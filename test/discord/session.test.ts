import { beforeEach, expect, test } from "bun:test"

import { GATEWAY_URL, GatewaySession, type Resumable, type Socket } from "../../src/discord/session"

class FakeSocket implements Socket {
  sent: { op: number; d: unknown }[] = []
  closedWith: number | undefined
  private onMessage: ((event: { data: unknown }) => void) | undefined
  private onClose: ((event: { code: number }) => void) | undefined

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number): void {
    this.closedWith = code
  }

  addEventListener(type: "message" | "close", listener: never): void {
    if (type === "message") this.onMessage = listener
    else this.onClose = listener
  }

  receive(frame: object): void {
    this.onMessage?.({ data: JSON.stringify(frame) })
  }

  hangUp(code: number): void {
    this.onClose?.({ code })
  }
}

let sockets: FakeSocket[]
let opened: string[]
let saved: Resumable | undefined
let delays: number[]
let readies: string[]
let events: string[]

function session() {
  return new GatewaySession("token", {
    open(url) {
      opened.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return Promise.resolve(socket)
    },
    load: () => saved,
    save(state) {
      saved = state
    },
    schedule(delay) {
      delays.push(delay)
    },
    ready(ids) {
      readies.push(ids.application)
      return Promise.resolve()
    },
    dispatch(event) {
      events.push(event)
      return Promise.resolve()
    },
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  sockets = []
  opened = []
  saved = undefined
  delays = []
  readies = []
  events = []
})

const ready = {
  op: 0,
  s: 1,
  t: "READY",
  d: {
    session_id: "sess",
    resume_gateway_url: "wss://resume.discord.gg",
    user: { id: "bot" },
    application: { id: "app" },
  },
}

test("a fresh connection identifies, then saves the session on READY", async () => {
  const gateway = session()
  await gateway.tick()
  expect(opened).toEqual([GATEWAY_URL + "?v=10&encoding=json"])
  const socket = sockets[0]!
  socket.receive({ op: 10, d: { heartbeat_interval: 1000 } })
  expect(socket.sent[0]?.op).toBe(2)
  expect(delays[0]).toBeLessThan(1000)
  socket.receive(ready)
  await flush()
  expect(saved).toEqual({ sessionId: "sess", resumeUrl: "wss://resume.discord.gg", seq: 1 })
  expect(readies).toEqual(["app"])
})

test("a saved session resumes at its resume URL with the last sequence", async () => {
  saved = { sessionId: "sess", resumeUrl: "wss://resume.discord.gg", seq: 7 }
  const gateway = session()
  await gateway.tick()
  expect(opened).toEqual(["wss://resume.discord.gg?v=10&encoding=json"])
  sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 1000 } })
  expect(sockets[0]!.sent[0]).toEqual({ op: 6, d: { token: "token", session_id: "sess", seq: 7 } })
})

test("each tick heartbeats with the last sequence and an unanswered one reconnects", async () => {
  const gateway = session()
  await gateway.tick()
  const first = sockets[0]!
  first.receive({ op: 10, d: { heartbeat_interval: 1000 } })
  first.receive(ready)
  await flush()
  first.receive({ op: 0, s: 2, t: "MESSAGE_CREATE", d: {} })
  await gateway.tick()
  expect(first.sent.at(-1)).toEqual({ op: 1, d: 2 })
  expect(delays.at(-1)).toBe(1000)
  first.receive({ op: 11 })
  await gateway.tick()
  expect(sockets).toHaveLength(1)
  await gateway.tick()
  expect(first.closedWith).toBe(4000)
  expect(opened.at(-1)).toBe("wss://resume.discord.gg?v=10&encoding=json")
})

test("dispatches other than READY reach the handler", async () => {
  const gateway = session()
  await gateway.tick()
  sockets[0]!.receive({ op: 0, s: 1, t: "MESSAGE_CREATE", d: {} })
  await flush()
  expect(events).toEqual(["MESSAGE_CREATE"])
})

test("an invalid session that cannot resume is forgotten", async () => {
  saved = { sessionId: "sess", resumeUrl: "wss://resume.discord.gg", seq: 7 }
  const gateway = session()
  await gateway.tick()
  sockets[0]!.receive({ op: 9, d: false })
  expect(saved).toBeUndefined()
  expect(gateway.connected).toBe(false)
  await gateway.tick()
  expect(opened.at(-1)).toBe(GATEWAY_URL + "?v=10&encoding=json")
})

test("a dropped socket reconnects soon, a rejected token never", async () => {
  const original = console.error
  console.error = () => {}
  const gateway = session()
  await gateway.tick()
  sockets[0]!.hangUp(1006)
  expect(delays.at(-1)).toBe(1000)
  await gateway.tick()
  sockets[1]!.hangUp(4004)
  await gateway.tick()
  console.error = original
  expect(sockets).toHaveLength(2)
})
