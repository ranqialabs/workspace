// What the agent is doing, one line per tool call, on a single card a human can
// glance at. Pure and total: a progress line is never worth failing a run over,
// so any shape the arguments arrive in comes back as text.
import type { Card } from "../chat/card"

const TOOLS: Record<string, [icon: string, verb: string]> = {
  read_file: ["📄", "reading"],
  search_code: ["🔎", "searching code"],
  list_dir: ["📁", "listing"],
  list_repos: ["📚", "listing repos"],
  similar_issues: ["🔗", "checking for duplicates"],
  repo_labels: ["🏷️", "reading labels"],
  teammates: ["👥", "looking up teammates"],
  recent_commits: ["📜", "reading history"],
  read_conversation: ["💬", "reading back"],
  list_issues: ["📋", "listing issues"],
  get_issue: ["🐛", "reading issue"],
  list_pull_requests: ["🗂️", "listing PRs"],
  get_pull_request: ["🔀", "reading PR"],
  pull_request_files: ["📑", "reading PR files"],
  pull_request_reviews: ["✅", "reading reviews"],
  pull_request_comments: ["💭", "reading review notes"],
  check_runs: ["🧪", "reading CI"],
  check_failures: ["🚨", "reading CI failures"],
  get_commit: ["🕘", "reading commit"],
  compare_refs: ["↔️", "comparing"],
  propose_issue: ["📝", "drafting the issue"],
  linear_issues: ["🧾", "listing Linear issues"],
  linear_issue: ["🔖", "reading Linear issue"],
}

// Ordered by how much each identifies a call. `repo` leads the line on its own.
const LEAD = ["query", "path", "number", "issue", "sha", "ref", "head", "base", "assignee", "label"]
const HIDDEN = new Set(["repo", "page", "body", "questions", "confidence"])
const MAX_LINE = 118
const MAX_LINES = 12

type State = "running" | "done" | "failed"

const MARK: Partial<Record<State, string>> = { running: "⏳", failed: "⚠️" }

interface Line {
  id: string
  tool: string
  input: unknown
  state: State
  reason?: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export class Progress {
  private readonly lines: Line[] = []

  started(id: string, tool: string, input: unknown): void {
    this.lines.push({ id, tool, input, state: "running" })
  }

  finished(id: string, error?: unknown): void {
    const line = this.lines.find((candidate) => candidate.id === id)
    if (line === undefined) return
    line.state = error === undefined ? "done" : "failed"
    if (error !== undefined) line.reason = reasonOf(error)
  }

  get empty(): boolean {
    return this.lines.length === 0
  }

  card(status: string, usage?: Usage): Card {
    const shown = this.lines.slice(-MAX_LINES)
    const folded = this.lines.length - shown.length
    const rows = shown.map(describe)
    if (folded > 0) rows.unshift(`… ${folded} earlier ${folded === 1 ? "step" : "steps"}`)
    return {
      tone: "grey",
      kicker: "🤖 bob",
      title: status,
      body: rows.join("\n") || undefined,
      footer: usage === undefined ? undefined : footnote(usage),
    }
  }
}

export function footnote(usage: Usage): string {
  const total = usage.inputTokens + usage.outputTokens
  const cached = usage.cachedTokens > 0 ? `, ${compact(usage.cachedTokens)} cached` : ""
  return `${compact(total)} tokens (${compact(usage.inputTokens)} in${cached}, ${compact(usage.outputTokens)} out)`
}

function compact(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

function describe(line: Line): string {
  const [icon, verb] = TOOLS[line.tool] ?? ["🔧", line.tool]
  const mark = MARK[line.state] ?? icon
  const args = asRecord(line.input)
  const repo = typeof args.repo === "string" ? `\`${args.repo.split("/").at(-1)}\` ` : ""
  const subject = subjectOf(args)
  const reason = line.reason === undefined ? "" : ` · ${line.reason}`
  return flat(`${mark} ${repo}${verb}${subject === "" ? "" : ` ${subject}`}${reason}`, MAX_LINE)
}

function subjectOf(args: Record<string, unknown>): string {
  const present = Object.entries(args).filter(
    ([key, value]) => !HIDDEN.has(key) && value !== undefined && value !== null && value !== "",
  )
  present.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  const [first] = present
  if (first === undefined) return ""
  const [key, value] = first
  if (key === "number") return `#${scalar(value)}`
  if (key === "title") return `"${scalar(value)}"`
  return `\`${scalar(value)}\``
}

function rank(key: string): number {
  const index = LEAD.indexOf(key)
  return index === -1 ? LEAD.length : index
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value) ?? ""
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {}
  return Object.fromEntries(Object.entries(input))
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return flat(message.split("\n")[0] ?? "", 60)
}

function flat(text: string, limit: number): string {
  const line = text.replaceAll(/\s+/g, " ").trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}
