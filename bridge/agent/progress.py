"""What the agent is doing, as one card a human can glance at.

The live status is the only window into a run that takes tens of seconds. It has
to say what the agent is *doing* and roughly what it found — enough to see it is
looking in the right place — without becoming the thing you read instead of the
answer.

So: one line per call, and one card holding all of them. An earlier version gave
each call its own card and pruned them as the run went; that made the channel
dance, buried the draft, and spent the channel's edit budget on scaffolding. A
line keeps the subject and the magnitude of the answer and drops the excerpt.

Formatting is pure and total. A progress card is never worth failing a run over,
so every shape `args` can arrive in (a dict, a JSON string, a half-streamed
fragment, or something that isn't JSON at all) comes back as text rather than
an exception.
"""

import json
from collections import Counter
from collections.abc import Sequence
from typing import Any, cast

import discord
import pydantic_core

from pydantic_ai import ToolCallPart, ToolReturnPart

from bridge.render import GREY

_MAX_ARG = 180  # chars of any single argument value
_MAX_LINE = 90  # chars of one call's line; wider wraps on a narrow client
_MAX_HEADLINE = 60  # chars of a failure's reason, which earns more room than a count
_MAX_LINES = 12  # lines kept on the card before the oldest fold into a count
_MAX_BODY = 4096  # Discord's own ceiling on an embed description

# Values that say nothing: an omitted optional reads the same as one never in
# the signature, and neither earns a place in a card.
_EMPTY = (None, "", [], {})

# Ordered by how much each identifies a call, not by the tools' signatures: the
# arguments a reader scans for come first. `query` before `repo` because "what
# am I searching for" beats "where".
_LEAD = (
    "query",
    "path",
    "number",
    "sha",
    "ref",
    "head",
    "base",
    "repo",
    "name",
    "login",
    "url",
)

# What each tool is doing, in words and a glyph, since the reader is following a
# draft and not reading our function names. One entry per tool rather than a
# dict each, so a tool can't have a verb and lose its icon. A tool we don't list
# falls back to its name.
_TOOLS = {
    "read_file": ("📄", "reading"),
    "search_code": ("🔎", "searching code"),
    "list_dir": ("📁", "listing"),
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

    `ToolCallPart.args` is a dict or a JSON string depending on the provider,
    and mid-stream that string is a fragment of one. `allow_partial` reads the
    keys that have arrived and drops the one still being written, which is what
    makes a half-streamed call renderable instead of blank.
    """
    if isinstance(raw, dict):
        return raw
    # Typed `str | dict | None`, but it comes from a provider — anything else is
    # something we can't read, which is the same answer as unparseable.
    if not raw or not isinstance(raw, str):
        return {}
    try:
        parsed = pydantic_core.from_json(raw, allow_partial="trailing-strings")
    except ValueError:
        return {}  # not JSON at all; the caller falls back to the raw text
    return parsed if isinstance(parsed, dict) else {}


def _ordered(args: dict[str, Any]) -> list[tuple[str, Any]]:
    """Arguments with the identifying ones first, empties dropped.

    An omitted optional (`ref=None`, `path=""`) is noise: it says nothing the
    tool name didn't already say, and the card has a budget.
    """
    present = [(k, v) for k, v in args.items() if v not in _EMPTY]
    return sorted(
        present,
        key=lambda kv: (_LEAD.index(kv[0]) if kv[0] in _LEAD else len(_LEAD), kv[0]),
    )


def _subject(part: ToolCallPart, ordered: list[tuple[str, Any]]) -> str:
    """The one thing this call is about, for the card's title.

    A title reading `reading bridge/agent/view.py` is the whole story for most
    calls; the rest of the arguments are below it and don't need to compete. A
    search term is quoted, since it's prose and would otherwise run into the
    verb in front of it.
    """
    if not ordered:
        # No readable arguments: the verb alone dangles ("reading"), so name the
        # tool instead and let the raw arguments below say the rest.
        return part.tool_name
    key, value = ordered[0]
    subject = _scalar(value)
    if key == "query":
        subject = f'"{subject}"'
    return _flat(f"{_verb(part.tool_name)} {subject}", 200)


def _rows(content: object) -> list[object] | None:
    """The rows of a countable answer, or None if it isn't one.

    Returns the collection rather than a verdict about it, so the caller can
    both count and sample it without re-establishing what it is.
    """
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

    The magnitude of the answer, not the answer — a line has room for "1,204
    chars" or "6 results", which is enough to see the agent is looking in the
    right place. A failure spends that room on why instead, since "error" alone
    leaves the reader with nothing to act on. The flag picks the glyph in front.
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
    """One call as one line: what it's doing, and what came back.

    A line rather than a card because a run makes a dozen of these and the reader
    is following a conversation, not auditing it. What survives the squeeze is the
    subject (which file, which query) and the magnitude of the answer — enough to
    see the agent is looking in the right place, and no more.
    """
    subject = _subject(part, _ordered(parse_args(part.args)))
    if result is None:
        return f"{_RUNNING} {_flat(subject, _MAX_LINE)}"
    headline, ok = result_summary(result)
    mark = _icon(part.tool_name) if ok else "⚠️"
    # A reason needs more room than "6 results" does, and on a failed call it is
    # the more useful half of the line — but never so much that the pair overruns
    # the line, which the subject's floor of 24 would otherwise allow.
    headline = _flat(headline, min(40 if ok else _MAX_HEADLINE, _MAX_LINE - 28))
    # The headline is the point of the line, so the subject yields to it when the
    # two together won't fit.
    room = _MAX_LINE - len(headline) - 4
    return f"{mark} {_flat(subject, max(room, 24))}  `{headline}`"


def card(lines: Sequence[str]) -> discord.Embed:
    """Every call this run has made, stacked, as one embed we keep editing.

    One message rather than one per call: the cards used to be posted, pruned and
    deleted as the run went, which made the channel dance and spent the channel's
    edit budget on scaffolding. Editing one message costs one request per update
    and holds still while the reader reads it.

    Always grey: the card only exists while the run does, and `collapse` replaces
    it with a summary line rather than recolouring it green.
    """
    body = "\n".join(lines[-_MAX_LINES:]) or _RUNNING
    if len(lines) > _MAX_LINES:
        body = f"-# +{len(lines) - _MAX_LINES} earlier\n{body}"
    return discord.Embed(
        title="🤖 working...", description=_clip(body, _MAX_BODY), color=GREY
    )


def summarise(calls: list[str], *, elapsed: float | None = None) -> str:
    """One line standing in for a finished run's cards.

    Counted by tool rather than listed: the cards are gone, and what survives
    them is how much ground the agent covered, not the order it covered it in.
    """
    if not calls:
        return "Drafted without looking anything up."
    counts = Counter(calls)
    parts = [f"{count}x {_verb(name)}" for name, count in sorted(counts.items())]
    took = f", {elapsed:.0f}s" if elapsed is not None else ""
    return f"Looked at: {', '.join(parts)}{took}."
