"""GitHub webhook payload -> Discord message. Pure functions (payload + Mentions
in, Rendered or None out); add a renderer and register it in RENDERERS."""

import re
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

# Hiding a marker inside text a human reads. live.py stamps an entity key into a
# footer with this, and a merging card marks the fields and headline it owns. It
# lives here because live.py imports render.py, not the other way round.
_SENTINEL = "⁣"  # zero-width; marks where the hidden payload starts
_SHIFT = 0xE0000  # tag/PUA plane — codepoints here render as nothing


def encode(payload: str) -> str:
    """`payload` as codepoints that render as nothing, behind a sentinel."""
    return _SENTINEL + "".join(chr(_SHIFT + ord(c)) for c in payload)


def decode(text: str | None) -> str | None:
    """The hidden payload in `text`, or None if there isn't one."""
    if not text or _SENTINEL not in text:
        return None
    return "".join(chr(ord(c) - _SHIFT) for c in text.split(_SENTINEL, 1)[1])


def decode_visible(text: str) -> str:
    """`text` without any hidden payload — what a reader actually sees."""
    return text.split(_SENTINEL, 1)[0]


# Commit subject chars on a pipeline card's title. Discord caps a title at 256
# and the sha and branch sit in front of it, so this stays well clear.
_SUBJECT_LIMIT = 160


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
#
# A step's line is named the way GitHub names a check, `workflow / job`. The two
# events that report one run each know only half of that and arrive in either
# order, so they carry the run id as their identity and merge_step_name joins the
# halves. live.py drives the merge but the naming rules are GitHub's, so they live
# here — as do the icons, which it reads a merged card's verdict back off.
PASSED, FAILED, RUNNING = "✅", "❌", "🕒"
STEP_ICONS: dict[bool | None, str] = {True: PASSED, False: FAILED, None: RUNNING}

_WORKFLOW, _JOB = "workflow", "job"  # which half of `workflow / job` a name is


def step_key(name: str) -> str:
    """What identifies a step across the events reporting it: the run id hidden in
    its name, else the name itself (enough for a deploy, reported by one event)."""
    hidden = decode(name)
    return hidden.split(":", 1)[0] if hidden else name


def merge_step_name(newer: str, older: str) -> str:
    """One `workflow / job` name from the two events that report a run, in
    GitHub's order whichever arrived first. A name already joined is kept."""
    new_name, old_name = decode_visible(newer), decode_visible(older)
    if new_name == old_name:
        return newer
    if new_name in old_name.split(" / "):
        return older  # the older name already spells out both halves
    if old_name in new_name.split(" / "):
        return newer
    run, _, half = (decode(newer) or "").partition(":")
    workflow, job = (old_name, new_name) if half == _JOB else (new_name, old_name)
    return f"{workflow} / {job}" + (encode(run) if run else "")


def headlined(card: discord.Embed) -> bool:
    """Whether a card brought its own headline, marked when it was built."""
    return (decode(card.title) or "") == "headline"


def pipeline_key(repo_full_name: str, sha: str) -> str:
    """The live-message key for a commit's card. Every step on the same commit
    must use this, or each one posts its own message again."""
    return f"pipeline:{repo_full_name}:{sha}"


def _subject(message: str | None) -> str:
    """A commit message's first line, short enough to sit in an embed title."""
    subject = (message or "").strip().split("\n", 1)[0].strip()
    return (
        subject
        if len(subject) <= _SUBJECT_LIMIT
        else subject[: _SUBJECT_LIMIT - 1] + "…"
    )


def _pipeline_card(
    gh_repo: dict,
    *,
    sha: str,
    step: str,
    detail: str,
    ok: bool | None,
    when: str | None,
    by: str | None = None,
    subject: str | None = None,
    run_id: int | None = None,
    half: str = "",
) -> Rendered:
    """One step's line on its commit's card.

    `step` names the line and the icon goes in `detail`, so a step reporting twice
    (queued, then deployed) replaces its own line rather than adding one. `run_id`
    and `half` identify a line whose name arrives in two pieces; see
    `merge_step_name`. `ok=None` means still running, which leaves the card's
    colour to the steps that have finished.
    """
    icon = STEP_ICONS[ok]
    short = sha[:7]
    # The subject says what the commit *did*, so when an event carries one it takes
    # the title and the sha steps back to the byline. Deploys don't carry one, so
    # such a card leads with the sha until merge_into adopts a titled one.
    if subject:
        title = subject + encode("headline")
        description = f"`{short}` by {by}" if by else f"`{short}`"
    else:
        title = f"{short} on {gh_repo.get('default_branch') or 'main'}"
        description = f"by {by}" if by else None
    embed = _embed(
        gh_repo,
        author=f"{icon} pipeline · {gh_repo['name']}",
        title=title,
        url=f"{gh_repo['html_url']}/commit/{sha}",
        description=description,
        color=BLUE if ok is None else GREEN if ok else RED,
        when=when,
    )
    name = step if run_id is None else step + encode(f"{run_id}:{half}")
    embed.add_field(name=name, value=f"{icon} {detail}", inline=False)
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


def _workflow_run(payload: dict, m: Mentions) -> Rendered | None:
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
    # ponytail: the commit's own author is a git name, not a GitHub login, so it
    # can't be mapped to a Discord account. The run's actor *is* a login — prefer
    # it and @mention, falling back to the git name as plain text.
    head = run.get("head_commit") or {}
    if login := (run.get("actor") or {}).get("login"):
        name = m.user(login)
    else:
        name = head.get("author", {}).get("name") or "someone"
    return _pipeline_card(
        gh_repo,
        sha=run.get("head_sha", ""),
        # Only the workflow half of the name; check_run supplies the job.
        step=run.get("name") or "workflow",
        run_id=run.get("id"),
        half=_WORKFLOW,
        detail=detail,
        ok=ok,
        when=head.get("timestamp"),
        by=name,
        subject=_subject(head.get("message")),
    )


def _run_id_from(url: str | None) -> int | None:
    """The run id in an Actions job URL (`.../actions/runs/<id>/job/<id>`)."""
    match = re.search(r"/actions/runs/(\d+)", url or "")
    return int(match.group(1)) if match else None


def _check_run(payload: dict, _m: Mentions) -> Rendered | None:
    """A job's half of its run's line: the job name (`prek`, `bot`), which
    `_workflow_run` completes with the workflow it belongs to."""
    if payload.get("action") != "completed":
        return None
    run, gh_repo = payload["check_run"], payload["repository"]
    suite = run.get("check_suite") or {}
    if suite.get("head_branch") != gh_repo.get("default_branch"):
        return None
    verdict = _RUN_CONCLUSIONS.get(run.get("conclusion") or "")
    if verdict is None:
        return None
    word, ok = verdict
    detail = f"[{word}]({run.get('html_url') or gh_repo['html_url']})"
    if took := _took(run.get("started_at"), run.get("completed_at")):
        detail += f" in {took}"
    return _pipeline_card(
        gh_repo,
        sha=run.get("head_sha") or suite.get("head_sha", ""),
        step=run.get("name") or "job",
        run_id=_run_id_from(run.get("details_url") or run.get("html_url")),
        half=_JOB,
        detail=detail,
        ok=ok,
        when=run.get("completed_at"),
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
    # log_url is current, target_url its deprecated predecessor; the run that
    # triggered the deploy beats both, being the job you'd actually go read.
    run = payload.get("workflow_run") or {}
    live = ds.get("environment_url")
    log_url = run.get("html_url") or ds.get("log_url") or ds.get("target_url")
    # The name carries the environment and the title the branch, so the line adds
    # only the verdict and where to click — plus anything unusual, which the name
    # alone would misrepresent.
    detail = f"[{word}]({live})" if live else word
    if log_url:
        detail += f" ([logs]({log_url}))"
    if (origin := deployment.get("original_environment")) and origin != env:
        detail += f", promoted from `{origin}`"
    if (ref := deployment.get("ref")) and ref not in (
        sha,
        gh_repo.get("default_branch"),
    ):
        detail += f" at `{ref}`"
    if note := ds.get("description"):
        detail += f"\n{note}"
    return _pipeline_card(
        gh_repo,
        sha=sha,
        # Named for the environment alone: the triggering workflow rides on
        # `workflow_run`, which the queued event can arrive without, and a name
        # that changed between two reports would leave two lines instead of one.
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
    "check_run": _check_run,
    "deployment_status": _deployment_status,
}


def render(event: str, payload: dict, mentions: Mentions) -> Rendered | None:
    """The message for a webhook event, or None if this event/action is ignored."""
    renderer = RENDERERS.get(event)
    return renderer(payload, mentions) if renderer else None
