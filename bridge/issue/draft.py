"""The proposed issue, and how it looks in Discord while it's still a proposal.

Pure: no Discord reads, no GitHub calls, no LLM. The preview embed doubles as
storage — see `from_embed`, which recovers a draft after a restart.
"""

import json
from typing import Literal

import discord
from pydantic import BaseModel, Field, ValidationError

from bridge import live
from bridge.render import BLUE, GREEN, GREY

PREVIEW_LIMIT = 1500  # body chars shown in the preview; GitHub gets the full text

_CONFIDENCE_COLOR = {"high": GREEN, "medium": BLUE, "low": GREY}


class IssueDraft(BaseModel):
    """What the agent proposes. Nothing here is trusted: `repo` is checked
    against the store and `assignee` against the org before we act on it."""

    title: str = Field(max_length=256)
    body: str
    repo: str  # "owner/name"
    labels: list[str] = Field(default_factory=list, max_length=8)
    assignee: str | None = None  # github login
    confidence: Literal["high", "medium", "low"] = "medium"
    questions: list[str] = Field(default_factory=list, max_length=5)
    """What the agent couldn't tell from the conversation. Asking beats inventing."""


def preview(draft: IssueDraft, *, note: str | None = None) -> discord.Embed:
    """The draft as a reviewable card."""
    body = draft.body[:PREVIEW_LIMIT]
    if len(draft.body) > PREVIEW_LIMIT:
        body += "\n\n..."
    embed = discord.Embed(
        title=draft.title,
        description=body,
        color=_CONFIDENCE_COLOR[draft.confidence],
    )
    embed.set_author(name=f"📝 draft issue · {draft.repo}")
    embed.add_field(name="Repo", value=f"`{draft.repo}`", inline=True)
    embed.add_field(
        name="Assignee",
        value=f"`{draft.assignee}`" if draft.assignee else "—",
        inline=True,
    )
    if draft.labels:
        embed.add_field(
            name="Labels",
            value=", ".join(f"`{lbl}`" for lbl in draft.labels),
            inline=False,
        )
    if draft.questions:
        embed.add_field(
            name="Open questions",
            value="\n".join(f"- {q}" for q in draft.questions)[:1024],
            inline=False,
        )
    if note:
        embed.add_field(name="⚠️", value=note[:1024], inline=False)
    embed.set_footer(text=f"confidence: {draft.confidence} · not submitted yet")
    # The card is the draft's only storage once this process forgets it, so the
    # model rides along invisibly instead of being re-read from its own prose.
    # Everything but the body, which is unbounded and would burst the footer —
    # it comes back from the description.
    return live.stamp(embed, draft.model_dump_json(exclude={"body"}))


def from_embed(embed: discord.Embed) -> IssueDraft | None:
    """Recover a draft from its own preview card.

    The session dict lives in memory, so a restart loses it while the buttons
    (whose state rides in their custom_id) keep working. The card is the backup
    store — the same channel-as-truth trick the config and live messages use.

    The body comes from the visible preview, so one longer than `PREVIEW_LIMIT`
    comes back truncated; every other field is exact.
    """
    payload = live.decode(embed.footer.text)
    if payload is None:
        return None
    try:
        fields = json.loads(payload)
    except json.JSONDecodeError:
        return None
    fields["body"] = (embed.description or "").removesuffix("\n\n...")
    try:
        return IssueDraft.model_validate(fields)
    except ValidationError:
        return None
