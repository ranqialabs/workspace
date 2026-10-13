import { beforeEach, expect, test } from "bun:test"

import { NOTICE_LIFETIME, Rollouts } from "../src/news/rollouts"
import { Config } from "../src/store/config"
import { elapsed, type Rollout, rolloutCard } from "../src/ui/rollout"
import { FakeChat } from "./fake-chat"
import { memoryDatabase } from "./memory-database"

const COMMITTED = Date.parse("2026-10-13T00:38:59Z")

const rollout: Rollout = {
  commit: {
    sha: "d0b6e52aaaaaaaa",
    subject: "fix(discord): check the slash commands on every heartbeat",
    url: "https://github.com/acme/bob/commit/d0b6e52",
    at: COMMITTED,
  },
  uploadedAt: COMMITTED + 39_000,
  liveAt: COMMITTED + 70_000,
  commandsAt: COMMITTED + 71_000,
}

let discord: FakeChat
let slack: FakeChat
let rollouts: Rollouts

beforeEach(() => {
  const db = memoryDatabase()
  const config = new Config(db)
  config.mapChannel("acme/bob", "discord", "home", "d-bob")
  discord = new FakeChat("discord")
  slack = new FakeChat("slack")
  rollouts = new Rollouts(db, config, [discord, slack])
})

test("the card counts each step from the commit", () => {
  const card = rolloutCard(rollout, NOTICE_LIFETIME)
  expect(card.title).toBe("fix(discord): check the slash commands on every heartbeat")
  expect(card.body).toBe(
    [
      "✅ Committed `d0b6e52`",
      "✅ Built and uploaded · +39s",
      "✅ Running · +1m 10s",
      "✅ Slash commands updated · +1m 11s",
    ].join("\n"),
  )
  expect(card.footer).toBe("This message deletes itself in 5 min")
})

test("without the commit, the steps count from the upload", () => {
  const card = rolloutCard({ uploadedAt: 0, liveAt: 45_000 }, NOTICE_LIFETIME)
  expect(card.body).toBe(
    ["✅ Built and uploaded · +0s", "✅ Running · +45s", "✅ Slash commands unchanged"].join("\n"),
  )
})

test("elapsed reads at a glance", () => {
  expect(elapsed(4_400)).toBe("4s")
  expect(elapsed(125_000)).toBe("2m 05s")
  expect(elapsed(4_320_000)).toBe("1h 12m")
})

test("the notice goes to the repo's home and is deleted once due", async () => {
  await rollouts.announce("acme/bob", rollout, 1_000)
  expect(discord.log).toEqual(["post d-bob/m1 🚀 bob is live"])
  expect(slack.log).toEqual([])
  expect(rollouts.nextSweep()).toBe(1_000 + NOTICE_LIFETIME)

  await rollouts.sweep(1_000 + NOTICE_LIFETIME - 1)
  expect(discord.log).toHaveLength(1)

  await rollouts.sweep(1_000 + NOTICE_LIFETIME)
  expect(discord.log.at(-1)).toBe("delete d-bob/m1")
  expect(rollouts.nextSweep()).toBeUndefined()
})

test("a delete that fails is tried again", async () => {
  await rollouts.announce("acme/bob", rollout, 0)
  discord.delete = () => Promise.reject(new Error("down"))
  await rollouts.sweep(NOTICE_LIFETIME)
  expect(rollouts.nextSweep()).toBe(NOTICE_LIFETIME)
})
