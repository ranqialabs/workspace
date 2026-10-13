// The numbers a retro shows, worked out from what was collected: totals,
// each person's share, a few highlights, and the merged pull requests grouped
// the way a changelog groups them.
import type { Merged, Retro } from "./collect"

export interface Totals {
  merged: number
  commits: number
  additions: number
  deletions: number
  files: number
  comments: number
  reviews: number
  inProduction: number
  waiting: number
  /** Half the merged pull requests took less than this, or undefined with none. */
  medianMinutesToMerge: number | undefined
}

export interface PersonStats {
  login: string
  merged: number
  commits: number
  additions: number
  deletions: number
  reviewed: number
  closed: number
}

export type HighlightKind = "biggest" | "talked" | "fastest"

export interface Highlight {
  kind: HighlightKind
  pull: Merged
}

export type ChangeGroup = "breaking" | "features" | "fixes" | "performance" | "maintenance"

export interface Change {
  pull: Merged
  /** The title without its `feat(scope)!:` prefix. */
  subject: string
}

export function totals(retro: Retro): Totals {
  const sum = (pick: (pull: Merged) => number): number =>
    retro.merged.reduce((total, pull) => total + pick(pull), 0)
  const minutes = retro.merged.map((pull) => pull.minutesToMerge).toSorted((a, b) => a - b)
  return {
    merged: retro.merged.length,
    commits: sum((pull) => pull.commits),
    additions: sum((pull) => pull.additions),
    deletions: sum((pull) => pull.deletions),
    files: sum((pull) => pull.files),
    comments: sum((pull) => pull.comments),
    reviews: sum((pull) => pull.reviews),
    inProduction: retro.merged.filter((pull) => pull.shipped === "production").length,
    waiting: retro.merged.filter((pull) => pull.shipped === "waiting").length,
    medianMinutesToMerge: median(minutes),
  }
}

/** The middle of sorted numbers, or the mean of the two middle ones. */
function median(sorted: number[]): number | undefined {
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? upper) + upper) / 2
}

export interface RepoStats {
  repo: string
  merged: number
  additions: number
  deletions: number
}

/** Per repository, the most lines changed first. */
export function repoStats(retro: Retro): RepoStats[] {
  const stats = new Map<string, RepoStats>()
  for (const pull of retro.merged) {
    const known = stats.get(pull.repo) ?? { repo: pull.repo, merged: 0, additions: 0, deletions: 0 }
    known.merged += 1
    known.additions += pull.additions
    known.deletions += pull.deletions
    stats.set(pull.repo, known)
  }
  return [...stats.values()].toSorted(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) || a.repo.localeCompare(b.repo),
  )
}

/** Per person, most active first: what they merged and wrote, reviewed and closed. */
export function peopleStats(retro: Retro): PersonStats[] {
  const stats = new Map<string, PersonStats>()
  function of(login: string): PersonStats {
    const known = stats.get(login) ?? {
      login,
      merged: 0,
      commits: 0,
      additions: 0,
      deletions: 0,
      reviewed: 0,
      closed: 0,
    }
    stats.set(login, known)
    return known
  }
  for (const pull of retro.merged) {
    const person = of(pull.author)
    person.merged += 1
    person.commits += pull.commits
    person.additions += pull.additions
    person.deletions += pull.deletions
  }
  for (const item of retro.closed) for (const login of item.assignees) of(login).closed += 1
  for (const [login, count] of Object.entries(retro.reviewed)) of(login).reviewed += count
  return [...stats.values()]
    .filter((person) => !person.login.endsWith("[bot]"))
    .toSorted((a, b) => activity(b) - activity(a) || a.login.localeCompare(b.login))
}

/** How much a person did, for ordering and for the length of their bar. */
export function activity(person: PersonStats): number {
  return person.merged * 3 + person.reviewed * 2 + person.closed + person.commits / 5
}

/**
 * The biggest, the most talked about and the fastest pull request. One that
 * already took a highlight leaves the next to the runner-up, so no pull
 * request is shown twice.
 */
export function highlights(retro: Retro): Highlight[] {
  if (retro.merged.length < 2) return []
  const found: Highlight[] = []
  const taken = new Set<Merged>()
  const pick = (kind: HighlightKind, score: (pull: Merged) => number): void => {
    const best = retro.merged
      .filter((pull) => !taken.has(pull) && score(pull) > Number.NEGATIVE_INFINITY)
      .toSorted((a, b) => score(b) - score(a))[0]
    if (best === undefined) return
    taken.add(best)
    found.push({ kind, pull: best })
  }
  pick("biggest", (pull) => pull.additions + pull.deletions)
  pick("talked", (pull) => (pull.comments > 0 ? pull.comments : Number.NEGATIVE_INFINITY))
  pick("fastest", (pull) => -pull.minutesToMerge)
  return found
}

// Conventional commits, the way release-please reads them.
const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/
const GROUP: Record<string, ChangeGroup> = { feat: "features", fix: "fixes", perf: "performance" }

export const CHANGE_ORDER: ChangeGroup[] = [
  "breaking",
  "features",
  "fixes",
  "performance",
  "maintenance",
]

/** The kind of change a title announces, and the title without its prefix. */
export function changeOf(title: string): { group: ChangeGroup; subject: string } {
  const match = CONVENTIONAL.exec(title)
  const type = match?.[1]?.toLowerCase() ?? ""
  const group: ChangeGroup = match?.[3] === "!" ? "breaking" : (GROUP[type] ?? "maintenance")
  return { group, subject: match?.[4] ?? title }
}

/** The merged pull requests by kind of change, in changelog order. */
export function changelog(retro: Retro): Map<ChangeGroup, Change[]> {
  const groups = new Map<ChangeGroup, Change[]>(CHANGE_ORDER.map((group) => [group, []]))
  for (const pull of retro.merged) {
    const { group, subject } = changeOf(pull.title)
    groups.get(group)?.push({ pull, subject })
  }
  for (const [group, changes] of groups) if (changes.length === 0) groups.delete(group)
  return groups
}
