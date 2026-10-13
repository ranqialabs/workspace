// The card of an issue the agent drafted, from proposal to its end: filed on
// GitHub, discarded, or replaced by a newer draft.
import type { IssueDraft } from "../agent/draft"
import type { Card, Field, Tone } from "./card"
import { KIND } from "./glyphs"
import { code, cut, repoName } from "./text"

export type DraftState =
  | { kind: "proposed"; requester: string }
  | { kind: "filed"; url: string; number: number }
  | { kind: "discarded" }
  | { kind: "superseded" }

const PREVIEW = 3000
const CONFIDENCE = { high: "High", medium: "Medium", low: "Low" }

export function draftCard(draft: IssueDraft, state: DraftState): Card {
  const repo = repoName(draft.repo)
  if (state.kind === "discarded" || state.kind === "superseded") {
    const [word, footer] =
      state.kind === "discarded"
        ? ["Discarded draft", undefined]
        : ["Replaced draft", "A newer draft follows."]
    return draftBase(draft, "grey", `${KIND.draft} ${word} for ${repo}`, { footer })
  }
  const fields = draftFields(draft)
  if (state.kind === "filed") {
    return draftBase(draft, "green", `${KIND.draft} Filed as #${state.number} in ${repo}`, {
      url: state.url,
      body: cut(draft.body, PREVIEW),
      fields,
    })
  }
  fields.push({ name: "Confidence", value: CONFIDENCE[draft.confidence], inline: true })
  if (draft.questions.length > 0) {
    const value = draft.questions.map((question) => `- ${question}`).join("\n")
    fields.push({ name: "Open questions", value, inline: false })
  }
  return draftBase(draft, "blue", `${KIND.draft} Draft issue for ${repo}`, {
    body: cut(draft.body, PREVIEW),
    fields,
    footer: `Not on GitHub yet. Only ${state.requester} can file or discard it.`,
  })
}

function draftBase(draft: IssueDraft, tone: Tone, kicker: string, rest: Partial<Card>): Card {
  return { tone, kicker, title: draft.title, ...rest }
}

function draftFields(draft: IssueDraft): Field[] {
  const assignee = draft.assignee === null ? "Nobody" : code(draft.assignee)
  const fields: Field[] = [{ name: "Assignee", value: assignee, inline: true }]
  if (draft.labels.length > 0) {
    fields.push({ name: "Labels", value: draft.labels.map(code).join(" "), inline: true })
  }
  return fields
}
