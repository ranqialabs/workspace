// What the org did in a period, read from GitHub: pull requests merged, with
// their commits and lines, whether each reached production, what is still
// open, issues, CI time, and who reviewed. These are facts anyone can check on
// GitHub; only the summary of what shipped is the model's.
import type { GitHub } from "../github/app"
import type { PipelineStory } from "../news/stories"
import type { Period } from "./period"

export interface Item {
  /** `owner/name`. */
  repo: string
  number: number
  title: string
  url: string
  author: string
  assignees: string[]
  draft: boolean
}

/** Where a merged pull request stands against its repo's production deploys. */
export type Shipped = "production" | "waiting" | "no-deploys"

export interface Merged extends Item {
  /** Before any squash: what the author actually committed. */
  commits: number
  additions: number
  deletions: number
  files: number
  /** Conversation and review comments together. */
  comments: number
  /** Reviews submitted, every round counted. */
  reviews: number
  /** From opening to merge. */
  minutesToMerge: number
  shipped: Shipped
}

export interface Ci {
  runs: number
  failed: number
  /** Wall-clock time of the finished runs, in minutes. */
  minutes: number
}

export interface Deploy {
  repo: string
  environment: string
}

export interface Retro {
  org: string
  period: Period
  merged: Merged[]
  /** Pull requests opened in the period and still open. */
  open: Item[]
  closed: Item[]
  opened: { pulls: number; issues: number }
  /** Pull requests each person reviewed, others' only. */
  reviewed: Record<string, number>
  ci: Ci
  deploys: Deploy[]
}

// A busy week stays well under this; past it the retro would be a list anyway.
const MAX_ITEMS = 200
// GitHub asks for no more than a handful of requests at once from one client.
const CONCURRENCY = 6
const MAX_RUN_PAGES = 3

export async function collect(
  github: GitHub,
  org: string,
  logins: string[],
  repos: string[],
  period: Period,
  deploys: Deploy[],
): Promise<Retro> {
  const scope = `org:${org}`
  const [found, open, closed, pulls, issues, reviewed] = await Promise.all([
    items(github, `${scope} is:pr is:merged merged:${period.range}`),
    items(github, `${scope} is:pr is:open created:${period.range}`),
    items(github, `${scope} is:issue is:closed reason:completed closed:${period.range}`),
    total(github, `${scope} is:pr created:${period.range}`),
    total(github, `${scope} is:issue created:${period.range}`),
    limited(logins, async (login) => {
      const query = `${scope} is:pr reviewed-by:${login} -author:${login} updated:${period.range}`
      return [login, await total(github, query)] as const
    }),
  ])
  const touched = [...new Set([...repos, ...found.map((item) => item.repo)])]
  const [production, ci] = await Promise.all([
    productionHeads(github, [...new Set(found.map((item) => item.repo))]),
    limited(touched, (repo) => ciTime(github, repo, period)),
  ])
  const merged = await limited(found, (item) => details(github, item, production.get(item.repo)))
  return {
    org,
    period,
    merged,
    open,
    closed,
    opened: { pulls, issues },
    reviewed: Object.fromEntries(reviewed.filter(([, count]) => count > 0)),
    ci: ci.reduce(
      (sum, repo) => ({
        runs: sum.runs + repo.runs,
        failed: sum.failed + repo.failed,
        minutes: sum.minutes + repo.minutes,
      }),
      { runs: 0, failed: 0, minutes: 0 },
    ),
    deploys,
  }
}

/**
 * Deploys to a production environment that succeeded in the period, from the
 * pipelines bob followed; GitHub's search does not cover deployments.
 */
export function productionDeploys(pipelines: PipelineStory[], period: Period): Deploy[] {
  return pipelines.flatMap((story) => {
    const at = story.at === undefined ? Number.NaN : Date.parse(story.at)
    if (!(at >= period.from && at < period.to)) return []
    return story.steps.flatMap((step) =>
      step.type === "deploy" && step.outcome.ok === true && PRODUCTION.test(step.environment)
        ? [{ repo: story.repo.name, environment: step.environment }]
        : [],
    )
  })
}

const PRODUCTION = /prod/i

async function items(github: GitHub, q: string): Promise<Item[]> {
  const found: Item[] = []
  for (let page = 1; found.length < MAX_ITEMS; page += 1) {
    const { data } = await github.rest.search.issuesAndPullRequests({ q, per_page: 100, page })
    for (const item of data.items) {
      found.push({
        repo: item.repository_url.split("/").slice(-2).join("/"),
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: item.user?.login ?? "",
        assignees: (item.assignees ?? []).map((user) => user.login),
        draft: item.draft === true,
      })
    }
    if (data.items.length < 100) break
  }
  return found
}

async function total(github: GitHub, q: string): Promise<number> {
  const { data } = await github.rest.search.issuesAndPullRequests({ q, per_page: 1 })
  return data.total_count
}

/** The commit each repo's production runs, from its latest successful deployment. */
async function productionHeads(github: GitHub, repos: string[]): Promise<Map<string, string>> {
  const heads = await limited(repos, async (full) => {
    const [owner = "", repo = ""] = full.split("/")
    const { data } = await github.rest.repos.listDeployments({ owner, repo, per_page: 30 })
    for (const deployment of data.filter((d) => PRODUCTION.test(d.environment))) {
      const statuses = await github.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: deployment.id,
        per_page: 5,
      })
      if (statuses.data.some((status) => status.state === "success")) {
        return [full, deployment.sha] as const
      }
    }
    return undefined
  })
  return new Map(heads.filter((head) => head !== undefined))
}

async function details(
  github: GitHub,
  item: Item,
  production: string | undefined,
): Promise<Merged> {
  const [owner = "", repo = ""] = item.repo.split("/")
  const [{ data }, reviews] = await Promise.all([
    github.rest.pulls.get({ owner, repo, pull_number: item.number }),
    github.rest.pulls.listReviews({ owner, repo, pull_number: item.number, per_page: 100 }),
  ])
  let shipped: Shipped = "no-deploys"
  if (production !== undefined && data.merge_commit_sha !== null) {
    // Production contains the merge when it is the same commit or ahead of it.
    const compared = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: data.merge_commit_sha,
      head: production,
      per_page: 1,
    })
    shipped =
      compared.data.status === "ahead" || compared.data.status === "identical"
        ? "production"
        : "waiting"
  }
  return {
    ...item,
    commits: data.commits,
    additions: data.additions,
    deletions: data.deletions,
    files: data.changed_files,
    comments: data.comments + data.review_comments,
    reviews: reviews.data.length,
    minutesToMerge:
      data.merged_at === null
        ? 0
        : (Date.parse(data.merged_at) - Date.parse(data.created_at)) / 60_000,
    shipped,
  }
}

async function ciTime(github: GitHub, full: string, period: Period): Promise<Ci> {
  const [owner = "", repo = ""] = full.split("/")
  const ci: Ci = { runs: 0, failed: 0, minutes: 0 }
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const { data } = await github.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      created: period.range,
      per_page: 100,
      page,
    })
    for (const run of data.workflow_runs) {
      if (run.status !== "completed" || run.run_started_at === undefined) continue
      ci.runs += 1
      if (run.conclusion === "failure" || run.conclusion === "timed_out") ci.failed += 1
      ci.minutes += (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 60_000
    }
    if (data.workflow_runs.length < 100) break
  }
  return ci
}

/** `work` over every item, a few at a time, in order. */
async function limited<T, R>(list: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < list.length; start += CONCURRENCY) {
    results.push(...(await Promise.all(list.slice(start, start + CONCURRENCY).map(work))))
  }
  return results
}
