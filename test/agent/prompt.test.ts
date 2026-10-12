import { expect, test } from "bun:test"

import { explainFailure } from "../../src/agent/prompt"
import type { PipelineStory } from "../../src/news/stories"

test("explaining a failure names the commit, what failed and where to look", () => {
  const story: PipelineStory = {
    kind: "pipeline",
    repo: {
      name: "web",
      fullName: "acme/web",
      url: "https://github.com/acme/web",
      defaultBranch: "main",
    },
    sha: "abc1234def",
    commit: { subject: "fix: login loops", login: "ana" },
    steps: [
      {
        type: "run",
        id: "1",
        workflow: "CI",
        jobs: [
          { name: "lint", outcome: { ok: true, word: "passed" } },
          { name: "test", outcome: { ok: false, word: "failed" } },
        ],
      },
      { type: "deploy", environment: "production", outcome: { ok: false, word: "deploy failed" } },
    ],
  }
  const ask = explainFailure(story)
  expect(ask).toContain(
    'commit abc1234 ("fix: login loops") in acme/web failed: CI / test, deploy to production.',
  )
  expect(ask).toContain("`check_failures` on abc1234def")
  expect(ask).toContain("Do not propose an issue.")
})
