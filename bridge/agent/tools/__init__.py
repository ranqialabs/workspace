"""The agent's tools, one toolset per system it talks to.

Each toolset carries its own instructions, so the guidance for a tool lives next
to the tool. Adding a system (Linear, Vercel, an OTEL server) means a new module
here and one line in `build()`.

Read-only throughout: nothing here writes anywhere. The one write in this bot,
creating the issue, is a human pressing Submit in `bridge.cogs.issues`.
"""

from pydantic_ai import AbstractToolset

from bridge.agent.tools import discord, github
from bridge.agent.tools._shared import Deps, Unattached, Workspace

__all__ = ["Deps", "Unattached", "Workspace", "build"]


def build() -> list[AbstractToolset[Deps]]:
    """Every toolset the agent runs with, GitHub first so its instructions lead."""
    # Past ~30 tools, .defer_loading() the long tail instead of shipping every
    # schema in every request.
    return [github.toolset(), discord.toolset()]
