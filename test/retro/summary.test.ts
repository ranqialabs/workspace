import { describe, expect, spyOn, test } from "bun:test"
import { MockLanguageModelV4 } from "ai/test"

import { summarize } from "../../src/retro/summary"
import { retroCard } from "../../src/ui/retro"
import { SAMPLE } from "./sample"

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

function answering(output: object): MockLanguageModelV4 & { prompts: string[] } {
  const prompts: string[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt))
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }
    },
  })
  return Object.assign(model, { prompts })
}

const READING = {
  overview: "bob moved to Cloudflare Workers, and sessions survive a password reset.",
  themes: [
    {
      title: "bob on Workers",
      meaning: "The bot now runs on Cloudflare and talks on Discord and Slack.",
      refs: ["workspace#32", "nowhere#1"],
    },
    {
      title: "Sessions after a reset",
      meaning: "People stay signed in after changing their password.",
      refs: ["#ada-api#118", "workspace#32"],
    },
    { title: "Made up", meaning: "Nothing behind it.", refs: ["ghost#9"] },
  ],
}

describe("the summary", () => {
  test("themes point at the merged pull requests; made-up and repeated refs are dropped", async () => {
    const model = answering(READING)
    const summary = await summarize(SAMPLE, model)
    expect(summary?.overview).toBe(READING.overview)
    expect(
      summary?.themes.map((theme) => [theme.title, theme.pulls.map((pull) => pull.number)]),
    ).toEqual([
      ["bob on Workers", [32]],
      ["Sessions after a reset", [118]],
    ])
    // The model reads refs it can hand back.
    expect(model.prompts[0]).toContain("ada-infra#87")
  })

  test("without a model, or with one that fails, there is no summary", async () => {
    expect(await summarize(SAMPLE, undefined)).toBeUndefined()
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("You have no credits remaining")
      },
    })
    const quiet = spyOn(console, "error").mockImplementation(() => {})
    expect(await summarize(SAMPLE, broken)).toBeUndefined()
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })

  test("nothing merged asks nothing", async () => {
    const model = answering(READING)
    expect(await summarize({ ...SAMPLE, merged: [] }, model)).toBeUndefined()
    expect(model.prompts).toHaveLength(0)
  })

  test("the card opens with the overview and a line per theme", async () => {
    const summary = await summarize(SAMPLE, answering(READING))
    const card = retroCard(SAMPLE, (login) => login, true, summary)
    expect(card.body?.startsWith(READING.overview)).toBe(true)
    expect(card.body).toContain(
      "- **bob on Workers**: The bot now runs on Cloudflare and talks on Discord and Slack. [#32](https://github.com/ranqialabs/workspace/pull/32)",
    )
  })
})
