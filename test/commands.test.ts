import { beforeEach, expect, test } from "bun:test"

import { type Directory, run } from "../src/commands"
import { Config } from "../src/store/config"
import { memoryDatabase } from "./memory-database"

const directory: Directory = {
  repo: (name) => Promise.resolve(name.toLowerCase() === "acme/web" ? "acme/web" : undefined),
  member: (login) => Promise.resolve(login.toLowerCase() === "ana" ? "Ana" : undefined),
}

let config: Config
beforeEach(() => {
  config = new Config(memoryDatabase())
})

test("mapping a repo saves it under GitHub's spelling", async () => {
  const reply = await run(
    { name: "map-repo", repo: "ACME/web", channel: "c1", purpose: "home" },
    "discord",
    config,
    directory,
  )
  expect(reply.text).toBe("`acme/web` now sends its news and conversations to <#c1>.")
  expect(config.homeChannel("acme/web", "discord")).toBe("c1")
})

test("a repo the org does not have is refused", async () => {
  const reply = await run(
    { name: "map-repo", repo: "acme/nope", channel: "c1", purpose: "home" },
    "slack",
    config,
    directory,
  )
  expect(reply.text).toContain("can't find")
  expect(config.channels()).toEqual([])
})

test("linking a GitHub login checks the org, a Linear email does not", async () => {
  await run(
    { name: "map-person", account: "github", value: "ana", user: "U1" },
    "slack",
    config,
    directory,
  )
  await run(
    { name: "map-person", account: "linear", value: "ana@acme.dev", user: "U1" },
    "slack",
    config,
    directory,
  )
  expect(config.personBy("slack", "U1")).toMatchObject({ github: "Ana", linear: "ana@acme.dev" })
  const refused = await run(
    { name: "map-person", account: "github", value: "zed", user: "U2" },
    "slack",
    config,
    directory,
  )
  expect(refused.text).toContain("not a member")
})

test("the config card shows only this platform's channels and people", async () => {
  config.mapChannel("acme/web", "discord", "home", "d1")
  config.mapChannel("acme/web", "discord", "announce", "d2")
  config.setAccessGroup("acme/web", "discord", "r1")
  config.mapChannel("acme/api", "slack", "home", "s1")
  config.link("discord", "D1", "github", "ana")
  const { cards } = await run({ name: "config" }, "discord", config, directory)
  expect(cards?.[0]?.body).toBe(
    [
      "**Repos**",
      "**acme/web** · <#d1> · news in <#d2> · <@&r1>",
      "",
      "**People**",
      "<@D1> · GitHub `ana`",
    ].join("\n"),
  )
})

test("an empty config says how to start", async () => {
  const { cards } = await run({ name: "config" }, "slack", config, directory)
  expect(cards?.[0]?.body).toContain("Map one with `map repo`.")
})
