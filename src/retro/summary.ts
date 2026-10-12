// What shipped, per project, in a few plain lines. The model only rewords the
// titles it is given; when it fails or is not configured, the titles are the
// summary.
import { generateText, type LanguageModel } from "ai"

import type { Retro } from "./collect"

const INSTRUCTIONS = `\
You write the "what shipped" part of a team's retro, read by the whole company,
engineers or not.

For each project you get the pull requests merged and the issues closed. Write
one bold project name per project, then one to three bullets saying what
changed for the people who use it, in plain English. Group related items into
one bullet and cite their numbers, like (#31, #34). Leave out chores, version
bumps and dependency updates unless nothing else happened. Never invent
anything the titles do not say. No intro, no closing line, no emoji.`

/** Markdown, one block per project; undefined when nothing shipped. */
export async function summarize(
  model: LanguageModel | undefined,
  retro: Retro,
): Promise<string | undefined> {
  const projects = byProject(retro)
  if (projects.size === 0) return undefined
  if (model === undefined) return fallback(projects)
  const listing = [...projects].map(([repo, lines]) => `${repo}\n${lines.join("\n")}`).join("\n\n")
  try {
    const { text } = await generateText({ model, system: INSTRUCTIONS, prompt: listing })
    return text.trim() || fallback(projects)
  } catch (error) {
    console.error("retro summary failed", error)
    return fallback(projects)
  }
}

function byProject(retro: Retro): Map<string, string[]> {
  const projects = new Map<string, string[]>()
  const add = (repo: string, line: string): void => {
    projects.set(repo, [...(projects.get(repo) ?? []), line])
  }
  for (const item of retro.merged) add(item.repo, `- merged #${item.number}: ${item.title}`)
  for (const item of retro.closed) add(item.repo, `- closed issue #${item.number}: ${item.title}`)
  return projects
}

function fallback(projects: Map<string, string[]>): string {
  return [...projects]
    .map(
      ([repo, lines]) =>
        `**${repo}**\n${lines.map((line) => line.replace(/^- (merged|closed issue) /, "- ")).join("\n")}`,
    )
    .join("\n\n")
}
