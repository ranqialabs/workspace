import { describe, expect, test } from "bun:test"

import type { PipelineStory } from "../../src/news/stories"
import { collect, peopleStats, productionDeploys, type Retro } from "../../src/retro/collect"
import { periodAt } from "../../src/retro/period"
import { summarize } from "../../src/retro/summary"
import { retroCard } from "../../src/ui/retro"
import { type Calls, fakeGitHub } from "../agent/github"

const TZ = "America/Sao_Paulo"
// Wednesday 2026-10-14, 18:30 in São Paulo.
const WEDNESDAY = Date.parse("2026-10-14T21:30:00Z")

describe("periods", () => {
  test("a day is the team's calendar day, as a search range", () => {
    const day = periodAt("day", WEDNESDAY, TZ)
    expect(day.range).toBe("2026-10-14T00:00:00-03:00..2026-10-15T00:00:00-03:00")
    expect(day.to - day.from).toBe(24 * 3_600_000)
  })

  test("a week runs Monday to Sunday", () => {
    expect(periodAt("week", WEDNESDAY, TZ)).toMatchObject({
      first: "2026-10-12",
      next: "2026-10-19",
    })
    const sunday = Date.parse("2026-10-18T15:00:00Z")
    expect(periodAt("week", sunday, TZ).first).toBe("2026-10-12")
  })
})

const item = (
  repo: string,
  number: number,
  title: string,
  author: string,
  assignees: string[] = [],
) => ({
  repository_url: `https://api.github.com/repos/acme/${repo}`,
  number,
  title,
  html_url: `https://github.com/acme/${repo}/pull/${number}`,
  user: { login: author },
  assignees: assignees.map((login) => ({ login })),
})

function deployStory(environment: string, ok: boolean, at: string): PipelineStory {
  return {
    kind: "pipeline",
    repo: { name: "web", fullName: "acme/web", url: "", defaultBranch: "main" },
    sha: "abc",
    steps: [{ type: "deploy", environment, outcome: { ok, word: "deployed" } }],
    at,
  }
}

describe("collecting", () => {
  test("merged, closed, opened and reviewed come from GitHub's search", async () => {
    const calls: Calls = []
    const github = fakeGitHub(
      {
        "search.issuesAndPullRequests": ({ q }: { q: string }) => {
          if (q.includes("is:merged"))
            return {
              total_count: 2,
              items: [
                item("web", 31, "fix: login loops", "ana"),
                item("api", 8, "feat: retries", "beto"),
              ],
            }
          if (q.includes("reason:completed"))
            return { total_count: 1, items: [item("web", 12, "Login loops", "cris", ["ana"])] }
          if (q.includes("reviewed-by:beto")) return { total_count: 3, items: [] }
          if (q.includes("reviewed-by:")) return { total_count: 0, items: [] }
          if (q.includes("is:pr created")) return { total_count: 4, items: [] }
          return { total_count: 5, items: [] }
        },
      },
      calls,
    )
    const period = periodAt("day", WEDNESDAY, TZ)
    const retro = await collect(github, "acme", ["ana", "beto"], period, [])
    expect(retro.merged.map((pr) => `${pr.repo}#${pr.number}`)).toEqual(["web#31", "api#8"])
    expect(retro.opened).toEqual({ pulls: 4, issues: 5 })
    expect(retro.reviewed).toEqual({ beto: 3 })
    expect(calls[0]?.params.q).toBe(`org:acme is:pr is:merged merged:${period.range}`)
    expect(peopleStats(retro)).toEqual([
      { login: "beto", merged: 1, reviewed: 3, closed: 0 },
      { login: "ana", merged: 1, reviewed: 0, closed: 1 },
    ])
  })

  test("only production deploys that succeeded in the period count", () => {
    const period = periodAt("day", WEDNESDAY, TZ)
    const deploys = productionDeploys(
      [
        deployStory("production", true, "2026-10-14T15:00:00Z"),
        deployStory("Production", false, "2026-10-14T15:00:00Z"),
        deployStory("preview", true, "2026-10-14T15:00:00Z"),
        deployStory("production", true, "2026-10-13T15:00:00Z"),
      ],
      period,
    )
    expect(deploys).toEqual([{ repo: "web", environment: "production" }])
  })
})

const retro: Retro = {
  period: periodAt("day", WEDNESDAY, TZ),
  merged: [
    { repo: "web", number: 31, title: "fix: login loops", url: "", author: "ana", assignees: [] },
  ],
  closed: [],
  opened: { pulls: 1, issues: 0 },
  reviewed: { beto: 2 },
  deploys: [{ repo: "web", environment: "production" }],
}

describe("the card", () => {
  test("without a model the summary lists the titles per project", async () => {
    expect(await summarize(undefined, retro)).toBe("**web**\n- #31: fix: login loops")
  })

  test("it says what shipped, the counts, and what each person did", () => {
    const card = retroCard(retro, "**web**\n- Login no longer loops (#31)", (login) => `@${login}`)
    expect(card.kicker).toBe("📊 Daily retro")
    expect(card.title).toBe("What shipped on Wednesday, October 14")
    expect(card.fields).toEqual([
      { name: "Merged", value: "1 pull request", inline: true },
      { name: "Closed", value: "0 issues", inline: true },
      { name: "Opened", value: "1 pull request, 0 issues", inline: true },
      { name: "Deploys", value: "1 to production: 1 in web", inline: false },
      { name: "People", value: "@beto 2 reviewed\n@ana 1 merged", inline: false },
    ])
  })

  test("a quiet period says so", () => {
    const quiet = {
      ...retro,
      merged: [],
      deploys: [],
      reviewed: {},
      period: periodAt("week", WEDNESDAY, TZ),
    }
    const card = retroCard(quiet, undefined, (login) => login)
    expect(card.title).toBe("What shipped the week of October 12")
    expect(card.body).toBe("A quiet week. Nothing was merged or closed.")
  })
})
