// A believable week of work, for the retro's views.
import type { Merged, Retro } from "../../src/retro/collect"
import { periodAt } from "../../src/retro/period"

function pull(
  repo: string,
  number: number,
  title: string,
  author: string,
  extra: Partial<Merged> = {},
): Merged {
  return {
    repo: `ranqialabs/${repo}`,
    number,
    title,
    url: `https://github.com/ranqialabs/${repo}/pull/${number}`,
    author,
    assignees: [],
    draft: false,
    body: "",
    commits: 4,
    additions: 120,
    deletions: 30,
    files: 6,
    comments: 2,
    reviews: 1,
    minutesToMerge: 180,
    mergedAt: Date.parse("2026-10-12T15:00:00Z"),
    shipped: "production",
    ...extra,
  }
}

export const SAMPLE: Retro = {
  org: "ranqialabs",
  period: periodAt("day", Date.parse("2026-10-12T21:00:00Z"), "America/Sao_Paulo"),
  merged: [
    pull(
      "workspace",
      32,
      "feat!: rewrite bob on Cloudflare Workers with Discord and Slack",
      "felipeadeildo",
      {
        commits: 27,
        additions: 8410,
        deletions: 5120,
        files: 96,
        comments: 3,
        minutesToMerge: 1440,
        mergedAt: Date.parse("2026-10-12T20:40:00Z"),
      },
    ),
    pull("ada-api", 118, "fix(auth): keep the session after a password reset", "itsmeale", {
      comments: 12,
      reviews: 3,
      minutesToMerge: 300,
      mergedAt: Date.parse("2026-10-12T13:10:00Z"),
      shipped: "waiting",
    }),
    pull("ada-infra", 87, "feat(ada): let aws manage the aurora master password", "felipeadeildo", {
      commits: 2,
      additions: 64,
      deletions: 8,
      minutesToMerge: 14,
      mergedAt: Date.parse("2026-10-12T17:25:00Z"),
      shipped: "no-deploys",
    }),
    pull("mary-web", 41, "chore: bump vite to 8.1", "lverissimo9", {
      commits: 1,
      additions: 40,
      deletions: 40,
      minutesToMerge: 50,
    }),
  ],
  open: [
    {
      repo: "ranqialabs/grace",
      number: 212,
      title: "feat: export the funnel as CSV",
      url: "https://github.com/ranqialabs/grace/pull/212",
      author: "milenaveiga18",
      assignees: [],
      draft: true,
      body: "",
    },
  ],
  closed: [],
  opened: { pulls: 5, issues: 2 },
  reviewed: { itsmeale: 2, lverissimo9: 1 },
  ci: { runs: 31, failed: 3, minutes: 41.4 },
  deploys: [{ repo: "workspace", environment: "production" }],
}
