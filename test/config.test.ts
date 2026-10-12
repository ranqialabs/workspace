import { describe, expect, test } from "bun:test"

import { Config } from "../src/store/config"
import { memoryDatabase } from "./memory-database"

const config = () => new Config(memoryDatabase())

describe("people", () => {
  test("linking twice from one chat user fills one person", () => {
    const c = config()
    c.link("discord", "1", "github", "ana-gh", "Ana")
    c.link("discord", "1", "linear", "ana@ranqia.com")
    expect(c.people()).toEqual([
      { id: 1, name: "Ana", github: "ana-gh", linear: "ana@ranqia.com", discord: "1", slack: null },
    ])
  })

  test("the same login linked from Discord and from Slack is one person", () => {
    const c = config()
    c.link("discord", "1", "github", "ana-gh")
    c.link("slack", "U1", "github", "ana-gh")
    expect(c.people()).toHaveLength(1)
    expect(c.personBy("slack", "U1")?.discord).toBe("1")
  })

  test("two chat rows of one person merge when an account joins them", () => {
    const c = config()
    c.link("discord", "1", "github", "ana-gh")
    c.link("slack", "U1", "linear", "ana@ranqia.com")
    c.link("slack", "U1", "github", "ana-gh")
    expect(c.people()).toEqual([
      expect.objectContaining({
        github: "ana-gh",
        linear: "ana@ranqia.com",
        discord: "1",
        slack: "U1",
      }),
    ])
  })

  test("re-linking a login moves it to the new member", () => {
    const c = config()
    c.link("discord", "1", "github", "ana-gh")
    c.link("discord", "2", "github", "ana-gh")
    expect(c.personBy("github", "ana-gh")?.discord).toBe("2")
    expect(c.personBy("discord", "1")).toBeUndefined()
  })

  test("logins and emails match regardless of case", () => {
    const c = config()
    c.link("discord", "1", "github", "Ana-GH")
    expect(c.personBy("github", "ana-gh")?.discord).toBe("1")
  })

  test("unlinking the last account forgets the person", () => {
    const c = config()
    c.link("discord", "1", "github", "ana-gh")
    c.unlink("discord", "1", "github")
    expect(c.people()).toEqual([])
  })

  test("a rename reaches the person", () => {
    const c = config()
    c.link("slack", "U1", "github", "ana-gh")
    c.rename("slack", "U1", "Ana Lima")
    expect(c.personBy("github", "ana-gh")?.name).toBe("Ana Lima")
  })
})

describe("channels", () => {
  test("news go to the announce channel when there is one", () => {
    const c = config()
    c.mapChannel("org/api", "discord", "home", "10")
    expect(c.newsChannel("org/api", "discord")).toBe("10")
    c.mapChannel("org/api", "discord", "announce", "20")
    expect(c.newsChannel("org/api", "discord")).toBe("20")
    expect(c.newsChannel("org/api", "slack")).toBeUndefined()
  })

  test("a repo's home channel settles which repo a conversation is about", () => {
    const c = config()
    c.mapChannel("org/api", "discord", "home", "10")
    c.mapChannel("org/web", "discord", "home", "11")
    expect(c.reposFor("discord", "10")).toEqual(["org/api"])
    expect(c.reposFor("discord", "thread", "11")).toEqual(["org/web"])
    expect(c.reposFor("discord", "99")).toEqual(["org/api", "org/web"])
    expect(c.reposFor("slack", "10")).toEqual([])
  })

  test("re-mapping replaces the channel", () => {
    const c = config()
    c.mapChannel("org/api", "slack", "home", "C1")
    c.mapChannel("org/api", "slack", "home", "C2")
    expect(c.channels()).toEqual([
      { repo: "org/api", platform: "slack", purpose: "home", channel: "C2" },
    ])
    c.unmapChannel("org/api", "slack", "home")
    expect(c.channels()).toEqual([])
  })
})

test("access groups are kept per repo and platform", () => {
  const c = config()
  c.setAccessGroup("org/api", "discord", "role-1")
  expect(c.accessGroup("org/api", "discord")).toBe("role-1")
  expect(c.accessGroups("discord")).toEqual([{ repo: "org/api", group: "role-1" }])
  c.forgetAccessGroup("org/api", "discord")
  expect(c.accessGroup("org/api", "discord")).toBeUndefined()
})
