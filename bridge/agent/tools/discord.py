"""What the agent may read from the Discord side of the conversation.

Both tools reach Discord through the `Workspace` protocol rather than a client of
their own: the run already belongs to a thread, and the workspace knows which.
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
        """Who can be assigned, as `login` and the `name` people call them by.

        The conversation uses first names; GitHub only takes logins. Resolve any
        name through this list before setting `assignee` — a name that isn't
        here has no GitHub account we know of.
        """
        mapped = ctx.deps.workspace.teammates()
        if not mapped:
            raise ToolFailed("nobody is mapped yet; `/map user` links a login")
        return [{"login": login, "name": name} for login, name in mapped.items()]

    return tools
