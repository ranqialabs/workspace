"""What the agent may read from the Discord side of the conversation.

Both tools reach Discord through the `Workspace` protocol rather than a client of
their own: the run already belongs to a thread, and the workspace knows which.

`teammates` lives here rather than beside either system's tools because the
mapping is Discord's: the member is the key a GitHub login and a Linear email meet
through, and neither system knows about the other.
"""

from pydantic_ai import FunctionToolset, RunContext, ToolFailed

from bridge.agent.tools._shared import Deps


def toolset() -> FunctionToolset[Deps]:
    """The Discord reading tools, as one registerable group."""
    tools = FunctionToolset[Deps]()

    @tools.tool
    async def read_conversation(ctx: RunContext[Deps], messages: int = 25) -> str:
        """Read further back in this Discord channel, before what you were given.

        Use this when you were dropped into the middle of a conversation and what
        someone means by "this" or "isso" is in messages you can't see — reading
        more beats guessing. Ask for more if the first read doesn't settle it.
        Reads only the channel the request came from, and only messages already
        there. `read_back` caps how far a single call reaches.
        """
        earlier = await ctx.deps.workspace.earlier(messages)
        return earlier or "(nothing earlier in this channel)"

    @tools.tool
    def teammates(ctx: RunContext[Deps]) -> list[dict[str, str]]:
        """Who is who here: the `name` people use, and the accounts it maps to.

        The conversation uses first names; GitHub takes a `github` login and
        Linear takes a `linear` email. Resolve any name through this list before
        setting `assignee` or filtering by a person — a name that isn't here has
        no account we know of, and a first name is not a login.

        The two account fields fill in independently, because they are separate
        mappings on the same person. An empty `github` means nobody ran
        `/map github` for them; an empty `linear` means nobody ran `/map linear`,
        **not** that they have no work in Linear. Say which half you have rather
        than reporting an empty board for the half you don't.
        """
        mapped = ctx.deps.workspace.people()
        if not mapped:
            raise ToolFailed(
                "nobody is mapped yet; `/map github` links a login and "
                "`/map linear` links a Linear member"
            )
        return mapped

    return tools
