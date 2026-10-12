// What the org did in a period, read from GitHub's search: pull requests
// merged, issues closed as completed, what was opened, and who reviewed. The
// counts are facts; only the summary of what shipped is the model's.
import type { GitHub } from "../github/app"
import type { PipelineStory } from "../news/stories"
import type { Period } from "./period"

export interface Item {
  repo: string
  number: number
  title: string
  url: string
  author: string
  assignees: string[]
}

export interface Deploy {
  repo: string
  environment: string
}

export interface Retro {
  period: Period
  merged: Item[]
  closed: Item[]
  opened: { pulls: number; issues: number }
  /** Pull requests each person reviewed, others' only. */
  reviewed: Record<string, number>
  deploys: Deploy[]
}

export interface PersonStats {
  login: string
  merged: number
  reviewed: number
  closed: number
}

// A busy week stays well under this; past it the retro would be a list anyway.
const MAX_ITEMS = 200

export async function collect(
  github: GitHub,
  org: string,
  logins: string[],
  period: Period,
  deploys: Deploy[],
): Promise<Retro> {
  const scope = `org:${org}`
  const [merged, closed, pulls, issues, reviewed] = await Promise.all([
    items(github, `${scope} is:pr is:merged merged:${period.range}`),
    items(github, `${scope} is:issue is:closed reason:completed closed:${period.range}`),
    total(github, `${scope} is:pr created:${period.range}`),
    total(github, `${scope} is:issue created:${period.range}`),
    Promise.all(
      logins.map(
        async (login) =>
          [
            login,
            await total(
              github,
              `${scope} is:pr reviewed-by:${login} -author:${login} updated:${period.range}`,
            ),
          ] as const,
      ),
    ),
  ])
  return {
    period,
    merged,
    closed,
    opened: { pulls, issues },
    reviewed: Object.fromEntries(reviewed.filter(([, count]) => count > 0)),
    deploys,
  }
}

/** Per person: pull requests merged, others' pull requests reviewed, issues closed while assigned. */
export function peopleStats(retro: Retro): PersonStats[] {
  const stats = new Map<string, PersonStats>()
  const of = (login: string): PersonStats => {
    const known = stats.get(login) ?? { login, merged: 0, reviewed: 0, closed: 0 }
    stats.set(login, known)
    return known
  }
  for (const item of retro.merged) of(item.author).merged += 1
  for (const item of retro.closed) for (const login of item.assignees) of(login).closed += 1
  for (const [login, count] of Object.entries(retro.reviewed)) of(login).reviewed += count
  return [...stats.values()]
    .filter((person) => !person.login.endsWith("[bot]"))
    .toSorted(
      (a, b) =>
        b.merged + b.reviewed + b.closed - (a.merged + a.reviewed + a.closed) ||
        a.login.localeCompare(b.login),
    )
}

async function items(github: GitHub, q: string): Promise<Item[]> {
  const found: Item[] = []
  for (let page = 1; found.length < MAX_ITEMS; page += 1) {
    const { data } = await github.rest.search.issuesAndPullRequests({ q, per_page: 100, page })
    for (const item of data.items) {
      found.push({
        repo: item.repository_url.split("/").at(-1) ?? "",
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: item.user?.login ?? "",
        assignees: (item.assignees ?? []).map((user) => user.login),
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

/**
 * Deploys to a production environment that succeeded in the period, from the
 * pipelines bob followed; GitHub's search does not cover deployments.
 */
export function productionDeploys(pipelines: PipelineStory[], period: Period): Deploy[] {
  return pipelines.flatMap((story) => {
    const at = story.at === undefined ? Number.NaN : Date.parse(story.at)
    if (!(at >= period.from && at < period.to)) return []
    return story.steps.flatMap((step) =>
      step.type === "deploy" && step.outcome.ok === true && /prod/i.test(step.environment)
        ? [{ repo: story.repo.name, environment: step.environment }]
        : [],
    )
  })
}
