"""The agent's tools, one toolset per system it talks to.

Each toolset carries its own instructions, so the guidance for a tool lives next
to the tool. Adding a system (Vercel, an OTEL server) means a new module here and
one line in `build()`.

Read-only throughout: nothing here writes anywhere. The one write in this bot,
creating the issue, is a human pressing Submit in `bridge.cogs.issues`.
"""

from pydantic_ai import AbstractToolset

from bridge.agent.tools import discord, github, linear
from bridge.agent.tools._shared import (
    Deps,
    Reader,
    Unattached,
    Unconfigured,
    Workspace,
)

__all__ = [
    "Deps",
    "Reader",
    "Unattached",
    "Unconfigured",
    "Workspace",
    "build",
]


def build() -> list[AbstractToolset[Deps]]:
    """Every toolset the agent runs with, GitHub first so its instructions lead.

    Linear second, so its "code goes to GitHub" line lands beside GitHub's own
    prose rather than after Discord's.
    """
    # 31 tools across the three, which is where the long tail starts to cost more
    # than it earns: every schema and docstring ships in every request, including
    # the many that never touch Linear. So the two document tools defer — a
    # document is only ever reached after a listing or a project pointed at it,
    # never as a run's first call, which is what makes a round trip to discover it
    # cheap.
    #
    # `.defer_loading()` only marks them; the `ToolSearch` capability in
    # `core.build` is what hides them, and without it this line costs nothing and
    # saves nothing. Deferring also keeps a toolset's `instructions` in context
    # either way, so what it saves is schemas and not prose. The next candidates
    # are GitHub's deep tools (`check_failures`, `pull_request_comments`,
    # `compare_refs`), each likewise only reached once a broader tool pointed at it.
    return [
        github.toolset(),
        linear.toolset().defer_loading(["linear_documents", "linear_document"]),
        discord.toolset(),
    ]
