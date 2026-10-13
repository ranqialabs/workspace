// The card that shows what the agent is doing, one line per tool call, edited
// as the run goes. Pure and total: a progress line is never worth failing a
// run over, so any shape a tool's input arrives in comes back as text.
import type { Step, Usage } from "../agent/progress"
import type { Card, Tone } from "./card"
import { KIND, MARK } from "./glyphs"
import { code, compact, cut, oneLine, repoName } from "./text"

export type RunStatus =
  | { kind: "thinking" }
  | { kind: "working" }
  | { kind: "answered" }
  | { kind: "drafted" }
  | { kind: "stopped"; by: string }
  | { kind: "failed"; reason: string }

// What each tool does, while it runs and once it ran.
const VERBS: Record<string, [running: string, done: string]> = {
  list_repos: ["Listing repos", "Listed repos"],
  search_code: ["Searching code for", "Searched code for"],
  read_file: ["Reading", "Read"],
  list_dir: ["Listing", "Listed"],
  recent_commits: ["Reading the history of", "Read the history of"],
  get_commit: ["Reading commit", "Read commit"],
  compare_refs: ["Comparing", "Compared"],
  list_issues: ["Listing issues", "Listed issues"],
  get_issue: ["Reading issue", "Read issue"],
  similar_issues: ["Looking for issues like", "Looked for issues like"],
  repo_labels: ["Reading labels", "Read labels"],
  list_pull_requests: ["Listing pull requests", "Listed pull requests"],
  get_pull_request: ["Reading pull request", "Read pull request"],
  pull_request_files: ["Reading the files of", "Read the files of"],
  pull_request_reviews: ["Reading the reviews of", "Read the reviews of"],
  check_runs: ["Reading checks on", "Read checks on"],
  check_failures: ["Reading CI failures", "Read CI failures"],
  teammates: ["Looking up teammates", "Looked up teammates"],
  read_conversation: ["Reading back", "Read back"],
  propose_issue: ["Drafting the issue", "Drafted the issue"],
}

// Which argument names a call best, most telling first. `repo` goes at the end
// of the line on its own; the rest never says much.
const SUBJECT = ["query", "path", "number", "sha", "ref", "head", "base", "assignee", "label"]
const MAX_LINE = 120
const MAX_STEPS = 12

const STATUS: Record<RunStatus["kind"], [Tone, string]> = {
  thinking: ["blue", "Thinking…"],
  working: ["blue", "Working…"],
  answered: ["green", "Answered"],
  drafted: ["green", "Drafted an issue"],
  stopped: ["grey", "Stopped"],
  failed: ["red", "Failed"],
}

export function progressCard(steps: readonly Step[], status: RunStatus, usage?: Usage): Card {
  const [tone, word] = STATUS[status.kind]
  let title = word
  if (status.kind === "stopped") title = `Stopped by ${status.by}`
  if (status.kind === "failed") title = `Failed: ${oneLine(status.reason, 200)}`
  const shown = steps.slice(-MAX_STEPS)
  const folded = steps.length - shown.length
  const lines = shown.map(stepLine)
  if (folded > 0) lines.unshift(`… ${folded} earlier`)
  return {
    tone,
    kicker: `${KIND.bob} bob`,
    title,
    body: lines.length > 0 ? lines.join("\n") : undefined,
    footer: usage === undefined ? undefined : tokens(usage),
  }
}

/** `13.2k tokens (12.4k in, 9k cached, 800 out)`. */
export function tokens(usage: Usage): string {
  const total = compact(usage.inputTokens + usage.outputTokens)
  const cached = usage.cachedTokens > 0 ? `, ${compact(usage.cachedTokens)} cached` : ""
  return `${total} tokens (${compact(usage.inputTokens)} in${cached}, ${compact(usage.outputTokens)} out)`
}

/** `✅ Read issue #12 in web`, `⚠️ Reading src/a.ts in web: not found`. */
export function stepLine(step: Step): string {
  const [running, done] = VERBS[step.tool] ?? [step.tool, step.tool]
  const args = record(step.input)
  const parts = [step.state === "running" ? running : done]
  const subject = subjectOf(args)
  if (subject !== undefined) parts.push(subject)
  if (typeof args.repo === "string") parts.push(`in ${repoName(args.repo)}`)
  const mark = { running: MARK.waiting, done: MARK.done, failed: MARK.warning }[step.state]
  const error = step.error === undefined ? "" : `: ${oneLine(step.error.split("\n")[0] ?? "", 60)}`
  return cut(`${mark} ${oneLine(parts.join(" "), MAX_LINE)}${error}`, MAX_LINE + 64)
}

function subjectOf(args: Record<string, unknown>): string | undefined {
  if (typeof args.base === "string" && typeof args.head === "string") {
    return code(`${args.base}...${args.head}`)
  }
  for (const key of SUBJECT) {
    const value = args[key]
    if (value === undefined || value === null || value === "") continue
    return key === "number" ? `#${scalar(value)}` : code(scalar(value))
  }
  return undefined
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value) ?? ""
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {}
  return Object.fromEntries(Object.entries(input))
}
