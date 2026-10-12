// The parts of GitHub's webhook payloads that bob reads, checked on arrival.
// Kept narrow on purpose: the test fixtures stay short, and this file lists
// every field the news depends on.
import { z } from "zod"

// GitHub sends null and leaves fields out interchangeably; bob reads both as absent.
function optional<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined)
}

const text = optional(z.string())

const user = z.object({ login: z.string() })

const repository = z.object({
  name: z.string(),
  full_name: z.string(),
  html_url: z.string(),
  default_branch: z.string(),
})

export type Repository = z.infer<typeof repository>

const issues = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    body: text,
    state: text,
    state_reason: text,
    user,
    assignees: optional(z.array(user)),
    labels: optional(z.array(z.object({ name: z.string() }))),
    created_at: text,
    updated_at: text,
  }),
  assignee: optional(user),
  repository,
})

const pullRequest = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  body: text,
  draft: optional(z.boolean()),
  merged: optional(z.boolean()),
  user,
  updated_at: text,
  closed_at: text,
})

export type PullRequest = z.infer<typeof pullRequest>

const pullRequestEvent = z.object({
  action: z.string(),
  pull_request: pullRequest,
  requested_reviewer: optional(user),
  sender: optional(user),
  repository,
})

const pullRequestReview = z.object({
  action: z.string(),
  review: z.object({ state: text, body: text, user, submitted_at: text }),
  pull_request: pullRequest,
  repository,
})

const headCommit = z.object({
  message: text,
  timestamp: text,
  author: optional(z.object({ name: text, login: text })),
})

const workflowRun = z.object({
  action: z.string(),
  workflow_run: z.object({
    id: z.number(),
    name: text,
    html_url: text,
    head_sha: z.string(),
    head_branch: text,
    conclusion: text,
    run_attempt: optional(z.number()),
    run_started_at: text,
    updated_at: text,
    actor: optional(user),
    head_commit: optional(headCommit),
  }),
  repository,
})

const checkRun = z.object({
  action: z.string(),
  check_run: z.object({
    name: z.string(),
    head_sha: z.string(),
    html_url: text,
    details_url: text,
    conclusion: text,
    started_at: text,
    completed_at: text,
    check_suite: optional(z.object({ head_branch: text })),
  }),
  repository,
})

const deploymentStatus = z.object({
  deployment_status: z.object({
    state: z.string(),
    environment_url: text,
    log_url: text,
    target_url: text,
    description: text,
    updated_at: text,
  }),
  deployment: z.object({
    sha: z.string(),
    ref: text,
    environment: text,
    original_environment: text,
  }),
  workflow_run: optional(z.object({ html_url: text })),
  repository,
})

export const PAYLOADS = {
  issues,
  pull_request: pullRequestEvent,
  pull_request_review: pullRequestReview,
  workflow_run: workflowRun,
  check_run: checkRun,
  deployment_status: deploymentStatus,
}

type NewsEvent = keyof typeof PAYLOADS
export type Payloads = { [E in NewsEvent]: z.infer<(typeof PAYLOADS)[E]> }
export type IssuesPayload = Payloads["issues"]
export type PullRequestPayload = Payloads["pull_request"]
export type PullRequestReviewPayload = Payloads["pull_request_review"]
export type WorkflowRunPayload = Payloads["workflow_run"]
export type CheckRunPayload = Payloads["check_run"]
export type DeploymentStatusPayload = Payloads["deployment_status"]
