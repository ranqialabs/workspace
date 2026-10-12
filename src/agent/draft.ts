// The issue the agent proposes, and its card while a human reviews it.
// Nothing here is trusted: the repo is checked against the mapped ones before
// the draft is accepted, and GitHub checks the assignee and labels on Submit.
import { z } from "zod"

import type { Card, Tone } from "../chat/card"

export const IssueDraft = z.object({
  title: z.string().max(256).describe("`type: what changes`, e.g. `fix: ...`, `feat: ...`"),
  body: z.string().describe("GitHub Markdown, following the repo's issue template"),
  repo: z.string().describe('"owner/name", one of the candidates'),
  labels: z.array(z.string()).max(8).default([]),
  assignee: z.string().nullable().default(null).describe("A GitHub login, or null"),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  questions: z
    .array(z.string())
    .max(5)
    .default([])
    .describe("What blocks someone from starting that the conversation does not say"),
})

export type IssueDraft = z.infer<typeof IssueDraft>

export type DraftState =
  | { kind: "proposed" }
  | { kind: "submitted"; url: string; number: number }
  | { kind: "discarded" }

const TONE: Record<IssueDraft["confidence"], Tone> = { high: "green", medium: "blue", low: "grey" }
const PREVIEW_CHARS = 3_000

export function draftCard(draft: IssueDraft, state: DraftState, note?: string): Card {
  const fields = [
    { name: "Repo", value: `\`${draft.repo}\``, inline: true },
    {
      name: "Assignee",
      value: draft.assignee === null ? "nobody" : `\`${draft.assignee}\``,
      inline: true,
    },
  ]
  if (draft.labels.length > 0) {
    fields.push({
      name: "Labels",
      value: draft.labels.map((l) => `\`${l}\``).join(", "),
      inline: false,
    })
  }
  if (draft.questions.length > 0) {
    const questions = draft.questions.map((question) => `- ${question}`).join("\n")
    fields.push({ name: "Open questions", value: questions, inline: false })
  }
  if (note !== undefined) fields.push({ name: "Note", value: note, inline: false })

  const body =
    draft.body.length > PREVIEW_CHARS ? `${draft.body.slice(0, PREVIEW_CHARS)}\n\n…` : draft.body
  if (state.kind === "submitted") {
    return {
      tone: "green",
      kicker: `📝 issue #${state.number} · ${draft.repo}`,
      title: draft.title,
      url: state.url,
      body,
      fields,
      footer: "submitted",
    }
  }
  if (state.kind === "discarded") {
    return {
      tone: "grey",
      kicker: `📝 discarded draft · ${draft.repo}`,
      title: draft.title,
      fields,
      footer: "discarded",
    }
  }
  return {
    tone: TONE[draft.confidence],
    kicker: `📝 draft issue · ${draft.repo}`,
    title: draft.title,
    body,
    fields,
    footer: `confidence: ${draft.confidence} · not submitted yet`,
  }
}
