import { beforeEach, expect, test } from "bun:test"

import { Newsroom } from "../src/news/newsroom"
import { changeFor } from "../src/news/stories"
import { Config } from "../src/store/config"
import { FakeChat } from "./fake-chat"
import { memoryDatabase } from "./memory-database"

const repository = {
  name: "web",
  full_name: "acme/web",
  html_url: "https://github.com/acme/web",
  default_branch: "main",
}

const issue = (action: string, extra: object = {}) =>
  changeFor("issues", {
    action,
    issue: {
      number: 7,
      title: "Login loops",
      html_url: "https://github.com/acme/web/issues/7",
      state: action === "closed" ? "closed" : "open",
      state_reason: action === "closed" ? "completed" : null,
      user: { login: "ana" },
      assignees: [],
    },
    repository,
    ...extra,
  })

const job = (name: string) =>
  changeFor("check_run", {
    action: "completed",
    check_run: {
      name,
      head_sha: "abc1234def",
      details_url: "https://github.com/acme/web/actions/runs/5/job/1",
      conclusion: "success",
      check_suite: { head_branch: "main" },
    },
    repository,
  })

let now = 0
let config: Config
let discord: FakeChat
let slack: FakeChat
let newsroom: Newsroom
let lookups: string[]

beforeEach(() => {
  now = 1_000_000
  const db = memoryDatabase()
  config = new Config(db)
  config.mapChannel("acme/web", "discord", "home", "d-web")
  config.setAccessGroup("acme/web", "discord", "r1")
  config.link("discord", "D-ANA", "github", "ana")
  discord = new FakeChat("discord")
  slack = new FakeChat("slack")
  lookups = []
  newsroom = new Newsroom(
    db,
    config,
    [discord, slack],
    (repo, sha) => {
      lookups.push(`${repo}@${sha}`)
      return Promise.resolve({ subject: "fix: the loop", login: "ana" })
    },
    () => now,
  )
})

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value")
  return value
}

test("news goes only to platforms that follow the repo", async () => {
  await newsroom.publish(must(issue("opened")))
  expect(discord.log).toEqual(["post d-web/m1 <@&r1> | 🐛 issue · web"])
  expect(slack.log).toEqual([])
})

test("a fresh card is edited, and a ping on it goes out as a reply", async () => {
  await newsroom.publish(must(issue("opened")))
  now += 5 * 60_000
  await newsroom.publish(must(issue("assigned", { assignee: { login: "ana" } })))
  await newsroom.publish(must(issue("closed")))
  expect(discord.log).toEqual([
    "post d-web/m1 <@&r1> | 🐛 issue · web",
    "edit d-web/m1 🐛 issue · web",
    "post d-web/m2 ↩m1 <@D-ANA>",
    "edit d-web/m1 ✅ closed · web",
  ])
})

test("a card that has scrolled away is posted again", async () => {
  await newsroom.publish(must(issue("opened")))
  now += 2 * 60 * 60_000
  await newsroom.publish(must(issue("closed")))
  expect(discord.log.at(-1)).toBe("post d-web/m2 ✅ closed · web")
  expect(newsroom.card("issue:acme/web:7", "discord")?.id).toBe("m2")
})

test("moving the repo's channel starts a card in the new one", async () => {
  await newsroom.publish(must(issue("opened")))
  config.mapChannel("acme/web", "discord", "announce", "d-news")
  await newsroom.publish(must(issue("closed")))
  expect(discord.log.at(-1)).toBe("post d-news/m2 ✅ closed · web")
})

test("both platforms get the card when both follow the repo", async () => {
  config.mapChannel("acme/web", "slack", "home", "s-web")
  config.link("slack", "S-ANA", "github", "ana")
  await newsroom.publish(must(issue("assigned", { assignee: { login: "ana" } })))
  expect(discord.log).toEqual(["post d-web/m1 <@D-ANA> | 🐛 issue · web"])
  expect(slack.log).toEqual(["post s-web/m1 <@S-ANA> | 🐛 issue · web"])
})

test("concurrent steps of one commit land on one card, looked up once", async () => {
  await Promise.all([newsroom.publish(must(job("lint"))), newsroom.publish(must(job("test")))])
  expect(discord.log).toEqual([
    "post d-web/m1 ✅ pipeline · web",
    "edit d-web/m1 ✅ pipeline · web",
  ])
  expect(lookups).toEqual(["acme/web@abc1234def"])
  const story = newsroom.story("pipeline:acme/web:abc1234def")
  expect(story?.kind === "pipeline" && story.steps).toHaveLength(1)
})

test("a failed lookup still publishes, leading with the sha", async () => {
  newsroom = new Newsroom(memoryDatabase(), config, [discord], () =>
    Promise.reject(new Error("404")),
  )
  await newsroom.publish(must(job("lint")))
  expect(discord.log).toHaveLength(1)
})

test("old stories are pruned", async () => {
  await newsroom.publish(must(issue("opened")))
  now += 31 * 24 * 60 * 60_000
  newsroom.prune()
  expect(newsroom.story("issue:acme/web:7")).toBeUndefined()
  expect(newsroom.card("issue:acme/web:7", "discord")).toBeUndefined()
})
