"""Everything the agent may read from GitHub: code, issues, pull requests, CI.

Read-only by construction: no create, update, merge or comment tool, so a
confused model can waste tokens but cannot change anything. Filing an issue is a
human pressing Submit in Discord (`bridge.cogs.issues`).

These wrap githubkit rather than the GitHub MCP server, which would mean a PAT, a
second identity, and 47 tool definitions in context.
"""

import base64

from githubkit.exception import RequestFailed
from githubkit.utils import UNSET
from pydantic_ai import FunctionToolset, RunContext, ToolFailed, ToolReturn

from bridge.agent.tools._shared import (
    MAX_ANNOTATION_CHARS,
    MAX_COMMITS,
    MAX_FILE_CHARS,
    MAX_FILES,
    MAX_RESULTS,
    MAX_REVIEWS,
    Deps,
    Sort,
    State,
    author_name,
    body,
    changed_file,
    clipped,
    commit_row,
    held_back,
    label_names,
    login,
    logins,
    reports_failure,
    stamp,
)

INSTRUCTIONS = """\
Ground what you say in the actual code before you say it. Find the files and
symbols people are talking about and read them; cite `path/to/file.py:line` so
the next person can check you. Saying you're not sure beats guessing.

`search_code` reads an index that misses uncrawled private repos, so an empty
result is not absence: read the file or directory it would be in and say which
you did. A string you already know from this repo needs no search at all.

You may read any repository in the org, not just the one an issue would be filed
against — follow a bug across a client and its service if that is where it leads.

When someone cites a PR or an issue — "#12", "PR 40", "aquela PR do webhook" —
go read it before you answer about it. `get_issue` and `get_pull_request` take a
number; `list_issues` and `list_pull_requests` find the number when they only
described it. Answering from what the conversation says a PR contains, when you
could have read the PR, is how you end up confidently wrong.

A question about people — "tem issue pra mim?", "o que está livre pra pegar?" —
is a filter, not a listing to sift by eye. Describing a subset of a listing you
never asked GitHub for states as fact something you only assumed.

For diagnosing something broken: `check_runs` on a branch or sha says what CI
thinks, `check_failures` gives that run's actual error messages, and
`compare_refs` says what is in one ref and not another. A regression usually has
a commit behind it — `recent_commits` for the shas, `get_commit` for what one did.

No tool returns patches. To read the code itself, `read_file` at the head ref or
the sha.
"""


def _applied(given: dict[str, str | None]) -> str:
    """The filters that were actually sent, as `key=value` text."""
    return ", ".join(f"{key}={value}" for key, value in given.items() if value)


def _nothing_matched(state: str, given: dict[str, str | None], page: int) -> str:
    """An empty listing, said as the filters that emptied it — a bare empty list
    reads as "this repo has no issues"."""
    filters = _applied(given)
    if not filters and page <= 1:
        return f"This repo has no {state} issues."
    where = f" on page {page}" if page > 1 else ""
    narrowed = f" matching {filters}" if filters else ""
    return (
        f"No {state} issues{narrowed}{where} — a filtered result, not an empty "
        "board. Drop a filter and look again; a login comes from `teammates` and a "
        "label from `repo_labels`."
    )


def toolset() -> FunctionToolset[Deps]:
    """The GitHub reading tools, as one registerable group."""
    tools = FunctionToolset[Deps](instructions=INSTRUCTIONS)

    # --- code ---

    @tools.tool
    @reports_failure
    async def search_code(
        ctx: RunContext[Deps], query: str
    ) -> ToolReturn[list[dict[str, str]]]:
        """Find code across the org by keyword. Finds things; never proves absence.

        This is an index, not a grep: it only sees each repo's default branch,
        skips files over 384KB, is rate-limited to ~10 calls/minute, and does not
        do regex. Use it to locate a symbol or string, then read_file to confirm.

        A hit is trustworthy. No hits is not: an unindexed private repo answers
        exactly like an empty one. To show something is absent, list_dir and
        read_file the place it would be.
        """
        resp = await ctx.deps.github.rest.search.async_code(
            q=f"{query} org:{ctx.deps.org}", per_page=MAX_RESULTS
        )
        found = [
            {"repo": item.repository.full_name, "path": item.path}
            for item in resp.parsed_data.items
        ]
        # The warning has to arrive with the empty list, not only in the docstring:
        # no hits is the one answer a model will happily read as proof.
        return ToolReturn(
            found,
            content=None
            if found
            else (
                "Nothing matched. This index skips repos it has not crawled, so "
                "this is not evidence the code is absent. Check by reading the "
                "repo directly with list_dir and read_file."
            ),
        )

    @tools.tool
    @reports_failure
    async def read_file(
        ctx: RunContext[Deps], repo: str, path: str, ref: str | None = None
    ) -> str:
        """Read a file from a repo, optionally at a branch, tag, or commit."""
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.repos.async_get_content(
            owner, name, path, **({"ref": ref} if ref else {})
        )
        data = resp.parsed_data
        content = getattr(data, "content", None)
        if content is None:  # a directory, or a symlink/submodule
            raise ToolFailed(f"{path} is not a file; use list_dir")
        text = base64.b64decode(content).decode("utf-8", "replace")
        return clipped(text, MAX_FILE_CHARS)

    @tools.tool
    @reports_failure
    async def list_dir(
        ctx: RunContext[Deps], repo: str, path: str = ""
    ) -> list[dict[str, str]]:
        """List a directory, to get oriented before reading files."""
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.repos.async_get_content(owner, name, path)
        data = resp.parsed_data
        if not isinstance(data, list):
            raise ToolFailed(f"{path} is a file; use read_file")
        return [{"name": e.name, "type": e.type} for e in data]

    @tools.tool
    @reports_failure
    async def repo_labels(ctx: RunContext[Deps], repo: str) -> list[str]:
        """The labels this repo actually has. Don't propose any others."""
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.issues.async_list_labels_for_repo(
            owner, name, per_page=100
        )
        return [label.name for label in resp.parsed_data]

    # --- history ---

    @tools.tool
    @reports_failure
    async def recent_commits(
        ctx: RunContext[Deps], repo: str, path: str | None = None
    ) -> list[dict[str, str]]:
        """Recent commits, optionally only those touching one path."""
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.repos.async_list_commits(
            owner, name, per_page=MAX_COMMITS, **({"path": path} if path else {})
        )
        return [commit_row(c) for c in resp.parsed_data]

    @tools.tool
    @reports_failure
    async def get_commit(
        ctx: RunContext[Deps], repo: str, sha: str
    ) -> dict[str, object]:
        """One commit: its message, author, and which files it touched.

        `recent_commits` gives you the shas, and a regression usually has one of
        them in it.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.repos.async_get_commit(owner, name, sha)
        commit = resp.parsed_data
        author = commit.commit.author
        return {
            "sha": commit.sha[:8],
            "message": body(commit.commit.message),
            "author": author_name(author),
            "date": stamp(getattr(author, "date", None)),
            "additions": commit.stats.additions if commit.stats else None,
            "deletions": commit.stats.deletions if commit.stats else None,
            "url": commit.html_url,
            "files": [changed_file(f) for f in (commit.files or ())[:MAX_FILES]],
        }

    @tools.tool
    @reports_failure
    async def compare_refs(
        ctx: RunContext[Deps], repo: str, base: str, head: str
    ) -> dict[str, object]:
        """What is in `head` and not in `base`: the commits and files between two
        refs. Both take a branch, tag, or sha."""
        owner, name = ctx.deps.repo(repo)
        # Paged server-side: the default page carries up to 250 commits and 300
        # files, each with a patch we never read.
        resp = await ctx.deps.github.rest.repos.async_compare_commits(
            owner, name, f"{base}...{head}", per_page=MAX_FILES
        )
        diff = resp.parsed_data
        return {
            # A branch can be ahead and behind at once, which is what tells a
            # diverged branch from a stale one.
            "status": diff.status,
            "ahead_by": diff.ahead_by,
            "behind_by": diff.behind_by,
            "total_commits": diff.total_commits,
            "commits": [commit_row(c) for c in (diff.commits or ())[:MAX_RESULTS]],
            "files": [changed_file(f) for f in (diff.files or ())[:MAX_FILES]],
        }

    # --- issues ---

    @tools.tool
    @reports_failure
    async def similar_issues(
        ctx: RunContext[Deps], repo: str, query: str
    ) -> ToolReturn[list[dict[str, object]]]:
        """Search a repo's existing issues, to catch duplicates before drafting.

        Words, not a listing: `list_issues` is what filters a board by state or by
        who holds what.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.search.async_issues_and_pull_requests(
            q=f"{query} repo:{owner}/{name} is:issue", per_page=MAX_RESULTS
        )
        found = resp.parsed_data
        rows: list[dict[str, object]] = [
            {
                "number": item.number,
                "title": item.title,
                "state": item.state,
                "url": item.html_url,
            }
            for item in found.items
        ]
        # This search reaches only indexed issues, so no hits is weak evidence — the
        # same trap `search_code` warns about. `total_count` is exact, unlike a
        # listing's `rel="next"`.
        caveat = None
        if not rows:
            caveat = (
                f"No indexed issue in {name} matched. That is not proof there is no "
                "duplicate; a recently filed one may not be indexed yet."
            )
        elif found.total_count > len(rows):
            caveat = (
                f"{found.total_count} issues matched and the {len(rows)} closest are "
                "here. Narrow the query if none of them is the duplicate."
            )
        return ToolReturn(rows, content=caveat)

    @tools.tool
    @reports_failure
    async def list_issues(
        ctx: RunContext[Deps],
        repo: str,
        state: State = "open",
        assignee: str | None = None,
        creator: str | None = None,
        mentioned: str | None = None,
        labels: str | None = None,
        sort: Sort = "created",
        page: int = 1,
    ) -> ToolReturn[list[dict[str, object]]]:
        """A repo's issues. A page holds 15, so filter rather than list-then-sift.

        - `assignee`: a login from `teammates`, `"none"` for what nobody has taken,
          `"*"` for what somebody has.
        - `creator`: who opened it. `mentioned`: who is @-ed in it.
        - `labels`: comma-separated and ANDed, each matching `repo_labels`.
        - `sort`: `created`, `updated`, or `comments`.

        Say who holds an issue from the row's `assignees`, not from the filter you
        passed. `similar_issues` searches by words; `get_issue` reads one in full.
        """
        owner, name = ctx.deps.repo(repo)
        page = max(page, 1)
        given = {
            "assignee": assignee,
            "creator": creator,
            "mentioned": mentioned,
            "labels": labels,
        }
        try:
            resp = await ctx.deps.github.rest.issues.async_list_for_repo(
                owner,
                name,
                state=state,
                sort=sort,
                per_page=MAX_RESULTS,
                page=page,
                # UNSET, not None, which would filter on a literal null.
                assignee=assignee or UNSET,
                creator=creator or UNSET,
                mentioned=mentioned or UNSET,
                labels=labels or UNSET,
            )
        except RequestFailed as exc:
            # A login nobody has is a 422, not an empty list, and githubkit's own
            # message for it is the response repr.
            if exc.response.status_code != 422:
                raise
            raise ToolFailed(
                f"GitHub rejected these filters: {_applied(given) or state}. "
                "`assignee`, `creator` and `mentioned` take a login from "
                '`teammates`, not a name; only "none" and "*" are special.'
            ) from exc
        # Truthiness, not `is None`: githubkit leaves an absent field as `UNSET`,
        # which is not None, so an identity test drops every real issue too.
        issues = [item for item in resp.parsed_data if not item.pull_request]
        rows: list[dict[str, object]] = [
            {
                "number": item.number,
                "title": item.title,
                "state": item.state,
                "author": login(item.user),
                "assignees": logins(item.assignees),
                "labels": label_names(item.labels),
                "comments": item.comments,
                "updated_at": stamp(item.updated_at),
                "url": item.html_url,
            }
            for item in issues
        ]
        # Silence is what gets a partial board quoted as the whole one, and an empty
        # list read as an empty board.
        caveat = (
            _nothing_matched(state, given, page)
            if not rows
            else held_back(resp, "issues", page)
        )
        return ToolReturn(rows, content=caveat)

    @tools.tool
    @reports_failure
    async def get_issue(
        ctx: RunContext[Deps], repo: str, number: int
    ) -> dict[str, object]:
        """One issue in full: its description, state, author, and labels."""
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.issues.async_get(owner, name, number)
        issue = resp.parsed_data
        return {
            "number": issue.number,
            "title": issue.title,
            "state": issue.state,
            "state_reason": issue.state_reason,
            "author": login(issue.user),
            "assignees": logins(issue.assignees),
            "labels": label_names(issue.labels),
            "comments": issue.comments,
            "created_at": stamp(issue.created_at),
            "closed_at": stamp(issue.closed_at),
            "url": issue.html_url,
            "body": body(issue.body),
        }

    # --- pull requests ---

    @tools.tool
    @reports_failure
    async def list_pull_requests(
        ctx: RunContext[Deps], repo: str, state: State = "open", page: int = 1
    ) -> ToolReturn[list[dict[str, object]]]:
        """A repo's pull requests, newest first. `state` is `open`, `closed`, `all`.

        For "what's in review", or to find the number of a PR someone described but
        didn't cite. `get_pull_request` then reads one in full. This endpoint takes
        no author or assignee filter: to find whose PR one is, read `author` on the
        rows.
        """
        owner, name = ctx.deps.repo(repo)
        page = max(page, 1)
        resp = await ctx.deps.github.rest.pulls.async_list(
            owner, name, state=state, per_page=MAX_RESULTS, page=page
        )
        rows: list[dict[str, object]] = [
            {
                "number": pr.number,
                "title": pr.title,
                "state": pr.state,
                "draft": pr.draft,
                "author": login(pr.user),
                "head": pr.head.ref,
                "base": pr.base.ref,
                "labels": label_names(pr.labels),
                "url": pr.html_url,
            }
            for pr in resp.parsed_data
        ]
        return ToolReturn(rows, content=held_back(resp, "pull requests", page))

    @tools.tool
    @reports_failure
    async def get_pull_request(
        ctx: RunContext[Deps], repo: str, number: int
    ) -> dict[str, object]:
        """One PR in full: description, state, branches, and how big the change is.

        `merged` and `mergeable_state` are the difference between "it shipped" and
        "it is waiting" — read them before saying which. For what the PR changes,
        follow with `pull_request_files`; for the discussion, `pull_request_reviews`.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.pulls.async_get(owner, name, number)
        pr = resp.parsed_data
        return {
            "number": pr.number,
            "title": pr.title,
            "state": pr.state,
            "draft": pr.draft,
            "merged": pr.merged,
            # Null while GitHub recomputes it, which is not "conflicted".
            "mergeable": pr.mergeable,
            "mergeable_state": pr.mergeable_state,
            "author": login(pr.user),
            "assignees": logins(pr.assignees),
            "reviewers": logins(pr.requested_reviewers),
            "labels": label_names(pr.labels),
            "head": pr.head.ref,
            "base": pr.base.ref,
            "commits": pr.commits,
            "changed_files": pr.changed_files,
            "additions": pr.additions,
            "deletions": pr.deletions,
            "comments": pr.comments,
            "review_comments": pr.review_comments,
            "created_at": stamp(pr.created_at),
            "merged_at": stamp(pr.merged_at),
            "closed_at": stamp(pr.closed_at),
            "url": pr.html_url,
            "body": body(pr.body),
        }

    @tools.tool
    @reports_failure
    async def pull_request_files(
        ctx: RunContext[Deps], repo: str, number: int
    ) -> list[dict[str, object]]:
        """Which files a PR touches, and by how much. At most 30 are listed.

        Use this to find where to look, then `read_file` on the branch
        (`get_pull_request` gives you `head`) to read the code itself.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.pulls.async_list_files(
            owner, name, number, per_page=MAX_FILES
        )
        return [changed_file(f) for f in resp.parsed_data]

    @tools.tool
    @reports_failure
    async def pull_request_reviews(
        ctx: RunContext[Deps], repo: str, number: int
    ) -> list[dict[str, object]]:
        """The reviews on a PR: who approved, who asked for changes, and what they said.

        The verdicts and their summaries, for why a PR is blocked. The notes
        attached to code are in `pull_request_comments`.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.pulls.async_list_reviews(
            owner, name, number, per_page=MAX_REVIEWS
        )
        return [
            {
                "reviewer": login(review.user),
                "state": review.state,
                "submitted_at": stamp(review.submitted_at),
                "body": body(review.body),
            }
            for review in resp.parsed_data
        ]

    @tools.tool
    @reports_failure
    async def pull_request_comments(
        ctx: RunContext[Deps], repo: str, number: int
    ) -> list[dict[str, object]]:
        """Line-level review comments on a PR: the file, the line, and the remark.

        Where the specific objections live — "this races", "wrong branch here".
        `pull_request_reviews` gives the verdicts; this gives the notes on code.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.pulls.async_list_review_comments(
            owner, name, number, per_page=MAX_REVIEWS
        )
        return [
            {
                "author": login(c.user),
                "path": c.path,
                # The line in the file as it stands now; null on an outdated
                # comment whose lines the branch has since moved.
                "line": c.line,
                "body": body(c.body),
            }
            for c in resp.parsed_data
        ]

    # --- CI ---

    @tools.tool
    @reports_failure
    async def check_runs(
        ctx: RunContext[Deps], repo: str, ref: str
    ) -> list[dict[str, object]]:
        """CI results for a branch, tag, or commit sha — what passed and what failed.

        `ref` takes a branch name (`get_pull_request` gives you `head`) or a sha. A
        failing run's actual error messages come from `check_failures`.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.checks.async_list_for_ref(
            owner, name, ref, per_page=MAX_RESULTS
        )
        return [
            {
                "id": run.id,
                "name": run.name,
                "status": run.status,
                # Null until the run finishes; `status` says whether it has.
                "conclusion": run.conclusion,
                "started_at": stamp(run.started_at),
                "url": run.html_url,
            }
            for run in resp.parsed_data.check_runs
        ]

    @tools.tool
    @reports_failure
    async def check_failures(
        ctx: RunContext[Deps], repo: str, check_run_id: int
    ) -> list[dict[str, object]]:
        """Why one check run failed: the file, the line, and the error text.

        What CI actually reported — the failing assertion, the type error, the lint
        message. Take `check_run_id` from `check_runs`. An empty list means the run
        left no annotations, not that nothing failed; the run's `url` has the log.
        """
        owner, name = ctx.deps.repo(repo)
        resp = await ctx.deps.github.rest.checks.async_list_annotations(
            owner, name, check_run_id, per_page=MAX_RESULTS
        )
        return [
            {
                "path": a.path,
                "line": a.start_line,
                "level": a.annotation_level,
                "title": a.title,
                "message": body(a.message, MAX_ANNOTATION_CHARS),
            }
            for a in resp.parsed_data
        ]

    return tools
