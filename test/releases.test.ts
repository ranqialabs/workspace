import { beforeEach, expect, test } from "bun:test"

import { Newsroom } from "../src/news/newsroom"
import { Releases } from "../src/news/releases"
import { changeFor } from "../src/news/stories"
import { Config } from "../src/store/config"
import { type Calls, fakeGitHub } from "./agent/github"
import { FakeChat } from "./fake-chat"
import { memoryDatabase } from "./memory-database"

const repository = {
  name: "web",
  full_name: "acme/web",
  html_url: "https://github.com/acme/web",
  default_branch: "main",
}

function deployed(sha: string, state = "success", environment = "production") {
  const change = changeFor("deployment_status", {
    deployment_status: { state, updated_at: "2026-10-12T10:05:00Z" },
    deployment: { sha, ref: "main", environment },
    repository,
  })
  if (change === undefined) throw new Error("expected a change")
  return change
}

let chat: FakeChat
let newsroom: Newsroom
let releases: Releases
let calls: Calls
let compare: { status: string; commits: { commit: { message: string } }[] }

beforeEach(() => {
  const db = memoryDatabase()
  const config = new Config(db)
  config.mapChannel("acme/web", "discord", "home", "d-web")
  chat = new FakeChat("discord")
  calls = []
  compare = {
    status: "ahead",
    commits: [
      { commit: { message: "fix: login loops on Safari (#31)\n\nbody" } },
      { commit: { message: "chore: bump deps" } },
    ],
  }
  newsroom = new Newsroom(db, config, [chat], () => Promise.resolve(undefined))
  const github = fakeGitHub({ "repos.compareCommits": () => compare }, calls)
  releases = new Releases(db, newsroom, [chat], {
    github: () => Promise.resolve(github),
    model: () => undefined,
  })
})

async function ship(sha: string, state = "success", environment = "production"): Promise<void> {
  await releases.after(await newsroom.publish(deployed(sha, state, environment)))
}

test("the first production deploy only sets the starting point", async () => {
  await ship("aaa1111")
  expect(calls).toEqual([])
  expect(chat.log.some((line) => line.includes("What shipped"))).toBe(false)
})

test("the next one lists the commits since, under its checks card", async () => {
  await ship("aaa1111")
  await ship("bbb2222", "in_progress")
  await ship("bbb2222")
  expect(calls[0]?.params).toMatchObject({ base: "aaa1111", head: "bbb2222" })
  expect(chat.log.at(-1)).toBe(
    "post d-web/m3 ↩m2 🚀 **What shipped to production**\n- fix: login loops on Safari (#31)\n- chore: bump deps",
  )
  await ship("bbb2222")
  expect(calls).toHaveLength(1)
})

test("previews and rollbacks announce nothing", async () => {
  await ship("aaa1111")
  await ship("ccc3333", "success", "preview")
  expect(calls).toEqual([])
  compare = { status: "behind", commits: [] }
  await ship("0000000")
  expect(chat.log.some((line) => line.includes("What shipped"))).toBe(false)
})
