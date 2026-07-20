"""Turn GitHub webhook payloads into Discord messages.

Pure functions: a payload plus a `Mentions` resolver in, a `Rendered` (content +
embed) or `None` out. No network, no discord client — so each event is trivially
testable. The cog (cogs/notifications.py) owns registration and sending; this
module owns *what a message looks like*.

To handle a new event or action, add a renderer and register it in `RENDERERS`.
"""

from collections.abc import Callable
from typing import NamedTuple, Protocol

import discord

# --- palette & icons (one place to restyle every message) ---

GREEN = 0x2DA44E
GREY = 0x6E7681
BLUE = 0x0969DA
RED = 0xCF222E
PURPLE = 0x8250DF  # merged PRs

BODY_LIMIT = 400  # issue/PR body chars shown in an embed description


class Mentions(Protocol):
    """How to turn GitHub logins/repos into Discord mentions (backed by the store)."""

    def user(self, github_login: str | None) -> str: ...
    def role(self, repo_full_name: str) -> str | None: ...


class Rendered(NamedTuple):
    content: str | None  # plain text (e.g. a role ping), shown above the embed
    embed: discord.Embed | None
    # A stable id for the entity this message is about (issue, deploy). When set,
    # the cog edits the last recent message for this key instead of posting anew,
    # so a fast-changing entity (deploy pending→done) stays one live message.
    key: str | None = None


def _ping(*mentions: str | None) -> str | None:
    """Join the mentions that will actually notify, into embed-external content.

    Discord only notifies from a message's `content`, never from inside an embed.
    So whoever must be pinged goes here. Keeps only real `<@…>`/`<@&…>` mentions
    (drops `None` and plain-text `` `login` `` fallbacks), de-duplicated in order.
    """
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
    """A styled embed with the shared author line, repo footer, and timestamp.

    `author` is the "🐛 New issue" style header; `when` is an ISO8601 string from
    the payload (created_at/updated_at) shown as Discord's relative time.
    """
    embed = discord.Embed(title=title, url=url, description=description, color=color)
    embed.set_author(name=author, url=gh_repo["html_url"])
    embed.set_footer(text=gh_repo["full_name"])
    if when:
        embed.timestamp = discord.utils.parse_time(when)
    return embed


# --- issues ---


_ISSUE_ACTIONS = frozenset({"opened", "closed", "reopened", "assigned", "unassigned"})


def _issue(payload: dict, m: Mentions) -> Rendered | None:
    """One live message per issue: the embed reflects the *current* state, so any
    tracked action just re-renders it. The action only decides who to notify."""
    action = payload.get("action", "")
    if action not in _ISSUE_ACTIONS:
        return None  # labeled, edited, milestoned… — noise

    issue, gh_repo = payload["issue"], payload["repository"]
    closed = issue.get("state") == "closed"
    if closed:
        completed = issue.get("state_reason") == "completed"
        icon, header = ("✅", "closed") if completed else ("🚫", "closed")
        color = GREEN if completed else GREY
    else:
        icon, header, color = "🐛", "issue", GREEN

    embed = _embed(
        gh_repo,
        author=f"{icon} {header} · {gh_repo['name']}",
        title=f"#{issue['number']} · {issue['title']}",
        url=issue["html_url"],
        description=_body(issue) if not closed else None,
        color=color,
        when=issue.get("updated_at") or issue.get("created_at"),
    )
    embed.add_field(name="Opened by", value=m.user(issue["user"]["login"]), inline=True)
    assignee_mentions = [m.user(a["login"]) for a in issue.get("assignees") or []]
    if assignee_mentions:
        embed.add_field(
            name="Assignees", value=" ".join(assignee_mentions), inline=True
        )
    if labels := _labels(issue):
        embed.add_field(name="Labels", value=labels, inline=False)

    # Who to notify depends on the action, not the state.
    if action in ("opened", "reopened"):
        notify = _ping(m.role(gh_repo["full_name"]), *assignee_mentions)
    elif action == "assigned":
        notify = _ping(m.user((payload.get("assignee") or {}).get("login")))
    else:  # closed / unassigned — update the card, ping no one
        notify = None

    key = f"issue:{gh_repo['full_name']}:{issue['number']}"
    return Rendered(content=notify, embed=embed, key=key)


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
    # Notify the requested reviewer — this is a direct ask.
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
    # Tell the author their PR was merged/closed.
    return Rendered(content=_ping(m.user(pr["user"]["login"])), embed=embed)


# action -> renderer; unlisted actions (edited, synchronize, labeled…) are noise.
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
    # Notify the PR author — the review is aimed at them.
    return Rendered(content=_ping(pr_author), embed=embed)


# --- checks ---


def _check_suite(payload: dict, _m: Mentions) -> Rendered | None:
    if payload.get("action") != "completed":
        return None
    suite, gh_repo = payload["check_suite"], payload["repository"]
    # Only the main line matters; ignore branch/PR check suites.
    if suite.get("head_branch") != gh_repo.get("default_branch"):
        return None
    conclusion = suite.get("conclusion")
    if conclusion == "success":
        icon, word, color = "✅", "passed", GREEN
    elif conclusion == "failure":
        icon, word, color = "❌", "failed", RED
    else:  # neutral/cancelled/skipped — not worth a line
        return None
    sha = suite.get("head_sha", "")
    # ponytail: a check suite carries the git commit author (a name, not a GitHub
    # login), so we can't reliably @mention — show the name as text.
    name = (suite.get("head_commit") or {}).get("author", {}).get("name") or "someone"
    embed = _embed(
        gh_repo,
        author=f"{icon} CI · {gh_repo['name']}",
        title=f"main checks {word} — {sha[:7]}",
        url=f"{gh_repo['html_url']}/commit/{sha}",
        description=f"by {name}",
        color=color,
        when=(suite.get("head_commit") or {}).get("timestamp"),
    )
    return Rendered(content=None, embed=embed)


# --- deployments (external CI: Vercel, etc.) ---

# One live message per deployment: pending → success/failure edits it in place.
_DEPLOY_STATES = {
    "pending": ("🕒", "deploying", BLUE),
    "in_progress": ("🕒", "deploying", BLUE),
    "queued": ("🕒", "queued", BLUE),
    "success": ("✅", "deployed", GREEN),
    "failure": ("❌", "deploy failed", RED),
    "error": ("❌", "deploy failed", RED),
}


def _deployment_status(payload: dict, _m: Mentions) -> Rendered | None:
    """The `deployment_status` event — cleaner env URL; keyed by deployment id.

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
    icon, word, color = styled
    env = deployment.get("environment") or "deploy"
    sha = deployment.get("sha", "")
    embed = _embed(
        gh_repo,
        author=f"{icon} {env} · {gh_repo['name']}",
        title=f"{word} — {sha[:7]}",
        url=ds.get("environment_url") or ds.get("target_url") or gh_repo["html_url"],
        description=ds.get("description"),
        color=color,
        when=ds.get("updated_at"),
    )
    key = f"deploy:{gh_repo['full_name']}:{deployment.get('id')}"
    return Rendered(content=None, embed=embed, key=key)


# --- dispatch ---

Renderer = Callable[[dict, Mentions], Rendered | None]

RENDERERS: dict[str, Renderer] = {
    "issues": _issue,
    "pull_request": _pull_request,
    "pull_request_review": _pull_request_review,
    "check_suite": _check_suite,
    "deployment_status": _deployment_status,
}


def render(event: str, payload: dict, mentions: Mentions) -> Rendered | None:
    """The message for a webhook event, or None if this event/action is ignored."""
    renderer = RENDERERS.get(event)
    return renderer(payload, mentions) if renderer else None
