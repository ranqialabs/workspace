// The issue the agent proposes, as the model fills it in. Nothing here is
// trusted: the repo is checked against the mapped ones before
// the draft is accepted, and GitHub checks the assignee and labels when it is filed.
import { z } from "zod"

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
