"""A Discord conversation -> the agent's own message history.

The thread is the conversation, so it is also the store for it. Rather than
holding `list[ModelMessage]` in RAM per thread — which caps how many drafts can
be open, dies on every restart, and has to be kept in step with what people can
plainly see — we read the thread back and rebuild the history from it.

That makes the same trick the rest of the bridge already leans on (`#bot-config`
holds the mappings, a preview card holds its own draft) cover conversations too:
the channel is the truth, and there is nothing to keep in step because there is
only one copy.

What comes back is prose turns only: what people said, and what we said. Tool
calls are deliberately left out — they belong to the run that made them, and a
rebuilt history that mentioned a call without its result would be a history no
provider accepts. The cost is that a rebuilt run may re-read a file it read
before; the gain is that the history is always exactly what the thread shows.

No LLM and no Discord writes here, same as `context` — this module is readable
and reasonable about without either.
"""

import discord
from pydantic_ai import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)

from bridge.agent.context import speaker
from bridge.store import Store

_MAX_TURNS = 60  # turns rebuilt; a long thread costs tokens on every reply
# Chars of any single turn. Above one Discord message on purpose: an answer that
# spilled is rejoined here, and capping at the message ceiling would cut every
# long answer back down to its first segment.
_MAX_TURN_CHARS = 8_000


def _ours(message: discord.Message, bot_user_id: int) -> bool:
    return message.author.id == bot_user_id


def _is_status(message: discord.Message) -> bool:
    """Our own scaffolding, as opposed to something we said.

    Progress cards, the collapsed run summary and the draft preview are all about
    watching a run rather than talking, so they are not turns in the conversation.
    A draft is not skipped for being unimportant — it is the artifact, and it
    reaches the agent as the current draft rather than as something it once said.
    """
    return bool(message.embeds) or message.content.startswith("-#")


async def rebuild(
    channel: discord.abc.Messageable,
    store: Store,
    *,
    bot_user_id: int,
    limit: int = _MAX_TURNS,
) -> list[ModelMessage]:
    """The conversation in `channel` as history the agent can be handed.

    Oldest first, which is the order a history has to be in. People become user
    turns named the way `context.speaker` names them everywhere else; our own
    messages become the assistant's turns, so the agent sees what it already
    said instead of repeating it.
    """
    collected: list[discord.Message] = []
    async for message in channel.history(limit=min(limit * 2, 200)):
        if _ours(message, bot_user_id):
            if _is_status(message):
                continue
        elif message.author.bot:
            continue  # another bot's noise is not part of the conversation
        if not message.content.strip():
            continue
        collected.append(message)
        if len(collected) >= limit:
            break
    collected.reverse()  # history() is newest-first; a history reads oldest-first
    return _turns(collected, store, bot_user_id=bot_user_id)


async def rebuild_chain(
    message: discord.Message,
    store: Store,
    *,
    bot_user_id: int,
    limit: int = _MAX_TURNS,
) -> list[ModelMessage]:
    """The reply chain ending at `message`, as history, excluding `message`.

    A busy channel is several conversations at once, so rebuilding the last sixty
    messages there would hand the agent all of them as one exchange. A reply says
    which message it answers, so walking those references back picks out exactly
    one conversation and nothing else.

    `message` itself is left out: it is the request being made now, which the
    caller sends as the prompt.
    """
    walked: list[discord.Message] = []
    seen: set[int] = {message.id}
    current = message
    while len(walked) < limit:
        parent = await replied_to(current)
        if parent is None or parent.id in seen:  # guard: a cycle would spin here
            break
        seen.add(parent.id)
        current = parent
        if _skippable(parent, bot_user_id):
            continue  # walk past our scaffolding; the chain runs through it
        walked.append(parent)
    walked.reverse()  # walked backwards from the reply; a history reads forwards
    return _turns(walked, store, bot_user_id=bot_user_id)


async def replied_to(message: discord.Message) -> discord.Message | None:
    """The message `message` replies to, if it replies to one we can read."""
    ref = message.reference
    if ref is None or ref.message_id is None:
        return None
    if isinstance(ref.resolved, discord.Message):
        return ref.resolved  # already in the payload; no fetch needed
    try:
        return await message.channel.fetch_message(ref.message_id)
    except discord.HTTPException:
        return None  # deleted, or in a channel we've lost access to


def _skippable(message: discord.Message, bot_user_id: int) -> bool:
    """Whether this message is scaffolding or noise rather than a turn."""
    if _ours(message, bot_user_id):
        return _is_status(message) or not message.content.strip()
    return message.author.bot or not message.content.strip()


def _turns(
    collected: list[discord.Message], store: Store, *, bot_user_id: int
) -> list[ModelMessage]:
    """Messages, oldest first, as alternating request/response turns."""
    turns: list[ModelMessage] = []
    for message in collected:
        if _ours(message, bot_user_id):
            # An answer over the ceiling was sent as several messages but was one
            # thing said, so rejoin it rather than hand back pieces cut mid-word.
            if turns and isinstance(last := turns[-1], ModelResponse):
                turns[-1] = _extended(last, message.content)
                continue
            turns.append(
                ModelResponse(parts=[TextPart(content=_capped(message.content))])
            )
            continue
        login = store.login_for(message.author.id)
        body = _capped(message.content)
        turns.append(
            ModelRequest(
                parts=[
                    UserPromptPart(content=f"{speaker(message.author, login)}: {body}")
                ]
            )
        )
    return turns


def _capped(text: str) -> str:
    return text[:_MAX_TURN_CHARS]


def _extended(turn: ModelResponse, more: str) -> ModelResponse:
    """`turn` with the next message of the same answer appended to it.

    Joined on a blank line because that is what the split took out: segments are
    cut at a break and stripped.
    """
    part = turn.parts[-1]
    if not isinstance(part, TextPart):
        return turn
    joined = _capped(f"{part.content}\n\n{more}".strip())
    return ModelResponse(parts=[*turn.parts[:-1], TextPart(content=joined)])
