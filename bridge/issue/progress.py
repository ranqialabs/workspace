"""One tool call, as a card a human can read.

The live status is the only window into a run that takes tens of seconds, so a
card has to say what the agent is *doing* and what it learned. A line of
`search_code(...)` says the first; only a real excerpt of the answer says the
second, and the difference between a search that found the file and one that
found nothing is what tells you where the draft is heading.

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

from bridge.render import GREEN, GREY, RED

_MAX_ARG = 180  # chars of any single argument value
_MAX_EXCERPT = 700  # chars of a returned file or blob
_MAX_ROWS = 8  # collection entries listed before "+N more"
_MAX_ROW = 90  # chars of any one listed row
_MAX_FIELD = 1024  # Discord's own ceiling on an embed field value
_MAX_NAME = 256  # Discord's ceiling on an embed title and on a field name
_MAX_FIELDS = 6  # arguments shown before the card is more grid than card

# Values that say nothing: an omitted optional reads the same as one never in
# the signature, and neither earns a place in a card.
_EMPTY = (None, "", [], {})

# Ordered by how much each identifies a call, not by the tools' signatures: the
# arguments a reader scans for come first. `query` before `repo` because "what
# am I searching for" beats "where".
_LEAD = ("query", "path", "repo", "ref", "name", "login", "number", "url")

# Which field names a returned row: `path` for a search hit, `title` for an
# issue, `message` for a commit, `name` for a directory entry or a teammate.
_ROW_LABEL = ("path", "title", "message", "name", "login")

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
    "recent_commits": ("🕘", "reading history"),
}

_RUNNING = "⏳"


def _icon(tool: str) -> str:
    return _TOOLS.get(tool, ("🔧", tool))[0]


def _verb(tool: str) -> str:
    return _TOOLS.get(tool, ("🔧", tool))[1]


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

    A title reading `reading bridge/issue/view.py` is the whole story for most
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


def _call_fields(
    part: ToolCallPart, args: dict[str, Any], ordered: list[tuple[str, Any]]
) -> list[tuple[str, str]]:
    """The call's arguments, as embed fields, identifying one first.

    Every argument is shown rather than only the leading one: `read_file` on a
    ref, or a search scoped to a repo, is a different call from the one without
    it, and the reader can't tell them apart from a title.
    """
    if not args:
        # A non-JSON or not-yet-parseable string is still better than nothing:
        # it's what the model actually sent.
        raw = part.args.strip() if isinstance(part.args, str) else ""
        return [("Arguments", f"```\n{_clip(raw, 400)}\n```")] if raw else []
    return [(k, f"`{_scalar(v)}`") for k, v in ordered]


def _rows(content: object) -> list[object] | None:
    """The rows of a countable answer, or None if it isn't one.

    Returns the collection rather than a verdict about it, so the caller can
    both count and sample it without re-establishing what it is.
    """
    if isinstance(content, str) or not isinstance(content, (list, tuple, set)):
        return None
    return list(cast(Sequence[object], content))


def _row(item: object) -> str:
    """One returned row, as the field a person would scan.

    Rows come back keyed by tool: a search hit has `path`, an issue has `title`,
    a directory entry has `name`. So the row is identified by which of those
    keys it has rather than by asking which tool produced it. A hit also carries
    where it lives, which is half of what makes it useful.
    """
    if not isinstance(item, dict):
        return _scalar(item, _MAX_ROW)
    row = cast(dict[str, object], item)
    labelled = (row[k] for k in _ROW_LABEL if row.get(k) not in _EMPTY)
    fallback = (v for v in row.values() if v not in _EMPTY)
    # A shape we don't know falls back to the first value it has.
    label = _scalar(next(labelled, next(fallback, "")), _MAX_ROW)
    if (number := row.get("number")) not in _EMPTY:
        label = f"#{number} {label}"
    elif (sha := row.get("sha")) not in _EMPTY:
        label = f"{sha} {label}"
    elif (repo := row.get("repo")) not in _EMPTY and "path" in row:
        label = f"{_scalar(repo, 40)} · {label}"
    return label


def _listing(rows: list[object]) -> str:
    """A returned collection, as lines under a count."""
    shown = [f"- {_row(item)}" for item in rows[:_MAX_ROWS]]
    if (more := len(rows) - len(shown)) > 0:
        shown.append(f"- +{more} more")
    return "\n".join(shown)


def _failure(content: object) -> str | None:
    """The refusal in a successful-looking answer, if there is one.

    Tools report a failed GitHub call as an `error` row rather than raising, so
    a successful outcome can still be something the reader has to see.
    """
    if isinstance(content, list) and len(content) == 1:
        first: object = content[0]
        if isinstance(first, dict) and (failure := first.get("error")):
            return str(failure)
    return None


def result_summary(part: ToolReturnPart) -> tuple[str, str | None, bool]:
    """What a tool gave back: a headline, the detail under it, and whether it's ok.

    Split rather than one blob because the two land in different places on the
    card — the headline next to the call, the detail in its own block — and the
    flag picks the colour.
    """
    content = part.content
    if part.outcome != "success":
        return part.outcome, _scalar(content, _MAX_EXCERPT), False

    if (failure := _failure(content)) is not None:
        return "failed", _clip(failure, _MAX_EXCERPT), False

    if isinstance(content, str):
        text = content.strip()
        if not text:
            return "empty", None, True
        # read_file returns the file itself; its length is the useful summary,
        # and the head of it is what tells the reader what the agent just saw.
        return f"{len(text):,} chars", _clip(text, _MAX_EXCERPT), True

    rows = _rows(content)
    if rows is None:
        return "done", _scalar(content, _MAX_EXCERPT), True
    if not rows:
        return "nothing found", None, True
    counted = f"{len(rows)} result{'s' if len(rows) != 1 else ''}"
    return counted, _listing(rows), True


def _fenced(detail: str, *, code: bool) -> str:
    """A detail block that fits an embed field, fenced when it's file content."""
    if not code:
        return _clip(detail, _MAX_FIELD)
    body = _clip(detail, _MAX_FIELD - 8)
    return f"```\n{body}\n```"


def calling(part: ToolCallPart) -> discord.Embed:
    """The card for a call that has just gone out and hasn't answered yet."""
    args = parse_args(part.args)
    ordered = _ordered(args)
    embed = discord.Embed(
        title=_clip(f"{_icon(part.tool_name)} {_subject(part, ordered)}", _MAX_NAME),
        color=GREY,
    )
    for name, value in _call_fields(part, args, ordered)[:_MAX_FIELDS]:
        embed.add_field(name=name, value=_clip(value, _MAX_FIELD), inline=True)
    embed.set_footer(text=f"{_RUNNING} {part.tool_name}")
    return embed


def answered(
    part: ToolCallPart, result: ToolReturnPart, *, elapsed: float | None = None
) -> discord.Embed:
    """The card for a call once its answer is in.

    Built from the call rather than by editing the pending card's fields: the
    two say different things, and rebuilding is how they stay consistent.
    """
    embed = calling(part)
    headline, detail, ok = result_summary(result)
    headline = _clip(headline, _MAX_NAME)  # it names a field, and that has a cap
    embed.color = GREEN if ok else RED
    # The headline names the block, so "15 results" sits above the hits it
    # counts; with nothing to put under it, it is the block.
    if detail:
        # File content keeps its own shape inside a fence; a list of hits reads
        # better as markdown, where a long path can wrap.
        code = isinstance(result.content, str)
        embed.add_field(name=headline, value=_fenced(detail, code=code), inline=False)
    else:
        embed.add_field(name="Result", value=f"*{headline}*", inline=False)
    took = f" · {elapsed:.1f}s" if elapsed is not None else ""
    embed.set_footer(text=f"{part.tool_name} · {headline}{took}")
    return embed


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
