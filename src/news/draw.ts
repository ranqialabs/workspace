// A story as the card a channel shows. Pure: the same story and mentions
// always draw the same card, so a card can be redrawn from storage at any time.
import { type Card, type Mentions, type Tone, who } from "../chat/card"
import type {
  DeployStep,
  IssueStory,
  Outcome,
  PipelineStory,
  Ping,
  PullStory,
  Review,
  Story,
} from "./stories"

export const PASSED = "✅"
export const FAILED = "❌"
export const RUNNING = "🕒"

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

function issueCard(story: IssueStory, mentions: Mentions): Card {
  const { repo } = story
  const [icon, tone, label]: [string, Tone, string] =
    story.status === "open"
      ? ["🐛", "green", "issue"]
      : story.status === "completed"
        ? ["✅", "green", "closed"]
        : ["🚫", "grey", "closed"]
  const fields = [{ name: "Opened by", value: who(mentions, story.author), inline: true }]
  if (story.assignees.length > 0) {
    const value = story.assignees.map((login) => who(mentions, login)).join(" ")
    fields.push({ name: "Assignees", value, inline: true })
  }
  if (story.labels.length > 0) {
    const value = story.labels.map((name) => `\`${name}\``).join(", ")
    fields.push({ name: "Labels", value, inline: false })
  }
  return {
    tone,
    kicker: `${icon} ${label} · ${repo.name}`,
    kickerUrl: repo.url,
    title: `#${story.number} · ${story.title}`,
    url: story.url,
    body: story.status === "open" ? story.body : undefined,
    fields,
    footer: repo.fullName,
    at: story.at,
  }
}

const REVIEW_ICONS: Record<Review["verdict"], string> = {
  requested: "👀",
  approved: "✅",
  changes: "🔴",
  commented: "💬",
}

function reviewLine(review: Review, mentions: Mentions): string {
  const name = who(mentions, review.login)
  const said =
    review.verdict === "requested"
      ? "review requested"
      : review.verdict === "approved"
        ? "approved"
        : review.verdict === "changes"
          ? "requested changes"
          : "commented"
  const count =
    review.comments > 0 ? ` · ${review.comments} comment${review.comments === 1 ? "" : "s"}` : ""
  return `${REVIEW_ICONS[review.verdict]} ${name} ${said}${count}`
}

function pullCard(story: PullStory, mentions: Mentions): Card {
  const { repo } = story
  const [icon, tone, label]: [string, Tone, string] =
    story.status === "merged"
      ? ["🟣", "purple", "PR merged"]
      : story.status === "closed"
        ? ["🔴", "red", "PR closed"]
        : story.reviews.some((review) => review.verdict === "approved")
          ? ["✅", "green", "PR approved"]
          : ["📥", "blue", "PR open"]
  const fields = [{ name: "Opened by", value: who(mentions, story.author), inline: true }]
  if (story.closedBy !== undefined && story.status !== "open") {
    const verb = story.status === "merged" ? "Merged by" : "Closed by"
    fields.push({ name: verb, value: who(mentions, story.closedBy), inline: true })
  }
  if (story.reviews.length > 0) {
    const value = story.reviews.map((review) => reviewLine(review, mentions)).join("\n")
    fields.push({ name: "Reviews", value, inline: false })
  }
  return {
    tone,
    kicker: `${icon} ${label} · ${repo.name}`,
    kickerUrl: repo.url,
    title: `#${story.number} · ${story.title}`,
    url: story.url,
    body: story.status === "open" ? story.body : undefined,
    fields,
    footer: repo.fullName,
    at: story.at,
  }
}

function stepIcon(ok: boolean | undefined): string {
  if (ok === undefined) return RUNNING
  return ok ? PASSED : FAILED
}

function pipelineTone(ok: boolean | undefined): Card["tone"] {
  if (ok === undefined) return "blue"
  return ok ? "green" : "red"
}

/** The commit's short sha and who wrote it, for the card's first line. */
function commitLead(short: string, by: string | undefined): string {
  if (by === undefined) return `\`${short}\``
  return `\`${short}\` by ${by}`
}

function outcomeText(outcome: Outcome): string {
  const word = outcome.url === undefined ? outcome.word : `[${outcome.word}](${outcome.url})`
  return outcome.took === undefined ? word : `${word} in ${outcome.took}`
}

function deployLine(step: DeployStep): string {
  let detail = outcomeText(step.outcome)
  if (step.logs !== undefined) detail += ` ([logs](${step.logs}))`
  if (step.promotedFrom !== undefined) detail += `, promoted from \`${step.promotedFrom}\``
  if (step.ref !== undefined) detail += ` at \`${step.ref}\``
  if (step.note !== undefined) detail += ` · ${step.note.replaceAll(/\s+/g, " ")}`
  return `${stepIcon(step.outcome.ok)} 🚀 deploy: ${step.environment} · ${detail}`
}

/**
 * One line per job, named the way GitHub names a check (`workflow / job`).
 * A run's own line shows only until its jobs arrive, since they say more.
 */
function stepLines(story: PipelineStory): { line: string; ok: boolean | undefined }[] {
  return story.steps.flatMap((step) => {
    if (step.type === "deploy") return [{ line: deployLine(step), ok: step.outcome.ok }]
    if (step.jobs.length > 0) {
      return step.jobs.map((job) => {
        const name = step.workflow === undefined ? job.name : `${step.workflow} / ${job.name}`
        return {
          line: `${stepIcon(job.outcome.ok)} ${name} · ${outcomeText(job.outcome)}`,
          ok: job.outcome.ok,
        }
      })
    }
    if (step.outcome === undefined) return []
    let detail = outcomeText(step.outcome)
    if (step.attempt !== undefined && step.attempt > 1) detail += `, attempt ${step.attempt}`
    const line = `${stepIcon(step.outcome.ok)} ${step.workflow ?? "workflow"} · ${detail}`
    return [{ line, ok: step.outcome.ok }]
  })
}

/** Red while any step stands failed, blue while any runs, green otherwise. */
export function verdict(story: PipelineStory): boolean | undefined {
  const outcomes = stepLines(story).map((step) => step.ok)
  if (outcomes.includes(false)) return false
  if (outcomes.includes(undefined)) return undefined
  return true
}

function pipelineCard(story: PipelineStory, mentions: Mentions): Card {
  const { repo, commit } = story
  const short = story.sha.slice(0, 7)
  const ok = verdict(story)
  const by = commit?.login !== undefined ? who(mentions, commit.login) : (commit?.name ?? undefined)
  const lead = commit === undefined ? undefined : commitLead(short, by)
  const lines = stepLines(story).map((step) => step.line)
  return {
    tone: pipelineTone(ok),
    kicker: `${stepIcon(ok)} pipeline · ${repo.name}`,
    kickerUrl: repo.url,
    title: commit?.subject ?? `${short} on ${repo.defaultBranch}`,
    url: `${repo.url}/commit/${story.sha}`,
    body: [lead, ...lines].filter((part) => part !== undefined).join("\n"),
    footer: repo.fullName,
    at: story.at,
  }
}
