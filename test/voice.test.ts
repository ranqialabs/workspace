import { describe, expect, test } from "bun:test"
import { MockLanguageModelV4 } from "ai/test"

import { changeOf, clean, narratorFor } from "../src/news/voice"
import type { IssueStory, PullStory } from "../src/news/stories"

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

/** A model that answers with `text`, keeping every prompt it was sent. */
function answering(text: string): MockLanguageModelV4 & { prompts: string[] } {
  const prompts: string[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt))
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }
    },
  })
  return Object.assign(model, { prompts })
}

const repo = {
  fullName: "acme/web",
  name: "web",
  url: "https://github.com/acme/web",
  defaultBranch: "main",
}

const issue = (over: Partial<IssueStory> = {}): IssueStory => ({
  kind: "issue",
  repo,
  number: 7,
  title: "Login loops",
  url: "https://github.com/acme/web/issues/7",
  author: "beto",
  assignees: [],
  labels: [],
  status: "open",
  ...over,
})

const pull = (over: Partial<PullStory> = {}): PullStory => ({
  kind: "pull",
  repo,
  number: 9,
  title: "Fix the login redirect",
  url: "https://github.com/acme/web/pull/9",
  author: "beto",
  status: "open",
  reviews: [],
  ...over,
})

describe("what changed", () => {
  test("an issue names who picked it up, or how its state moved", () => {
    expect(changeOf(issue(), issue({ assignees: ["ana"] }))).toBe("assigned to ana")
    expect(changeOf(issue(), issue({ status: "completed" }))).toBe("state open to completed")
  })

  test("a pull request names a new review, or how it ended", () => {
    expect(
      changeOf(issue(), pull({ reviews: [{ login: "ana", verdict: "approved", comments: 0 }] })),
    ).toBe("updated")
    expect(
      changeOf(pull(), pull({ reviews: [{ login: "ana", verdict: "requested", comments: 0 }] })),
    ).toBe("ana was asked to review")
    expect(changeOf(pull(), pull({ status: "merged", closedBy: "anat" }))).toBe(
      "status open to merged",
    )
  })

  test("first news of a story says so", () => {
    expect(changeOf(undefined, issue())).toBe("first news of it")
  })
})

describe("the line", () => {
  test("it comes back as one sentence, without the quotes a model likes", () => {
    expect(clean('  "Ana picked this up."  ')).toBe("Ana picked this up.")
    expect(clean(`\`Beto is on it\nnow\``)).toBe("Beto is on it now")
  })

  test("a model writes it from the facts of the change", async () => {
    const model = answering("Ana picked this up and is on it now.")
    const narrate = narratorFor(model)
    expect(
      await narrate({
        story: issue({ assignees: ["ana"] }),
        previous: issue(),
        pinged: ["ana"],
      }),
    ).toBe("Ana picked this up and is on it now.")
    const prompt = model.prompts[0] ?? ""
    expect(prompt).toContain("assigned to ana")
    expect(prompt).toContain("people told: ana")
  })

  test("without a model it says nothing rather than inventing", async () => {
    expect(await narratorFor(undefined)({ story: issue(), pinged: ["ana"] })).toBeUndefined()
  })
})
