import { describe, expect, test } from "bun:test"

import { draftCard, IssueDraft } from "../../src/agent/draft"
import { footnote, Progress } from "../../src/agent/progress"

describe("progress", () => {
  test("a call reads as its verb, its repo and what identifies it", () => {
    const progress = new Progress()
    progress.started("1", "get_issue", { repo: "acme/web", number: 12 })
    progress.started("2", "search_code", { query: "useAuth", page: 2 })
    progress.finished("1")
    expect(progress.card("Looking").body).toBe(
      "🐛 `web` reading issue #12\n⏳ searching code `useAuth`",
    )
  })

  test("a failure keeps its first line as the reason", () => {
    const progress = new Progress()
    progress.started("1", "read_file", { path: "x" })
    progress.finished("1", new Error("GitHub found nothing there (404)\nstack"))
    expect(progress.card("").body).toBe("⚠️ reading `x` · GitHub found nothing there (404)")
  })

  test("an unknown tool and garbage arguments still make a line", () => {
    const progress = new Progress()
    progress.started("1", "mystery", "not an object")
    expect(progress.card("").body).toBe("⏳ mystery")
  })

  test("past twelve calls the oldest fold into a count", () => {
    const progress = new Progress()
    for (let index = 0; index < 15; index += 1) progress.started(String(index), "list_dir", {})
    const body = progress.card("").body ?? ""
    expect(body.split("\n")).toHaveLength(13)
    expect(body).toStartWith("… 3 earlier steps")
  })

  test("the footnote counts tokens compactly", () => {
    expect(footnote({ inputTokens: 12_400, outputTokens: 800, cachedTokens: 9_000 })).toBe(
      "13.2k tokens (12.4k in, 9k cached, 800 out)",
    )
  })
})

describe("draft card", () => {
  const draft = IssueDraft.parse({
    title: "fix: login loops",
    body: "Steps…",
    repo: "acme/web",
    questions: ["Which browser?"],
  })

  test("a proposed draft shows its confidence and open questions", () => {
    const card = draftCard(draft, { kind: "proposed" })
    expect(card.footer).toBe("confidence: medium · not submitted yet")
    expect(card.fields?.find((field) => field.name === "Open questions")?.value).toBe(
      "- Which browser?",
    )
  })

  test("a submitted draft links the issue it became", () => {
    const card = draftCard(draft, { kind: "submitted", number: 7, url: "https://x/7" })
    expect(card).toMatchObject({
      tone: "green",
      url: "https://x/7",
      kicker: "📝 issue #7 · acme/web",
    })
  })
})
