import { describe, expect, test } from "bun:test"

import type { PipelineStory } from "../../src/news/stories"
import { collect, productionDeploys } from "../../src/retro/collect"
import { periodAt } from "../../src/retro/period"
import { changelog, highlights, peopleStats, totals } from "../../src/retro/stats"
import { retroPost } from "../../src/ui/retro"
import { type Calls, fakeGitHub } from "../agent/github"
import { SAMPLE } from "./sample"

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
  test("search finds the work, then each merged pull request gets its numbers", async () => {
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
          if (q.includes("is:open"))
            return { total_count: 1, items: [item("web", 40, "wip", "ana")] }
          if (q.includes("reason:completed"))
            return { total_count: 1, items: [item("web", 12, "Login loops", "cris", ["ana"])] }
          if (q.includes("reviewed-by:beto")) return { total_count: 3, items: [] }
          if (q.includes("reviewed-by:")) return { total_count: 0, items: [] }
          if (q.includes("is:pr created")) return { total_count: 4, items: [] }
          return { total_count: 5, items: [] }
        },
        "pulls.get": ({ pull_number }: { pull_number: number }) => ({
          commits: pull_number === 31 ? 3 : 1,
          additions: 100,
          deletions: 20,
          changed_files: 4,
          comments: 2,
          review_comments: 1,
          created_at: "2026-10-14T10:00:00Z",
          merged_at: "2026-10-14T12:00:00Z",
          merge_commit_sha: `m${pull_number}`,
        }),
        "pulls.listReviews": [{ id: 1 }, { id: 2 }],
        "repos.listDeployments": ({ repo }: { repo: string }) =>
          repo === "web" ? [{ id: 9, environment: "production", sha: "prod-head" }] : [],
        "repos.listDeploymentStatuses": [{ state: "success" }],
        "repos.compareCommits": { status: "ahead" },
        "actions.listWorkflowRunsForRepo": {
          workflow_runs: [
            {
              status: "completed",
              conclusion: "failure",
              run_started_at: "2026-10-14T10:00:00Z",
              updated_at: "2026-10-14T10:06:00Z",
            },
          ],
        },
      },
      calls,
    )
    const period = periodAt("day", WEDNESDAY, TZ)
    const retro = await collect(github, "acme", ["ana", "beto"], ["acme/web"], period, [])
    expect(calls[0]?.params.q).toBe(`org:acme is:pr is:merged merged:${period.range}`)
    expect(retro.merged.map((pr) => `${pr.repo}#${pr.number} ${pr.shipped}`)).toEqual([
      "acme/web#31 production",
      "acme/api#8 no-deploys",
    ])
    expect(retro.merged[0]).toMatchObject({
      commits: 3,
      comments: 3,
      reviews: 2,
      minutesToMerge: 120,
    })
    expect(retro.open.map((pr) => pr.number)).toEqual([40])
    expect(retro.opened).toEqual({ pulls: 4, issues: 5 })
    expect(retro.reviewed).toEqual({ beto: 3 })
    // CI is read for the mapped repo and for each repo that merged something.
    expect(retro.ci).toEqual({ runs: 2, failed: 2, minutes: 12 })
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

describe("stats", () => {
  test("totals add the merged pull requests up", () => {
    expect(totals(SAMPLE)).toMatchObject({
      merged: 4,
      commits: 34,
      additions: 8634,
      inProduction: 2,
      waiting: 1,
      medianMinutesToMerge: 175,
    })
  })

  test("people are ordered by what they did", () => {
    expect(peopleStats(SAMPLE).map((person) => person.login)).toEqual([
      "felipeadeildo",
      "itsmeale",
      "lverissimo9",
    ])
  })

  test("the highlights are the biggest, the most talked about and the fastest", () => {
    expect(highlights(SAMPLE).map(({ kind, pull }) => `${kind} #${pull.number}`)).toEqual([
      "biggest #32",
      "talked #118",
      "fastest #87",
    ])
  })

  test("the changelog groups by conventional commit, a ! being breaking", () => {
    const groups = changelog(SAMPLE)
    expect([...groups.keys()]).toEqual(["breaking", "features", "fixes", "maintenance"])
    expect(groups.get("fixes")?.[0]?.subject).toBe("keep the session after a password reset")
  })
})

describe("the card", () => {
  test("it is a linked changelog, marked by whether each change reached production", () => {
    const { card } = retroPost(SAMPLE, (login) => `@${login}`, true)
    expect(card.kicker).toBe("📊 Daily retro")
    expect(card.image).toBe("retro.png")
    expect(card.body).toContain(
      "**💥 Breaking changes**\n- **workspace** rewrite bob on Cloudflare Workers with Discord and Slack [#32](https://github.com/ranqialabs/workspace/pull/32) 🚀",
    )
    expect(card.body).toContain(
      "- **ada-api** keep the session after a password reset [#118](https://github.com/ranqialabs/ada-api/pull/118) ⏳",
    )
    expect(card.body).toContain("**🔀 Still open, 1 pull request**")
    expect(card.body).toContain("by @milenaveiga18 (draft)")
  })

  test("it carries the numbers under the summary", () => {
    const { card } = retroPost(SAMPLE, (login) => login, false)
    expect(card.body).toContain(
      "**4 pull requests merged** · 34 commits · +8.6k / −5.2k lines · 41 min of CI · 2 in production · 1 waiting for a deploy",
    )
  })

  test("a quiet period says so", () => {
    const quiet = { ...SAMPLE, merged: [], open: [], period: periodAt("week", WEDNESDAY, TZ) }
    const { card } = retroPost(quiet, (login) => login, false)
    expect(card.body).toBe("A quiet week. Nothing was merged.")
    expect(card.image).toBeUndefined()
  })

  test("a full week keeps whole sections and sends the rest as a reply", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...SAMPLE.merged[0]!,
      number: 100 + index,
      title: `${index} ${"with a subject long enough to fill the card ".repeat(2)}`,
    }))
    const crowded = {
      ...SAMPLE,
      merged: [
        ...many.map((pull, index) => ({
          ...pull,
          title: `feat!: breaking ${index} ${pull.title}`,
        })),
        ...many.map((pull, index) => ({ ...pull, title: `feat: feature ${index} ${pull.title}` })),
        ...many.map((pull, index) => ({ ...pull, title: `fix: bug ${index} ${pull.title}` })),
        ...many.map((pull, index) => ({ ...pull, title: `perf: faster ${index} ${pull.title}` })),
        ...many.map((pull, index) => ({ ...pull, title: `chore: upkeep ${index} ${pull.title}` })),
      ],
      period: periodAt("week", WEDNESDAY, TZ),
    }
    const post = retroPost(crowded, (login) => login, false)
    expect(post.rest).toBeDefined()
    expect(post.card.body?.endsWith("**The rest of the list is in the reply below.**")).toBe(true)
    expect(post.card.body).toContain("**💥 Breaking changes**")
    expect(post.rest).toContain("**🧹 Maintenance**")
    expect((post.card.body?.length ?? 0) + (post.rest?.length ?? 0)).toBeGreaterThan(4000)
    // No section is silently cut in half: every heading survives in one of the two.
    for (const heading of ["💥", "✨", "🐛", "⚡", "🧹"]) {
      expect(`${post.card.body}${post.rest}`).toContain(heading)
    }
  })
})
