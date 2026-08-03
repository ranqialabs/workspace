"""GitHub webhook payload -> Discord message. Pure functions (payload + Mentions
in, Rendered or None out); add a renderer and register it in RENDERERS."""

from collections.abc import Callable
from typing import NamedTuple, Protocol

import discord

# --- palette & icons (one place to restyle every message) ---

GREEN = 0x2DA44E
GREY = 0x6E7681
BLUE = 0x0969DA
RED = 0xCF222E
PURPLE = 0x8250DF  # merged PRs
BLURPLE = 0x5865F2  # Discord's own colour: our panels, not GitHub's news

BODY_LIMIT = 400  # issue/PR body chars shown in an embed description


class Mentions(Protocol):
    """GitHub login/repo -> Discord mention (backed by the store)."""

    def user(self, github_login: str | None) -> str: ...
    def role(self, repo_full_name: str) -> str | None: ...


class Rendered(NamedTuple):
    content: str | None  # ping text, shown above the embed
    embed: discord.Embed | None
    # entity id; if set, edit the live message in place instead of posting anew
    key: str | None = None
    # when set, this card is one line of a running summary: the live message keeps
    # every field it already had, and this render only adds/replaces its own.
    merge: bool = False


def _ping(*mentions: str | None) -> str | None:
    """Join the real `<@...>`/`<@&...>` mentions (dropping None/plaintext), deduped.
    Discord only notifies from `content`, never from inside an embed."""
    seen: dict[str, None] = {}
    for mention in mentions:
        if mention and mention.startswith("<"):
            seen[mention] = None
    return " ".join(seen) or None


def _body(payload_obj: dict) -> str | None:
    return (payload_obj.get("body") or "")[:BODY_LIMIT] or None


def _labels(issue: dict) -> str:
    return ", ".join(f"`{lbl['name']}`" for lbl in issue.get("labels") or [])


def _embed(
    gh_repo: dict,
    *,
    author: str,
    title: str,
    url: str,
    color: int,
    description: str | None = None,
    when: str | None = None,
) -> discord.Embed:
    """A styled embed with the shared author line, repo footer, and timestamp
    (`when` is an ISO8601 string shown as Discord relative time)."""
    embed = discord.Embed(title=title, url=url, description=description, color=color)
    embed.set_author(name=author, url=gh_repo["html_url"])
    embed.set_footer(text=gh_repo["full_name"])
    if when:
        embed.timestamp = discord.utils.parse_time(when)
    return embed


# --- issues ---


def issue_key(repo_full_name: str, number: int) -> str:
    """The live-message key for an issue. Anything posting an issue card must use
    this, or the webhook that follows will post a second card instead of editing."""
    return f"issue:{repo_full_name}:{number}"


def _issue_embed(payload: dict, m: Mentions) -> discord.Embed:
    issue, gh_repo = payload["issue"], payload["repository"]
    closed = issue.get("state") == "closed"
    if closed:
        completed = issue.get("state_reason") == "completed"
        icon = "✅" if completed else "🚫"
        color = GREEN if completed else GREY
    else:
        icon, color = "🐛", GREEN

    embed = _embed(
        gh_repo,
        author=f"{icon} {'closed' if closed else 'issue'} · {gh_repo['name']}",
        title=f"#{issue['number']} · {issue['title']}",
        url=issue["html_url"],
        description=_body(issue) if not closed else None,
        color=color,
        when=issue.get("updated_at") or issue.get("created_at"),
    )
    embed.add_field(name="Opened by", value=m.user(issue["user"]["login"]), inline=True)
    if assignees := [m.user(a["login"]) for a in issue.get("assignees") or []]:
        embed.add_field(name="Assignees", value=" ".join(assignees), inline=True)
    if labels := _labels(issue):
        embed.add_field(name="Labels", value=labels, inline=False)
    return embed


def _issue_notify(payload: dict, m: Mentions) -> str | None:
    issue, repo = payload["issue"], payload["repository"]["full_name"]
    action = payload.get("action", "")
    if action in ("opened", "reopened"):
        assignees = [m.user(a["login"]) for a in issue.get("assignees") or []]
        return _ping(m.role(repo), *assignees)
    if action == "assigned":
        return _ping(m.user((payload.get("assignee") or {}).get("login")))
    return None  # closed / unassigned — update the card, ping no one


def _issue(payload: dict, m: Mentions) -> Rendered | None:
    """One live message per issue: embed = current state, action = who to notify.
    Unlisted actions (labeled, edited, milestoned...) are noise."""
    if payload.get("action", "") not in _ISSUE_ACTIONS:
        return None
    issue, gh_repo = payload["issue"], payload["repository"]
    key = issue_key(gh_repo["full_name"], issue["number"])
    return Rendered(
        content=_issue_notify(payload, m), embed=_issue_embed(payload, m), key=key
    )


_ISSUE_ACTIONS = frozenset({"opened", "closed", "reopened", "assigned", "unassigned"})


# --- pull requests ---


def _pr_title(pr: dict) -> str:
    return f"#{pr['number']} · {pr['title']}"


def _pr_ready(payload: dict, m: Mentions) -> Rendered:
    pr, gh_repo = payload["pull_request"], payload["repository"]
    embed = _embed(
        gh_repo,
        author=f"📥 PR ready for review · {gh_repo['name']}",
        title=_pr_title(pr),
        url=pr["html_url"],
        description=_body(pr),
        color=GREEN,
        when=pr.get("updated_at"),
    )
    embed.add_field(name="Opened by", value=m.user(pr["user"]["login"]), inline=True)
    return Rendered(content=_ping(m.role(gh_repo["full_name"])), embed=embed)


def _pr_review_requested(payload: dict, m: Mentions) -> Rendered | None:
    # Only individual reviewers for now (requested_team has no reviewer field).
    reviewer = payload.get("requested_reviewer")
    if not reviewer:
        return None
    pr, gh_repo = payload["pull_request"], payload["repository"]
    who = m.user(reviewer["login"])
    embed = _embed(
        gh_repo,
        author=f"👀 Review requested · {gh_repo['name']}",
        title=_pr_title(pr),
        url=pr["html_url"],
        description=f"{m.user(pr['user']['login'])} wants {who} to review",
        color=BLUE,
        when=pr.get("updated_at"),
    )
    return Rendered(content=_ping(who), embed=embed)


def _pr_closed(payload: dict, m: Mentions) -> Rendered:
    pr, gh_repo = payload["pull_request"], payload["repository"]
    merged = pr.get("merged")
    icon, verb, color = ("🟣", "merged", PURPLE) if merged else ("🔴", "closed", RED)
    embed = _embed(
        gh_repo,
        author=f"{icon} PR {verb} · {gh_repo['name']}",
        title=_pr_title(pr),
        url=pr["html_url"],
        color=color,
        when=pr.get("closed_at") or pr.get("updated_at"),
    )
    actor = (payload.get("sender") or {}).get("login")
    embed.add_field(name=verb.capitalize() + " by", value=m.user(actor), inline=True)
    return Rendered(content=_ping(m.user(pr["user"]["login"])), embed=embed)


# action -> renderer; unlisted actions (edited, synchronize, labeled...) are noise.
_PR_ACTIONS: dict[str, Renderer] = {
    "ready_for_review": _pr_ready,
    "review_requested": _pr_review_requested,
    "closed": _pr_closed,
}


def _pull_request(payload: dict, m: Mentions) -> Rendered | None:
    action = payload.get("action", "")
    # "opened" only counts when it's not a draft; then it's the same as ready.
    if action == "opened" and not payload["pull_request"].get("draft"):
        return _pr_ready(payload, m)
    renderer = _PR_ACTIONS.get(action)
    return renderer(payload, m) if renderer else None


def _pull_request_review(payload: dict, m: Mentions) -> Rendered | None:
    if payload.get("action") != "submitted":
        return None
    review, pr, gh_repo = (
        payload["review"],
        payload["pull_request"],
        payload["repository"],
    )
    state = (review.get("state") or "").lower()
    icon = {"approved": "✅", "changes_requested": "🔴"}.get(state, "💬")
    verb = {"approved": "approved", "changes_requested": "requested changes on"}.get(
        state, "commented on"
    )
    pr_author = m.user(pr["user"]["login"])
    embed = _embed(
        gh_repo,
        author=f"{icon} Review · {gh_repo['name']}",
        title=_pr_title(pr),
        url=review.get("html_url") or pr["html_url"],
        description=f"{m.user(review['user']['login'])} {verb} {pr_author}'s PR"
        + (f"\n\n{body}" if (body := _body(review)) else ""),
        color=GREEN if state == "approved" else BLUE,
        when=review.get("submitted_at"),
    )
    return Rendered(content=_ping(pr_author), embed=embed)


# --- the pipeline card (workflows + deploys for one commit) ---
#
# A push runs every matching workflow and each deploy it triggers, so one commit
# produces a handful of events within a minute of each other. Rather than a
# message each, they all render the same keyed card, one field per step, and
# live.py merges each new field into the card already in the channel.
#
# ponytail: we read `workflow_run`, not `check_suite`. A check suite is keyed by
# the *app* that ran it, and all our workflows are GitHub Actions — so three
# suites would arrive claiming the same name and collapse into one line.

# live.py reads a merged card's verdict back off these, so they live beside the
# code that writes them.
PASSED, FAILED, RUNNING = "✅", "❌", "🕒"
STEP_ICONS: dict[bool | None, str] = {True: PASSED, False: FAILED, None: RUNNING}


def pipeline_key(repo_full_name: str, sha: str) -> str:
    """The live-message key for a commit's card. Every step on the same commit
    must use this, or each one posts its own message again."""
    return f"pipeline:{repo_full_name}:{sha}"


def _pipeline_card(
    gh_repo: dict,
    *,
    sha: str,
    step: str,
    detail: str,
    ok: bool | None,
    when: str | None,
    by: str | None = None,
) -> Rendered:
    """One step's line on its commit's card.

    `step` is the field name, and so the step's identity when merged — which is
    why the icon goes in `detail`: reporting twice (queued, then deployed) has to
    land on the same name to replace its own line. `ok=None` means still running,
    which leaves the card's colour to the steps that have finished.
    """
    icon = STEP_ICONS[ok]
    embed = _embed(
        gh_repo,
        author=f"{icon} pipeline · {gh_repo['name']}",
        title=f"{sha[:7]} on {gh_repo.get('default_branch') or 'main'}",
        url=f"{gh_repo['html_url']}/commit/{sha}",
        description=f"by {by}" if by else None,
        color=BLUE if ok is None else GREEN if ok else RED,
        when=when,
    )
    embed.add_field(name=step, value=f"{icon} {detail}", inline=False)
    return Rendered(
        content=None,
        embed=embed,
        key=pipeline_key(gh_repo["full_name"], sha),
        merge=True,
    )


# Anything absent is skipped: cancelled, skipped, stale, neutral and
# action_required say nothing about the code and don't earn a line.
_RUN_CONCLUSIONS: dict[str, tuple[str, bool]] = {
    "success": ("passed", True),
    "failure": ("failed", False),
    "timed_out": ("timed out", False),
    "startup_failure": ("failed to start", False),
}


def _took(started: str | None, ended: str | None) -> str | None:
    """How long a run took, as `44s` or `3m 12s`. None if GitHub didn't say."""
    start, end = discord.utils.parse_time(started), discord.utils.parse_time(ended)
    if start is None or end is None:
        return None
    seconds = round((end - start).total_seconds())
    if seconds < 0:
        return None
    minutes, seconds = divmod(seconds, 60)
    return f"{minutes}m {seconds}s" if minutes else f"{seconds}s"


def _workflow_run(payload: dict, _m: Mentions) -> Rendered | None:
    """One workflow's line on its commit's card, named after the workflow file
    (`docs`, `checks`) and linked to the run — where a failure is diagnosed."""
    if payload.get("action") != "completed":
        return None
    run, gh_repo = payload["workflow_run"], payload["repository"]
    # Only the main line matters; ignore branch/PR runs.
    if run.get("head_branch") != gh_repo.get("default_branch"):
        return None
    verdict = _RUN_CONCLUSIONS.get(run.get("conclusion") or "")
    if verdict is None:
        return None
    word, ok = verdict
    detail = f"[{word}]({run.get('html_url') or gh_repo['html_url']})"
    if took := _took(run.get("run_started_at"), run.get("updated_at")):
        detail += f" in {took}"
    # Same workflow twice on one commit means someone retried it, not that CI ran
    # twice — say so.
    if (attempt := run.get("run_attempt") or 1) > 1:
        detail += f", attempt {attempt}"
    # ponytail: a workflow run carries the git commit author (a name, not a GitHub
    # login), so we can't reliably @mention — show the name as text.
    name = (run.get("head_commit") or {}).get("author", {}).get("name") or "someone"
    return _pipeline_card(
        gh_repo,
        sha=run.get("head_sha", ""),
        step=run.get("name") or "workflow",
        detail=detail,
        ok=ok,
        when=(run.get("head_commit") or {}).get("timestamp"),
        by=name,
    )


# --- deployments (GitHub Pages, Fly, Vercel, ...) ---

# state -> (what to call it, did it finish well). None means still running, which
# is not the same as failed: it leaves the card's colour to the finished steps.
# GitHub's seventh state, `inactive`, is absent because it never arrives: GitHub
# fires no webhook for it. Anything unlisted is skipped rather than guessed at.
_DEPLOY_STATES: dict[str, tuple[str, bool | None]] = {
    "pending": ("deploying", None),
    "in_progress": ("deploying", None),
    "queued": ("queued", None),
    "success": ("deployed", True),
    "failure": ("deploy failed", False),
    "error": ("deploy failed", False),
}


def _deployment_status(payload: dict, _m: Mentions) -> Rendered | None:
    """The `deployment_status` event — a deploy step on its commit's card.

    (We ignore the raw `status` event, which would double-report the same deploy.)
    """
    ds, deployment, gh_repo = (
        payload["deployment_status"],
        payload["deployment"],
        payload["repository"],
    )
    state = (ds.get("state") or "").lower()
    styled = _DEPLOY_STATES.get(state)
    if styled is None:
        return None
    word, ok = styled
    sha = deployment.get("sha", "")
    env = deployment.get("environment") or "deploy"
    where = f"`{env}`"
    if (origin := deployment.get("original_environment")) and origin != env:
        where += f" (from `{origin}`)"
    if (ref := deployment.get("ref")) and ref != sha:
        where += f" at `{ref}`"
    # log_url is current, target_url its deprecated predecessor; the run that
    # triggered the deploy beats both, being the job you'd actually go read.
    run = payload.get("workflow_run") or {}
    live = ds.get("environment_url")
    log_url = run.get("html_url") or ds.get("log_url") or ds.get("target_url")
    detail = f"deploy to {where} — " + (f"[{word}]({live})" if live else word)
    if log_url:
        detail += f" ([logs]({log_url}))"
    if triggered_by := run.get("name"):
        detail += f", by `{triggered_by}`"
    if note := ds.get("description"):
        detail += f"\n{note}"
    return _pipeline_card(
        gh_repo,
        sha=sha,
        # "deploy" in the name so this doesn't read as one more test suite.
        step=f"🚀 deploy: {env}",
        detail=detail,
        ok=ok,
        when=ds.get("updated_at"),
    )


# --- dispatch ---

Renderer = Callable[[dict, Mentions], Rendered | None]

RENDERERS: dict[str, Renderer] = {
    "issues": _issue,
    "pull_request": _pull_request,
    "pull_request_review": _pull_request_review,
    "workflow_run": _workflow_run,
    "deployment_status": _deployment_status,
}


def render(event: str, payload: dict, mentions: Mentions) -> Rendered | None:
    """The message for a webhook event, or None if this event/action is ignored."""
    renderer = RENDERERS.get(event)
    return renderer(payload, mentions) if renderer else None
