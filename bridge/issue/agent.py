"""The agent that drafts an issue from a conversation.

Read-only by construction: nothing here can write to GitHub. Submitting is the
cog's job, behind a human click — so a confused model can waste tokens but never
open an issue.

The tools wrap githubkit rather than the GitHub MCP server. MCP would mean a PAT
(its remote server won't take an installation token), a second identity, and 47
tool definitions in context; these six reuse the app auth the bot already has.
Each returns a hand-trimmed dict — returning githubkit's parsed models would put
the context bloat we just avoided straight back in.
"""

import base64
from collections.abc import AsyncIterable, Awaitable, Callable, Sequence
from dataclasses import dataclass, field

import httpx
from githubkit import GitHub
from githubkit.exception import GitHubException
from pydantic_ai import (
    Agent,
    AgentStreamEvent,
    BinaryContent,
    FunctionToolCallEvent,
    ModelMessage,
    ModelRetry,
    RunContext,
    ToolCallPart,
    UserContent,
)
from pydantic_ai.capabilities import ProcessEventStream
from pydantic_ai.exceptions import ModelAPIError, UsageLimitExceeded

from bridge.issue.context import Transcript
from bridge.issue.draft import IssueDraft
from bridge.repo import split_repo

_MAX_FILE_CHARS = 6_000
_MAX_RESULTS = 15
_MAX_ERROR_CHARS = 400  # provider messages can carry a whole request dump
# Errors from these come straight out of the stream, untranslated by pydantic-ai.
_PROVIDER_SDKS = frozenset({"openai", "anthropic", "google", "groq", "mistralai"})

INSTRUCTIONS = """\
You turn a Discord conversation into a GitHub issue that a developer can pick up
without asking follow-up questions.

Read the conversation, then use your tools to ground it in the actual code: find
the files and symbols people are talking about, and check whether the issue
already exists before proposing a new one.

You may read any repository in the org, not just the one the issue will be filed
against — follow a bug across a client and its service if that is where it leads.
`repo` is only where the issue gets filed.

Write the body as Markdown, with whatever of these the conversation supports:
what happens, what should happen instead, how to reproduce it, and where in the
code it probably lives (cite `path/to/file.py` and line numbers when you found
them). Quote the messages that matter instead of paraphrasing them away.

Rules:
- Never invent detail the conversation doesn't support. Put what you'd need to
  know in `questions` instead — a short draft with honest questions beats a
  confident wrong one.
- Choose `repo` only from the candidates you're given — the code you read to
  understand the problem is not restricted, but where it gets filed is.
- Choose `labels` only from the repo's existing labels (`repo_labels`).
- Set `assignee` only to a login you saw in the conversation or that people
  clearly agreed on. Leave it null otherwise. When the person you are talking to
  asks for it themselves, that is their login — not the one who started the
  discussion.
- Set `confidence` to how well the conversation actually specifies the work:
  `high` only when someone could start on it as written.
- If `similar_issues` turns up a real duplicate, say so at the top of the body
  and link it.
"""


@dataclass
class Deps:
    """Per-run state: the app-authed client, the org, and the repos on offer.

    `on_step` is how the run reports progress — carried here rather than in a
    global so each run reports to its own thread.
    """

    github: GitHub
    org: str
    candidates: list[str] = field(default_factory=list)
    on_step: Callable[[str], Awaitable[None]] | None = None


def _describe(part: ToolCallPart) -> str:
    """A tool call as a line a human can follow."""
    args = part.args if isinstance(part.args, dict) else {}
    detail = args.get("path") or args.get("query") or args.get("repo") or ""
    return f"{part.tool_name}({detail})" if detail else part.tool_name


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
    """Forward each tool call to the run's progress callback."""
    async for event in events:
        if isinstance(event, FunctionToolCallEvent) and ctx.deps.on_step is not None:
            await ctx.deps.on_step(_describe(event.part))


def build(model: str) -> Agent[Deps, IssueDraft]:
    """The issue-drafting agent. One per process; `deps` carries the run's state."""
    agent = Agent[Deps, IssueDraft](
        model,
        deps_type=Deps,
        output_type=IssueDraft,
        instructions=INSTRUCTIONS,
        retries=2,
        capabilities=[ProcessEventStream(_report_steps)],
    )

    @agent.output_validator
    def _known_repo(ctx: RunContext[Deps], draft: IssueDraft) -> IssueDraft:
        candidates = ctx.deps.candidates
        if candidates and draft.repo not in candidates:
            raise ModelRetry(
                f"`{draft.repo}` isn't one of the candidates. Choose from: "
                + ", ".join(f"`{c}`" for c in candidates)
            )
        return draft

    def _repo(ctx: RunContext[Deps], repo: str) -> tuple[str, str]:
        return split_repo(repo, ctx.deps.org)

    @agent.tool
    async def search_code(ctx: RunContext[Deps], query: str) -> list[dict[str, str]]:
        """Find code across the org by keyword.

        This is an index, not a grep: it only sees each repo's default branch,
        skips files over 384KB, is rate-limited to ~10 calls/minute, and does not
        do regex. Use it to locate a symbol or string, then read_file to confirm.
        """
        try:
            resp = await ctx.deps.github.rest.search.async_code(
                q=f"{query} org:{ctx.deps.org}", per_page=_MAX_RESULTS
            )
        except GitHubException as exc:
            return [{"error": f"search failed: {exc}"}]
        return [
            {"repo": item.repository.full_name, "path": item.path}
            for item in resp.parsed_data.items
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
        except GitHubException as exc:
            return f"could not read {path}: {exc}"
        data = resp.parsed_data
        content = getattr(data, "content", None)
        if content is None:  # a directory, or a symlink/submodule
            return f"{path} is not a file; use list_dir"
        text = base64.b64decode(content).decode("utf-8", "replace")
        if len(text) > _MAX_FILE_CHARS:
            return text[:_MAX_FILE_CHARS] + f"\n…[truncated at {_MAX_FILE_CHARS} chars]"
        return text

    @agent.tool
    async def list_dir(
        ctx: RunContext[Deps], repo: str, path: str = ""
    ) -> list[dict[str, str]]:
        """List a directory, to get oriented before reading files."""
        owner, name = _repo(ctx, repo)
        try:
            resp = await ctx.deps.github.rest.repos.async_get_content(owner, name, path)
        except GitHubException as exc:
            return [{"error": f"could not list {path or '/'}: {exc}"}]
        data = resp.parsed_data
        if not isinstance(data, list):
            return [{"error": f"{path} is a file; use read_file"}]
        return [{"name": e.name, "type": e.type} for e in data]

    @agent.tool
    async def similar_issues(
        ctx: RunContext[Deps], repo: str, query: str
    ) -> list[dict[str, object]]:
        """Search a repo's existing issues, to catch duplicates before drafting."""
        owner, name = _repo(ctx, repo)
        try:
            resp = await ctx.deps.github.rest.search.async_issues_and_pull_requests(
                q=f"{query} repo:{owner}/{name} is:issue", per_page=_MAX_RESULTS
            )
        except GitHubException as exc:
            return [{"error": f"search failed: {exc}"}]
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
    async def repo_labels(ctx: RunContext[Deps], repo: str) -> list[str]:
        """The labels this repo actually has. Don't propose any others."""
        owner, name = _repo(ctx, repo)
        try:
            resp = await ctx.deps.github.rest.issues.async_list_labels_for_repo(
                owner, name, per_page=100
            )
        except GitHubException as exc:
            return [f"error: {exc}"]
        return [label.name for label in resp.parsed_data]

    @agent.tool
    async def recent_commits(
        ctx: RunContext[Deps], repo: str, path: str | None = None
    ) -> list[dict[str, str]]:
        """Recent commits, optionally only those touching one path — useful for
        working out whether something regressed and who last touched it."""
        owner, name = _repo(ctx, repo)
        try:
            resp = await ctx.deps.github.rest.repos.async_list_commits(
                owner, name, per_page=10, **({"path": path} if path else {})
            )
        except GitHubException as exc:
            return [{"error": f"could not list commits: {exc}"}]
        return [
            {
                "sha": c.sha[:8],
                "message": (c.commit.message or "").split("\n")[0],
                "author": (c.commit.author.name if c.commit.author else "") or "",
            }
            for c in resp.parsed_data
        ]

    return agent


def _prompt(
    transcript: Transcript,
    candidates: list[str],
    instruction: str | None,
    requester: str | None = None,
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
        '"me" and "I" mean them, not whoever spoke in the conversation.\n\n'
        if requester
        else ""
    )

    # The instruction goes first: it's what the person actually wants, and the
    # conversation is only evidence for it.
    asked = (
        f"What they asked for:\n{instruction}\n\n"
        "Draft that issue. The conversation below is your evidence — use the parts "
        "that bear on it and ignore the rest.\n\n"
        if instruction
        else "Work out what issue this conversation is asking for.\n\n"
    )

    parts: list[UserContent] = [
        f"{who}{asked}{repo_line}\n\n"
        f"Discord conversation, oldest message first:\n\n{transcript.text}"
    ]
    parts.extend(
        BinaryContent(data=data, media_type=kind) for data, kind in transcript.images
    )
    if transcript.images:
        parts.append("The images above were shared in that conversation.")
    return parts


class Session:
    """One draft being iterated on, with the agent history behind it.

    Keeping the history is what makes refining cheap: the agent already read the
    files it needed, and starting over would read them again.
    """

    def __init__(
        self,
        agent: Agent[Deps, IssueDraft],
        deps: Deps,
        requester: str | None = None,
    ) -> None:
        self._agent = agent
        self._deps = deps
        self._requester = requester
        self._history: list[ModelMessage] = []
        self.draft: IssueDraft | None = None

    def report_to(self, on_step: Callable[[str], Awaitable[None]] | None) -> None:
        """Send progress somewhere else — a refine writes to a different message."""
        self._deps.on_step = on_step

    async def _run(self, prompt: str | Sequence[UserContent]) -> IssueDraft:
        result = await self._agent.run(
            prompt, deps=self._deps, message_history=self._history or None
        )
        self._history = list(result.all_messages())
        self.draft = result.output
        return result.output

    async def start(
        self,
        transcript: Transcript,
        candidates: list[str],
        *,
        prompt: str | None = None,
    ) -> IssueDraft:
        """First pass: what the requester asked for, grounded in the conversation."""
        self._deps.candidates = candidates
        return await self._run(_prompt(transcript, candidates, prompt, self._requester))

    async def refine(self, feedback: str, candidates: list[str]) -> IssueDraft:
        """Revise the current draft from a human's note."""
        self._deps.candidates = candidates
        who = self._requester or "the person who asked for it"
        return await self._run(f"Revise the draft. Feedback from {who}:\n\n{feedback}")
