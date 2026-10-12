// What one turn says to the model: who is asking, what they asked, where a
// draft may go and, on a conversation's first turn, the messages just before it.
import type { ChatMessage } from "../chat/chat"
import { failedSteps, type PipelineStory } from "../news/stories"
import type { IssueDraft } from "./draft"

export interface Ask {
  author: { id: string; name: string }
  text: string
}

export interface TurnContext {
  /** Everything said to bob since its last answer, oldest first. */
  asks: Ask[]
  candidates: string[]
  /** The messages before the first ask; only on a conversation's first turn. */
  seed: ChatMessage[]
  /** The draft under review in this conversation, if one is open. */
  draft?: IssueDraft
}

export function turnText(context: TurnContext): string {
  const sections: string[] = []
  if (context.seed.length > 0) {
    sections.push(
      `The last messages before you were called, oldest first. Read further back with \`read_conversation\` if they don't settle what's meant.\n\n${context.seed.map(line).join("\n")}`,
    )
  }
  if (context.draft !== undefined) {
    sections.push(
      `An issue draft is open for review in this conversation. Change it only if asked to:\n\n${JSON.stringify(context.draft, undefined, 2)}`,
    )
  }
  sections.push(repoLine(context.candidates))
  const [last] = context.asks.slice(-1)
  if (last !== undefined) {
    sections.push(
      `You are talking to ${last.author.name}. "Me" and "I" mean them, not whoever spoke earlier.`,
    )
  }
  sections.push(context.asks.map((ask) => `${ask.author.name}: ${ask.text}`).join("\n\n"))
  return sections.join("\n\n---\n\n")
}

function repoLine(candidates: string[]): string {
  if (candidates.length === 1) return `An issue from here belongs to \`${candidates[0]}\`.`
  if (candidates.length === 0)
    return "No repo is mapped here, so an issue may go to any repo you can read."
  return `An issue from here goes to one of: ${candidates.map((repo) => `\`${repo}\``).join(", ")}.`
}

function line(message: ChatMessage): string {
  const who = message.author.bot ? `${message.author.name} (bot)` : message.author.name
  return `[${message.at.slice(0, 16).replace("T", " ")}] ${who}: ${message.text}`
}

/** What someone pressing "Why did it fail?" on a checks card is asking. */
export function explainFailure(story: PipelineStory): string {
  const sha = story.sha.slice(0, 7)
  const subject = story.commit?.subject === undefined ? "" : ` ("${story.commit.subject}")`
  const failed = failedSteps(story).join(", ") || "some checks"
  return [
    `The checks on commit ${sha}${subject} in ${story.repo.fullName} failed: ${failed}.`,
    `Find out why. Read the failures with \`check_failures\` on ${story.sha} and what the commit changed with \`get_commit\`.`,
    "Answer in a few lines: the cause, citing `path:line`, and what would fix it. Do not propose an issue.",
  ].join(" ")
}
