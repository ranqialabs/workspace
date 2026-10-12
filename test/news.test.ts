import { describe, expect, test } from "bun:test"

import type { Mentions } from "../src/ui/card"
import { draw, pingText } from "../src/ui/news"
import { changeFor, type Ping, type Story } from "../src/news/stories"

const repository = {
  name: "web",
  full_name: "acme/web",
  html_url: "https://github.com/acme/web",
  default_branch: "main",
}

const mentions: Mentions = {
  person: (login) => ({ ana: "<@1>", bia: "<@2>" })[login],
  group: (repo) => (repo === "acme/web" ? "<@&9>" : undefined),
}

/** Plays deliveries in order onto one story, as the workspace does. */
function play(...deliveries: [string, unknown][]): { story: Story; pings: Ping[][] } {
  let story: Story | undefined
  const pings: Ping[][] = []
  for (const [event, payload] of deliveries) {
    const change = changeFor(event, payload)
    if (change === undefined) throw new Error(`${event} was ignored`)
    const applied = change.apply(story)
    story = applied.story
    pings.push(applied.ping)
  }
  if (story === undefined) throw new Error("no deliveries")
  return { story, pings }
}

const issue = (action: string, extra: object = {}) => ({
  action,
  issue: {
    number: 7,
    title: "Login loops",
    html_url: "https://github.com/acme/web/issues/7",
    body: "Steps:\n1. log in",
    state: "open",
    user: { login: "ana" },
    assignees: [{ login: "bia" }],
    labels: [{ name: "bug" }],
    updated_at: "2026-10-12T10:00:00Z",
    ...extra,
  },
  repository,
})

describe("issues", () => {
  test("an opened issue pings the repo's group and its assignees", () => {
    const { story, pings } = play(["issues", issue("opened")])
    expect(pingText(pings[0] ?? [], mentions)).toBe("<@&9> <@2>")
    const card = draw(story, mentions)
    expect(card.kicker).toBe("🐛 Open issue in web")
    expect(card.title).toBe("Login loops #7")
    expect(card.body).toBe("Steps:\n1. log in")
    expect(card.fields).toEqual([
      { name: "Opened by", value: "<@1>", inline: true },
      { name: "Assignees", value: "<@2>", inline: true },
      { name: "Labels", value: "`bug`", inline: false },
    ])
  })

  test("closing as completed turns the card purple and pings no one", () => {
    const { story, pings } = play(
      ["issues", issue("opened")],
      ["issues", issue("closed", { state: "closed", state_reason: "completed" })],
    )
    expect(pings[1]).toEqual([])
    const card = draw(story, mentions)
    expect(card.kicker).toBe("🐛 Closed issue in web")
    expect(card.tone).toBe("purple")
    expect(card.body).toBeUndefined()
  })

  test("closing as not planned greys it out", () => {
    const { story } = play([
      "issues",
      issue("closed", { state: "closed", state_reason: "not_planned" }),
    ])
    expect(draw(story, mentions).tone).toBe("grey")
  })

  test("an assignment pings the new assignee only", () => {
    const { pings } = play(["issues", { ...issue("assigned"), assignee: { login: "ana" } }])
    expect(pings[0]).toEqual([{ login: "ana" }])
  })

  test("labels and edits are noise", () => {
    expect(changeFor("issues", issue("labeled"))).toBeUndefined()
    expect(changeFor("issues", issue("edited"))).toBeUndefined()
  })

  test("someone bob does not know is named in code, not mentioned", () => {
    const { story } = play(["issues", issue("opened", { user: { login: "zed" } })])
    expect(draw(story, mentions).fields?.[0]?.value).toBe("`zed`")
  })

  test("a payload missing what bob reads is dropped", () => {
    expect(changeFor("issues", { action: "opened", repository })).toBeUndefined()
    expect(changeFor("star", { action: "created" })).toBeUndefined()
  })
})

const pull = (action: string, extra: object = {}, pr: object = {}) => ({
  action,
  pull_request: {
    number: 12,
    title: "Fix login",
    html_url: "https://github.com/acme/web/pull/12",
    body: "Fixes #7",
    draft: false,
    merged: false,
    user: { login: "ana" },
    updated_at: "2026-10-12T11:00:00Z",
    ...pr,
  },
  repository,
  ...extra,
})

const review = (login: string, state: string) => ({
  action: "submitted",
  review: { state, user: { login }, submitted_at: "2026-10-12T12:00:00Z" },
  pull_request: pull("").pull_request,
  repository,
})

describe("pull requests", () => {
  test("a draft is not news until it is ready", () => {
    expect(changeFor("pull_request", pull("opened", {}, { draft: true }))).toBeUndefined()
    const { pings } = play(["pull_request", pull("ready_for_review")])
    expect(pings[0]).toEqual([{ repo: "acme/web" }])
  })

  test("one card follows the PR from review request to merge", () => {
    const { story, pings } = play(
      ["pull_request", pull("opened")],
      ["pull_request", pull("review_requested", { requested_reviewer: { login: "bia" } })],
      ["pull_request_review", review("bia", "commented")],
      ["pull_request_review", review("bia", "commented")],
      ["pull_request_review", review("bia", "approved")],
      ["pull_request", pull("closed", { sender: { login: "bia" } }, { merged: true })],
    )
    expect(pings.map((ping) => pingText(ping, mentions))).toEqual([
      "<@&9>",
      "<@2>",
      "<@1>",
      "<@1>",
      "<@1>",
      "<@1>",
    ])
    const card = draw(story, mentions)
    expect(card.kicker).toBe("🔀 Merged pull request in web")
    expect(card.tone).toBe("purple")
    expect(card.fields).toEqual([
      { name: "Opened by", value: "<@1>", inline: true },
      { name: "Merged by", value: "<@2>", inline: true },
      { name: "Reviews", value: "✅ Approved by <@2>, with 2 comments", inline: false },
    ])
  })

  test("commenting on your own PR notifies no one", () => {
    const { pings } = play(["pull_request_review", review("ana", "commented")])
    expect(pings[0]).toEqual([])
  })

  test("a team review request is skipped", () => {
    expect(changeFor("pull_request", pull("review_requested"))).toBeUndefined()
  })
})

const sha = "1ab46d1c0ffee"

const run = (conclusion: string, extra: object = {}) => ({
  action: "completed",
  workflow_run: {
    id: 99,
    name: "checks",
    html_url: "https://github.com/acme/web/actions/runs/99",
    head_sha: sha,
    head_branch: "main",
    conclusion,
    run_attempt: 1,
    run_started_at: "2026-10-12T10:00:00Z",
    updated_at: "2026-10-12T10:03:12Z",
    actor: { login: "ana" },
    head_commit: { message: "fix: stop the login loop\n\nbody", timestamp: "2026-10-12T09:59:00Z" },
    ...extra,
  },
  repository,
})

const job = (name: string, conclusion: string) => ({
  action: "completed",
  check_run: {
    name,
    head_sha: sha,
    html_url: `https://github.com/acme/web/actions/runs/99/job/${name}`,
    details_url: `https://github.com/acme/web/actions/runs/99/job/${name}`,
    conclusion,
    started_at: "2026-10-12T10:00:00Z",
    completed_at: "2026-10-12T10:00:44Z",
    check_suite: { head_branch: "main" },
  },
  repository,
})

const deploy = (state: string, extra: object = {}) => ({
  deployment_status: {
    state,
    environment_url: "https://web.acme.dev",
    log_url: "https://github.com/acme/web/actions/runs/100",
    updated_at: "2026-10-12T10:05:00Z",
    ...extra,
  },
  deployment: { sha, ref: "main", environment: "production" },
  repository,
})

describe("pipelines", () => {
  test("a job arriving before its run is named once the run names the workflow", () => {
    const { story } = play(["check_run", job("lint", "success")], ["workflow_run", run("success")])
    const card = draw(story, mentions)
    expect(card.title).toBe("fix: stop the login loop")
    expect(card.body).toBe(
      "`1ab46d1` by <@1>\n✅ checks / lint [passed](https://github.com/acme/web/actions/runs/99/job/lint) in 44s",
    )
    expect(card.tone).toBe("green")
  })

  test("without a commit the card leads with the sha", () => {
    const { story } = play(["check_run", job("lint", "success")])
    expect(draw(story, mentions).title).toBe("1ab46d1 on main")
  })

  test("a run without jobs shows its own line, with the retry", () => {
    const { story } = play(["workflow_run", run("failure", { run_attempt: 2 })])
    expect(draw(story, mentions).body).toBe(
      "`1ab46d1` by <@1>\n❌ checks [failed](https://github.com/acme/web/actions/runs/99) in 3m 12s, attempt 2",
    )
  })

  test("a deploy replaces its own line as it moves along", () => {
    const { story } = play(
      ["workflow_run", run("success")],
      ["deployment_status", deploy("in_progress")],
      ["deployment_status", deploy("success")],
    )
    const card = draw(story, mentions)
    expect(card.body?.split("\n").at(-1)).toBe(
      "✅ 🚀 production [deployed](https://web.acme.dev), [logs](https://github.com/acme/web/actions/runs/100)",
    )
    expect(card.body?.split("\n")).toHaveLength(3)
  })

  test("one failed job keeps the card red while the others pass", () => {
    const { story } = play(
      ["check_run", job("lint", "failure")],
      ["check_run", job("test", "success")],
      ["deployment_status", deploy("queued")],
    )
    const card = draw(story, mentions)
    expect(card.tone).toBe("red")
    expect(card.kicker).toBe("🚦 Checks failed in web")
  })

  test("a re-run that passes clears the red", () => {
    const { story } = play(
      ["check_run", job("lint", "failure")],
      ["check_run", job("lint", "success")],
    )
    expect(draw(story, mentions).tone).toBe("green")
  })

  test("a running deploy turns the card blue", () => {
    const { story } = play(
      ["check_run", job("lint", "success")],
      ["deployment_status", deploy("pending")],
    )
    expect(draw(story, mentions).tone).toBe("blue")
  })

  test("branches other than the default and cancelled runs are skipped", () => {
    expect(changeFor("workflow_run", run("success", { head_branch: "feature" }))).toBeUndefined()
    expect(changeFor("workflow_run", run("cancelled"))).toBeUndefined()
    expect(changeFor("deployment_status", deploy("inactive"))).toBeUndefined()
  })
})
