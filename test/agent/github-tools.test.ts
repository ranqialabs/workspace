import { describe, expect, test } from "bun:test"

import { githubTools } from "../../src/agent/tools/github"
import type { GitHub } from "../../src/github/app"
import { type Calls, fakeGitHub } from "./github"

async function call(
  github: GitHub,
  name: keyof ReturnType<typeof githubTools>,
  input: object,
): Promise<unknown> {
  const chosen = githubTools(github, "acme")[name]
  return chosen.execute?.(input as never, { toolCallId: "t", messages: [], context: {} })
}

/** The message a call fails with; fails the test if the call succeeds. */
async function failure(pending: Promise<unknown>): Promise<string> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(outcome instanceof Error)) throw new Error("expected the call to fail")
  return outcome.message
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

describe("files", () => {
  test("read_file decodes the content and resolves a short repo name in the org", async () => {
    const calls: Calls = []
    const content = btoa("export const a = 1\n")
    const github = fakeGitHub({ "repos.getContent": { type: "file", content } }, calls)
    expect(await call(github, "read_file", { repo: "web", path: "a.ts" })).toBe(
      "export const a = 1\n",
    )
    expect(calls[0]?.params).toMatchObject({ owner: "acme", repo: "web", path: "a.ts" })
  })

  test("read_file clips a long file and says where", async () => {
    const content = btoa("x".repeat(7000))
    const github = fakeGitHub({ "repos.getContent": { type: "file", content } })
    const text = await call(github, "read_file", { repo: "acme/web", path: "big" })
    expect(String(text)).toEndWith("...[truncated at 6000 chars]")
  })

  test("reading a directory as a file points at list_dir", async () => {
    const github = fakeGitHub({ "repos.getContent": [{ name: "src", type: "dir" }] })
    expect(await failure(call(github, "read_file", { repo: "web", path: "" }))).toContain(
      "use list_dir",
    )
    expect(await call(github, "list_dir", { repo: "web", path: "" })).toEqual([
      { name: "src", type: "dir" },
    ])
  })
})

describe("issues", () => {
  test("list_issues leaves pull requests out and passes the filters through", async () => {
    const calls: Calls = []
    const github = fakeGitHub(
      {
        "issues.listForRepo": [
          { number: 1, title: "Bug", state: "open", assignees: [], labels: ["bug"] },
          { number: 2, title: "PR", state: "open", pull_request: {} },
        ],
      },
      calls,
    )
    const result = await call(github, "list_issues", { repo: "web", assignee: "ana", page: 1 })
    expect(result).toMatchObject({ issues: [{ number: 1, labels: ["bug"] }], note: undefined })
    expect(calls[0]?.params).toMatchObject({ assignee: "ana", per_page: 15, page: 1 })
  })

  test("an empty list says the filters found nothing, not that there are no issues", async () => {
    const github = fakeGitHub({ "issues.listForRepo": [] })
    const result = await call(github, "list_issues", { repo: "web", page: 1 })
    expect(result).toMatchObject({ note: expect.stringContaining("No issue matched") })
  })

  test("a full page warns that there may be more", async () => {
    const page = Array.from({ length: 15 }, (_, index) => ({ number: index, title: "t" }))
    const github = fakeGitHub({ "issues.listForRepo": page })
    const result = await call(github, "list_issues", { repo: "web", page: 2 })
    expect(result).toMatchObject({ note: expect.stringContaining("Ask for page 3") })
  })
})

describe("errors", () => {
  test("a GitHub 404 reaches the model as one plain line", async () => {
    const github = fakeGitHub({
      "issues.get": httpError(404, "Not Found - https://docs.github.com/rest\nmore"),
    })
    expect(await failure(call(github, "get_issue", { repo: "web", number: 9 }))).toBe(
      "GitHub found nothing there (404): Not Found - https://docs.github.com/rest",
    )
  })

  test("search_code warns that no hits is not absence", async () => {
    const github = fakeGitHub({ "search.code": { items: [] } })
    const result = await call(github, "search_code", { query: "useThing" })
    expect(result).toMatchObject({ found: [], note: expect.stringContaining("not evidence") })
  })
})
