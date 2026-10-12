// The short things bob says in a conversation, and the labels of its buttons.
// A button and the reply it causes use the same verb: File issue, then Filed.
import { MARK } from "./glyphs"

export const BUTTON = {
  stop: "Stop",
  file: "File issue",
  discard: "Discard",
} as const

const DRAFT_ENDED: Record<string, string> = {
  submitted: "filed",
  discarded: "discarded",
  superseded: "replaced by a newer one",
}

export const REPLY = {
  queued: `${MARK.waiting} Queued. I'll answer this right after the current one.`,
  noAnswer: "I ran out of things to say. Try asking again, more specifically.",
  nothingRunning: "Nothing is running here.",
  notYourRun: (name: string) => `Only ${name} can stop this answer.`,
  draftGone: "That draft is gone.",
  notYourDraft: "Only whoever asked for this draft can file or discard it.",
  draftEnded: (state: string) => `This draft was already ${DRAFT_ENDED[state] ?? state}.`,
  filed: (number: number, url: string, repo: string) =>
    `${MARK.done} Filed [#${number}](${url}) in ${repo.split("/").at(-1)}.`,
  githubRefused: (reason: string) => `GitHub refused the issue: ${reason}`,
} as const
