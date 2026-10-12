// A story as the card a channel shows. Pure: the same story and mentions
// always draw the same card, so a card can be redrawn from storage at any time.
import type {
  DeployStep,
  IssueStory,
  Outcome,
  PipelineStory,
  Ping,
  PullStory,
  Review,
  RunStep,
  Story,
} from "../news/stories"
import { type Card, type Field, type Mentions, type Tone, who } from "./card"
import { KIND, MARK, outcomeMark, outcomeTone } from "./glyphs"
import { code, count, oneLine } from "./text"

export function draw(story: Story, mentions: Mentions): Card {
  if (story.kind === "issue") return issueCard(story, mentions)
  if (story.kind === "pull") return pullCard(story, mentions)
  return pipelineCard(story, mentions)
}

/** The mentions that notify, deduplicated; plain names notify no one and are left out. */
export function pingText(ping: Ping[], mentions: Mentions): string | undefined {
  const notified = ping.map((target) =>
    "login" in target ? mentions.person(target.login) : mentions.group(target.repo),
  )
  const unique = [...new Set(notified.filter((mention) => mention !== undefined))]
  return unique.length > 0 ? unique.join(" ") : undefined
}

// GitHub's own colours, which the team already reads at a glance.
const ISSUE_STATE: Record<IssueStory["status"], [Tone, string]> = {
  open: ["green", "Open issue"],
  completed: ["purple", "Closed issue"],
  not_planned: ["grey", "Closed as not planned"],
}

function issueCard(story: IssueStory, mentions: Mentions): Card {
  const [tone, state] = ISSUE_STATE[story.status]
  const fields: Field[] = [{ name: "Opened by", value: who(mentions, story.author), inline: true }]
  if (story.assignees.length > 0) {
    const value = story.assignees.map((login) => who(mentions, login)).join(" ")
    fields.push({ name: "Assignees", value, inline: true })
  }
  if (story.labels.length > 0) {
    fields.push({ name: "Labels", value: story.labels.map(code).join(" "), inline: false })
  }
  return {
    tone,
    kicker: `${KIND.issue} ${state} in ${story.repo.name}`,
    kickerUrl: story.repo.url,
    title: `${story.title} #${story.number}`,
    url: story.url,
    body: story.status === "open" ? story.body : undefined,
    fields,
    at: story.at,
  }
}

function pullState(story: PullStory): [Tone, string] {
  if (story.status === "merged") return ["purple", "Merged pull request"]
  if (story.status === "closed") return ["red", "Closed pull request"]
  if (story.reviews.some((review) => review.verdict === "approved")) {
    return ["green", "Approved pull request"]
  }
  return ["green", "Open pull request"]
}

function reviewLine(review: Review, mentions: Mentions): string {
  const name = who(mentions, review.login)
  const notes = count(review.comments, "comment")
  if (review.verdict === "requested") return `${MARK.waiting} Review requested from ${name}`
  if (review.verdict === "commented") return `${MARK.comment} ${notes} from ${name}`
  const [mark, said] =
    review.verdict === "approved"
      ? [MARK.done, `Approved by ${name}`]
      : [MARK.failed, `Changes requested by ${name}`]
  return review.comments > 0 ? `${mark} ${said}, with ${notes}` : `${mark} ${said}`
}

function pullCard(story: PullStory, mentions: Mentions): Card {
  const [tone, state] = pullState(story)
  const fields: Field[] = [{ name: "Opened by", value: who(mentions, story.author), inline: true }]
  if (story.closedBy !== undefined && story.status !== "open") {
    const name = story.status === "merged" ? "Merged by" : "Closed by"
    fields.push({ name, value: who(mentions, story.closedBy), inline: true })
  }
  if (story.reviews.length > 0) {
    const value = story.reviews.map((review) => reviewLine(review, mentions)).join("\n")
    fields.push({ name: "Reviews", value, inline: false })
  }
  return {
    tone,
    kicker: `${KIND.pull} ${state} in ${story.repo.name}`,
    kickerUrl: story.repo.url,
    title: `${story.title} #${story.number}`,
    url: story.url,
    body: story.status === "open" ? story.body : undefined,
    fields,
    at: story.at,
  }
}

/** `[passed](url) in 41s`: the word links to the run. */
function outcomeText(outcome: Outcome): string {
  const word = outcome.url === undefined ? outcome.word : `[${outcome.word}](${outcome.url})`
  return outcome.took === undefined ? word : `${word} in ${outcome.took}`
}

function deployLine(step: DeployStep): string {
  const details = [outcomeText(step.outcome)]
  if (step.logs !== undefined) details.push(`[logs](${step.logs})`)
  if (step.promotedFrom !== undefined) details.push(`promoted from ${code(step.promotedFrom)}`)
  if (step.ref !== undefined) details.push(`at ${code(step.ref)}`)
  const line = `${outcomeMark(step.outcome.ok)} ${KIND.deploy} ${step.environment} ${details.join(", ")}`
  return step.note === undefined ? line : `${line}. ${oneLine(step.note, 200)}`
}

/**
 * One line per job, named the way GitHub names a check (`workflow / job`).
 * A run's own line shows only until its jobs arrive, since they say more.
 */
function runLines(step: RunStep): { line: string; ok: boolean | undefined }[] {
  if (step.jobs.length > 0) {
    return step.jobs.map((job) => {
      const name = step.workflow === undefined ? job.name : `${step.workflow} / ${job.name}`
      const line = `${outcomeMark(job.outcome.ok)} ${name} ${outcomeText(job.outcome)}`
      return { line, ok: job.outcome.ok }
    })
  }
  if (step.outcome === undefined) return []
  let line = `${outcomeMark(step.outcome.ok)} ${step.workflow ?? "Workflow"} ${outcomeText(step.outcome)}`
  if (step.attempt !== undefined && step.attempt > 1) line += `, attempt ${step.attempt}`
  return [{ line, ok: step.outcome.ok }]
}

function stepLines(story: PipelineStory): { line: string; ok: boolean | undefined }[] {
  return story.steps.flatMap((step) =>
    step.type === "deploy" ? [{ line: deployLine(step), ok: step.outcome.ok }] : runLines(step),
  )
}

/** Failed while any step stands failed, running while any runs, passed otherwise. */
export function verdict(story: PipelineStory): boolean | undefined {
  const outcomes = stepLines(story).map((step) => step.ok)
  if (outcomes.includes(false)) return false
  if (outcomes.includes(undefined)) return undefined
  return true
}

const CHECKS_STATE = { passed: "Checks passed", failed: "Checks failed", running: "Checks running" }

function pipelineCard(story: PipelineStory, mentions: Mentions): Card {
  const { repo, commit } = story
  const short = code(story.sha.slice(0, 7))
  const ok = verdict(story)
  const state = ok === undefined ? CHECKS_STATE.running : CHECKS_STATE[ok ? "passed" : "failed"]
  const author = commit?.login === undefined ? commit?.name : who(mentions, commit.login)
  const lead = author === undefined ? short : `${short} by ${author}`
  const lines = stepLines(story).map((step) => step.line)
  return {
    tone: outcomeTone(ok),
    kicker: `${KIND.checks} ${state} in ${repo.name}`,
    kickerUrl: repo.url,
    title: commit?.subject ?? `${story.sha.slice(0, 7)} on ${repo.defaultBranch}`,
    url: `${repo.url}/commit/${story.sha}`,
    // Without the commit the title already names the sha.
    body: (commit === undefined ? lines : [lead, ...lines]).join("\n"),
    at: story.at,
  }
}
