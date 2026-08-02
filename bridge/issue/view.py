"""The buttons under a draft, and the modals behind two of them.

Every button carries the requester's id in its own custom_id, so "only whoever
ran /issue may act" survives a restart with no state on our side — and so does
the button itself. DynamicItem is what makes that possible: discord.py matches
the custom_id against `template` and rebuilds the item from the match.

The handlers live on the cog (see `Actions`); this module is only the widgets.
"""

from typing import Protocol, runtime_checkable

import discord
from discord.ext import commands

from bridge.issue.draft import IssueDraft

_DENIED = "Only whoever ran `/issue` can act on this draft."


@runtime_checkable
class Actions(Protocol):
    """What the widgets call back into — implemented by the issues cog."""

    def draft_for(self, interaction: discord.Interaction) -> IssueDraft | None: ...
    async def submit(self, interaction: discord.Interaction) -> None: ...
    async def apply_edit(
        self, interaction: discord.Interaction, title: str, body: str
    ) -> None: ...
    async def refine(self, interaction: discord.Interaction, feedback: str) -> None: ...
    async def cancel(self, interaction: discord.Interaction) -> None: ...
    async def start_from_menu(
        self,
        interaction: discord.Interaction,
        message: discord.Message,
        prompt: str | None,
    ) -> None: ...


def _actions(interaction: discord.Interaction) -> Actions | None:
    """The issues cog, found through the client the interaction arrived on."""
    client = interaction.client
    if not isinstance(client, commands.Bot):
        return None
    cog = client.get_cog("Issues")
    return cog if isinstance(cog, Actions) else None


class _DraftButton(
    discord.ui.DynamicItem[discord.ui.Button],
    template=r"issue:(?P<action>\w+):(?P<author>\d+)",
):
    """One button under a draft. Subclasses set the class attributes and `act`.

    Each subclass narrows `template` to its own prefix, so discord.py routes a
    click straight to the right class.
    """

    prefix: str
    label: str
    style: discord.ButtonStyle

    def __init_subclass__(cls, **kwargs) -> None:
        kwargs.setdefault("template", rf"issue:{cls.prefix}:(?P<author>\d+)")
        super().__init_subclass__(**kwargs)

    def __init__(self, author_id: int) -> None:
        self.author_id = author_id
        super().__init__(
            discord.ui.Button[discord.ui.View](
                label=self.label,
                style=self.style,
                custom_id=f"issue:{self.prefix}:{author_id}",
            )
        )

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls(int(match["author"]))

    async def callback(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message(_DENIED, ephemeral=True)
            return
        await self.act(interaction)

    async def act(self, interaction: discord.Interaction) -> None: ...


class ApproveButton(_DraftButton):
    prefix, label, style = "approve", "Submit", discord.ButtonStyle.success

    async def act(self, interaction: discord.Interaction) -> None:
        # Creating the issue takes a round trip; ack before the 3s window closes.
        await interaction.response.defer()
        if (actions := _actions(interaction)) is not None:
            await actions.submit(interaction)


class EditButton(_DraftButton):
    prefix, label, style = "edit", "Edit", discord.ButtonStyle.secondary

    async def act(self, interaction: discord.Interaction) -> None:
        actions = _actions(interaction)
        draft = actions.draft_for(interaction) if actions is not None else None
        if draft is None:
            await interaction.response.send_message(
                "Couldn't read this draft — start a new `/issue`.", ephemeral=True
            )
            return
        await interaction.response.send_modal(EditModal(draft))


class RefineButton(_DraftButton):
    prefix, label, style = "refine", "Refine", discord.ButtonStyle.primary

    async def act(self, interaction: discord.Interaction) -> None:
        # A modal rather than "type your feedback in the thread": it acks the
        # interaction for free, and can't be confused with other people talking.
        await interaction.response.send_modal(RefineModal())


class CancelButton(_DraftButton):
    prefix, label, style = "cancel", "Discard", discord.ButtonStyle.danger

    async def act(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        if (actions := _actions(interaction)) is not None:
            await actions.cancel(interaction)


class EditModal(discord.ui.Modal, title="Edit draft"):
    """Hand-edit the title and body, pre-filled with what the agent wrote."""

    def __init__(self, draft: IssueDraft) -> None:
        super().__init__()
        self.title_input = discord.ui.TextInput(
            label="Title", default=draft.title, max_length=256
        )
        # Discord caps a paragraph input at 4000 chars, so a very long body gets
        # clipped by editing it. The agent's own text is normally well under.
        self.body_input = discord.ui.TextInput(
            label="Body",
            default=draft.body[:4000],
            style=discord.TextStyle.paragraph,
            max_length=4000,
        )
        self.add_item(self.title_input)
        self.add_item(self.body_input)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        if (actions := _actions(interaction)) is not None:
            await actions.apply_edit(
                interaction, self.title_input.value, self.body_input.value
            )


class PromptModal(discord.ui.Modal, title="Draft an issue"):
    """Asks what the issue is about before drafting from a picked message.

    Holds the cog and message directly — it's opened and submitted inside one
    interaction, so there's nothing to survive a restart.
    """

    prompt = discord.ui.TextInput(
        label="What's the issue?",
        placeholder="Optional — e.g. the fork PRs failing CI, not the renderer",
        style=discord.TextStyle.paragraph,
        max_length=1000,
        required=False,
    )

    def __init__(self, cog: Actions, message: discord.Message) -> None:
        super().__init__()
        self._cog = cog
        self._message = message

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        await self._cog.start_from_menu(
            interaction, self._message, self.prompt.value or None
        )


class RefineModal(discord.ui.Modal, title="Refine draft"):
    """Tell the agent what to change; it revises with its history intact."""

    feedback = discord.ui.TextInput(
        label="What should change?",
        placeholder="e.g. this is about the webhook handler, not the renderer",
        style=discord.TextStyle.paragraph,
        max_length=1000,
    )

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        if (actions := _actions(interaction)) is not None:
            await actions.refine(interaction, self.feedback.value)


BUTTONS = (ApproveButton, RefineButton, EditButton, CancelButton)


def draft_view(author_id: int) -> discord.ui.View:
    """The four buttons, bound to whoever asked for the draft.

    timeout=None because the view is never held in memory — the buttons are
    rebuilt from their custom_id when clicked, however much later that is.
    """
    view = discord.ui.View(timeout=None)
    for button in BUTTONS:
        view.add_item(button(author_id))
    return view
