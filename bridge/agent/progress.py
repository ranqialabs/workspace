"""What the agent is doing, as one card a human can glance at.

The live status is the only window into a run that takes tens of seconds. It has
to say what the agent is *doing* and roughly what it found — enough to see it is
looking in the right place — without becoming the thing you read instead of the
answer.

So: one line per call, and one card holding all of them. An earlier version gave
each call its own card and pruned them as the run went; that made the channel
dance and buried the draft.

Formatting is pure and total. A progress card is never worth failing a run over,
so every shape `args` can arrive in comes back as text rather than an exception.
"""

import json
from collections import Counter
from collections.abc import Sequence
from typing import Any, cast

import discord
import pydantic_core

from pydantic_ai import ToolCallPart, ToolReturnPart

from bridge.agent.spend import Spend, footnote
from bridge.render import GREY
from bridge.repo import short_name

_MAX_ARG = 180  # chars of any single argument value
_MAX_LINE = 118  # chars of one call's line; past ~120 a narrow client wraps
_MAX_HEADLINE = 60  # chars of a failure's reason, which earns more room than a count
_MAX_REPO = 24  # chars of the repo tag; past this it is eating the subject's room
_MAX_LINES = 12  # lines kept on the card before the oldest fold into a count
_MAX_BODY = 4096  # Discord's own ceiling on an embed description

_EMPTY = (None, "", [], {})

# Ordered by how much each identifies a call, not by the tools' signatures.
# `repo` is absent on purpose: `_where` lifts it into its own slot at the front.
_LEAD = (
    "query",
    "path",
    "number",
    # Linear's own "which one": `RAN-123` on an issue, a uuid on a document.
    "issue",
    "identifier",
    "document",
    "sha",
    "ref",
    "head",
    "base",
    # On a filtered listing, what it was filtered by is the news.
    "assignee",
    "assignee_email",
    "creator",
    "mentioned",
    "labels",
    "label",
    "project",
    "team",
    "initiative",
    "name",
    "login",
    "url",
)
_HIDDEN = ("repo", "after")  # `after` is an opaque cursor, not a subject

# What each tool is doing, in words and a glyph, since the reader is following a
# draft and not reading our function names. A tool we don't list falls back to
# its name.
_TOOLS = {
    "read_file": ("📄", "reading"),
    "search_code": ("🔎", "searching code"),
    "list_dir": ("📁", "listing"),
    "list_repos": ("📚", "listing repos"),
    "similar_issues": ("🔗", "checking for duplicates"),
    "repo_labels": ("🏷️", "reading labels"),
    "teammates": ("👥", "looking up teammates"),
    "recent_commits": ("📜", "reading history"),
    "read_conversation": ("💬", "reading back"),
    "list_issues": ("📋", "listing issues"),
    "get_issue": ("🐛", "reading issue"),
    "list_pull_requests": ("🗂️", "listing PRs"),
    "get_pull_request": ("🔀", "reading PR"),
    "pull_request_files": ("📑", "reading PR files"),
    "pull_request_reviews": ("✅", "reading reviews"),
    "pull_request_comments": ("💭", "reading review notes"),
    "check_runs": ("🧪", "reading CI"),
    "check_failures": ("🚨", "reading CI failures"),
    "get_commit": ("🕘", "reading commit"),
    "compare_refs": ("↔️", "comparing"),
    # Named after the system, so a card reading both sides doesn't say "listing
    # issues" twice for two different boards.
    "linear_teams": ("🧭", "listing Linear teams"),
    "linear_vocabulary": ("🏷️", "reading Linear statuses"),
    "linear_projects": ("🗺️", "listing Linear projects"),
    "linear_initiatives": ("🎯", "listing initiatives"),
    "linear_cycles": ("🔄", "listing cycles"),
    "linear_members": ("🧑‍🤝‍🧑", "listing Linear members"),
    "linear_issues": ("🧾", "listing Linear issues"),
    "linear_issue": ("🔖", "reading Linear issue"),
    "linear_documents": ("📘", "listing Linear docs"),
    "linear_document": ("📖", "reading Linear doc"),
}

_RUNNING = "⏳"


def _icon(tool: str) -> str:
    return _labelled(tool)[0]


def _verb(tool: str) -> str:
    return _labelled(tool)[1]


def _labelled(tool: str) -> tuple[str, str]:
    """A tool's glyph and verb, falling back to its own name."""
    return _TOOLS.get(tool, ("🔧", tool))


def _clip(text: str, limit: int) -> str:
    """`text` in at most `limit` chars, with `...` when it was cut."""
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _flat(text: str, limit: int) -> str:
    """`text` on one line, clipped — for a value that shares a row with a label."""
    return _clip(" ".join(text.split()), limit)


def _scalar(value: object, limit: int = _MAX_ARG) -> str:
    """One argument value, as a human reads it rather than as JSON."""
    if isinstance(value, str):
        return _flat(value, limit)
    if isinstance(value, bool) or value is None:
        return json.dumps(value)  # true/false/null, not True/False/None
    if isinstance(value, (int, float)):
        return str(value)
    return _flat(json.dumps(value, default=str), limit)


def parse_args(raw: str | dict[str, Any] | None) -> dict[str, Any]:
    """Whatever the model sent for a tool's arguments, as a dict.

    `ToolCallPart.args` is a dict or a JSON string depending on the provider, and
    mid-stream that string is a fragment of one. `allow_partial` reads the keys
    that have arrived, which is what makes a half-streamed call renderable.
    """
    if isinstance(raw, dict):
        return raw
    if not raw or not isinstance(raw, str):
        return {}
    try:
        parsed = pydantic_core.from_json(raw, allow_partial="trailing-strings")
    except ValueError:
        return {}  # not JSON at all; the caller falls back to the raw text
    return parsed if isinstance(parsed, dict) else {}


def _ordered(args: dict[str, Any]) -> list[tuple[str, Any]]:
    """Arguments with the identifying ones first, empties and `_HIDDEN` dropped.

    An omitted optional (`ref=None`, `path=""`) is noise. `repo` is hidden because
    `_where` already shows it in front, and `after` because a cursor identifies
    nothing to a reader.
    """
    present = [(k, v) for k, v in args.items() if k not in _HIDDEN and v not in _EMPTY]
    return sorted(
        present,
        key=lambda kv: (_LEAD.index(kv[0]) if kv[0] in _LEAD else len(_LEAD), kv[0]),
    )


def _where(args: dict[str, Any]) -> str:
    """Which repo this call is against, or "" for one that isn't against any.

    Just the name, not `owner/name`: every repo the app can read is the one org's,
    so the owner would repeat on every line and crowd the subject.

    Deliberately not widened to Linear's `team` or `project`. This slot exists to
    tell apart the same tool called against different places; a Linear listing
    filters by team only sometimes, so the column would be blank on most lines,
    and a project name would clip in 24 chars. The Linear verbs name their system
    instead (see `_TOOLS`).
    """
    repo = args.get("repo")
    if not isinstance(repo, str) or not repo.strip():
        return ""
    return _flat(short_name(repo.strip()), _MAX_REPO)


def _subject(part: ToolCallPart, ordered: list[tuple[str, Any]]) -> str:
    """The one thing this call is about, for the card's title.

    A search term is quoted, since it's prose and would otherwise run into the
    verb in front of it.
    """
    if not ordered:
        # The argument-less tools (`list_repos`, `teammates`) already read as
        # whole actions, so the verb stands alone.
        return _verb(part.tool_name)
    key, value = ordered[0]
    subject = _scalar(value)
    if key == "query":
        subject = f'"{subject}"'
    return _flat(f"{_verb(part.tool_name)} {subject}", 200)


def _rows(content: object) -> list[object] | None:
    """The rows of a countable answer, or None if it isn't one."""
    if isinstance(content, str) or not isinstance(content, (list, tuple, set)):
        return None
    return list(cast(Sequence[object], content))


def _why(content: object, outcome: str) -> str:
    """A failure's reason, as short as the line can hold.

    Tools raise `ToolFailed("<tool> failed: <reason>")`, so the prefix repeats the
    verb already at the front of the line; only the reason past it is news. Falls
    back to the outcome when there is no message to read.
    """
    text = content.strip() if isinstance(content, str) else ""
    reason = text.rpartition("failed: ")[2] or text or outcome
    # The reason goes inside backticks, so its own would end the span early.
    return reason.replace("`", "")


def result_summary(part: ToolReturnPart) -> tuple[str, bool]:
    """What a tool gave back: a headline, and whether it went well.

    The magnitude of the answer, not the answer. A failure spends that room on
    why instead, since "error" alone leaves the reader nothing to act on.
    """
    content = part.content
    if part.outcome != "success":
        return _why(content, part.outcome), False

    if isinstance(content, str):
        text = content.strip()
        if not text:
            return "empty", True
        # read_file returns the file itself; its length is the useful summary.
        return f"{len(text):,} chars", True

    rows = _rows(content)
    if rows is None:
        return "done", True
    if not rows:
        return "nothing found", True
    return f"{len(rows)} result{'s' if len(rows) != 1 else ''}", True


def line(part: ToolCallPart, result: ToolReturnPart | None) -> str:
    """One call as one line: what it's doing, and what came back."""
    args = parse_args(part.args)
    repo = _where(args)
    subject = _subject(part, _ordered(args))
    # Measured by the name rather than the markup, so a tagged line isn't clipped
    # four chars shorter than an untagged one for markup nobody sees.
    where = f"**{repo}** " if repo else ""
    shown = len(repo) + 1 if repo else 0
    if result is None:
        return f"{_RUNNING} {where}{_flat(subject, _MAX_LINE - shown)}"
    headline, ok = result_summary(result)
    mark = _icon(part.tool_name) if ok else "⚠️"
    # A failure's reason earns more room than "6 results", but never so much that
    # the pair overruns the line — which the subject's floor of 24 would allow.
    headline = _flat(headline, min(40 if ok else _MAX_HEADLINE, _MAX_LINE - 28))
    # The subject yields to the headline; the repo never does, since it is the
    # half of the line the reader is scanning down.
    room = _MAX_LINE - len(headline) - shown - 4
    return f"{mark} {where}{_flat(subject, max(room, 24))}  `{headline}`"


def card(lines: Sequence[str]) -> discord.Embed:
    """Every call this run has made, stacked, as one embed we keep editing.

    Always grey: the card only exists while the run does, and `collapse` replaces
    it with a summary line rather than recolouring it green.
    """
    body = "\n".join(lines[-_MAX_LINES:]) or _RUNNING
    if len(lines) > _MAX_LINES:
        body = f"-# +{len(lines) - _MAX_LINES} earlier\n{body}"
    return discord.Embed(
        title="🤖 working...", description=_clip(body, _MAX_BODY), color=GREY
    )


def summarise(
    calls: list[str],
    *,
    elapsed: float | None = None,
    spend: Spend | None = None,
) -> str:
    """One line standing in for a finished run's cards.

    Counted by tool rather than listed: what survives the cards is how much ground
    the agent covered, not the order it covered it in. What it spent goes on the
    same line, since a run that looked at twelve files and one that answered from
    memory are told apart by exactly these two numbers.
    """
    took = f", {elapsed:.0f}s" if elapsed is not None else ""
    cost = f", {footnote(spend)}" if spend is not None else ""
    if not calls:
        # A run that called nothing still spent something, so the clause moves to
        # the front of a sentence that has no list to hang off. Neutral about what
        # the run produced, since the same line follows a draft and an answer.
        return f"Looked nothing up{took}{cost}."
    counts = Counter(calls)
    parts = [f"{count}x {_verb(name)}" for name, count in sorted(counts.items())]
    return f"Looked at: {', '.join(parts)}{took}{cost}."
