// What the period's work means, in a few lines: the model reads the merged
// pull requests (titles and descriptions) and groups them into themes, each
// saying what changed and why it matters. Everything else in the retro is a
// fact from GitHub; this is the model's reading of those facts, so it is
// optional: without a model, or when it fails, the retro goes out without it.
import { generateText, type LanguageModel, Output } from "ai"
import { z } from "zod"

import { repoName } from "../ui/text"
import type { Merged, Retro } from "./collect"

export interface Theme {
  title: string
  meaning: string
  /** The pull requests behind it, in the order the model gave them. */
  pulls: Merged[]
}

export interface Summary {
  overview: string
  themes: Theme[]
}

const MAX_THEMES = 5
// A description is context, not the point; long ones are mostly templates and logs.
const BODY_LIMIT = 600
const MAX_PULLS = 60
// The retro waits on this; a model that is down must not hold it for long.
const TIMEOUT_MS = 25_000

const INSTRUCTIONS = `\
You summarize what an engineering team shipped, for everyone in the company,
including people who don't read code. You get the pull requests merged in the
period, each with a ref like ada-infra#87, its title, its description, the
lines it changed and whether it reached production.

Return:
- overview: one or two sentences, at most 240 characters, with the gist of the
  period. Concrete and plain, no hype.
- themes: one to five groups of related pull requests, most important first.
  Each has a title of at most six words naming what changed (not the repo), a
  meaning of one sentence, at most 160 characters, saying what it means for the
  people who use the product or for the team, and the refs of its pull requests
  exactly as given. Leave chores, version bumps and dependency updates out
  unless nothing else happened. A pull request goes in one theme at most.

Never invent anything the titles and descriptions do not say. Write in English.
No emoji, no em dashes.`

const SCHEMA = z.object({
  overview: z.string(),
  themes: z.array(z.object({ title: z.string(), meaning: z.string(), refs: z.array(z.string()) })),
})

export function ref(pull: Merged): string {
  return `${repoName(pull.repo)}#${pull.number}`
}

/** The model's reading of the period, or undefined without a model, without work, or on failure. */
export async function summarize(
  retro: Retro,
  model: LanguageModel | undefined,
): Promise<Summary | undefined> {
  if (model === undefined || retro.merged.length === 0) return undefined
  try {
    const { output } = await generateText({
      model,
      system: INSTRUCTIONS,
      prompt: describe(retro),
      output: Output.object({ schema: SCHEMA }),
      maxRetries: 0,
      timeout: TIMEOUT_MS,
    })
    return resolve(retro, output)
  } catch (error) {
    console.error("retro summary failed", error)
    return undefined
  }
}

function describe(retro: Retro): string {
  const kind = retro.period.kind === "day" ? "day" : "week"
  const pulls = retro.merged.slice(0, MAX_PULLS).map((pull) => {
    const shipped =
      pull.shipped === "production"
        ? "in production"
        : pull.shipped === "waiting"
          ? "waiting for a deploy"
          : "no deploys in this repo"
    const body = pull.body.replaceAll(/<!--[\s\S]*?-->/g, "").trim()
    return [
      `## ${ref(pull)}: ${pull.title}`,
      `+${pull.additions} -${pull.deletions} lines, ${shipped}`,
      body === "" ? "" : body.slice(0, BODY_LIMIT),
    ]
      .filter((line) => line !== "")
      .join("\n")
  })
  return `Pull requests merged this ${kind} in ${retro.org}:\n\n${pulls.join("\n\n")}`
}

/** Refs back to pull requests; a ref the model made up is dropped, and so is an empty theme. */
function resolve(retro: Retro, output: z.infer<typeof SCHEMA>): Summary | undefined {
  const byRef = new Map(retro.merged.map((pull) => [ref(pull).toLowerCase(), pull]))
  const used = new Set<Merged>()
  const themes: Theme[] = []
  for (const theme of output.themes) {
    const pulls = theme.refs.flatMap((name) => {
      const pull = byRef.get(name.trim().replace(/^#/, "").toLowerCase())
      if (pull === undefined || used.has(pull)) return []
      used.add(pull)
      return [pull]
    })
    if (pulls.length === 0 || theme.title.trim() === "") continue
    themes.push({ title: theme.title.trim(), meaning: theme.meaning.trim(), pulls })
    if (themes.length === MAX_THEMES) break
  }
  const overview = output.overview.trim()
  if (overview === "" && themes.length === 0) return undefined
  return { overview, themes }
}
