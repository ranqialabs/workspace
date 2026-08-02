"""The agent behind a conversation: it answers, or it proposes an issue.

A run ends one of two ways, and the model picks which: prose, when someone asked
a question, or an `IssueDraft`, when they asked for an issue. Anything that isn't
a draft leaves the current draft alone — a question about the code must not
rewrite the issue someone is still reviewing.

Read-only by construction: nothing here can write to GitHub. Submitting is the
cog's job, behind a human click — so a confused model can waste tokens but never
open an issue. `propose_issue` is an output, not an action: it ends the run with
a draft for a human to look at, and reaches GitHub only if they press Submit.

The tools wrap githubkit rather than the GitHub MCP server. MCP would mean a PAT
(its remote server won't take an installation token), a second identity, and 47
tool definitions in context; these reuse the app auth the bot already has.
Each returns a hand-trimmed dict — returning githubkit's parsed models would put
the context bloat we just avoided straight back in. A GitHub call that fails
raises `ToolFailed` (`_reports_failure`), so the model reads a refusal the same
way whichever tool it came from, in the channel pydantic-ai has for exactly that.
"""

import base64
import functools
import logging
import math
from collections.abc import AsyncIterable, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

import httpx
from githubkit import GitHub
from githubkit.exception import GitHubException, RateLimitExceeded
from pydantic_ai import (
    Agent,
    AgentStreamEvent,
    BinaryContent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelRetry,
    RunContext,
    TextOutput,
    ToolCallPart,
    ToolFailed,
    ToolOutput,
    ToolReturnPart,
    UserContent,
)
from pydantic_ai.capabilities import ProcessEventStream
from pydantic_ai.exceptions import ModelAPIError, UsageLimitExceeded

from bridge.agent.context import Transcript
from bridge.agent.draft import IssueDraft
from bridge.repo import split_repo

log = logging.getLogger(__name__)

_MAX_FILE_CHARS = 6_000
_MAX_RESULTS = 15
_MAX_ERROR_CHARS = 400  # provider messages can carry a whole request dump
# Errors from these come straight out of the stream, untranslated by pydantic-ai.
_PROVIDER_SDKS = frozenset({"openai", "anthropic", "google", "groq", "mistralai"})

INSTRUCTIONS = """\
You are a developer on this team, talking to your colleagues in Discord. You read
the code, you answer questions about it, and when someone asks for an issue you
write one.

Ground what you say in the actual code before you say it. Find the files and
symbols people are talking about and read them; cite `path/to/file.py:line` so
the next person can check you. Saying you're not sure beats guessing.

`search_code` finds things; it cannot prove one isn't there. It reads an index
that does not cover every private repo, so a repo nobody indexed answers exactly
like a repo without the code. Never conclude something is missing because a
search came back empty — go read the file or directory it would be in and say
which you did. A string you already know from this repo needs no search at all.

You may read any repository in the org, not just the one an issue would be filed
against — follow a bug across a client and its service if that is where it leads.

Every run ends one of two ways, and you choose:

- **Answer in prose.** The default. Somebody asked a question, wants to think
  something through, or asked you to go look at something. Reply the way you'd
  reply to a colleague: as short as the question allows, no preamble restating
  what they asked, no "great question". Discord markdown, and keep it skimmable.
- **Call `propose_issue`.** Only when they asked for an issue — "let's write an
  issue about this", "abre uma issue pra isso". That call ends the run with a
  draft a human then reviews and submits; it does not file anything itself.

Do not propose an issue just because the conversation described a bug. Somebody
describing a bug is a conversation; somebody asking you to file it is an issue.
When you're unsure which they meant, answer and ask.

If an issue draft already exists in this conversation, call `propose_issue` only
when they asked you to change the issue. Answering a question must not rewrite
it. When you do revise it, carry over everything they didn't ask you to change.

House style for an issue, from the ones this org already writes:

- `title` is `type: what changes`, lowercase after the prefix. Types in use:
  `fix`, `feat`, `chore`, `refactor`. A reader scanning the list should be able
  to tell what the issue is from the title alone.
- Open the body with one or two sentences stating the problem — no `## Summary`
  heading above them, just the sentences.
- Add `##` sections only when there is something to separate: `## Reproducing`,
  `## Cause`, `## Expected`, `## Scope`. Skip the ones you have nothing real to
  put under. An empty template section is worse than no section.
- Aim for 1500-2500 characters. A tight issue gets picked up; a long one gets
  skipped. Cut background the assignee already knows.
- Cite `path/to/file.py:line` where the work lands. Quote the message that
  settled something instead of paraphrasing it; drop the rest of the chatter.

Rules:
- Never invent detail the conversation doesn't support. Put what you'd need to
  know in `questions` instead — a short draft with honest questions beats a
  confident wrong one. Leave out anything the issue itself is meant to discover.
- `questions` is for what blocks someone from starting, not for design choices
  whose answer is the work.
- Choose `repo` only from the candidates you're given — the code you read to
  understand the problem is not restricted, but where it gets filed is.
- Choose `labels` only from the repo's existing labels (`repo_labels`).
- `assignee` is a GitHub login from `teammates`, not a name from the
  conversation. If nobody there matches, leave it null and ask who takes it in
  `questions` — a login that doesn't exist is rejected, and one that does
  assigns a stranger.
- Assign only who was actually named or agreed on. When the person you are
  talking to asks for it themselves, that is their login — not the one who
  started the discussion.
- Set `confidence` to how well the conversation actually specifies the work:
  `high` only when someone could start on it as written.
- If `similar_issues` turns up a real duplicate, say so at the top of the body
  and link it.
"""


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

        Reading further back is the agent's call, not ours: a mention arrives with
        a small seed, and only the agent knows whether "isso" needs five messages
        of context or fifty. Scoped to the channel the request came from.
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


class _Unattached:
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


type Reply = IssueDraft | str
"""How a run ended: a draft to review, or an answer to read.

Narrow it with `isinstance(reply, IssueDraft)` — a `str` is the agent talking,
and carries no draft, so it must never overwrite one.
"""


@dataclass
class Deps:
    """Per-run state: the app-authed client, the org, and the repos on offer.

    `workspace` is how the run reaches Discord — carried here rather than in a
    global so each run reports to its own thread.
    """

    github: GitHub
    org: str
    candidates: list[str] = field(default_factory=list)
    workspace: Workspace = field(default_factory=_Unattached)


def _reports_failure[**P, T](
    doing: str,
) -> Callable[[Callable[P, Awaitable[T]]], Callable[P, Awaitable[T]]]:
    """Hand a failed GitHub call to the model as a failed result, not a raise.

    One error shape for every tool: a new tool gets the handling by saying what it
    was doing rather than by copying a `try` block. `ToolFailed` rather than a row
    the model has to notice — the call is over and it failed, which is a thing
    pydantic-ai can say natively; it also spends none of the retry budget, since
    a spent quota is not something rephrasing the arguments would fix.

    A rate limit says when it lifts, so it gets said out loud. githubkit already
    slept that long and retried once before the error reached us, so the quota is
    genuinely gone rather than momentarily busy — code search allows only ten
    calls a minute, and the model's instinct on a bare failure is to rephrase and
    search again, which spends what little is left. Telling it the wait is what
    stops that.
    """

    def decorate(fn: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
        @functools.wraps(fn)
        async def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
            try:
                return await fn(*args, **kwargs)
            except RateLimitExceeded as exc:
                raise ToolFailed(f"{doing} failed: {_rate_limited(exc)}") from exc
            except GitHubException as exc:
                raise ToolFailed(f"{doing} failed: {exc}") from exc

        return wrapped

    return decorate


def _rate_limited(exc: RateLimitExceeded) -> str:
    """A spent quota, as the wait it costs and what to do meanwhile.

    Rounded up to the second: the model is deciding whether to wait, not timing
    anything, and "0.4s" would read as free. A non-positive wait means the reset
    passed while we were failing, so there is nothing to promise and the sentence
    just stops.
    """
    seconds = math.ceil(exc.retry_after.total_seconds())
    if seconds <= 0:
        return "GitHub's rate limit is spent. Do not repeat this search."
    return (
        f"GitHub's rate limit is spent for another {seconds}s. Do not repeat this "
        "search — answer from what you have already read, or say what you could "
        "not check."
    )


def _leaves(exc: BaseException) -> list[BaseException]:
    """Flatten an ExceptionGroup; streaming wraps the real cause in one."""
    if isinstance(exc, BaseExceptionGroup):
        return [leaf for sub in exc.exceptions for leaf in _leaves(sub)]
    return [exc]


def explain(exc: BaseException) -> str:
    """Why a run failed, phrased so the reader knows whether to retry.

    The provider's own words are quoted rather than paraphrased: the cause is
    usually billing or a key, and no wording of ours resolves that for them.
    A provider SDK may raise its own error straight out of the stream, so the
    status code is read by attribute rather than by type.
    """
    for leaf in _leaves(exc):
        if isinstance(leaf, UsageLimitExceeded):
            return f"This draft hit its usage limit:\n> {leaf}"
        if isinstance(leaf, httpx.HTTPError):
            return "Couldn't reach the model provider. Try `/issue` again."
        if isinstance(leaf, ModelAPIError):
            detail = getattr(leaf, "body", None) or leaf.message
            status = getattr(leaf, "status_code", None)
        elif type(leaf).__module__.split(".")[0] in _PROVIDER_SDKS:
            detail, status = str(leaf), getattr(leaf, "status_code", None)
        else:
            continue
        detail = str(detail)[:_MAX_ERROR_CHARS]
        if status == 429:
            return f"The model provider is rate-limiting us:\n> {detail}"
        if status in (401, 403):
            return f"The model provider rejected our API key:\n> {detail}"
        return f"The model call failed:\n> {detail}"
    return "Something went wrong reaching the model."


async def _report_steps(
    ctx: RunContext[Deps], events: AsyncIterable[AgentStreamEvent]
) -> None:
    """Forward each tool call, and what it gave back, to the watching workspace.

    Reporting progress must never be what kills a draft: a malformed argument, an
    odd return shape, or a Discord hiccup costs one card, not the run. The guard
    is here rather than in the workspace so every implementation of the protocol
    gets it.
    """
    async for event in events:
        if isinstance(event, FunctionToolCallEvent):
            await _safely(ctx.deps.workspace.on_step(event.part))
        elif isinstance(event, FunctionToolResultEvent) and isinstance(
            event.part, ToolReturnPart
        ):
            # A RetryPromptPart is the model being corrected, not a tool answering;
            # the retried call reports itself when it comes round again.
            await _safely(ctx.deps.workspace.on_result(event.tool_call_id, event.part))


async def _safely(reporting: Awaitable[None]) -> None:
    """Run a progress report, swallowing whatever it raises."""
    try:
        await reporting
    except Exception:  # noqa: BLE001 - progress is not worth a failed run
        log.debug("could not report progress", exc_info=True)


def _answer(text: str) -> str:
    """The prose branch of the output: what the agent says, unchanged.

    `TextOutput` needs a callable to hand the text to, and there is nothing to do
    to it — the point is only that plain text is a legal way for a run to end.
    """
    return text


def build(model: str) -> Agent[Deps, Reply]:
    """The conversational agent. One per process; `deps` carries the run's state.

    Two ways to finish, and the model picks: text when it's answering, or
    `propose_issue` when it's proposing a draft. `isinstance(output, IssueDraft)`
    is what the caller reads them apart by.
    """
    agent = Agent[Deps, Reply](
        model,
        deps_type=Deps,
        output_type=[
            TextOutput(_answer),
            ToolOutput(
                IssueDraft,
                name="propose_issue",
                description=(
                    "Propose a GitHub issue for a human to review and submit. "
                    "Use this only when asked for an issue; it files nothing."
                ),
            ),
        ],
        instructions=INSTRUCTIONS,
        retries=2,
        capabilities=[ProcessEventStream(_report_steps)],
    )

    @agent.output_validator
    def _known_repo(ctx: RunContext[Deps], reply: Reply) -> Reply:
        # Only the draft branch names a repo; prose has nothing to validate.
        if not isinstance(reply, IssueDraft):
            return reply
        candidates = ctx.deps.candidates
        if candidates and reply.repo not in candidates:
            raise ModelRetry(
                f"`{reply.repo}` isn't one of the candidates. Choose from: "
                + ", ".join(f"`{c}`" for c in candidates)
            )
        return reply

    def _repo(ctx: RunContext[Deps], repo: str) -> tuple[str, str]:
        return split_repo(repo, ctx.deps.org)

    @agent.tool
    @_reports_failure("search")
    async def search_code(ctx: RunContext[Deps], query: str) -> list[dict[str, str]]:
        """Find code across the org by keyword. Finds things; never proves absence.

        This is an index, not a grep: it only sees each repo's default branch,
        skips files over 384KB, is rate-limited to ~10 calls/minute, and does not
        do regex. Use it to locate a symbol or string, then read_file to confirm.

        A hit is trustworthy. No hits is not: this index does not cover every
        private repo, and an unindexed one answers exactly like an empty one. To
        show something is absent, list_dir and read_file the place it would be.
        """
        resp = await ctx.deps.github.rest.search.async_code(
            q=f"{query} org:{ctx.deps.org}", per_page=_MAX_RESULTS
        )
        found = [
            {"repo": item.repository.full_name, "path": item.path}
            for item in resp.parsed_data.items
        ]
        # Said here, not just in the docstring: an empty list is the one answer a
        # model will happily read as proof, and the warning has to arrive with it.
        return found or [
            {
                "no_results": (
                    "Nothing matched — but this index skips repos it has not "
                    "crawled, and private repos are the usual ones missing. This "
                    "is not evidence the code is absent. Check by reading the "
                    "repo directly with list_dir and read_file."
                )
            }
        ]

    @agent.tool
    async def read_file(
        ctx: RunContext[Deps], repo: str, path: str, ref: str | None = None
    ) -> str:
        """Read a file from a repo, optionally at a branch, tag, or commit."""
        owner, name = _repo(ctx, repo)
        try:
            resp = await ctx.deps.github.rest.repos.async_get_content(
                owner, name, path, **({"ref": ref} if ref else {})
            )
        except RateLimitExceeded as exc:
            raise ToolFailed(f"could not read {path}: {_rate_limited(exc)}") from exc
        except GitHubException as exc:
            raise ToolFailed(f"could not read {path}: {exc}") from exc
        data = resp.parsed_data
        content = getattr(data, "content", None)
        if content is None:  # a directory, or a symlink/submodule
            raise ToolFailed(f"{path} is not a file; use list_dir")
        text = base64.b64decode(content).decode("utf-8", "replace")
        if len(text) > _MAX_FILE_CHARS:
            return (
                text[:_MAX_FILE_CHARS] + f"\n...[truncated at {_MAX_FILE_CHARS} chars]"
            )
        return text

    @agent.tool
    @_reports_failure("listing the directory")
    async def list_dir(
        ctx: RunContext[Deps], repo: str, path: str = ""
    ) -> list[dict[str, str]]:
        """List a directory, to get oriented before reading files."""
        owner, name = _repo(ctx, repo)
        resp = await ctx.deps.github.rest.repos.async_get_content(owner, name, path)
        data = resp.parsed_data
        if not isinstance(data, list):
            raise ToolFailed(f"{path} is a file; use read_file")
        return [{"name": e.name, "type": e.type} for e in data]

    @agent.tool
    @_reports_failure("searching issues")
    async def similar_issues(
        ctx: RunContext[Deps], repo: str, query: str
    ) -> list[dict[str, object]]:
        """Search a repo's existing issues, to catch duplicates before drafting."""
        owner, name = _repo(ctx, repo)
        resp = await ctx.deps.github.rest.search.async_issues_and_pull_requests(
            q=f"{query} repo:{owner}/{name} is:issue", per_page=_MAX_RESULTS
        )
        return [
            {
                "number": item.number,
                "title": item.title,
                "state": item.state,
                "url": item.html_url,
            }
            for item in resp.parsed_data.items
        ]

    @agent.tool
    @_reports_failure("reading the repo's labels")
    async def repo_labels(ctx: RunContext[Deps], repo: str) -> list[str]:
        """The labels this repo actually has. Don't propose any others."""
        owner, name = _repo(ctx, repo)
        resp = await ctx.deps.github.rest.issues.async_list_labels_for_repo(
            owner, name, per_page=100
        )
        return [label.name for label in resp.parsed_data]

    @agent.tool
    async def read_conversation(ctx: RunContext[Deps], messages: int = 25) -> str:
        """Read further back in this Discord channel, before what you were given.

        Use this when you were dropped into the middle of a conversation and what
        someone means by "this" or "isso" is in messages you can't see. Ask for
        more if the first read still doesn't settle it. Reads only the channel the
        request came from, and only messages already there.
        """
        earlier = await ctx.deps.workspace.earlier(max(1, min(messages, 100)))
        return earlier or "(nothing earlier in this channel)"

    @agent.tool
    def teammates(ctx: RunContext[Deps]) -> list[dict[str, str]]:
        """Who can be assigned, as `login` and the `name` people call them by.

        The conversation uses first names; GitHub only takes logins. Resolve any
        name through this list before setting `assignee` — a name that isn't
        here has no GitHub account we know of.
        """
        mapped = ctx.deps.workspace.teammates()
        if not mapped:
            raise ToolFailed("nobody is mapped yet; `/map user` links a login")
        return [{"login": login, "name": name} for login, name in mapped.items()]

    @agent.tool
    @_reports_failure("listing commits")
    async def recent_commits(
        ctx: RunContext[Deps], repo: str, path: str | None = None
    ) -> list[dict[str, str]]:
        """Recent commits, optionally only those touching one path — useful for
        working out whether something regressed and who last touched it."""
        owner, name = _repo(ctx, repo)
        resp = await ctx.deps.github.rest.repos.async_list_commits(
            owner, name, per_page=10, **({"path": path} if path else {})
        )
        return [
            {
                "sha": c.sha[:8],
                "message": (c.commit.message or "").split("\n")[0],
                "author": (c.commit.author.name if c.commit.author else "") or "",
            }
            for c in resp.parsed_data
        ]

    return agent


def _with_conversation(preamble: str, transcript: Transcript) -> list[UserContent]:
    """A prompt's wording, then the conversation it is about and its images.

    The assembly rather than the wording: every entry point ends the same way —
    the transcript last, its images after it, and a line saying where they came
    from — and only the framing above it differs. Kept in one place so a change
    to how images are attached reaches every prompt at once.
    """
    parts: list[UserContent] = [
        f"{preamble}\n\nThe conversation, oldest message first:\n\n{transcript.text}"
    ]
    parts.extend(
        BinaryContent(data=data, media_type=kind) for data, kind in transcript.images
    )
    if transcript.images:
        parts.append("The images above were shared in that conversation.")
    return parts


def _prompt(
    transcript: Transcript,
    candidates: list[str],
    instruction: str | None,
    requester: str,
) -> list[UserContent]:
    """The user prompt: what they asked for, the conversation, and its images."""
    if len(candidates) == 1:
        repo_line = f"The issue belongs to `{candidates[0]}`."
    else:
        listed = ", ".join(f"`{c}`" for c in candidates) or "(none mapped)"
        repo_line = f"Pick the repo from these candidates: {listed}."

    # Without this the agent has no referent for "me" and picks whoever opened
    # the discussion.
    who = (
        f"You are talking to {requester}. In anything they ask you, "
        '"me" and "I" mean them, not whoever spoke in the conversation.'
    )

    # The instruction goes first: it's what the person actually wants, and the
    # conversation is only evidence for it.
    asked = (
        f"What they asked for:\n{instruction}\n\n"
        "Draft that issue with `propose_issue`. The conversation below is your "
        "evidence — use the parts that bear on it and ignore the rest."
        if instruction
        else (
            "Work out what issue this conversation is asking for, and draft it "
            "with `propose_issue`."
        )
    )

    # Joined rather than each part carrying its own trailing blank line — the
    # separator belongs between the sections, not baked into each one.
    return _with_conversation("\n\n".join([who, asked, repo_line]), transcript)


def asked_prompt(
    seed: Transcript,
    *,
    candidates: list[str],
    asked: str,
    requester: str,
    pointed_at: bool,
) -> list[UserContent]:
    """The prompt for a request made by mentioning us in a conversation.

    Unlike `/issue`, this doesn't say what the outcome should be — answering and
    proposing an issue are both on the table and the instructions govern which.
    What it does say is how little context it came with, and that reading more is
    the agent's job: without that the model answers confidently off eight
    messages it should have known were not the whole story.
    """
    listed = ", ".join(f"`{c}`" for c in candidates) or "(none mapped)"
    context_note = (
        "They replied to a specific message, so that message and their request "
        "are below. That reply is them pointing at something."
        if pointed_at
        else "Below are the last few messages of the channel, for orientation only."
    )
    preamble = (
        f"You are talking to {requester} in Discord. In anything they ask you, "
        '"me" and "I" mean them.\n\n'
        f"What they said to you:\n{asked}\n\n"
        f"{context_note} It may well not be enough to know what they mean — if "
        "anything is unclear, or they refer to something you can't see, call "
        "`read_conversation` to read further back before answering. Prefer reading "
        "more over guessing.\n\n"
        f"If this turns into an issue, it can only be filed against: {listed}."
    )
    return _with_conversation(preamble, seed)


class Session:
    """One conversation with the agent, and the draft it may have produced.

    Keeping the history is what makes a follow-up cheap: the agent already read
    the files it needed, and starting over would read them again.
    """

    def __init__(
        self,
        agent: Agent[Deps, Reply],
        deps: Deps,
        requester: str,
        owner_id: int,
        *,
        history: list[ModelMessage] | None = None,
        draft: IssueDraft | None = None,
    ) -> None:
        self._agent = agent
        self._deps = deps
        # Public: a caller streaming a turn itself still has to name who is
        # speaking, and there must be only one spelling of that name.
        self.requester = requester
        # Who may steer this draft. Held here because it shares the session's
        # lifetime exactly — a second dict keyed by thread would only be one more
        # thing to keep in step.
        self.owner_id = owner_id
        # Passed in when the conversation was rebuilt from its thread, so a
        # session resumed after a restart starts where the thread left off.
        self._history: list[ModelMessage] = history or []
        self.draft: IssueDraft | None = draft

    async def stream(
        self,
        prompt: str | Sequence[UserContent],
        on_answer: Callable[[str], Awaitable[None]] | None = None,
    ) -> Reply:
        """Run, handing the answer so far to `on_answer` as it is written.

        `stream_output` rather than `stream_text`, because the output type is a
        union: the model picks prose or a draft, and `stream_text` raises on the
        draft branch. `stream_output` covers both, yielding validated snapshots —
        accumulated text for an answer, a partly-filled `IssueDraft` for a draft.

        Only prose is forwarded. A half-written draft is not worth showing: its
        card is built from a validated model and a partial one renders as a card
        with holes in it, so a draft arrives whole or not at all.

        Each snapshot is the whole answer so far, not a delta — which is what a
        Discord edit wants anyway, since an edit replaces the message.

        `on_answer` is optional: a caller with nowhere to paint the answer as it
        arrives still runs through here, so there is one run path rather than two
        that have to be kept in step.
        """
        async with self._agent.run_stream(
            prompt, deps=self._deps, message_history=self._history or None
        ) as result:
            async for snapshot in result.stream_output():
                if on_answer is not None and isinstance(snapshot, str):
                    await on_answer(snapshot)
            # Completes the stream, applies the output validators, and is what
            # puts the final message into the history.
            output = await result.get_output()
            self._history = list(result.all_messages())
        # Only a draft replaces the draft. A run that answered a question has no
        # draft in it, and taking its prose as one would wipe what the requester
        # is still reviewing.
        if isinstance(output, IssueDraft):
            self.draft = output
        return output

    async def start(
        self,
        transcript: Transcript,
        candidates: list[str],
        *,
        prompt: str | None = None,
    ) -> Reply:
        """First pass: what the requester asked for, grounded in the conversation."""
        self._deps.candidates = candidates
        return await self.stream(
            _prompt(transcript, candidates, prompt, self.requester)
        )

    def candidates(self, candidates: list[str]) -> None:
        """Set what repos an issue from this session could be filed against.

        Read at call time by the output validator, so it has to be set before a
        run rather than at construction: a `/map repo` between two turns of the
        same conversation should reach the second one.
        """
        self._deps.candidates = candidates

    def saying(self, feedback: str) -> str:
        """A human's turn, as the agent should read it."""
        return f"{self.requester} says:\n\n{feedback}"

    def resuming(self, feedback: str) -> str:
        """A turn in a conversation rebuilt from its thread rather than held.

        The draft is restated because a rebuilt history has the preview card
        filtered out of it — the agent would otherwise be revising an issue it
        can't see. Its fields come from the card, so this is what the thread
        shows, not a remembered copy.
        """
        if self.draft is None:
            return self.saying(feedback)
        return (
            "The issue draft currently under review in this conversation:\n"
            f"{self.draft.model_dump_json(indent=2)}\n\n"
            f"{self.saying(feedback)}"
        )
