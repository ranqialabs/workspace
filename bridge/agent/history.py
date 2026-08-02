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
_MAX_TURN_CHARS = 4_000  # chars of any single turn


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

    turns: list[ModelMessage] = []
    for message in collected:
        body = message.content[:_MAX_TURN_CHARS]
        if _ours(message, bot_user_id):
            turns.append(ModelResponse(parts=[TextPart(content=body)]))
            continue
        login = store.login_for(message.author.id)
        turns.append(
            ModelRequest(
                parts=[
                    UserPromptPart(content=f"{speaker(message.author, login)}: {body}")
                ]
            )
        )
    return turns
