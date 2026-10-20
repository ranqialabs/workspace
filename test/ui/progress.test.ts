import { describe, expect, test } from "bun:test"

import { Progress } from "../../src/agent/progress"
import { answerText, liveText, stepLine } from "../../src/ui/progress"
import { FakeChat } from "../fake-chat"

const chat = new FakeChat("discord")

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
  test("the thinking, the answer and the calls, in the order they happen", () => {
    const progress = new Progress()
    progress.reasoned("checking auth.ts")
    progress.started("1", "read_file", { repo: "acme/web", path: "src/auth.ts" })
    expect(liveText(progress, chat)).toBe(
      "-# 💭 checking auth.ts\n\n-# ⏳ Reading `src/auth.ts` in web",
    )
  })

  test("it opens with a sign of life, quietly", () => {
    expect(liveText(new Progress(), chat)).toBe("-# 💭 Thinking…")
  })

  test("the thinking goes away once the answer starts, and the calls stay", () => {
    const progress = new Progress()
    progress.reasoned("checking auth.ts")
    progress.started("1", "list_dir", {})
    progress.finished("1")
    progress.wrote("It's in `auth.ts`.")
    expect(liveText(progress, chat)).toBe("It's in `auth.ts`.\n\n-# ✅ Listed")
  })

  test("the thinking keeps its tail, since only the newest part is worth reading", () => {
    const progress = new Progress()
    progress.reasoned("a".repeat(500))
    const text = liveText(progress, chat)
    expect(text.startsWith("-# 💭 …")).toBe(true)
    expect(text.length).toBe(166)
  })

  test("only the last few calls are shown", () => {
    const progress = new Progress()
    for (const id of ["1", "2", "3", "4"]) {
      progress.started(id, "list_dir", { path: id })
      progress.finished(id)
    }
    expect(liveText(progress, chat)).toBe("-# ✅ Listed `2`\n-# ✅ Listed `3`\n-# ✅ Listed `4`")
  })

  test("a message never passes what the platform takes", () => {
    const progress = new Progress()
    progress.wrote("x".repeat(5000))
    expect(liveText(progress, chat)).toHaveLength(2000)
    expect(liveText(progress, chat).endsWith("x")).toBe(true)
  })
})

describe("the final message", () => {
  test("the thinking is gone and one quiet line says what the answer used", () => {
    const progress = new Progress()
    progress.reasoned("checking auth.ts")
    progress.wrote("It's in `src/auth.ts`.")
    progress.started("1", "read_file", { repo: "acme/web", path: "src/auth.ts" })
    progress.finished("1")
    expect(
      answerText(
        progress,
        { kind: "answered" },
        chat,
        { inputTokens: 12_400, outputTokens: 800, cachedTokens: 9_000 },
        "deepseek-v4-flash",
      ),
    ).toBe("It's in `src/auth.ts`.\n\n-# ✅ 1 call · 12.4k in · 800 out · $0.0010")
  })

  test("a stopped or failed run says who or why, and still counts what it used", () => {
    expect(answerText(new Progress(), { kind: "stopped", by: "Ana" }, chat)).toBe(
      "-# ⚪ Stopped by Ana",
    )
    expect(answerText(new Progress(), { kind: "failed", reason: "rate\nlimited" }, chat)).toBe(
      "-# ❌ Failed: rate limited",
    )
    expect(
      answerText(new Progress(), { kind: "drafted" }, chat, {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
      }),
    ).toBe("-# 📝 Drafted an issue · 100 in · 20 out")
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
        chat,
        { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
        "someone-elses-model",
      ),
    ).toBe("-# ✅ 2 calls (1 failed) · 100 in · 20 out")
  })
})
