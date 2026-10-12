import { describe, expect, test } from "bun:test"

import { Progress } from "../../src/agent/progress"
import { progressCard, stepLine, tokens } from "../../src/ui/progress"

describe("progress lines", () => {
  test("a call reads as a sentence, in the present while it runs and the past once done", () => {
    const progress = new Progress()
    progress.started("1", "get_issue", { repo: "acme/web", number: 12 })
    progress.started("2", "search_code", { query: "useAuth", page: 2 })
    progress.finished("1")
    expect(progressCard(progress.steps, { kind: "working" }).body).toBe(
      "✅ Read issue #12 in web\n⏳ Searching code for `useAuth`",
    )
  })

  test("a failed call says why, on one line", () => {
    const progress = new Progress()
    progress.started("1", "read_file", { repo: "acme/web", path: "x.ts" })
    progress.finished("1", new Error("GitHub found nothing there (404)\nstack"))
    expect(stepLine(progress.steps[0]!)).toBe(
      "⚠️ Read `x.ts` in web: GitHub found nothing there (404)",
    )
  })

  test("a comparison names both ends", () => {
    const line = stepLine({
      id: "1",
      tool: "compare_refs",
      input: { repo: "web", base: "main", head: "fix/login" },
      state: "done",
    })
    expect(line).toBe("✅ Compared `main...fix/login` in web")
  })

  test("an unknown tool or odd input still makes a line", () => {
    const line = stepLine({ id: "1", tool: "mystery", input: "not an object", state: "running" })
    expect(line).toBe("⏳ mystery")
  })

  test("only the last twelve calls show, after a count of the rest", () => {
    const progress = new Progress()
    for (let index = 0; index < 15; index += 1) progress.started(String(index), "list_dir", {})
    const lines = (progressCard(progress.steps, { kind: "working" }).body ?? "").split("\n")
    expect(lines).toHaveLength(13)
    expect(lines[0]).toBe("… 3 earlier")
  })
})

describe("the card", () => {
  test("its colour and title follow how the run ended", () => {
    expect(progressCard([], { kind: "thinking" })).toMatchObject({
      tone: "blue",
      title: "Thinking…",
    })
    expect(progressCard([], { kind: "answered" }).tone).toBe("green")
    expect(progressCard([], { kind: "stopped", by: "Ana" })).toMatchObject({
      tone: "grey",
      title: "Stopped by Ana",
    })
    expect(progressCard([], { kind: "failed", reason: "rate\nlimited" })).toMatchObject({
      tone: "red",
      title: "Failed: rate limited",
    })
  })

  test("the footer counts tokens compactly", () => {
    expect(tokens({ inputTokens: 12_400, outputTokens: 800, cachedTokens: 9_000 })).toBe(
      "13.2k tokens (12.4k in, 9k cached, 800 out)",
    )
  })
})
