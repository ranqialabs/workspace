// The agent's GitHub tools. All of them read; none writes. Filing an issue is
// the File issue button's job, behind a human click, so a confused model can waste
// tokens but never change anything on GitHub.
import { tool } from "ai"
import { z } from "zod"

import type { GitHub } from "../../github/app"

const MAX_FILE_CHARS = 6_000
const MAX_RESULTS = 15
/** Past this a body is pasted logs. */
const MAX_BODY_CHARS = 4_000
/** Past this the shape of a change is already clear. */
const MAX_FILES = 30
const MAX_REVIEWS = 20
const MAX_COMMITS = 10
const MAX_SUMMARY_CHARS = 200
const MAX_ANNOTATION_CHARS = 500

export const GITHUB_INSTRUCTIONS = `\
Ground what you say in the actual code before you say it. Find the files and
symbols people are talking about and read them; cite \`path/to/file.ts:line\` so
the next person can check you. Saying you're not sure beats guessing.

\`search_code\` reads an index that misses uncrawled private repos, so an empty
result is not absence: read the file or directory it would be in and say which
you did. The same holds for a repo's guideline files (\`.github/ISSUE_TEMPLATE\`,
\`CLAUDE.md\`, \`CONTRIBUTING.md\`): reach for them with \`list_dir\` and
\`read_file\` at the path they would be in.

You may read any repository the app was granted, not only the one an issue would
be filed against. \`list_repos\` is what you have; call it before saying a repo
is missing, because what people call a repo in conversation is often not its
name on GitHub.

When someone cites a PR or an issue ("#12", "PR 40", "that webhook PR"), read it
before you answer about it. \`get_issue\` and \`get_pull_request\` take a
number; \`list_issues\` and \`list_pull_requests\` find the number.

A question about people ("any issue for me?", "what's free to take?") is a
filter on \`list_issues\`, not a listing to sift by eye.

For something broken: \`check_runs\` on a branch or sha says what CI thinks,
\`check_failures\` gives that run's error messages, \`compare_refs\` says what
is in one ref and not another, and \`recent_commits\` with \`get_commit\` find
the commit behind a regression. No tool returns patches; \`read_file\` at a ref
reads the code itself.`

export function clipped(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n...[truncated at ${limit} chars]`
}

function body(text: string | null | undefined, limit = MAX_BODY_CHARS): string {
  return clipped((text ?? "").trim(), limit)
}

function logins(users: ({ login: string } | null)[] | null | undefined): string[] {
  return (users ?? []).flatMap((user) => (user === null ? [] : [user.login]))
}

function labelNames(labels: (string | { name?: string })[] | undefined): string[] {
  return (labels ?? []).flatMap((label) => {
    const name = typeof label === "string" ? label : label.name
    return name === undefined || name === "" ? [] : [name]
  })
}

/** A note for a page that came back full: there may be more behind it. */
function fullPage(count: number, noun: string, page: number): string | undefined {
  if (count < MAX_RESULTS) return undefined
  return `This is page ${page} and it is full, so there may be more ${noun}. Ask for page ${page + 1} or narrow the filters before saying this is all of them.`
}

/** GitHub's errors carry the whole request; the model needs the status and the reason. */
async function plainly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      const reason = error.message.split("\n")[0]?.slice(0, 300) ?? ""
      const said =
        error.status === 404
          ? `GitHub found nothing there (404): ${reason}`
          : `GitHub answered ${error.status}: ${reason}`
      throw new Error(said, { cause: error })
    }
    throw error
  }
}

const repoArg = z.string().describe('"owner/name", or just "name" for a repo in the org')
const pageArg = z.number().int().min(1).default(1)
const stateArg = z.enum(["open", "closed", "all"]).default("open")

function changedFile(file: {
  filename: string
  status?: string
  additions?: number
  deletions?: number
}) {
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }
}

function commitRow(commit: {
  sha: string
  commit: { message: string; author?: { name?: string; date?: string } | null }
  // GitHub sends an empty object for an author it could not match to an account.
  author?: { login?: string } | null
}) {
  return {
    sha: commit.sha.slice(0, 8),
    subject: commit.commit.message.split("\n")[0] ?? "",
    author: commit.author?.login ?? commit.commit.author?.name ?? "",
    date: commit.commit.author?.date,
  }
}

export function githubTools(github: GitHub, org: string) {
  function split(repo: string): { owner: string; repo: string } {
    const [owner, name] = repo.includes("/") ? repo.split("/", 2) : [org, repo]
    return { owner: owner ?? org, repo: name ?? repo }
  }

  return {
    list_repos: tool({
      description:
        "The repos this app can read. A repo absent here is one you cannot read; call it before saying a repo is missing.",
      inputSchema: z.object({ page: pageArg }),
      execute: ({ page }) =>
        plainly(async () => {
          const { data } = await github.rest.apps.listReposAccessibleToInstallation({
            per_page: MAX_RESULTS,
            page,
          })
          const repos = data.repositories.map((repo) => ({
            repo: repo.full_name,
            description: body(repo.description, MAX_SUMMARY_CHARS),
            private: repo.private,
            archived: repo.archived,
            default_branch: repo.default_branch,
            pushed_at: repo.pushed_at,
          }))
          return { repos, note: fullPage(repos.length, "repos", page) }
        }),
    }),

    search_code: tool({
      description:
        "Search code across the org's default branches. An index, not a grep: no regex, files over 384KB skipped, about 10 calls a minute. A hit is trustworthy; no hits is not.",
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) =>
        plainly(async () => {
          const { data } = await github.rest.search.code({
            q: `${query} org:${org}`,
            per_page: MAX_RESULTS,
          })
          const found = data.items.map((item) => ({
            repo: item.repository.full_name,
            path: item.path,
          }))
          const note =
            found.length > 0
              ? undefined
              : "Nothing matched. This index skips repos it has not crawled, so this is not evidence the code is absent. Check with list_dir and read_file."
          return { found, note }
        }),
    }),

    read_file: tool({
      description: `One file's text, at a branch, tag or sha if given. Clipped at ${MAX_FILE_CHARS} characters.`,
      inputSchema: z.object({ repo: repoArg, path: z.string(), ref: z.string().optional() }),
      execute: ({ repo, path, ref }) =>
        plainly(async () => {
          const { data } = await github.rest.repos.getContent({ ...split(repo), path, ref })
          if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
            throw new Error(`${path} is not a file; use list_dir`)
          }
          const bytes = Uint8Array.fromBase64(data.content.replaceAll("\n", ""))
          return clipped(new TextDecoder().decode(bytes), MAX_FILE_CHARS)
        }),
    }),

    list_dir: tool({
      description: "A directory's entries. The repo root when path is empty.",
      inputSchema: z.object({
        repo: repoArg,
        path: z.string().default(""),
        ref: z.string().optional(),
      }),
      execute: ({ repo, path, ref }) =>
        plainly(async () => {
          const { data } = await github.rest.repos.getContent({ ...split(repo), path, ref })
          if (!Array.isArray(data)) throw new Error(`${path} is a file; use read_file`)
          return data.map((entry) => ({ name: entry.name, type: entry.type }))
        }),
    }),

    repo_labels: tool({
      description: "The labels a repo has. An issue's labels come only from these.",
      inputSchema: z.object({ repo: repoArg }),
      execute: ({ repo }) =>
        plainly(async () => {
          const { data } = await github.rest.issues.listLabelsForRepo({
            ...split(repo),
            per_page: 100,
          })
          return data.map((label) => label.name)
        }),
    }),

    recent_commits: tool({
      description: `The last ${MAX_COMMITS} commits on the default branch, or touching one path.`,
      inputSchema: z.object({ repo: repoArg, path: z.string().optional() }),
      execute: ({ repo, path }) =>
        plainly(async () => {
          const { data } = await github.rest.repos.listCommits({
            ...split(repo),
            path,
            per_page: MAX_COMMITS,
          })
          return data.map(commitRow)
        }),
    }),

    get_commit: tool({
      description: "One commit: its message, author, size and the files it touched.",
      inputSchema: z.object({ repo: repoArg, sha: z.string() }),
      execute: ({ repo, sha }) =>
        plainly(async () => {
          const { data } = await github.rest.repos.getCommit({ ...split(repo), ref: sha })
          return {
            ...commitRow(data),
            message: body(data.commit.message),
            additions: data.stats?.additions,
            deletions: data.stats?.deletions,
            url: data.html_url,
            files: (data.files ?? []).slice(0, MAX_FILES).map(changedFile),
          }
        }),
    }),

    compare_refs: tool({
      description: "What is in head and not in base. Both take a branch, tag or sha.",
      inputSchema: z.object({ repo: repoArg, base: z.string(), head: z.string() }),
      execute: ({ repo, base, head }) =>
        plainly(async () => {
          const { data } = await github.rest.repos.compareCommitsWithBasehead({
            ...split(repo),
            basehead: `${base}...${head}`,
            per_page: MAX_FILES,
          })
          return {
            status: data.status,
            ahead_by: data.ahead_by,
            behind_by: data.behind_by,
            commits: data.commits.slice(0, MAX_RESULTS).map(commitRow),
            files: (data.files ?? []).slice(0, MAX_FILES).map(changedFile),
          }
        }),
    }),

    similar_issues: tool({
      description:
        "Issues in a repo whose words match, open or closed. For spotting a duplicate before drafting.",
      inputSchema: z.object({ repo: repoArg, query: z.string() }),
      execute: ({ repo, query }) =>
        plainly(async () => {
          const { owner, repo: name } = split(repo)
          const { data } = await github.rest.search.issuesAndPullRequests({
            q: `${query} repo:${owner}/${name} is:issue`,
            per_page: MAX_RESULTS,
          })
          return data.items.map((issue) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            url: issue.html_url,
          }))
        }),
    }),

    list_issues: tool({
      description: `A repo's issues, ${MAX_RESULTS} a page; filter rather than list-then-sift. assignee, creator and mentioned take a GitHub login (the github field on teammates); assignee "none" is what nobody took and "*" what somebody did. labels is comma-separated and ANDed.`,
      inputSchema: z.object({
        repo: repoArg,
        state: stateArg,
        assignee: z.string().optional(),
        creator: z.string().optional(),
        mentioned: z.string().optional(),
        labels: z.string().optional(),
        sort: z.enum(["created", "updated", "comments"]).default("created"),
        page: pageArg,
      }),
      execute: ({ repo, page, ...filters }) =>
        plainly(async () => {
          const { data } = await github.rest.issues.listForRepo({
            ...split(repo),
            ...filters,
            per_page: MAX_RESULTS,
            page,
          })
          const issues = data
            .filter((issue) => issue.pull_request === undefined)
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              author: issue.user?.login,
              assignees: logins(issue.assignees),
              labels: labelNames(issue.labels),
              comments: issue.comments,
              updated_at: issue.updated_at,
              url: issue.html_url,
            }))
          const note =
            issues.length === 0
              ? "No issue matched these filters. Say which filters you used rather than that the repo has no issues."
              : fullPage(data.length, "issues", page)
          return { issues, note }
        }),
    }),

    get_issue: tool({
      description: "One issue in full: description, state, author, assignees and labels.",
      inputSchema: z.object({ repo: repoArg, number: z.number().int() }),
      execute: ({ repo, number }) =>
        plainly(async () => {
          const { data } = await github.rest.issues.get({ ...split(repo), issue_number: number })
          return {
            number: data.number,
            title: data.title,
            state: data.state,
            state_reason: data.state_reason,
            author: data.user?.login,
            assignees: logins(data.assignees),
            labels: labelNames(data.labels),
            comments: data.comments,
            created_at: data.created_at,
            closed_at: data.closed_at,
            url: data.html_url,
            body: body(data.body),
          }
        }),
    }),

    list_pull_requests: tool({
      description:
        "A repo's pull requests, newest first. No author filter: read author on the rows.",
      inputSchema: z.object({ repo: repoArg, state: stateArg, page: pageArg }),
      execute: ({ repo, state, page }) =>
        plainly(async () => {
          const { data } = await github.rest.pulls.list({
            ...split(repo),
            state,
            per_page: MAX_RESULTS,
            page,
          })
          const pulls = data.map((pull) => ({
            number: pull.number,
            title: pull.title,
            state: pull.state,
            draft: pull.draft,
            author: pull.user?.login,
            head: pull.head.ref,
            base: pull.base.ref,
            labels: labelNames(pull.labels),
            url: pull.html_url,
          }))
          return { pulls, note: fullPage(pulls.length, "pull requests", page) }
        }),
    }),

    get_pull_request: tool({
      description:
        "One PR in full. merged and mergeable_state tell shipped from waiting; read them before saying which.",
      inputSchema: z.object({ repo: repoArg, number: z.number().int() }),
      execute: ({ repo, number }) =>
        plainly(async () => {
          const { data } = await github.rest.pulls.get({ ...split(repo), pull_number: number })
          return {
            number: data.number,
            title: data.title,
            state: data.state,
            draft: data.draft,
            merged: data.merged,
            mergeable: data.mergeable,
            mergeable_state: data.mergeable_state,
            author: data.user.login,
            assignees: logins(data.assignees),
            reviewers: logins(data.requested_reviewers),
            labels: labelNames(data.labels),
            head: data.head.ref,
            base: data.base.ref,
            commits: data.commits,
            changed_files: data.changed_files,
            additions: data.additions,
            deletions: data.deletions,
            created_at: data.created_at,
            merged_at: data.merged_at,
            url: data.html_url,
            body: body(data.body),
          }
        }),
    }),

    pull_request_files: tool({
      description: `The files a PR touches and by how much, at most ${MAX_FILES}.`,
      inputSchema: z.object({ repo: repoArg, number: z.number().int() }),
      execute: ({ repo, number }) =>
        plainly(async () => {
          const { data } = await github.rest.pulls.listFiles({
            ...split(repo),
            pull_number: number,
            per_page: MAX_FILES,
          })
          return data.map(changedFile)
        }),
    }),

    pull_request_reviews: tool({
      description:
        "A PR's reviews: who approved, who asked for changes, what they said, and the notes left on lines of code.",
      inputSchema: z.object({ repo: repoArg, number: z.number().int() }),
      execute: ({ repo, number }) =>
        plainly(async () => {
          const target = { ...split(repo), pull_number: number, per_page: MAX_REVIEWS }
          const [reviews, comments] = await Promise.all([
            github.rest.pulls.listReviews(target),
            github.rest.pulls.listReviewComments(target),
          ])
          return {
            reviews: reviews.data.map((review) => ({
              reviewer: review.user?.login,
              state: review.state,
              submitted_at: review.submitted_at,
              body: body(review.body),
            })),
            comments: comments.data.map((comment) => ({
              author: comment.user.login,
              path: comment.path,
              line: comment.line,
              body: body(comment.body, MAX_ANNOTATION_CHARS),
            })),
          }
        }),
    }),

    check_runs: tool({
      description: "What CI says about a branch, tag or sha: each check and how it ended.",
      inputSchema: z.object({ repo: repoArg, ref: z.string() }),
      execute: ({ repo, ref }) =>
        plainly(async () => {
          const { data } = await github.rest.checks.listForRef({
            ...split(repo),
            ref,
            per_page: MAX_RESULTS * 2,
          })
          return data.check_runs.map((run) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            url: run.html_url,
          }))
        }),
    }),

    check_failures: tool({
      description:
        "A failed check's error messages, by its id from check_runs: the annotations it left and its summary.",
      inputSchema: z.object({ repo: repoArg, check_run_id: z.number().int() }),
      execute: ({ repo, check_run_id }) =>
        plainly(async () => {
          const target = { ...split(repo), check_run_id }
          const [run, annotations] = await Promise.all([
            github.rest.checks.get(target),
            github.rest.checks.listAnnotations({ ...target, per_page: MAX_RESULTS }),
          ])
          return {
            name: run.data.name,
            conclusion: run.data.conclusion,
            summary: body(run.data.output.summary),
            text: body(run.data.output.text),
            annotations: annotations.data.map((note) => ({
              path: note.path,
              line: note.start_line,
              level: note.annotation_level,
              message: body(note.message, MAX_ANNOTATION_CHARS),
            })),
          }
        }),
    }),
  }
}
