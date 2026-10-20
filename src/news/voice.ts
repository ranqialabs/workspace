// The one line on a card that talks to the person being pinged, written by the
// model: the card stays deterministic, and only the sentence a teammate would
// say is generated, only when there is someone to say it to.
import { generateText, type LanguageModel } from "ai"

import { type Review, type Step, type Story } from "./stories"

export interface Narration {
  story: Story
  /** The story before this change, when there was one. */
  previous?: Story
  /** The GitHub logins being mentioned in the message. */
  pinged: string[]
}

export type Narrator = (narration: Narration) => Promise<string | undefined>

const INSTRUCTIONS = [
  "You write the one sentence on a GitHub card that has just pinged someone in a team chat.",
  "Say what happened in plain words, the way a teammate would say it, and what it means for the people pinged.",
  "One sentence, at most 90 characters. No greeting, no markdown, no quotes, no emoji.",
  "Do not repeat the issue or pull request number, the repo name, or the title: the card already shows them.",
  "Do not mention the card, the message, or that you are summarising.",
].join(" ")

/** A narrator over `model`; without a model it says nothing rather than something made up. */
export function narratorFor(model: LanguageModel | undefined): Narrator {
  if (model === undefined) return () => Promise.resolve(undefined)
  return async (narration) => {
    const { text } = await generateText({
      model,
      instructions: INSTRUCTIONS,
      prompt: facts(narration),
      maxOutputTokens: 80,
    })
    const line = clean(text)
    return line === "" ? undefined : line
  }
}

/** The model's line as one plain sentence, without the whitespace runs and quotes it likes to add. */
export function clean(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim()
  const bare = line.replace(/^["'`“”]+|["'`“”]+$/g, "").trim()
  return bare.length <= 140 ? bare : `${bare.slice(0, 139).trimEnd()}…`
}

const VERDICT: Record<Review["verdict"], string> = {
  requested: "was asked to review",
  approved: "approved",
  changes: "asked for changes",
  commented: "commented",
}

/** What changed, in the fewest words that still say it. */
export function changeOf(previous: Story | undefined, story: Story): string {
  if (previous === undefined) return "first news of it"
  if (story.kind !== previous.kind) return "updated"
  if (story.kind === "issue" && previous.kind === "issue") {
    const added = story.assignees.filter((login) => !previous.assignees.includes(login))
    if (added.length > 0) return `assigned to ${added.join(", ")}`
    if (previous.status !== story.status) return `state ${previous.status} to ${story.status}`
  }
  if (story.kind === "pull" && previous.kind === "pull") {
    if (previous.status !== story.status) return `status ${previous.status} to ${story.status}`
    const known = previous.reviews.map((review) => `${review.login}:${review.verdict}`)
    const fresh = story.reviews.filter(
      (review) => !known.includes(`${review.login}:${review.verdict}`),
    )
    if (fresh.length > 0) {
      return fresh.map((review) => `${review.login} ${VERDICT[review.verdict]}`).join(", ")
    }
  }
  if (story.kind === "pipeline" && previous.kind === "pipeline") {
    const before = previous.steps.length
    const failed = story.steps.flatMap((step) =>
      step.outcome?.ok === false ? [stepName(step)] : [],
    )
    if (failed.length > 0) return `failed: ${failed.join(", ")}`
    if (story.steps.length > before) return "new checks ran"
  }
  return "updated"
}

function stepName(step: Step): string {
  return step.type === "deploy" ? `deploy to ${step.environment}` : (step.workflow ?? "checks")
}

/** The story as the facts a person would say out loud, not as JSON. */
function facts({ story, previous, pinged }: Narration): string {
  const lines = [
    `repo: ${story.repo.fullName}`,
    `people told: ${pinged.join(", ") || "the team"}`,
    `change: ${changeOf(previous, story)}`,
  ]
  if (story.kind === "issue") {
    lines.push(
      `issue #${story.number}: "${story.title}" in ${story.repo.name}`,
      `opened by: ${story.author}`,
      `assignees: ${story.assignees.join(", ") || "nobody"}`,
      `state: ${story.status}`,
    )
    if (story.labels.length > 0) lines.push(`labels: ${story.labels.join(", ")}`)
  } else if (story.kind === "pull") {
    lines.push(
      `pull request #${story.number}: "${story.title}" in ${story.repo.name}`,
      `opened by: ${story.author}`,
      `state: ${story.status}${story.closedBy === undefined ? "" : ` by ${story.closedBy}`}`,
      `reviews: ${story.reviews.map((review) => `${review.login} ${review.verdict}`).join(", ") || "none"}`,
    )
  } else {
    const failed = story.steps.flatMap((step) =>
      step.outcome?.ok === false ? [stepName(step)] : [],
    )
    lines.push(
      `commit: "${story.commit?.subject ?? story.sha.slice(0, 7)}" on ${story.repo.defaultBranch}`,
      `by: ${story.commit?.login ?? story.commit?.name ?? "unknown"}`,
      `checks: ${failed.length > 0 ? `failed: ${failed.join(", ")}` : "running or passing"}`,
    )
  }
  return lines.join("\n")
}
