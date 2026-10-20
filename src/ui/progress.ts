// A run as the one message bob keeps editing: the thinking above it while the
// run goes, the answer itself as it is written, and a line of numbers at the
// end. No card: a card makes the reader open a box to read what bob said, and
// then scroll to a second message to read it again.
import type { Progress, Step, Usage } from "../agent/progress"
import { costOf } from "../agent/pricing"
import { SERVICES } from "../services/catalog"
import { MARK } from "./glyphs"
import { code, compact, count, cut, oneLine, repoName, usd } from "./text"

export type RunStatus =
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
  sauron_dashboards: ["Looking for dashboards", "Looked for dashboards"],
  sauron_dashboard: ["Reading dashboard", "Read dashboard"],
  sauron_alerts: ["Reading alerts", "Read alerts"],
  metric_names: ["Looking for metrics like", "Looked for metrics like"],
  metric_labels: ["Reading the labels of", "Read the labels of"],
  query_metrics: ["Querying metrics", "Queried metrics"],
  log_labels: ["Reading log labels", "Read log labels"],
  query_logs: ["Querying logs", "Queried logs"],
  find_traces: ["Looking for traces", "Looked for traces"],
  get_trace: ["Reading trace", "Read trace"],
  sql_tables: ["Reading the tables", "Read the tables"],
  query_sql: ["Querying the database", "Queried the database"],
  query_cloudwatch: ["Querying CloudWatch for", "Queried CloudWatch for"],
  connect_service: ["Getting the link to connect", "Got the link to connect"],
}

// Which argument names a call best, most telling first. `repo` goes at the end
// of the line on its own; the rest never says much.
const SUBJECT = [
  "query",
  "path",
  "number",
  "sha",
  "ref",
  "head",
  "base",
  "assignee",
  "label",
  "uid",
  "id",
  "metric",
  "table",
  "search",
  "service",
]
const MAX_LINE = 120
// The thinking is read while it moves and deleted when the run ends, so only
// its tail is worth the space.
const THINKING_LIMIT = 400

/** The message while the run goes: what bob is thinking, what it is writing, and what it is doing. */
export function liveText(progress: Progress, limit: number): string {
  const blocks: string[] = []
  const thought = tail(progress.thinking, THINKING_LIMIT)
  const answer = progress.answer.trim()
  const activity = activityLine(progress, answer !== "")
  if (thought !== "") blocks.push(`> 💭 ${thought}`)
  if (answer !== "") blocks.push(answer)
  if (activity !== undefined) blocks.push(activity)
  if (blocks.length === 0) return "💭 Thinking…"
  return within(blocks.join("\n\n"), limit)
}

/** The message once it ends: the answer alone, then one line saying what it used. */
export function answerText(
  progress: Progress,
  status: RunStatus,
  usage?: Usage,
  model?: string,
): string {
  const answer = progress.answer.trim()
  const line = summary(status, progress.steps, usage, model)
  return answer === "" ? line : `${answer}\n\n${line}`
}

/** `✅ 3 tool calls · 12.4k tokens (12.4k in, 9k cached, 800 out) · $0.0003`. */
export function summary(
  status: RunStatus,
  steps: readonly Step[],
  usage?: Usage,
  model?: string,
): string {
  const [mark, words] = outcome(status)
  const parts: string[] = []
  if (words !== undefined) parts.push(words)
  if (steps.length > 0) {
    const calls = count(steps.length, "tool call")
    const failed = steps.filter((step) => step.state === "failed").length
    parts.push(failed === 0 ? calls : `${calls} (${failed} failed)`)
  }
  if (usage !== undefined) {
    parts.push(tokens(usage))
    const cost = model === undefined ? undefined : costOf(usage, model)
    if (cost !== undefined) parts.push(usd(cost))
  }
  return `${mark} ${parts.join(" · ")}`.trim()
}

/** The mark that opens the line, and what it has to say beyond the mark. */
function outcome(status: RunStatus): [string, string | undefined] {
  if (status.kind === "drafted") return ["📝", "Drafted an issue"]
  if (status.kind === "stopped") return ["⚪", `Stopped by ${status.by}`]
  if (status.kind === "failed") return [MARK.failed, `Failed: ${oneLine(status.reason, 200)}`]
  return [MARK.done, undefined]
}

/** `13.2k tokens (12.4k in, 9k cached, 800 out)`. */
export function tokens(usage: Usage): string {
  const total = compact(usage.inputTokens + usage.outputTokens)
  const cached = usage.cachedTokens > 0 ? `, ${compact(usage.cachedTokens)} cached` : ""
  return `${total} tokens (${compact(usage.inputTokens)} in${cached}, ${compact(usage.outputTokens)} out)`
}

/** `✅ Read issue #12 in web`, `⚠️ Reading src/a.ts in web: not found`. */
export function stepLine(step: Step): string {
  const [running, done] = VERBS[step.tool] ?? serviceVerbs(step.tool)
  const args = record(step.input)
  const parts = [step.state === "running" ? running : done]
  const subject = subjectOf(args)
  if (subject !== undefined) parts.push(subject)
  if (typeof args.repo === "string") parts.push(`in ${repoName(args.repo)}`)
  const mark = { running: MARK.waiting, done: MARK.done, failed: MARK.warning }[step.state]
  const error = step.error === undefined ? "" : `: ${oneLine(step.error.split("\n")[0] ?? "", 60)}`
  return cut(`${mark} ${oneLine(parts.join(" "), MAX_LINE)}${error}`, MAX_LINE + 64)
}

/** What bob is doing right now: the running call, or the last one while it thinks of the next. */
function activityLine(progress: Progress, answered: boolean): string | undefined {
  const running = progress.steps.findLast((step) => step.state === "running")
  if (running !== undefined) return stepLine(running)
  if (answered) return undefined
  const last = progress.steps.at(-1)
  return last === undefined ? undefined : stepLine(last)
}

/** `text` cut to `limit` characters, keeping the end, since that is what just arrived. */
function tail(text: string, limit: number): string {
  const line = text.replaceAll(/\s+/g, " ").trim()
  return line.length <= limit ? line : `…${line.slice(line.length - limit + 1)}`
}

/** The whole message within one platform's limit; the session splits a longer answer itself. */
function within(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`
}

/** `dorothy_list_sites` reads as "Asking Dorothy: `list_sites`". */
function serviceVerbs(tool: string): [string, string] {
  const spec = SERVICES.find((candidate) => tool.startsWith(`${candidate.id}_`))
  if (spec === undefined) return [tool, tool]
  const name = code(tool.slice(spec.id.length + 1))
  return [`Asking ${spec.name}: ${name}`, `Asked ${spec.name}: ${name}`]
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
