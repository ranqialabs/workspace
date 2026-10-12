// Every piece of GitHub news is a story with a key: an issue, a pull request,
// or what a push set off on one commit. A webhook event is a change to one
// story. The story is kept whole in SQLite and the card is drawn from it, so
// events arriving out of order or twice still land on one card.
import type {
  CheckRunPayload,
  DeploymentStatusPayload,
  IssuesPayload,
  PullRequest,
  PullRequestPayload,
  PullRequestReviewPayload,
  Repository,
  WorkflowRunPayload,
} from "./payloads"
import { PAYLOADS } from "./payloads"

export interface Repo {
  fullName: string
  name: string
  url: string
  defaultBranch: string
}

export interface IssueStory {
  kind: "issue"
  repo: Repo
  number: number
  title: string
  url: string
  body?: string
  author: string
  assignees: string[]
  labels: string[]
  status: "open" | "completed" | "not_planned"
  at?: string
}

export type Verdict = "requested" | "approved" | "changes" | "commented"

export interface Review {
  login: string
  verdict: Verdict
  comments: number
}

export interface PullStory {
  kind: "pull"
  repo: Repo
  number: number
  title: string
  url: string
  body?: string
  author: string
  status: "open" | "merged" | "closed"
  closedBy?: string
  reviews: Review[]
  at?: string
}

/** `ok` is undefined while the step still runs. */
export interface Outcome {
  ok?: boolean
  word: string
  url?: string
  took?: string
}

export interface JobStep {
  name: string
  outcome: Outcome
}

/** One workflow run. Its jobs arrive as separate events, in any order. */
export interface RunStep {
  type: "run"
  id: string
  workflow?: string
  outcome?: Outcome
  attempt?: number
  jobs: JobStep[]
}

export interface DeployStep {
  type: "deploy"
  environment: string
  outcome: Outcome
  logs?: string
  promotedFrom?: string
  ref?: string
  note?: string
}

export type Step = RunStep | DeployStep

export interface Commit {
  subject: string
  login?: string
  name?: string
}

export interface PipelineStory {
  kind: "pipeline"
  repo: Repo
  sha: string
  commit?: Commit
  steps: Step[]
  at?: string
}

export type Story = IssueStory | PullStory | PipelineStory

/** Someone a change should notify: a GitHub login, or everyone with access to a repo. */
export type Ping = { login: string } | { repo: string }

export interface Change {
  key: string
  repo: string
  apply(previous: Story | undefined): { story: Story; ping: Ping[] }
}

export const BODY_LIMIT = 400
const SUBJECT_LIMIT = 160

export function storyKey(kind: Story["kind"], repo: string, id: string | number): string {
  return `${kind}:${repo}:${id}`
}

/**
 * The change a delivery makes, or undefined for an event, action or shape bob
 * ignores. A payload that fails its schema is dropped rather than half-read.
 */
export function changeFor(event: string, payload: unknown): Change | undefined {
  switch (event) {
    case "issues":
      return parsed(PAYLOADS.issues, payload, issueChange)
    case "pull_request":
      return parsed(PAYLOADS.pull_request, payload, pullChange)
    case "pull_request_review":
      return parsed(PAYLOADS.pull_request_review, payload, reviewChange)
    case "workflow_run":
      return parsed(PAYLOADS.workflow_run, payload, workflowRunChange)
    case "check_run":
      return parsed(PAYLOADS.check_run, payload, checkRunChange)
    case "deployment_status":
      return parsed(PAYLOADS.deployment_status, payload, deploymentChange)
    default:
      return undefined
  }
}

function parsed<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  payload: unknown,
  change: (payload: T) => Change | undefined,
): Change | undefined {
  const result = schema.safeParse(payload)
  return result.success ? change(result.data) : undefined
}

function repoOf(repository: Repository): Repo {
  return {
    fullName: repository.full_name,
    name: repository.name,
    url: repository.html_url,
    defaultBranch: repository.default_branch,
  }
}

function clip(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim() ?? ""
  if (trimmed === "") return undefined
  return trimmed.length <= BODY_LIMIT ? trimmed : trimmed.slice(0, BODY_LIMIT - 1) + "…"
}

/** A commit message's first line, short enough for a title. */
export function subjectOf(message: string | undefined): string | undefined {
  const line = message?.trim().split("\n", 1)[0]?.trim() ?? ""
  if (line === "") return undefined
  return line.length <= SUBJECT_LIMIT ? line : line.slice(0, SUBJECT_LIMIT - 1) + "…"
}

/** How long something took, as `44s` or `3m 12s`. */
export function took(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return undefined
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

// --- issues ---

const ISSUE_ACTIONS = new Set(["opened", "closed", "reopened", "assigned", "unassigned"])

function issueChange(payload: IssuesPayload): Change | undefined {
  if (!ISSUE_ACTIONS.has(payload.action)) return undefined
  const { issue, repository } = payload
  const repo = repoOf(repository)
  const assignees = (issue.assignees ?? []).map((user) => user.login)
  const story: IssueStory = {
    kind: "issue",
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    body: clip(issue.body),
    author: issue.user.login,
    assignees,
    labels: (issue.labels ?? []).map((label) => label.name),
    status:
      issue.state !== "closed"
        ? "open"
        : issue.state_reason === "completed"
          ? "completed"
          : "not_planned",
    at: issue.updated_at ?? issue.created_at,
  }
  const ping: Ping[] =
    payload.action === "opened" || payload.action === "reopened"
      ? [{ repo: repo.fullName }, ...assignees.map((login) => ({ login }))]
      : payload.action === "assigned" && payload.assignee
        ? [{ login: payload.assignee.login }]
        : []
  return {
    key: storyKey("issue", repo.fullName, issue.number),
    repo: repo.fullName,
    apply: () => ({ story, ping }),
  }
}

// --- pull requests ---

function pullBase(previous: Story | undefined, pr: PullRequest, repository: Repository): PullStory {
  const repo = repoOf(repository)
  return {
    kind: "pull",
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    body: clip(pr.body),
    author: pr.user.login,
    status: pr.merged === true ? "merged" : "open",
    reviews: previous?.kind === "pull" ? previous.reviews : [],
    closedBy: previous?.kind === "pull" ? previous.closedBy : undefined,
    at: pr.updated_at,
  }
}

function pullChange(payload: PullRequestPayload): Change | undefined {
  const { action, pull_request: pr, repository } = payload
  const key = storyKey("pull", repository.full_name, pr.number)
  const change = (apply: Change["apply"]): Change => ({ key, repo: repository.full_name, apply })

  if ((action === "opened" && pr.draft !== true) || action === "ready_for_review") {
    return change((previous) => ({
      story: pullBase(previous, pr, repository),
      ping: [{ repo: repository.full_name }],
    }))
  }
  if (action === "review_requested") {
    // A team request names no reviewer, and teams have no chat mention.
    const reviewer = payload.requested_reviewer?.login
    if (reviewer === undefined) return undefined
    return change((previous) => {
      const story = pullBase(previous, pr, repository)
      story.reviews = upsertReview(story.reviews, reviewer, () => ({
        login: reviewer,
        verdict: "requested",
        comments: 0,
      }))
      return { story, ping: [{ login: reviewer }] }
    })
  }
  if (action === "closed") {
    return change((previous) => {
      const story = pullBase(previous, pr, repository)
      story.status = pr.merged === true ? "merged" : "closed"
      story.closedBy = payload.sender?.login
      story.at = pr.closed_at ?? pr.updated_at
      return { story, ping: [{ login: pr.user.login }] }
    })
  }
  return undefined
}

function upsertReview(
  reviews: Review[],
  login: string,
  update: (current: Review | undefined) => Review,
): Review[] {
  const index = reviews.findIndex((review) => review.login === login)
  if (index === -1) return [...reviews, update(undefined)]
  return reviews.map((review, i) => (i === index ? update(review) : review))
}

/**
 * A review submitted on a pull request.
 *
 * Commenting on a diff without batching sends one `submitted` event per thread,
 * all `commented`, so the card counts them instead of showing one each. A
 * verdict after them keeps the count: it concludes those comments.
 */
function reviewChange(payload: PullRequestReviewPayload): Change | undefined {
  if (payload.action !== "submitted") return undefined
  const { review, pull_request: pr, repository } = payload
  const state = review.state?.toLowerCase()
  const verdict: Verdict =
    state === "approved" ? "approved" : state === "changes_requested" ? "changes" : "commented"
  const reviewer = review.user.login
  return {
    key: storyKey("pull", repository.full_name, pr.number),
    repo: repository.full_name,
    apply(previous) {
      const story = pullBase(previous, pr, repository)
      story.at = review.submitted_at ?? pr.updated_at
      story.reviews = upsertReview(story.reviews, reviewer, (current) => ({
        login: reviewer,
        verdict,
        comments: (current?.comments ?? 0) + (verdict === "commented" ? 1 : 0),
      }))
      // Commenting on your own pull request is not news to you.
      return { story, ping: reviewer === pr.user.login ? [] : [{ login: pr.user.login }] }
    },
  }
}

// --- pipelines: the runs and deploys of one commit ---

// Anything absent (cancelled, skipped, neutral...) says nothing about the code.
const CONCLUSIONS: Record<string, { word: string; ok: boolean }> = {
  success: { word: "passed", ok: true },
  failure: { word: "failed", ok: false },
  timed_out: { word: "timed out", ok: false },
  startup_failure: { word: "failed to start", ok: false },
}

// `inactive` never arrives as a webhook; anything unlisted is skipped.
const DEPLOY_STATES: Record<string, { word: string; ok?: boolean }> = {
  pending: { word: "deploying" },
  in_progress: { word: "deploying" },
  queued: { word: "queued" },
  success: { word: "deployed", ok: true },
  failure: { word: "deploy failed", ok: false },
  error: { word: "deploy failed", ok: false },
}

function pipelineChange(
  repository: Repository,
  sha: string,
  commit: Commit | undefined,
  at: string | undefined,
  step: (steps: Step[]) => Step[],
): Change {
  const repo = repoOf(repository)
  return {
    key: storyKey("pipeline", repo.fullName, sha),
    repo: repo.fullName,
    apply(previous) {
      const before = previous?.kind === "pipeline" ? previous : undefined
      const story: PipelineStory = {
        kind: "pipeline",
        repo,
        sha,
        commit: commit ?? before?.commit,
        steps: step(before?.steps ?? []),
        at: before?.at ?? at,
      }
      return { story, ping: [] }
    },
  }
}

function upsertRun(steps: Step[], id: string, update: (run: RunStep) => RunStep): Step[] {
  const index = steps.findIndex((step) => step.type === "run" && step.id === id)
  if (index === -1) return [...steps, update({ type: "run", id, jobs: [] })]
  return steps.map((step, i) => (i === index && step.type === "run" ? update(step) : step))
}

/** Who to credit for a commit: the login it ran under, else its author's login or name. */
export function commitOf(
  message: string | undefined,
  login: string | undefined,
  name: string | undefined,
): Commit | undefined {
  const subject = subjectOf(message)
  return subject === undefined ? undefined : { subject, login, name }
}

function workflowRunChange(payload: WorkflowRunPayload): Change | undefined {
  const { workflow_run: run, repository } = payload
  if (payload.action !== "completed" || run.head_branch !== repository.default_branch) {
    return undefined
  }
  const conclusion = CONCLUSIONS[run.conclusion ?? ""]
  if (conclusion === undefined) return undefined
  const outcome: Outcome = {
    ...conclusion,
    url: run.html_url ?? repository.html_url,
    took: took(run.run_started_at, run.updated_at),
  }
  const head = run.head_commit
  const commit = commitOf(
    head?.message,
    run.actor?.login ?? head?.author?.login,
    head?.author?.name,
  )
  return pipelineChange(repository, run.head_sha, commit, run.head_commit?.timestamp, (steps) =>
    upsertRun(steps, String(run.id), (step) => ({
      ...step,
      workflow: run.name ?? "workflow",
      outcome,
      attempt: run.run_attempt,
    })),
  )
}

function runIdFrom(url: string | null | undefined): string | undefined {
  return /\/actions\/runs\/(\d+)/.exec(url ?? "")?.[1]
}

function checkRunChange(payload: CheckRunPayload): Change | undefined {
  const { check_run: job, repository } = payload
  if (payload.action !== "completed") return undefined
  if (job.check_suite?.head_branch !== repository.default_branch) return undefined
  const conclusion = CONCLUSIONS[job.conclusion ?? ""]
  const runId = runIdFrom(job.details_url ?? job.html_url)
  if (conclusion === undefined || runId === undefined) return undefined
  const outcome: Outcome = {
    ...conclusion,
    url: job.html_url ?? repository.html_url,
    took: took(job.started_at, job.completed_at),
  }
  return pipelineChange(
    repository,
    job.head_sha,
    undefined,
    job.completed_at ?? undefined,
    (steps) =>
      upsertRun(steps, runId, (run) => {
        const fresh: JobStep = { name: job.name, outcome }
        const known = run.jobs.some((other) => other.name === job.name)
        const jobs = known
          ? run.jobs.map((other) => (other.name === job.name ? fresh : other))
          : [...run.jobs, fresh]
        return { ...run, jobs }
      }),
  )
}

function deploymentChange(payload: DeploymentStatusPayload): Change | undefined {
  const { deployment_status: status, deployment, repository } = payload
  const state = DEPLOY_STATES[status.state.toLowerCase()]
  if (state === undefined) return undefined
  const environment = deployment.environment ?? "deploy"
  const live = status.environment_url || undefined
  // The run that triggered the deploy beats both log links: it is the job you'd read.
  const logs = payload.workflow_run?.html_url || status.log_url || status.target_url || undefined
  const ref = deployment.ref
  const step: DeployStep = {
    type: "deploy",
    environment,
    outcome: { ...state, url: live },
    logs: logs === live ? undefined : logs,
    promotedFrom:
      deployment.original_environment && deployment.original_environment !== environment
        ? deployment.original_environment
        : undefined,
    ref: ref && ref !== deployment.sha && ref !== repository.default_branch ? ref : undefined,
    note: status.description || undefined,
  }
  return pipelineChange(repository, deployment.sha, undefined, status.updated_at, (steps) => {
    const index = steps.findIndex(
      (other) => other.type === "deploy" && other.environment === environment,
    )
    return index === -1 ? [...steps, step] : steps.map((other, i) => (i === index ? step : other))
  })
}
