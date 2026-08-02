"""Streamed tool calls, as lines a human can follow.

The live status is the only window into a run that takes tens of seconds, so a
line has to say what the agent is *doing*. `search_code` alone doesn't, and
neither does a call whose one interesting argument happens not to be `path`,
`query`, or `repo`.

Formatting is pure and total. A progress line is never worth failing a run over,
so every shape `args` can arrive in (a dict, a JSON string, a half-streamed
fragment, or something that isn't JSON at all) comes back as text rather than
an exception.
"""

import json
from collections.abc import Sequence
from typing import Any, cast

import pydantic_core

from pydantic_ai import ToolCallPart, ToolReturnPart

_MAX_VALUE = 48  # chars of any single argument value
_MAX_LINE = 110  # chars of the whole rendered line; Discord wraps past this
_MAX_ITEMS = 3  # collection entries previewed before "+N more"

# Values that say nothing: an omitted optional reads the same as one never in
# the signature, and neither earns a place in a line with a budget.
_EMPTY = (None, "", [], {})

# Ordered by how much each identifies a call, not by the tools' signatures: the
# first argument present leads the line, and the rest follow in this order.
# `query` before `repo` because "what am I searching for" beats "where".
_LEAD = ("query", "path", "repo", "ref", "name", "login", "number", "url")

# Which field names a returned row: `path` for a search hit, `title` for an
# issue, `message` for a commit, `name` for a directory entry or a teammate.
_ROW_LABEL = ("path", "title", "message", "name", "login")


def _clip(text: str, limit: int = _MAX_VALUE) -> str:
    """`text` in at most `limit` chars, with `...` when it was cut.

    ASCII only, here and in every separator below: these land inside a Discord
    code fence, where a client that lacks the glyph substitutes a font and the
    lines stop lining up.
    """
    text = " ".join(text.split())  # newlines in a code fence break the line up
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _scalar(value: object) -> str:
    """One argument value, as a human reads it rather than as JSON."""
    if isinstance(value, str):
        return _clip(value)
    if isinstance(value, bool) or value is None:
        return json.dumps(value)  # true/false/null, not True/False/None
    if isinstance(value, (int, float)):
        return _clip(str(value))
    return _clip(json.dumps(value, default=str))


def parse_args(raw: str | dict[str, Any] | None) -> dict[str, Any]:
    """Whatever the model sent for a tool's arguments, as a dict.

    `ToolCallPart.args` is a dict or a JSON string depending on the provider,
    and mid-stream that string is a fragment of one. `allow_partial` reads the
    keys that have arrived and drops the one still being written, which is what
    makes a half-streamed call renderable instead of blank.
    """
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = pydantic_core.from_json(raw, allow_partial="trailing-strings")
    except ValueError:
        return {}  # not JSON at all; the caller falls back to the raw text
    return parsed if isinstance(parsed, dict) else {}


def _ordered(args: dict[str, Any]) -> list[tuple[str, Any]]:
    """Arguments with the identifying ones first, empties dropped.

    An omitted optional (`ref=None`, `path=""`) is noise: it says nothing the
    tool name didn't already say, and the line has a budget.
    """
    present = [(k, v) for k, v in args.items() if v not in _EMPTY]
    return sorted(
        present,
        key=lambda kv: (_LEAD.index(kv[0]) if kv[0] in _LEAD else len(_LEAD), kv[0]),
    )


def describe_call(part: ToolCallPart) -> str:
    """A tool call as a line a human can follow.

    Reads `tool(a, key=b)`: the leading identifier bare, since `search_code` on
    a query needs no label, and everything after it named so a bare value can't
    be mistaken for the thing being searched for.
    """
    args = parse_args(part.args)
    if not args:
        # A non-JSON or not-yet-parseable string is still better than nothing:
        # it's what the model actually sent.
        raw = part.args.strip() if isinstance(part.args, str) else ""
        return f"{part.tool_name}({_clip(raw)})" if raw else part.tool_name

    ordered = _ordered(args)
    if not ordered:
        return part.tool_name
    rendered = [_scalar(ordered[0][1])]
    rendered += [f"{k}={_scalar(v)}" for k, v in ordered[1:]]
    line = f"{part.tool_name}({', '.join(rendered)})"
    return _clip(line, _MAX_LINE)


def _rows(content: object) -> list[object] | None:
    """The rows of a countable answer, or None if it isn't one.

    Returns the collection rather than a verdict about it, so the caller can
    both count and sample it without re-establishing what it is.
    """
    if isinstance(content, str) or not isinstance(content, (list, tuple, set)):
        return None
    return list(cast(Sequence[object], content))


def _sample(content: Sequence[object]) -> str:
    """A few entries from a collection, as the field a person would scan.

    Rows come back keyed by tool: a search hit has `path`, an issue has
    `title`, a directory entry has `name`. So the row is identified by which
    of those keys it has rather than by asking which tool produced it.
    """
    items = list(content)[:_MAX_ITEMS]
    shown: list[str] = []
    for item in items:
        if isinstance(item, dict):
            row = cast(dict[str, object], item)
            labelled = (row[k] for k in _ROW_LABEL if row.get(k) not in _EMPTY)
            fallback = (v for v in row.values() if v not in _EMPTY)
            # A shape we don't know falls back to the first value it has.
            shown.append(_scalar(next(labelled, next(fallback, ""))))
        else:
            shown.append(_scalar(item))
    more = len(content) - len(items)
    if more > 0:
        shown.append(f"+{more} more")
    return ", ".join(shown)


def describe_result(part: ToolReturnPart) -> str:
    """What a tool gave back, in one line.

    Enough to tell a search that found the file from one that found nothing:
    the two look identical while only the calls are shown, and they mean very
    different things about where the draft is heading.
    """
    content = part.content
    if part.outcome != "success":
        return _clip(f"{part.outcome}: {_scalar(content)}", _MAX_LINE)

    # Tools report a failed GitHub call as an `error` row rather than raising,
    # so a successful outcome can still be a refusal the reader should see.
    if isinstance(content, list) and len(content) == 1:
        first: object = content[0]
        if isinstance(first, dict) and (failure := first.get("error")):
            return _clip(str(failure), _MAX_LINE)

    if isinstance(content, str):
        text = content.strip()
        if not text:
            return "empty"
        # read_file returns the file itself; its length is the useful summary.
        return _clip(f"{len(text)} chars: {_clip(text, _MAX_VALUE)}", _MAX_LINE)

    rows = _rows(content)
    if rows is None:
        return _clip(_scalar(content), _MAX_LINE)
    if not rows:
        return "nothing"
    counted = f"{len(rows)} result{'s' if len(rows) != 1 else ''}"
    return _clip(f"{counted}: {_sample(rows)}", _MAX_LINE)
