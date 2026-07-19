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

BODY_LIMIT = 400  # issue/PR body chars shown in an embed description


class Mentions(Protocol):
    """How to turn GitHub logins/repos into Discord mentions (backed by the store)."""

    def user(self, github_login: str | None) -> str: ...
    def role(self, repo_full_name: str) -> str | None: ...


class Rendered(NamedTuple):
    content: str | None  # plain text (e.g. a role ping), shown above the embed
    embed: discord.Embed | None


def _body(payload_obj: dict) -> str | None:
    return (payload_obj.get("body") or "")[:BODY_LIMIT] or None


def _labels(issue: dict) -> str:
    return ", ".join(f"`{lbl['name']}`" for lbl in issue.get("labels") or [])


def _assignees(issue: dict, m: Mentions) -> str:
    return " ".join(m.user(a["login"]) for a in issue.get("assignees") or [])


# --- issues ---


def _issue_opened(payload: dict, m: Mentions) -> Rendered:
    issue, gh_repo = payload["issue"], payload["repository"]
    embed = discord.Embed(
        title=f"#{issue['number']} · {issue['title']}",
        url=issue["html_url"],
        description=_body(issue),
        color=GREEN,
    )
    embed.set_author(name=f"🐛 New issue · {gh_repo['name']}")
    embed.add_field(name="Opened by", value=m.user(issue["user"]["login"]), inline=True)
    if assignees := _assignees(issue, m):
        embed.add_field(name="Assignees", value=assignees, inline=True)
    if labels := _labels(issue):
        embed.add_field(name="Labels", value=labels, inline=False)
    # Ping the repo's devs so they see the new issue.
    return Rendered(content=m.role(gh_repo["full_name"]), embed=embed)


def _issue_closed(payload: dict, m: Mentions) -> Rendered:
    issue, gh_repo = payload["issue"], payload["repository"]
    completed = issue.get("state_reason") == "completed"
    icon, tag = ("✅", "completed") if completed else ("🚫", "not planned")
    embed = discord.Embed(
        title=f"#{issue['number']} · {issue['title']}",
        url=issue["html_url"],
        color=GREY,
    )
    embed.set_author(name=f"{icon} Issue closed ({tag}) · {gh_repo['name']}")
    embed.add_field(
        name="Closed by",
        value=m.user(payload.get("sender", {}).get("login")),
        inline=True,
    )
    return Rendered(content=None, embed=embed)


def _issue_assignment(payload: dict, m: Mentions) -> Rendered:
    issue, gh_repo = payload["issue"], payload["repository"]
    assigned = payload["action"] == "assigned"
    who = m.user((payload.get("assignee") or {}).get("login"))
    verb = "assigned to" if assigned else "unassigned from"
    embed = discord.Embed(
        title=f"#{issue['number']} · {issue['title']}",
        url=issue["html_url"],
        description=f"{who} {verb} this issue",
        color=BLUE,
    )
    embed.set_author(name=f"👤 {gh_repo['name']}")
    return Rendered(content=None, embed=embed)


# --- pull requests ---


def _pull_request(payload: dict, m: Mentions) -> Rendered | None:
    action, pr, gh_repo = (
        payload["action"],
        payload["pull_request"],
        payload["repository"],
    )
    # "Ready for review" = opened as non-draft, or a draft flipped to ready.
    ready = (action == "opened" and not pr.get("draft")) or action == "ready_for_review"
    if not ready:
        return None
    embed = discord.Embed(
        title=f"#{pr['number']} · {pr['title']}",
        url=pr["html_url"],
        description=_body(pr),
        color=GREEN,
    )
    embed.set_author(name=f"📥 PR ready for review · {gh_repo['name']}")
    embed.add_field(name="Opened by", value=m.user(pr["user"]["login"]), inline=True)
    return Rendered(content=m.role(gh_repo["full_name"]), embed=embed)


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
        state, "reviewed"
    )
    embed = discord.Embed(
        title=f"#{pr['number']} · {pr['title']}",
        url=pr["html_url"],
        description=f"{m.user(review['user']['login'])} {verb} "
        f"{m.user(pr['user']['login'])}'s PR",
        color=GREEN if state == "approved" else BLUE,
    )
    embed.set_author(name=f"{icon} Review · {gh_repo['name']}")
    return Rendered(content=None, embed=embed)


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
    embed = discord.Embed(
        title=f"main checks {word} — {sha[:7]}",
        url=f"{gh_repo['html_url']}/commit/{sha}",
        description=f"by {name}",
        color=color,
    )
    embed.set_author(name=f"{icon} CI · {gh_repo['name']}")
    return Rendered(content=None, embed=embed)


# --- dispatch ---

Renderer = Callable[[dict, Mentions], Rendered | None]

# issue action -> renderer; unlisted actions (labeled, edited, …) are ignored.
_ISSUE_ACTIONS: dict[str, Renderer] = {
    "opened": _issue_opened,
    "closed": _issue_closed,
    "assigned": _issue_assignment,
    "unassigned": _issue_assignment,
}


def _issues(payload: dict, m: Mentions) -> Rendered | None:
    renderer = _ISSUE_ACTIONS.get(payload.get("action", ""))
    return renderer(payload, m) if renderer else None


RENDERERS: dict[str, Renderer] = {
    "issues": _issues,
    "pull_request": _pull_request,
    "pull_request_review": _pull_request_review,
    "check_suite": _check_suite,
}


def render(event: str, payload: dict, mentions: Mentions) -> Rendered | None:
    """The message for a webhook event, or None if this event/action is ignored."""
    renderer = RENDERERS.get(event)
    return renderer(payload, mentions) if renderer else None
