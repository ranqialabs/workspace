"""What every toolset needs: the run's state, and the shapes an answer comes back in.

`Deps` lives here rather than in `core` because the toolsets are what read it, so
a toolset can be built and exercised without constructing an agent.

githubkit's parsed models are exhaustive by design, and a GraphQL selection set
can be made fat by accident; every tool returns a hand-built dict instead, and
these are the pieces those dicts are made of.

A listing with something to say *about* its answer — nothing matched and why, or
rows were held back — returns `ToolReturn(return_value=rows, content=<caveat>)`.
The caveat reaches the model as its own message and the rows stay nothing but
results, so whoever counts them (`progress.py`) needs no correction. `held_back`
builds the paging half of that for GitHub, `more_pages` for Linear, which pages
by cursor instead of by number.

Where a helper has a twin — `stamp`/`when`, `reports_failure`/
`reports_linear_failure` — the two live side by side, because what differs
between the systems is exactly what a reader needs to see.
"""

import datetime as dt
import functools
import math
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import httpx
from githubkit import GitHub
from githubkit.exception import GitHubException, RateLimitExceeded
from pydantic_ai import ToolCallPart, ToolFailed, ToolReturnPart

from bridge.linear import LinearError, LinearQueryFailed, LinearRateLimited
from bridge.repo import split_repo

MAX_FILE_CHARS = 6_000
MAX_RESULTS = 15  # rows in a listing or a search
MAX_BODY_CHARS = 4_000  # past this a body is pasted logs
MAX_FILES = 30  # past this the shape of the change is already clear
MAX_REVIEWS = 20
MAX_COMMITS = 10  # enough history to spot a regression
# Annotation messages are one-liners; a lint run with 15 of them should not spend
# a body's worth of budget on each.
MAX_ANNOTATION_CHARS = 500
# A repo description is a tagline, and a listing carries 15 of them.
MAX_SUMMARY_CHARS = 200

type State = Literal["open", "closed", "all"]
"""`state` as GitHub spells it; a Literal so the schema rejects anything else."""

type Sort = Literal["created", "updated", "comments"]
"""`sort` as GitHub spells it, for the same reason `State` is a Literal."""


class Reader(Protocol):
    """What a tool may ask Linear. Satisfied by `bridge.linear.Linear`.

    A protocol rather than the class itself so this module doesn't import a
    client to type one, and so the unconfigured stand-in below is the same kind of
    thing — the relationship `Workspace` and `Unattached` already have.
    """

    async def query(
        self, document: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Run a GraphQL query and return its `data`."""
        ...


class Unconfigured:
    """A Linear client for a workspace that has none.

    Linear is optional in a way the model is not: without it the bridge is the
    bridge as it shipped, and GitHub keeps working. So a missing client is a null
    object rather than a `None` every tool has to test, and rather than switching
    the agent off the way a missing model does. Every query says the same thing,
    in the words the model needs: that this workspace has no Linear, not that the
    query was wrong.
    """

    async def query(
        self, document: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        raise LinearError(
            "Linear isn't configured for this workspace, so there is nothing to "
            "read there. Say so — do not guess at what Linear would have said."
        )


class Workspace(Protocol):
    """What the agent may ask the Discord side — implemented by the issues cog.

    Everything here is read at call time, not snapshotted into `Deps`: a
    `/map github` run while a draft is open has to reach the next revision.
    """

    def people(self) -> list[dict[str, str]]:
        """Who is who here: the name people use, and the accounts it maps to."""
        ...

    async def earlier(self, limit: int) -> str:
        """The `limit` messages before the ones the agent was already given.

        Scoped to the channel the request came from. How far back to read is the
        agent's call: only it knows whether "isso" needs five messages or fifty.
        """
        ...

    async def on_step(self, part: ToolCallPart) -> None:
        """Report a tool call to wherever this run is being watched.

        The part itself, not a rendered line: how a call should look is the
        watcher's business, and it needs the arguments to decide.
        """
        ...

    async def on_result(self, call_id: str, part: ToolReturnPart) -> None:
        """Report what the call with this id gave back."""
        ...


class Unattached:
    """A workspace that knows nothing — the default when nobody wired one up.

    Lets every tool read `ctx.deps.workspace` without a null check.
    """

    def people(self) -> list[dict[str, str]]:
        return []

    async def earlier(self, limit: int) -> str:
        return ""

    async def on_step(self, part: ToolCallPart) -> None:
        pass

    async def on_result(self, call_id: str, part: ToolReturnPart) -> None:
        pass


@dataclass
class Deps:
    """Per-run state: the app-authed clients, the org, and the repos on offer.

    `workspace` is how the run reaches Discord — carried here rather than in a
    global so each run reports to its own thread.

    `linear` defaults to the unconfigured stand-in, so a workspace without Linear
    is a sentence the model reads rather than a null every tool has to test.
    """

    github: GitHub
    org: str
    candidates: list[str] = field(default_factory=list)
    workspace: Workspace = field(default_factory=Unattached)
    linear: Reader = field(default_factory=Unconfigured)

    def repo(self, repo: str) -> tuple[str, str]:
        """`owner/name` split, defaulting a bare name to the run's org."""
        return split_repo(repo, self.org)


def reports_failure[**P, T](
    fn: Callable[P, Awaitable[T]],
) -> Callable[P, Awaitable[T]]:
    """Hand a failed GitHub call to the model as a `ToolFailed`, not a raise.

    Named from the function it wraps, so a new tool gets the handling by wearing
    the decorator and cannot drift from its own name. `ToolFailed` rather than a
    row the model has to notice: the call is over, and it spends none of the retry
    budget, since rephrasing the arguments does not refill a quota.
    """

    # Read once here: a `Callable` carries no `__name__`, and the decorator is
    # applied to plain functions, which do.
    doing = getattr(fn, "__name__", "the call")

    @functools.wraps(fn)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
        try:
            return await fn(*args, **kwargs)
        except RateLimitExceeded as exc:
            raise ToolFailed(f"{doing} failed: {rate_limited(exc)}") from exc
        except GitHubException as exc:
            raise ToolFailed(f"{doing} failed: {exc}") from exc

    return wrapped


def reports_linear_failure[**P, T](
    fn: Callable[P, Awaitable[T]],
) -> Callable[P, Awaitable[T]]:
    """Hand a failed Linear call to the model as a `ToolFailed`, not a raise.

    The Linear twin of `reports_failure`, and a separate decorator rather than one
    widened to both: what counts as a failure differs — a GraphQL error arrives
    with HTTP 200, so it is a raised `LinearQueryFailed` rather than a status — and
    a single decorator catching both clients would let a GitHub tool wear the wrong
    one without complaint.

    Kept beside its twin because they must produce the same
    `"<tool> failed: <reason>"` shape, which `progress._why` reads by splitting on
    `"failed: "`. Adjacent is what keeps that contract visible.
    """

    doing = getattr(fn, "__name__", "the call")

    @functools.wraps(fn)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
        try:
            return await fn(*args, **kwargs)
        except LinearRateLimited as exc:
            raise ToolFailed(
                f"{doing} failed: {exc} Do not repeat this query — answer from "
                "what you have already read, or say what you could not check."
            ) from exc
        except LinearQueryFailed as exc:
            raise ToolFailed(
                f"{doing} failed: Linear rejected the query: {exc}"
            ) from exc
        except LinearError as exc:
            raise ToolFailed(f"{doing} failed: {exc}") from exc
        except httpx.HTTPError as exc:
            raise ToolFailed(f"{doing} failed: could not reach Linear ({exc})") from exc

    return wrapped


def rate_limited(exc: RateLimitExceeded) -> str:
    """A spent quota, as the wait it costs and what to do meanwhile.

    Rounded up to the second, since "0.4s" would read as free. A non-positive wait
    means the reset passed while we were failing, so there is nothing to promise.
    """
    seconds = math.ceil(exc.retry_after.total_seconds())
    if seconds <= 0:
        return "GitHub's rate limit is spent. Do not repeat this search."
    return (
        f"GitHub's rate limit is spent for another {seconds}s. Do not repeat this "
        "search — answer from what you have already read, or say what you could "
        "not check."
    )


def held_back(
    resp: object, noun: str, page: int, *, narrowable: bool = True
) -> str | None:
    """What to tell the model when GitHub kept rows past this page, else None.

    Read from GitHub's own `rel="next"` rather than guessed from a full page,
    which false-positives on a page that happens to end exactly at the limit.

    `narrowable` is False for a listing that takes no filters, so the advice
    doesn't offer a way out the caller hasn't got.
    """
    link = getattr(resp, "headers", {}).get("link", "")
    if 'rel="next"' not in link:
        return None
    narrow = " or narrow the filters" if narrowable else ""
    return (
        f"GitHub has more {noun} past this page. Ask for page {page + 1}{narrow}; "
        "this is not the whole list."
    )


def more_pages(page_info: object, noun: str, *, narrowable: bool = True) -> str | None:
    """What to tell the model when Linear kept rows past this page, else None.

    Read from Linear's own `pageInfo.hasNextPage` rather than guessed from a full
    page, which false-positives on a page ending exactly at the limit — the same
    reason `held_back` reads GitHub's `rel="next"`.

    Hands back the cursor, because Linear pages by cursor rather than by number:
    there is no "page 2" to ask for, only "after this one". That is the one place
    the two systems' tools differ in shape, so the caveat spells the argument out
    rather than leaving the model to carry the habit over from GitHub.
    """
    info = page_info if isinstance(page_info, dict) else {}
    if not info.get("hasNextPage"):
        return None
    cursor = info.get("endCursor")
    narrow = " or narrow the filters" if narrowable else ""
    return (
        f'Linear has more {noun} past this page. Pass `after="{cursor}"` to '
        f"continue{narrow}; this is not the whole list."
    )


def applied(given: dict[str, str | None]) -> str:
    """The filters that were actually sent, as `key=value` text.

    Shared because both sides need it to say what emptied a listing, and an empty
    answer that can't name its own filters is the one a model reads as absence.
    """
    return ", ".join(f"{key}={value}" for key, value in given.items() if value)


def clipped(text: str, limit: int) -> str:
    """`text` within `limit`, marking the cut so the model knows it is partial."""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated at {limit} chars]"


def body(text: object, limit: int = MAX_BODY_CHARS) -> str:
    """A PR or issue body, trimmed and marked where it was cut.

    Takes `object` because githubkit types an optional field as `Unset | str |
    None`: absent, null and empty all mean "nothing to read" here.
    """
    return clipped(text.strip() if isinstance(text, str) else "", limit)


def login(user: object) -> str:
    """A GitHub actor's login, for the many nullable `user` fields on these models."""
    return getattr(user, "login", "") or ""


def logins(users: object) -> list[str]:
    """The logins of a list of actors: assignees, reviewers."""
    if not isinstance(users, Sequence):
        return []
    return [name for user in users if (name := login(user))]


def label_names(items: Sequence[object]) -> list[str]:
    """Label names. GitHub types a label as a bare string or an object with a name."""
    named = [i if isinstance(i, str) else getattr(i, "name", None) for i in items]
    return [name for name in named if isinstance(name, str) and name]


def stamp(when: object) -> str | None:
    """A timestamp as ISO text, or None. The models hand back datetimes."""
    return when.isoformat() if isinstance(when, dt.datetime) else None


def when(value: object) -> str | None:
    """A Linear timestamp, as the ISO text it already is, or None.

    Linear answers in JSON, so a timestamp arrives as a string rather than the
    `datetime` `stamp` exists for — and passing one to `stamp` returns None for
    every date in the workspace, silently.
    """
    return value if isinstance(value, str) and value else None


def changed_file(file: object) -> dict[str, object]:
    """One entry in a list of changed files, as PRs and commits both report them.

    The same four fields either way, so a reader of one has learned the other.
    """
    return {
        "path": getattr(file, "filename", ""),
        "status": getattr(file, "status", ""),
        "additions": getattr(file, "additions", 0),
        "deletions": getattr(file, "deletions", 0),
    }


def first_line(text: object) -> str:
    """A commit message's subject line."""
    return (text or "").split("\n")[0] if isinstance(text, str) else ""


def author_name(author: object) -> str:
    """A git author's name, which githubkit types as nullable on every commit."""
    return getattr(author, "name", "") or ""


def commit_row(commit: object) -> dict[str, str]:
    """One commit in a list: short sha, subject, author.

    The same three fields wherever commits are listed, so `recent_commits` and
    `compare_refs` cannot drift on the sha width.
    """
    inner = getattr(commit, "commit", None)
    return {
        "sha": getattr(commit, "sha", "")[:8],
        "message": first_line(getattr(inner, "message", "")),
        "author": author_name(getattr(inner, "author", None)),
    }
