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


def _issue_title(issue: dict) -> str:
    return f"#{issue['number']} · {issue['title']}"


def _issue_opened(payload: dict, m: Mentions) -> Rendered:
    issue, gh_repo = payload["issue"], payload["repository"]
    embed = _embed(
        gh_repo,
        author=f"🐛 New issue · {gh_repo['name']}",
        title=_issue_title(issue),
        url=issue["html_url"],
        description=_body(issue),
        color=GREEN,
        when=issue.get("created_at"),
    )
    embed.add_field(name="Opened by", value=m.user(issue["user"]["login"]), inline=True)
    assignee_mentions = [m.user(a["login"]) for a in issue.get("assignees") or []]
    if assignee_mentions:
        embed.add_field(
            name="Assignees", value=" ".join(assignee_mentions), inline=True
        )
    if labels := _labels(issue):
        embed.add_field(name="Labels", value=labels, inline=False)
    # Notify the repo's devs and any assignees (content pings; embeds don't).
    return Rendered(
        content=_ping(m.role(gh_repo["full_name"]), *assignee_mentions), embed=embed
    )


def _issue_closed(payload: dict, m: Mentions) -> Rendered:
    issue, gh_repo = payload["issue"], payload["repository"]
    completed = issue.get("state_reason") == "completed"
    icon, tag = ("✅", "completed") if completed else ("🚫", "not planned")
    embed = _embed(
        gh_repo,
        author=f"{icon} Issue closed ({tag}) · {gh_repo['name']}",
        title=_issue_title(issue),
        url=issue["html_url"],
        color=GREY,
        when=issue.get("closed_at"),
    )
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
    embed = _embed(
        gh_repo,
        author=f"👤 {gh_repo['name']}",
        title=_issue_title(issue),
        url=issue["html_url"],
        description=f"{who} {verb} this issue",
        color=BLUE,
        when=issue.get("updated_at"),
    )
    # Notify the person just assigned; unassigning isn't worth a ping.
    return Rendered(content=_ping(who) if assigned else None, embed=embed)


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
    embed = _embed(
        gh_repo,
        author=f"📥 PR ready for review · {gh_repo['name']}",
        title=f"#{pr['number']} · {pr['title']}",
        url=pr["html_url"],
        description=_body(pr),
        color=GREEN,
        when=pr.get("updated_at"),
    )
    embed.add_field(name="Opened by", value=m.user(pr["user"]["login"]), inline=True)
    return Rendered(content=_ping(m.role(gh_repo["full_name"])), embed=embed)


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
    pr_author = m.user(pr["user"]["login"])
    embed = _embed(
        gh_repo,
        author=f"{icon} Review · {gh_repo['name']}",
        title=f"#{pr['number']} · {pr['title']}",
        url=pr["html_url"],
        description=f"{m.user(review['user']['login'])} {verb} {pr_author}'s PR",
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
