// The short things bob says in a conversation, and the labels of its buttons.
// A button and the reply it causes use the same verb: File issue, then Filed.
import { MARK } from "./glyphs"

export const BUTTON = {
  stop: "Stop",
  file: "File issue",
  discard: "Discard",
  explain: "Why did it fail?",
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
  cardGone: "That card is too old to explain. Mention @bob in its thread instead.",
  // What the platform handlers say when bob cannot do what was asked.
  broke: "That didn't work. The details are in the Worker's logs; try again in a minute.",
  unknownCommand: "I don't know that command. `/config` lists what bob knows.",
  foreignButton: "That button isn't one of bob's.",
  unsupported: "bob doesn't handle that kind of interaction.",
  adminsOnly: "Only workspace admins can change bob's mappings.",
} as const

/** The usage of `/bob` on Slack, shown for anything it does not understand. */
export const SLACK_USAGE = [
  "`/bob config` shows every mapping.",
  "`/bob map repo owner/name #channel` makes the channel the repo's home.",
  "`/bob map announce owner/name #channel` sends its news there instead.",
  "`/bob map github login @person` and `/bob map linear email @person` say who someone is.",
  "`/bob unmap repo owner/name [announce]`, `/bob unmap github @person` and `/bob unmap linear @person` undo them.",
  "`/bob retro` posts what shipped today here; `/bob retro week`, this week.",
  "`/bob map retro #channel` posts the retros there on working days; `/bob unmap retro` stops them.",
].join("\n")
