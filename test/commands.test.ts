import { beforeEach, expect, test } from "bun:test"

import { type ConfigCommand, type Directory, run } from "../src/commands"
import { Config, type Platform } from "../src/store/config"
import { commandReply } from "../src/ui/commands"
import { memoryDatabase } from "./memory-database"

const directory: Directory = {
  repo: (name) => Promise.resolve(name.toLowerCase() === "acme/web" ? "acme/web" : undefined),
  member: (login) => Promise.resolve(login.toLowerCase() === "ana" ? "Ana" : undefined),
}

let config: Config
beforeEach(() => {
  config = new Config(memoryDatabase())
})

/** Runs a command and words the reply, as the Workspace does. */
async function say(command: ConfigCommand, platform: Platform) {
  return commandReply(await run(command, platform, config, directory), config, platform)
}

test("mapping a repo saves it under GitHub's spelling", async () => {
  const reply = await say(
    { name: "map-repo", repo: "ACME/web", channel: "c1", purpose: "home" },
    "discord",
  )
  expect(reply.text).toBe(
    "✅ <#c1> is now home to `acme/web`: its news, and the issues drafted there.",
  )
  expect(config.homeChannel("acme/web", "discord")).toBe("c1")
})

test("a repo the org does not have is refused", async () => {
  const reply = await say(
    { name: "map-repo", repo: "acme/nope", channel: "c1", purpose: "home" },
    "slack",
  )
  expect(reply.text).toContain("No repo called `acme/nope`")
  expect(config.channels()).toEqual([])
})

test("linking a GitHub login checks the org, a Linear email does not", async () => {
  await say({ name: "map-person", account: "github", value: "ana", user: "U1" }, "slack")
  await say({ name: "map-person", account: "linear", value: "ana@acme.dev", user: "U1" }, "slack")
  expect(config.personBy("slack", "U1")).toMatchObject({ github: "Ana", linear: "ana@acme.dev" })
  const refused = await say(
    { name: "map-person", account: "github", value: "zed", user: "U2" },
    "slack",
  )
  expect(refused.text).toContain("not a member")
})

test("the config card shows only this platform's channels and people", async () => {
  config.mapChannel("acme/web", "discord", "home", "d1")
  config.mapChannel("acme/web", "discord", "announce", "d2")
  config.setAccessGroup("acme/web", "discord", "r1")
  config.mapChannel("acme/api", "slack", "home", "s1")
  config.link("discord", "D1", "github", "ana")
  const { cards } = await say({ name: "config" }, "discord")
  expect(cards?.[0]?.body).toBe(
    [
      "**Repos**",
      "**web** <#d1>, news in <#d2>, access <@&r1>",
      "",
      "**People**",
      "<@D1> is `ana` on GitHub",
      "",
      "**Retro**",
      "Not posted. Choose a channel with `/map retro`.",
    ].join("\n"),
  )
})

test("an empty config says how to start", async () => {
  const { cards } = await say({ name: "config" }, "slack")
  expect(cards?.[0]?.body).toContain("Add one with `/bob map repo`.")
})

test("an import says what it read, leaving out what it found none of", () => {
  const reply = commandReply(
    {
      kind: "imported",
      channel: "c9",
      counts: { repos: 13, announce: 0, access: 13, accounts: 1 },
    },
    config,
    "discord",
  )
  expect(reply.text).toBe("✅ Read <#c9>: 13 home channels, 13 access roles and 1 linked account.")
})

test("a retro channel is set per platform and shows on the config card", async () => {
  const reply = await say({ name: "map-place", place: "retro", channel: "g1" }, "discord")
  expect(reply.text).toContain("<#g1>")
  expect(config.place("retro", "discord")).toBe("g1")
  expect(config.place("retro", "slack")).toBeUndefined()
  const { cards } = await say({ name: "config" }, "discord")
  expect(cards?.[0]?.body).toEndWith("**Retro**\n<#g1>, on working days at 18:00")
  await say({ name: "unmap-place", place: "retro" }, "discord")
  expect(config.place("retro", "discord")).toBeUndefined()
})
