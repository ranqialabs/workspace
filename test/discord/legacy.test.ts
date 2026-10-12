import { describe, expect, test } from "bun:test"

import { applyLines, readLines } from "../../src/discord/legacy"
import { DiscordRest } from "../../src/discord/rest"
import { Config } from "../../src/store/config"
import { memoryDatabase } from "../memory-database"

describe("applying #bot-config lines", () => {
  test("repo, announce, access, github and linear lines become the configuration", () => {
    const config = new Config(memoryDatabase())
    const got = applyLines(config, [
      "repo [ranqialabs/web](https://github.com/ranqialabs/web) <#100>",
      "announce [ranqialabs/web](https://github.com/ranqialabs/web) <#101>",
      "access [ranqialabs/web](https://github.com/ranqialabs/web) <@&200>",
      "github [ana-gh](https://github.com/ana-gh) <@300>",
      "linear [ana@acme.com](mailto:ana@acme.com) <@300>",
    ])
    expect(got).toEqual({ repos: 1, announce: 1, access: 1, accounts: 2 })
    expect(config.homeChannel("ranqialabs/web", "discord")).toBe("100")
    expect(config.newsChannel("ranqialabs/web", "discord")).toBe("101")
    expect(config.accessGroup("ranqialabs/web", "discord")).toBe("200")
    const ana = config.personBy("github", "ana-gh")
    expect(ana?.discord).toBe("300")
    expect(ana?.linear).toBe("ana@acme.com")
  })

  test("the plain form and the old identity kind still count", () => {
    const config = new Config(memoryDatabase())
    applyLines(config, ["repo ranqialabs/api 100", "identity beto-gh 300"])
    expect(config.homeChannel("ranqialabs/api", "discord")).toBe("100")
    expect(config.personBy("github", "beto-gh")?.discord).toBe("300")
  })

  test("a later line for the same repo wins, and anything else is ignored", () => {
    const config = new Config(memoryDatabase())
    const got = applyLines(config, [
      "repo [ranqialabs/api](https://github.com/ranqialabs/api) <#100>",
      "⚙️ Bridge configuration",
      "repo [ranqialabs/api](https://github.com/ranqialabs/api) <#999>",
    ])
    expect(got.repos).toBe(2)
    expect(config.homeChannel("ranqialabs/api", "discord")).toBe("999")
  })
})

function message(id: number, bot: boolean, content: string) {
  return {
    id: String(id),
    channel_id: "c",
    author: { id: bot ? "bob" : "ana", username: bot ? "bob" : "ana", bot },
    content,
    timestamp: "2026-10-01T00:00:00Z",
  }
}

test("only bob's own messages are read, oldest first, across pages", async () => {
  // Newest first, as Discord pages them: a full page, then the last one.
  const first = Array.from({ length: 100 }, (_, i) => message(300 - i, true, `line ${300 - i}`))
  const second = [message(200, false, "stray command"), message(199, true, "line 199")]
  const routes: string[] = []
  const rest = new DiscordRest("t", (request) => {
    routes.push(new URL(request.url).search)
    return Promise.resolve(Response.json(routes.length === 1 ? first : second))
  })
  const lines = await readLines(rest, "c")
  expect(routes).toEqual(["?limit=100", "?limit=100&before=201"])
  expect(lines[0]).toBe("line 199")
  expect(lines.at(-1)).toBe("line 300")
  expect(lines).not.toContain("stray command")
})
