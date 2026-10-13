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

/** The biggest, the most talked about and the fastest pull request, when they differ in kind. */
export function highlights(retro: Retro): Highlight[] {
  if (retro.merged.length < 2) return []
  const by = (score: (pull: Merged) => number): Merged | undefined =>
    retro.merged.toSorted((a, b) => score(b) - score(a))[0]
  const found: Highlight[] = []
  const biggest = by((pull) => pull.additions + pull.deletions)
  if (biggest !== undefined) found.push({ kind: "biggest", pull: biggest })
  const talked = by((pull) => pull.comments)
  if (talked !== undefined && talked.comments > 0) found.push({ kind: "talked", pull: talked })
  const fastest = by((pull) => -pull.minutesToMerge)
  if (fastest !== undefined) found.push({ kind: "fastest", pull: fastest })
  return found
}

// Conventional commits, the way release-please reads them.
const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/
const GROUP: Record<string, ChangeGroup> = { feat: "features", fix: "fixes", perf: "performance" }

/** The merged pull requests by kind of change, in changelog order. */
export function changelog(retro: Retro): Map<ChangeGroup, Change[]> {
  const order: ChangeGroup[] = ["breaking", "features", "fixes", "performance", "maintenance"]
  const groups = new Map<ChangeGroup, Change[]>(order.map((group) => [group, []]))
  for (const pull of retro.merged) {
    const match = CONVENTIONAL.exec(pull.title)
    const type = match?.[1]?.toLowerCase() ?? ""
    const group: ChangeGroup = match?.[3] === "!" ? "breaking" : (GROUP[type] ?? "maintenance")
    groups.get(group)?.push({ pull, subject: match?.[4] ?? pull.title })
  }
  for (const [group, changes] of groups) if (changes.length === 0) groups.delete(group)
  return groups
}
