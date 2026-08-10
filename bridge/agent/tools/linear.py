"""Everything the agent may read from Linear: teams, projects, issues, documents.

Read-only by construction, like the GitHub toolset, and here the credential
agrees: the app asks for the `read` scope and nothing else.

Two shapes differ from the GitHub side. Listings page by cursor rather than by
number, because that is what Linear offers. And an empty listing is three-way
ambiguous rather than two-way: an app-actor token reaches only the teams it was
granted, so a missing name may be absent, ungranted, or filtered out —
`_nothing_matched` says all three.
"""

from typing import Any, Literal, cast

from pydantic_ai import FunctionToolset, RunContext, ToolFailed, ToolReturn

from bridge.agent.tools._shared import (
    MAX_BODY_CHARS,
    MAX_FILE_CHARS,
    MAX_RESULTS,
    MAX_SUMMARY_CHARS,
    Deps,
    applied,
    clipped,
    more_pages,
    reports_linear_failure,
    when,
)
from bridge.linear import Node, nodes as _nodes

INSTRUCTIONS = """\
Linear holds the work that is not directly code, and the containers that group it:
teams, projects, initiatives, cycles. Code goes to GitHub, so a Linear issue often
*points at* GitHub rather than containing anything — read its `links` and follow
them. Plenty of questions are about both systems, and answering half of one as
though it were the whole thing is the mistake to avoid.

`linear_teams` settles what you can see. This app acts with a token granted
specific teams, so anything missing is one of two things — absent, or never
granted — and those are very different things to tell somebody. Never say a
project does not exist because a listing came back empty.

`linear_vocabulary` is this workspace's own words for status and label. State
names are per-team and arbitrary, so filter `linear_issues` by `status`, which is
the state *type* and the same everywhere. Never assert a status or label that
isn't in the vocabulary.

Two id forms, not interchangeable. People say `RAN-123` out loud, which is what
`linear_issue` takes and what every listing row carries; a uuid is what a listing
hands back for a team or a document. Quote what the person said.

An empty filtered listing is not an empty workspace. `linear_issues` and
`linear_projects` both default to what is in flight, so backlog and planned work
is invisible until you ask for `all`.

A question about a person is a filter, not a listing to read by eye. `teammates`
maps the people here to both accounts, and `linear_issues` takes the Linear one as
`assignee_email`. Somebody with no `linear` there is not somebody with no Linear
work: say `/map linear` hasn't run for them rather than reporting an empty board.

A listing that didn't fit hands you a cursor. Pass it back as `after`; Linear pages
by cursor, so unlike GitHub there is no page number to ask for.

You cannot change anything in Linear. Asked to create, move, assign or close
something there, say so and say who can.
"""

type IssueStatus = Literal[
    "backlog", "unstarted", "started", "completed", "canceled", "all"
]
"""A workflow state's *type*, the only status name that means the same thing in
every team. `linear_vocabulary` lists a team's own names."""

type ProjectState = Literal[
    "planned", "started", "paused", "completed", "canceled", "all"
]
"""A project's own status type, which Linear keeps separate from an issue's."""

ROWS = MAX_RESULTS
MAX_DESCRIPTION_CHARS = 400
# Not `ROWS`: short names grouped by type, and six teams have more than fifteen.
STATES = 60


def _nothing_matched(noun: str, given: dict[str, str | None]) -> str:
    """An empty listing, said as the filters that emptied it — a bare empty list
    reads as "this does not exist", which under an app-actor token it may not."""
    filters = applied(given)
    if not filters:
        return (
            f"No {noun} at all in what this token can reach. That is either a "
            "genuinely empty workspace or a token granted no teams — `linear_teams` "
            "tells those apart. Read it before saying the workspace is empty."
        )
    return (
        f"No {noun} matching {filters} — a filtered result, not an empty workspace, "
        "and not proof the team or project is absent. Three things look identical "
        "here: the filter matched nothing, the team or project was never granted to "
        "this app, or the name is not what Linear calls it. `linear_teams` settles "
        "the last two, and `linear_vocabulary` has the status and label names. "
        "Check the name, then drop a filter and look again."
    )


def _not_found(what: str, which: str) -> ToolFailed:
    """A lookup that came back null. A failure rather than an empty answer: null
    and "not granted" are indistinguishable here."""
    return ToolFailed(
        f"No {what} {which} — which may mean it does not exist, or that it is in a "
        "team this app was not granted. `linear_teams` lists the teams reachable "
        "here; if its team is missing from that list, you cannot see it and should "
        "say so rather than say it is absent."
    )


def _page(connection: object) -> Node:
    """A connection's `pageInfo`, for `more_pages`."""
    if not isinstance(connection, dict):
        return {}
    info: object = connection.get("pageInfo")
    return cast(Node, info) if isinstance(info, dict) else {}


def _named(value: object, key: str = "name") -> str:
    """One field off a nested object, or "" — these are all nullable in Linear, and
    a row wants "" over a None the model reads as a field it got wrong."""
    if not isinstance(value, dict):
        return ""
    return str(value.get(key) or "")


def _names(connection: object, key: str = "name") -> list[str]:
    """The names of a nested connection: a project's teams, an issue's labels."""
    return [name for node in _nodes(connection) if (name := _named(node, key))]


def _person(value: object) -> str:
    """Somebody's display name, as a row should show it."""
    return _named(value, "displayName") or _named(value)


def _more(connection: object) -> bool:
    """Whether there is at least one. Linear exposes no count on every connection,
    so the cheap ask is `hasNextPage` on an empty page."""
    return bool(_page(connection).get("hasNextPage"))


# What "not finished" means, for the counts that answer "is anyone on this".
_OPEN = ["backlog", "unstarted", "started"]


def _filter(**given: object) -> dict[str, Any]:
    """A Linear filter with the absent conditions dropped. Built here rather than
    in the query because `{ null: true }` means *is null*, not *no filter*."""
    return {key: value for key, value in given.items() if value is not None}


def _listing(
    connection: object,
    rows: list[dict[str, object]],
    noun: str,
    given: dict[str, str | None] | None = None,
    *,
    narrowable: bool = True,
) -> ToolReturn[list[dict[str, object]]]:
    """A listing plus the one thing worth saying about it: more pages, or what
    emptied it."""
    return ToolReturn(
        rows,
        content=(
            more_pages(_page(connection), noun, narrowable=narrowable)
            if rows
            else _nothing_matched(noun, given or {})
        ),
    )


_TEAMS = """
query Teams($rows: Int!, $after: String) {
  teams(first: $rows, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      key
      name
      description
      activeCycle { number name startsAt endsAt progress }
      members(first: 0) { pageInfo { hasNextPage } }
    }
  }
}
"""

_PROJECTS = """
query Projects(
  $rows: Int!
  $after: String
  $filter: ProjectFilter
  $open: [String!]
) {
  projects(first: $rows, after: $after, orderBy: updatedAt, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name
      description
      url
      progress
      targetDate
      startedAt
      updatedAt
      health
      status { name type }
      lead { name displayName }
      teams(first: 5) { nodes { key } }
      initiatives(first: 3) { nodes { name } }
      issues(first: 0, filter: { state: { type: { in: $open } } }) {
        pageInfo { hasNextPage }
      }
    }
  }
}
"""

_INITIATIVES = """
query Initiatives($rows: Int!, $after: String) {
  initiatives(first: $rows, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name
      description
      status
      targetDate
      updatedAt
      owner { name displayName }
      projects(first: 15) { nodes { name } }
    }
  }
}
"""

_CYCLES = """
query Cycles($rows: Int!, $filter: CycleFilter) {
  cycles(first: $rows, orderBy: updatedAt, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      number
      name
      startsAt
      endsAt
      progress
      team { key }
      issues(first: 0) { pageInfo { hasNextPage } }
    }
  }
}
"""

# A fragment rather than a copied selection: both member queries return the same
# `UserConnection` and feed the same row, so the two cannot drift on what a member
# is. Appended to each document, since a fragment travels with the query using it.
_MEMBER_FIELDS = """
fragment MemberFields on UserConnection {
  pageInfo { hasNextPage endCursor }
  nodes {
    name
    displayName
    email
    active
    admin
    teams(first: 10) { nodes { key } }
  }
}
"""

_MEMBERS = (
    """
query Members($rows: Int!, $after: String) {
  users(first: $rows, after: $after) { ...MemberFields }
}
"""
    + _MEMBER_FIELDS
)

_TEAM_MEMBERS = (
    """
query TeamMembers($team: String!, $rows: Int!, $after: String) {
  team(id: $team) {
    members(first: $rows, after: $after) { ...MemberFields }
  }
}
"""
    + _MEMBER_FIELDS
)

_ISSUES = """
query Issues($rows: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $rows, after: $after, orderBy: updatedAt, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier
      title
      description
      priorityLabel
      estimate
      dueDate
      updatedAt
      url
      state { name type }
      assignee { name displayName }
      team { key }
      project { name }
      cycle { number }
      labels(first: 10) { nodes { name } }
    }
  }
}
"""

_ISSUE = """
query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    priorityLabel
    estimate
    dueDate
    createdAt
    updatedAt
    startedAt
    completedAt
    canceledAt
    url
    state { name type }
    assignee { name displayName }
    creator { name displayName }
    team { key }
    project { name }
    cycle { number }
    labels(first: 20) { nodes { name } }
    parent { identifier }
    children(first: 20) { nodes { identifier } }
    attachments(first: 10) { nodes { url } }
    comments(first: 0) { pageInfo { hasNextPage } }
  }
}
"""

_VOCABULARY = """
query Vocabulary($rows: Int!, $states: Int!, $filter: WorkflowStateFilter) {
  workflowStates(first: $states, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { name type position team { key } }
  }
  issueLabels(first: $rows) {
    pageInfo { hasNextPage endCursor }
    nodes { name }
  }
}
"""

_DOCUMENTS = """
query Documents($rows: Int!, $after: String, $filter: DocumentFilter) {
  documents(first: $rows, after: $after, orderBy: updatedAt, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      content
      url
      updatedAt
      creator { name displayName }
      project { name }
      initiative { name }
    }
  }
}
"""

_DOCUMENT = """
query Document($id: String!) {
  document(id: $id) {
    title
    content
    url
    createdAt
    updatedAt
    creator { name displayName }
    project { name }
    initiative { name }
  }
}
"""


def toolset() -> FunctionToolset[Deps]:
    """The Linear reading tools, as one registerable group."""
    tools = FunctionToolset[Deps](instructions=INSTRUCTIONS)

    # --- the shape of the workspace ---

    @tools.tool
    @reports_linear_failure
    async def linear_teams(
        ctx: RunContext[Deps], after: str | None = None
    ) -> ToolReturn[list[dict[str, object]]]:
        """Every team you can read, with its current cycle. The one tool that
        settles "can you see X": a team missing here either does not exist or was
        never granted to this app, so read it before calling anything absent.

        Also where team `key`s come from ("RAN"), which is what `linear_issues`,
        `linear_projects` and `linear_cycles` filter on. Never guess one.
        """
        data = await ctx.deps.linear.query(_TEAMS, {"rows": ROWS, "after": after})
        teams = data.get("teams")
        rows = [
            {
                "key": node.get("key"),
                "name": node.get("name"),
                "description": clipped(
                    str(node.get("description") or ""), MAX_SUMMARY_CHARS
                ),
                "cycle": _cycle(node.get("activeCycle")),
                "has_members": _more(node.get("members")),
            }
            for node in _nodes(teams)
        ]
        # Empty here explains every other tool's emptiness, so it is said outright.
        return ToolReturn(
            rows,
            content=(
                more_pages(_page(teams), "teams", narrowable=False)
                if rows
                else (
                    "This token reaches no teams. Either the app was granted none, "
                    "or Linear isn't set up for this workspace — say that rather "
                    "than reporting an empty board."
                )
            ),
        )

    @tools.tool
    @reports_linear_failure
    async def linear_vocabulary(
        ctx: RunContext[Deps], team: str | None = None
    ) -> ToolReturn[dict[str, object]]:
        """This workspace's own words for status and label. Read it before you
        assert or propose either — a status you guessed matches nothing and reads
        as an empty board. Pass a team `key` for one team's columns.

        `states` are grouped by the `type` that `linear_issues` filters on. Filter
        by type, which is the same everywhere; use these names only to report.
        """
        data = await ctx.deps.linear.query(
            _VOCABULARY,
            {"rows": ROWS, "states": STATES, "filter": _filter(team=_eq_key(team))},
        )
        grouped: dict[str, list[str]] = {}
        # Sorted by Linear's own board order, so `started` reads left to right.
        for node in sorted(
            _nodes(data.get("workflowStates")),
            key=lambda state: float(state.get("position") or 0),
        ):
            name, kind = str(node.get("name") or ""), str(node.get("type") or "")
            if name and kind:
                grouped.setdefault(kind, []).append(name)
        labels = data.get("issueLabels")
        states = data.get("workflowStates")
        # This tool takes no cursor, so a clipped vocabulary can only be said, not
        # paged past — and saying it matters: the instructions tell the model never
        # to assert a status outside this list.
        clipped_off = [
            noun
            for noun, connection in (("states", states), ("labels", labels))
            if _more(connection)
        ]
        return ToolReturn(
            {"states": grouped, "labels": _names(labels)},
            content=(
                f"More {' and '.join(clipped_off)} than fit here — pass a `team` to "
                "narrow this; treat the list as partial rather than complete."
                if clipped_off
                else None
            ),
        )

    # --- the containers work lives in ---

    @tools.tool
    @reports_linear_failure
    async def linear_projects(
        ctx: RunContext[Deps],
        team: str | None = None,
        initiative: str | None = None,
        state: ProjectState = "started",
        after: str | None = None,
    ) -> ToolReturn[list[dict[str, object]]]:
        """Projects: who leads them, how they are going, when they are due. Usually
        the answer to "de quem é isso" and "isso faz parte de quê".

        - `team`: a `key` from `linear_teams`, not a display name.
        - `initiative`: an initiative name, for "what is under X".
        - `state` defaults to `started`. Ask for `all` before saying a project does
          not exist — a planned or paused one is invisible by default.

        `health` is the lead's last call and goes stale, so read `updated_at`
        beside it. A project's issues are `linear_issues(project=)`.
        """
        given = {"team": team, "initiative": initiative, "state": state}
        variables = {
            "rows": ROWS,
            "after": after,
            "open": _OPEN,
            "filter": _filter(
                accessibleTeams=_some_key(team),
                initiatives=_contains_name(initiative),
                status=_in_type(None if state == "all" else [state]),
            ),
        }
        data = await ctx.deps.linear.query(_PROJECTS, variables)
        projects = data.get("projects")
        rows = [
            {
                "name": node.get("name"),
                "status": _named(node.get("status")),
                "health": node.get("health") or None,
                "lead": _person(node.get("lead")),
                "teams": _names(node.get("teams"), "key"),
                "initiative": ", ".join(_names(node.get("initiatives"))),
                "progress": node.get("progress"),
                "target_date": when(node.get("targetDate")),
                "started_at": when(node.get("startedAt")),
                "updated_at": when(node.get("updatedAt")),
                "has_open_issues": _more(node.get("issues")),
                "summary": clipped(
                    str(node.get("description") or ""), MAX_DESCRIPTION_CHARS
                ),
                "url": node.get("url"),
            }
            for node in _nodes(projects)
        ]
        return _listing(projects, rows, "projects", given)

    @tools.tool
    @reports_linear_failure
    async def linear_initiatives(
        ctx: RunContext[Deps], after: str | None = None
    ) -> ToolReturn[list[dict[str, object]]]:
        """Initiatives, and the projects under each — the widest container, what
        the quarter is about. For a project's own health and dates,
        `linear_projects`.
        """
        data = await ctx.deps.linear.query(_INITIATIVES, {"rows": ROWS, "after": after})
        initiatives = data.get("initiatives")
        rows = [
            {
                "name": node.get("name"),
                "status": node.get("status") or None,
                "owner": _person(node.get("owner")),
                "target_date": when(node.get("targetDate")),
                "updated_at": when(node.get("updatedAt")),
                "projects": _names(node.get("projects")),
                "summary": clipped(
                    str(node.get("description") or ""), MAX_DESCRIPTION_CHARS
                ),
            }
            for node in _nodes(initiatives)
        ]
        return _listing(initiatives, rows, "initiatives", narrowable=False)

    @tools.tool
    @reports_linear_failure
    async def linear_cycles(
        ctx: RunContext[Deps], team: str | None = None, current_only: bool = True
    ) -> ToolReturn[list[dict[str, object]]]:
        """Cycles: what a team is meant to finish in this stretch of time.

        `current_only` is "o que tá no sprint"; pass False for what a team just
        finished or takes on next. `team` is a `key` from `linear_teams`, and the
        work itself is `linear_issues(team=)`.
        """
        variables = {
            "rows": ROWS,
            "filter": _filter(
                team=_eq_key(team),
                isActive={"eq": True} if current_only else None,
            ),
        }
        data = await ctx.deps.linear.query(_CYCLES, variables)
        cycles = data.get("cycles")
        rows = [
            {
                "number": node.get("number"),
                "name": node.get("name") or None,
                "team": _named(node.get("team"), "key"),
                "starts_at": when(node.get("startsAt")),
                "ends_at": when(node.get("endsAt")),
                "progress": node.get("progress"),
                "has_issues": _more(node.get("issues")),
            }
            for node in _nodes(cycles)
        ]
        given = {"team": team, "current_only": "true" if current_only else None}
        return _listing(cycles, rows, "cycles", given)

    # --- people ---

    @tools.tool
    @reports_linear_failure
    async def linear_members(
        ctx: RunContext[Deps], team: str | None = None, after: str | None = None
    ) -> ToolReturn[list[dict[str, object]]]:
        """Everyone in the Linear workspace, mapped to Discord or not.

        The other direction from `teammates`, which starts from Discord and so
        cannot see anybody unmapped — so this answers "quem ainda falta mapear?"
        with its `mapped: false` rows, which `/map linear` fixes.

        `team` is a `key` from `linear_teams`. `email` is what
        `linear_issues(assignee_email=)` takes; a display name filters on nothing
        and comes back empty, reading as "she has no work".
        """
        # Down `Team.members` when a team is named, since `UserFilter` carries no
        # team field. Both sides hand back a `UserConnection`, so only the query
        # and where it sits in the answer differ.
        if team:
            data = await ctx.deps.linear.query(
                _TEAM_MEMBERS, {"team": team, "rows": ROWS, "after": after}
            )
            node = data.get("team")
            if not isinstance(node, dict):
                raise _not_found("team", team)
            members = node.get("members")
        else:
            data = await ctx.deps.linear.query(_MEMBERS, {"rows": ROWS, "after": after})
            members = data.get("users")
        # From the store, not Linear: reachability in Discord is Discord's fact.
        linked = {
            row["linear"].casefold()
            for row in ctx.deps.workspace.people()
            if row.get("linear")
        }
        rows = [
            {
                # Full name first, unlike `_person`: this row is for recognising
                # somebody to map, not for naming an assignee in passing.
                "name": _named(node) or _named(node, "displayName"),
                "email": email,
                "active": node.get("active"),
                "admin": node.get("admin"),
                "teams": _names(node.get("teams"), "key"),
                "mapped": email.casefold() in linked,
            }
            for node in _nodes(members)
            if (email := str(node.get("email") or ""))
        ]
        return _listing(members, rows, "workspace members", {"team": team})

    # --- the work ---

    @tools.tool
    @reports_linear_failure
    async def linear_issues(
        ctx: RunContext[Deps],
        team: str | None = None,
        project: str | None = None,
        assignee_email: str | None = None,
        status: IssueStatus = "started",
        label: str | None = None,
        updated_since: str | None = None,
        after: str | None = None,
    ) -> ToolReturn[list[dict[str, object]]]:
        """Linear's issues, filtered. A page holds 15, so filter rather than
        list-then-sift.

        - `team`: a `key` from `linear_teams` ("RAN"), not a team name.
        - `project`: a project name from `linear_projects`.
        - `assignee_email`: the `linear` field on `teammates`, or an `email` from
          `linear_members`. `"none"` for what nobody has taken. A display name
          matches nothing and comes back empty, which reads as "she has no work".
        - `status`: the state *type*, the same in every team. Team-specific names
          live in `linear_vocabulary`.
        - `label`: a label name from `linear_vocabulary`.
        - `updated_since`: ISO-8601, absolute (`2026-01-15`) or relative (`-P2W`
          for the last two weeks). For "o que andou essa semana".

        `status` defaults to `started`. Ask for `all` before concluding something is
        not in Linear, since a backlog item is invisible by default. `linear_issue`
        reads one in full, by the `identifier` on every row.
        """
        given = {
            "team": team,
            "project": project,
            "assignee_email": assignee_email,
            "status": status,
            "label": label,
            "updated_since": updated_since,
        }
        variables = {
            "rows": ROWS,
            "after": after,
            "filter": _filter(
                team=_eq_key(team),
                project=_contains_name(project),
                assignee=_assignee(assignee_email),
                state=_in_type(None if status == "all" else [status]),
                labels={"name": {"eq": label}} if label else None,
                updatedAt={"gt": updated_since} if updated_since else None,
            ),
        }
        data = await ctx.deps.linear.query(_ISSUES, variables)
        issues = data.get("issues")
        rows = [_issue_row(node) for node in _nodes(issues)]
        return _listing(issues, rows, "issues", given)

    @tools.tool
    @reports_linear_failure
    async def linear_issue(ctx: RunContext[Deps], issue: str) -> dict[str, object]:
        """One Linear issue in full, by the identifier people say: "RAN-123". When
        somebody cites one, read it before answering about it.

        `links` is where this issue points, usually the GitHub issue or PR holding
        the actual work — follow it and read that side too. `parent` and `children`
        say whether this is the grouping issue or one of the grouped.

        `comments` are not here; `has_comments` says there is discussion you have
        not read, which is worth saying rather than implying you read it.
        """
        data = await ctx.deps.linear.query(_ISSUE, {"id": issue})
        node = data.get("issue")
        if not isinstance(node, dict):
            raise _not_found("issue", issue)
        row = _issue_row(node)
        row.pop("summary", None)
        row |= {
            "description": clipped(str(node.get("description") or ""), MAX_BODY_CHARS),
            "creator": _person(node.get("creator")),
            "created_at": when(node.get("createdAt")),
            "started_at": when(node.get("startedAt")),
            "completed_at": when(node.get("completedAt")),
            "canceled_at": when(node.get("canceledAt")),
            "parent": _named(node.get("parent"), "identifier"),
            "children": _names(node.get("children"), "identifier"),
            "links": _names(node.get("attachments"), "url"),
            "has_comments": _more(node.get("comments")),
        }
        return row

    # --- documents ---

    @tools.tool
    @reports_linear_failure
    async def linear_documents(
        ctx: RunContext[Deps],
        query: str | None = None,
        project: str | None = None,
        after: str | None = None,
    ) -> ToolReturn[list[dict[str, object]]]:
        """Linear documents: specs, decisions, notes that are not an issue.

        Ask by `query` for words in a title, or by `project` for what is attached to
        one; with neither you get the most recently touched, a sample and not an
        inventory.

        Rows carry a clipped `summary` — `linear_document` reads one in full by its
        `id`. Finding nothing here proves nothing: most decisions live in the
        conversation or the code. Say you did not find one, not that none exists.
        """
        variables = {
            "rows": ROWS,
            "after": after,
            "filter": _filter(
                title={"containsIgnoreCase": query} if query else None,
                project=_contains_name(project),
            ),
        }
        data = await ctx.deps.linear.query(_DOCUMENTS, variables)
        documents = data.get("documents")
        rows = [
            {
                "id": node.get("id"),
                "title": node.get("title"),
                "project": _named(node.get("project")),
                "initiative": _named(node.get("initiative")),
                "creator": _person(node.get("creator")),
                "updated_at": when(node.get("updatedAt")),
                "summary": clipped(
                    str(node.get("content") or ""), MAX_DESCRIPTION_CHARS
                ),
                "url": node.get("url"),
            }
            for node in _nodes(documents)
        ]
        given = {"query": query, "project": project}
        return _listing(documents, rows, "documents", given)

    @tools.tool
    @reports_linear_failure
    async def linear_document(
        ctx: RunContext[Deps], document: str
    ) -> dict[str, object]:
        """One document in full, by the `id` a listing gave you. Read it before
        quoting a spec or a decision: paraphrasing from a title is how you state as
        settled something the document never said.
        """
        data = await ctx.deps.linear.query(_DOCUMENT, {"id": document})
        node = data.get("document")
        if not isinstance(node, dict):
            raise _not_found("document", document)
        return {
            "title": node.get("title"),
            "project": _named(node.get("project")),
            "initiative": _named(node.get("initiative")),
            "creator": _person(node.get("creator")),
            "created_at": when(node.get("createdAt")),
            "updated_at": when(node.get("updatedAt")),
            "content": clipped(str(node.get("content") or ""), MAX_FILE_CHARS),
            "url": node.get("url"),
        }

    return tools


def _issue_row(node: Node) -> dict[str, object]:
    """One issue as a listing shows it, shared with the single read so the two
    cannot drift. `priorityLabel` rather than `priority`, whose 0 means "none" and
    1 means "urgent" — an inversion a model gets backwards."""
    return {
        "identifier": node.get("identifier"),
        "title": node.get("title"),
        "state": _named(node.get("state")),
        "state_type": _named(node.get("state"), "type"),
        "priority": node.get("priorityLabel"),
        "assignee": _person(node.get("assignee")),
        "team": _named(node.get("team"), "key"),
        "project": _named(node.get("project")),
        "cycle": _named(node.get("cycle"), "number") or None,
        "labels": _names(node.get("labels")),
        "estimate": node.get("estimate"),
        "due_date": when(node.get("dueDate")),
        "updated_at": when(node.get("updatedAt")),
        "url": node.get("url"),
        "summary": clipped(str(node.get("description") or ""), MAX_DESCRIPTION_CHARS),
    }


def _cycle(value: object) -> dict[str, object] | None:
    """A team's active cycle, or None for a team that runs none."""
    if not isinstance(value, dict):
        return None
    return {
        "number": value.get("number"),
        "name": value.get("name") or None,
        "starts_at": when(value.get("startsAt")),
        "ends_at": when(value.get("endsAt")),
        "progress": value.get("progress"),
    }


def _eq_key(key: str | None) -> dict[str, Any] | None:
    """A `TeamFilter` on a team `key`, for the fields Linear types as one team."""
    return {"key": {"eq": key}} if key else None


def _some_key(key: str | None) -> dict[str, Any] | None:
    """The same, for a `TeamCollectionFilter` — which takes no `key` of its own,
    only `some`. `ProjectFilter.accessibleTeams` is the one that needs it."""
    return {"some": _eq_key(key)} if key else None


def _contains_name(name: str | None) -> dict[str, Any] | None:
    """A nested filter on a name, matched loosely: what someone calls a project in
    conversation is rarely its name to the character."""
    return {"name": {"containsIgnoreCase": name}} if name else None


def _in_type(types: list[str] | None) -> dict[str, Any] | None:
    """A nested filter on a state or status `type`."""
    return {"type": {"in": types}} if types else None


def _assignee(email: str | None) -> dict[str, Any] | None:
    """A filter on who holds an issue.

    `"none"` means unassigned, spelled the way GitHub's `list_issues` spells it so
    one habit serves both sides — and `{ null: true }` is how Linear says it.
    """
    if not email:
        return None
    if email == "none":
        return {"null": True}
    return {"email": {"eqIgnoreCase": email}}
