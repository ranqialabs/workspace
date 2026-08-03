"""What every toolset needs: the run's state, and the shapes an answer comes back in.

`Deps` lives here rather than in `core` because the toolsets are what read it, so
a toolset can be built and exercised without constructing an agent.

githubkit's parsed models are exhaustive by design; every tool returns a
hand-built dict instead, and these are the pieces those dicts are made of.
"""

import datetime as dt
import functools
import math
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from githubkit import GitHub
from githubkit.exception import GitHubException, RateLimitExceeded
from pydantic_ai import ToolCallPart, ToolFailed, ToolReturnPart

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

type State = Literal["open", "closed", "all"]
"""`state` as GitHub spells it; a Literal so the schema rejects anything else."""


class Workspace(Protocol):
    """What the agent may ask the Discord side — implemented by the issues cog.

    Everything here is read at call time, not snapshotted into `Deps`: a
    `/map user` run while a draft is open has to reach the next revision.
    """

    def teammates(self) -> dict[str, str]:
        """Mapped GitHub logins to the names people call each other by."""
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

    def teammates(self) -> dict[str, str]:
        return {}

    async def earlier(self, limit: int) -> str:
        return ""

    async def on_step(self, part: ToolCallPart) -> None:
        pass

    async def on_result(self, call_id: str, part: ToolReturnPart) -> None:
        pass


@dataclass
class Deps:
    """Per-run state: the app-authed client, the org, and the repos on offer.

    `workspace` is how the run reaches Discord — carried here rather than in a
    global so each run reports to its own thread.
    """

    github: GitHub
    org: str
    candidates: list[str] = field(default_factory=list)
    workspace: Workspace = field(default_factory=Unattached)

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


def labels(items: Sequence[object]) -> list[str]:
    """Label names. GitHub types a label as a bare string or an object with a name."""
    named = [i if isinstance(i, str) else getattr(i, "name", None) for i in items]
    return [name for name in named if isinstance(name, str) and name]


def stamp(when: object) -> str | None:
    """A timestamp as ISO text, or None. The models hand back datetimes."""
    return when.isoformat() if isinstance(when, dt.datetime) else None


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
