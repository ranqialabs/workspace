import { beforeEach, expect, test } from "bun:test"

import { Newsroom } from "../src/news/newsroom"
import { Reminders } from "../src/news/reminders"
import { changeFor } from "../src/news/stories"
import { Config } from "../src/store/config"
import { FakeChat } from "./fake-chat"
import { memoryDatabase } from "./memory-database"

const HOUR = 3_600_000
// Monday 2026-10-12, 10:00 in São Paulo.
const MONDAY_10 = Date.parse("2026-10-12T13:00:00Z")

const repository = {
  name: "web",
  full_name: "acme/web",
  html_url: "https://github.com/acme/web",
  default_branch: "main",
}
const pull = (action: string, extra: object = {}) =>
  changeFor("pull_request", {
    action,
    pull_request: {
      number: 31,
      title: "fix: login loops",
      html_url: "https://github.com/acme/web/pull/31",
      user: { login: "ana" },
      updated_at: "2026-10-11T09:00:00Z",
    },
    repository,
    ...extra,
  })

let now = 0
let chat: FakeChat
let newsroom: Newsroom
let reminders: Reminders

beforeEach(async () => {
  const db = memoryDatabase()
  const config = new Config(db)
  config.mapChannel("acme/web", "discord", "home", "d-web")
  config.link("discord", "D-BETO", "github", "beto")
  chat = new FakeChat("discord")
  now = MONDAY_10
  newsroom = new Newsroom(db, config, [chat], () => Promise.resolve(undefined), { now: () => now })
  reminders = new Reminders(db, newsroom, config, [chat], "America/Sao_Paulo", () => now)
  const requested = pull("review_requested", { requested_reviewer: { login: "beto" } })
  if (requested === undefined) throw new Error("expected a change")
  await newsroom.publish(requested)
  chat.log.length = 0
})

test("a review waiting more than a day is a reply under the card, once a day", async () => {
  await reminders.run()
  expect(chat.log).toEqual([
    "post d-web/m2 ↩m1 ⏳ <@D-BETO>, **fix: login loops** #31 has waited 28 hours for your review.",
  ])
  now += 5 * 60_000
  await reminders.run()
  expect(chat.log).toHaveLength(1)
  now += 24 * HOUR
  await reminders.run()
  expect(chat.log).toHaveLength(2)
})

test("nobody is reminded outside working hours", async () => {
  now = Date.parse("2026-10-12T23:00:00Z")
  await reminders.run()
  now = Date.parse("2026-10-17T15:00:00Z")
  await reminders.run()
  expect(chat.log).toEqual([])
})

test("a review given ends the reminders", async () => {
  const reviewed = changeFor("pull_request_review", {
    action: "submitted",
    review: { user: { login: "beto" }, state: "approved" },
    pull_request: { number: 31, title: "fix: login loops", html_url: "x", user: { login: "ana" } },
    repository,
  })
  if (reviewed === undefined) throw new Error("expected a change")
  await newsroom.publish(reviewed)
  chat.log.length = 0
  await reminders.run()
  expect(chat.log).toEqual([])
})
