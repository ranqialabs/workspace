import { describe, expect, test } from "bun:test"

import { Progress } from "../../src/agent/progress"
import { answerText, liveText, stepLine, tokens } from "../../src/ui/progress"

describe("progress lines", () => {
  test("a call reads as a sentence, in the present while it runs and the past once done", () => {
    const progress = new Progress()
    progress.started("1", "get_issue", { repo: "acme/web", number: 12 })
    progress.started("2", "search_code", { query: "useAuth", page: 2 })
    progress.finished("1")
    expect(progress.steps.map(stepLine)).toEqual([
      "✅ Read issue #12 in web",
      "⏳ Searching code for `useAuth`",
    ])
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
})

describe("the live message", () => {
  test("the thinking, the answer and the call in flight, in the order they happen", () => {
    const progress = new Progress()
    progress.reasoned("checking auth.ts")
    progress.started("1", "read_file", { repo: "acme/web", path: "src/auth.ts" })
    expect(liveText(progress, 2000)).toBe(
      "> 💭 checking auth.ts\n\n⏳ Reading `src/auth.ts` in web",
    )
  })

  test("it opens with a sign of life and drops the activity line once the answer starts", () => {
    const progress = new Progress()
    expect(liveText(progress, 2000)).toBe("💭 Thinking…")
    progress.started("1", "list_dir", {})
    progress.finished("1")
    expect(liveText(progress, 2000)).toBe("✅ Listed")
    progress.wrote("It's in `auth.ts`.")
    expect(liveText(progress, 2000)).toBe("It's in `auth.ts`.")
  })

  test("the thinking keeps its tail, since only the newest part is worth reading", () => {
    const progress = new Progress()
    progress.reasoned("a".repeat(500))
    const text = liveText(progress, 2000)
    expect(text.startsWith("> 💭 …")).toBe(true)
    expect(text.length).toBe(405)
  })

  test("a message never passes what the platform takes", () => {
    const progress = new Progress()
    progress.wrote("x".repeat(5000))
    expect(liveText(progress, 2000)).toHaveLength(2000)
    expect(liveText(progress, 2000).endsWith("x")).toBe(true)
  })
})

describe("the final message", () => {
  test("the thinking is gone and one line says what the answer used", () => {
    const progress = new Progress()
    progress.reasoned("checking auth.ts")
    progress.wrote("It's in `src/auth.ts`.")
    progress.started("1", "read_file", { repo: "acme/web", path: "src/auth.ts" })
    progress.finished("1")
    expect(
      answerText(
        progress,
        { kind: "answered" },
        { inputTokens: 12_400, outputTokens: 800, cachedTokens: 9_000 },
        "deepseek-v4-flash",
      ),
    ).toBe(
      "It's in `src/auth.ts`.\n\n✅ 1 tool call · 13.2k tokens (12.4k in, 9k cached, 800 out) · $0.0010",
    )
  })

  test("a stopped or failed run says who or why, and still counts what it used", () => {
    expect(answerText(new Progress(), { kind: "stopped", by: "Ana" })).toBe("⚪ Stopped by Ana")
    expect(answerText(new Progress(), { kind: "failed", reason: "rate\nlimited" })).toBe(
      "❌ Failed: rate limited",
    )
    expect(
      answerText(
        new Progress(),
        { kind: "drafted" },
        { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
      ),
    ).toBe("📝 Drafted an issue · 120 tokens (100 in, 40 cached, 20 out)")
  })

  test("a failed call is counted, and an unknown model shows no price", () => {
    const progress = new Progress()
    progress.started("1", "read_file", { path: "x.ts" })
    progress.finished("1", new Error("404"))
    progress.started("2", "list_dir", {})
    progress.finished("2")
    expect(
      answerText(
        progress,
        { kind: "answered" },
        { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
        "someone-elses-model",
      ),
    ).toBe("✅ 2 tool calls (1 failed) · 120 tokens (100 in, 20 out)")
  })

  test("the footer counts tokens compactly", () => {
    expect(tokens({ inputTokens: 12_400, outputTokens: 800, cachedTokens: 9_000 })).toBe(
      "13.2k tokens (12.4k in, 9k cached, 800 out)",
    )
  })
})
