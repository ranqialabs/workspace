"""The agent behind a conversation: it answers, or it proposes an issue.

A run ends one of two ways, and the model picks which: prose, when someone asked
a question, or an `IssueDraft`, when they asked for an issue. Anything that isn't
a draft leaves the current draft alone — a question about the code must not
rewrite the issue someone is still reviewing.

Read-only by construction: nothing the agent can call writes anywhere. Submitting
is the cog's job, behind a human click — so a confused model can waste tokens but
never open an issue. `propose_issue` is an output, not an action: it ends the run
with a draft for a human to look at, and reaches GitHub only if they press Submit.

The tools live in `bridge.agent.tools`; this module is the output contract, the
prompts, and the `Session` that holds a conversation's history between turns.
"""

import logging
from collections.abc import AsyncIterable, Awaitable, Callable, Sequence

import httpx
from pydantic_ai import (
    Agent,
    AgentStreamEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelRetry,
    RunContext,
    TextOutput,
    ToolOutput,
    ToolReturnPart,
    UserContent,
)
from pydantic_ai.capabilities import ProcessEventStream, ToolSearch
from pydantic_ai.exceptions import ModelAPIError, UsageLimitExceeded

from bridge.agent import tools
from bridge.agent.context import Transcript
from bridge.agent.draft import IssueDraft
from bridge.agent.tools import Deps

log = logging.getLogger(__name__)

_MAX_ERROR_CHARS = 400  # provider messages can carry a whole request dump
# Errors from these come straight out of the stream, untranslated by pydantic-ai.
_PROVIDER_SDKS = frozenset({"openai", "anthropic", "google", "groq", "mistralai"})

type Reply = IssueDraft | str
"""How a run ended: a draft to review, or an answer to read.

Narrow it with `isinstance(reply, IssueDraft)` — a `str` is the agent talking,
and carries no draft, so it must never overwrite one.
"""

INSTRUCTIONS = """\
You are a developer on this team, talking to your colleagues in Discord. You read
the code, you answer questions about it, and when someone asks for an issue you
write one.

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

The repo an issue is going to says what shape it takes. Once you know which one
it is, and before you call `propose_issue`, read what it published:
`.github/ISSUE_TEMPLATE` with `list_dir`, then its `CLAUDE.md` and
`CONTRIBUTING.md`. Follow them — a draft that drops the fields a project asked
for arrives wrong. Read them once per repo in a conversation, not once per turn,
and not at all when you're answering a question rather than drafting.

Rules:
- `title` is `type: what changes` — `fix`, `feat`, `chore`, `refactor` — unless
  the repo says otherwise. A reader scanning the list should be able to tell
  what the issue is from the title alone.
- Keep it tight. A short issue gets picked up and a long one gets skipped, so
  cut background the assignee already knows, and leave a section out rather than
  padding it. An empty template section is worse than no section.
- Cite `path/to/file.py:line` where the work lands. Quote the message that
  settled something instead of paraphrasing it; drop the rest of the chatter.
- Never invent detail the conversation doesn't support. Put what you'd need to
  know in `questions` instead — a short draft with honest questions beats a
  confident wrong one. Leave out anything the issue itself is meant to discover.
- `questions` is for what blocks someone from starting, not for design choices
  whose answer is the work.
- Choose `repo` only from the candidates you're given — the code you read to
  understand the problem is not restricted, but where it gets filed is.
- Choose `labels` only from the repo's existing labels (`repo_labels`).
- `assignee` is a GitHub login — the `github` field on `teammates` — not a name
  from the conversation. If nobody there matches, leave it null and ask who takes
  it in `questions` — a login that doesn't exist is rejected, and one that does
  assigns a stranger.
- Assign only who was actually named or agreed on. When the person you are
  talking to asks for it themselves, that is their login — not the one who
  started the discussion.
- Set `confidence` to how well the conversation actually specifies the work:
  `high` only when someone could start on it as written.
- If `similar_issues` turns up a real duplicate, say so at the top of the body
  and link it.
"""


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
        toolsets=tools.build(),
        retries=2,
        # `ToolSearch` is what actually hides the deferred tools: `.defer_loading()`
        # only marks them, and naming any capability here replaces the default set
        # that would otherwise have supplied it. Without it the long tail ships in
        # every request, silently — the tools still work, so nothing fails, it just
        # costs what deferring them was meant to save.
        capabilities=[ProcessEventStream(_report_steps), ToolSearch()],
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

    return agent


def _with_conversation(preamble: str, transcript: Transcript) -> list[UserContent]:
    """A prompt's wording, then the conversation it is about and its images.

    The assembly rather than the wording: every entry point ends the same way —
    the transcript last, its images after it, and a line saying where they came
    from — and only the framing above it differs. Kept in one place so a change
    to how images are attached reaches every prompt at once.
    """
    # A caller handing over history sends no transcript, and a bare header over
    # nothing reads as a conversation that failed to load.
    parts: list[UserContent] = [
        f"{preamble}\n\nThe conversation, oldest message first:\n\n{transcript.text}"
        if transcript.text.strip()
        else preamble
    ]
    parts.extend(transcript.images)
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
    # the discussion. Scoped to the turn rather than the conversation, because
    # colleagues with access to the repo review the draft in the thread too.
    who = (
        f"You are talking to {requester}, who asked for this issue. Every turn "
        'says who wrote it, and "me" and "I" always mean that person, not whoever '
        "spoke in the conversation below."
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
    continuing: bool = False,
) -> list[UserContent]:
    """The prompt for a request made by mentioning us in a conversation.

    Unlike `/issue`, this doesn't say what the outcome should be — answering and
    proposing an issue are both on the table and the instructions govern which.
    What it does say is how little context it came with, and that reading more is
    the agent's job: without that the model answers confidently off eight
    messages it should have known were not the whole story.

    `continuing` means the exchange came back as history, so the note points at
    that rather than at a transcript that isn't there.
    """
    listed = ", ".join(f"`{c}`" for c in candidates) or "(none mapped)"
    if continuing:
        context_note = (
            "They replied to something you said, so this continues the exchange "
            "above — what you have already said to each other is that history."
        )
    elif pointed_at:
        context_note = (
            "They replied to a specific message, so that message and their request "
            "are below. That reply is them pointing at something."
        )
    else:
        context_note = (
            "Below are the last few messages of the channel, for orientation only."
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

    def saying(self, feedback: str, speaker: str) -> str:
        """A human's turn, attributed to whoever wrote it.

        `speaker` is named on every turn, not only when it isn't the requester: a
        conversation has several people in it, and a uniform attribution is what
        lets the agent tell whose "me" it is reading. Named by `context.speaker`,
        like anywhere else a person reaches the model.
        """
        return f"{speaker} says:\n\n{feedback}"

    def resuming(self, feedback: str, speaker: str) -> str:
        """A turn in a conversation rebuilt from its thread rather than held.

        The draft is restated because a rebuilt history has the preview card
        filtered out of it, so the agent would otherwise be revising an issue it
        can't see. Its fields come from the card, so this is what the thread shows.
        """
        if self.draft is None:
            return self.saying(feedback, speaker)
        return (
            "The issue draft currently under review in this conversation:\n"
            f"{self.draft.model_dump_json(indent=2)}\n\n"
            + self.saying(feedback, speaker)
        )
