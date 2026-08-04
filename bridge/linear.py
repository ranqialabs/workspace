"""Linear client: read the workspace over GraphQL, as the app itself.

GraphQL over httpx rather than Linear's MCP server, for the same reason
`bridge.agent.tools.github` wraps githubkit: an MCP server would mean a second
identity to manage and dozens of tool definitions in every request's context.

Authenticates with the `client_credentials` grant, which yields an app-actor
token — the bot acts as itself in the workspace rather than impersonating whoever
set it up, and costs no billable seat. Unlike a GitHub App installation token,
that token comes with no refresh token: Linear's own guidance is to mint lazily
and mint again when a request comes back 401. So this holds one token, mints it on
first use, and re-mints exactly once on a 401 before giving up.

We ask for `read` and nothing else, so the read-only promise holds at the
credential and not only in which tools happen to exist.
"""

import asyncio
import logging
from typing import Any

import httpx

from bridge.config import Secrets

log = logging.getLogger(__name__)

TOKEN_URL = "https://api.linear.app/oauth/token"
API_URL = "https://api.linear.app/graphql"
SCOPES = "read"  # comma-separated if it ever needs more

_TIMEOUT = 20.0  # a workspace query is small; a slow one is a stuck run
_MAX_ERROR_CHARS = 300  # GraphQL errors can carry a whole query back


class LinearError(Exception):
    """Linear said no. The message is what to show a model or a human."""


class LinearRateLimited(LinearError):
    """Linear is rate-limiting us. Retrying now fails the same way.

    Its own type because it is the one failure where the answer is to stop asking
    rather than to ask differently.
    """


class LinearQueryFailed(LinearError):
    """The query ran and GraphQL returned errors.

    Its own type because a GraphQL error arrives with HTTP 200 and may sit beside
    partial data — which makes it a bug in our query or a field we may not read,
    not a transport failure, and it reads differently to whoever sees it.
    """


class Linear:
    """One workspace, read over GraphQL, as the app itself.

    Owns its `httpx.AsyncClient` for the process's lifetime: connection reuse is
    the point, and a client per query would spend a TLS handshake on each.
    """

    def __init__(self, client_id: str, client_secret: str) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = httpx.AsyncClient(timeout=_TIMEOUT)
        self._token: str | None = None
        # Tool calls run concurrently, so two queries can fail on the same
        # expired token at once. This is what stops them both minting.
        self._minting = asyncio.Lock()

    async def query(
        self, document: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Run a GraphQL query and return its `data`, raising on anything else."""
        token = await self._current()
        resp = await self._send(document, variables, token)
        if resp.status_code == httpx.codes.UNAUTHORIZED:
            # No refresh token exists, so a 401 means the token expired — Linear's
            # own documented signal to fetch a new one. Once only: a second 401 on
            # a token we just minted is the credentials, and retrying that spends
            # the token endpoint's quota to fail the same way.
            await self._mint(stale=token)
            resp = await self._send(document, variables, await self._current())
        if resp.status_code == httpx.codes.TOO_MANY_REQUESTS:
            raise LinearRateLimited("Linear's rate limit is spent.")
        resp.raise_for_status()
        return _data(resp.json())

    async def whoami(self) -> str:
        """The identity this token acts as, for one log line at boot.

        The cheap proof that the credentials are the ones we think they are: a
        wrong pair fails here rather than at somebody's first question.
        """
        data = await self.query("query Viewer { viewer { id name } }")
        viewer = data.get("viewer") or {}
        return f"{viewer.get('name') or 'unknown'} ({viewer.get('id') or '?'})"

    async def aclose(self) -> None:
        """Close the connection pool. Called from the bot's own `close`."""
        await self._http.aclose()

    async def _send(
        self, document: str, variables: dict[str, Any] | None, token: str
    ) -> httpx.Response:
        return await self._http.post(
            API_URL,
            json={"query": document, "variables": variables or {}},
            headers={"Authorization": f"Bearer {token}"},
        )

    async def _current(self) -> str:
        """The access token, minted on first use."""
        if self._token is None:
            await self._mint(stale=None)
        assert self._token is not None
        return self._token

    async def _mint(self, *, stale: str | None) -> None:
        """Fetch a fresh token, unless someone already replaced `stale`.

        `stale` is the token whose 401 sent us here. Whichever caller takes the
        lock first mints; the second finds the token already changed and uses that
        rather than minting a second one — two tokens is not wrong, but it burns a
        request and can turn one 401 into two failures under a rate limit.

        No `expires_in` clock: the 401 path has to exist and be correct anyway, a
        second mechanism could disagree with the server about when a token died,
        and one wasted request per 30 days is nothing.
        """
        async with self._minting:
            if stale is not None and self._token != stale:
                return
            resp = await self._http.post(
                TOKEN_URL,
                data={"grant_type": "client_credentials", "scope": SCOPES},
                auth=(self._client_id, self._client_secret),
            )
            if resp.status_code >= httpx.codes.BAD_REQUEST:
                raise LinearError(
                    f"Linear would not issue a token ({resp.status_code}): "
                    f"{resp.text[:_MAX_ERROR_CHARS]}"
                )
            token = resp.json().get("access_token")
            if not isinstance(token, str) or not token:
                raise LinearError("Linear issued a token response with no token in it.")
            self._token = token


def _data(payload: object) -> dict[str, Any]:
    """A GraphQL response's `data`, raising if it carried errors.

    Checked before `data` is read, and raised even when `data` is present: a
    GraphQL query can partially succeed, and half an answer returned as a whole
    one is exactly what the tools' caveats exist to prevent.
    """
    if not isinstance(payload, dict):
        raise LinearQueryFailed("Linear's answer was not a GraphQL response.")
    if errors := payload.get("errors"):
        raise LinearQueryFailed(_said(errors))
    data: object = payload.get("data")
    if not isinstance(data, dict):
        raise LinearQueryFailed("Linear answered with no data and no errors.")
    # Keys are field names, so the cast is what GraphQL already guarantees.
    return {str(field): value for field, value in data.items()}


def _said(errors: object) -> str:
    """What Linear complained about, as one sentence."""
    if not isinstance(errors, list):
        return str(errors)[:_MAX_ERROR_CHARS]
    messages = [
        message
        for error in errors
        if isinstance(error, dict) and (message := error.get("message"))
    ]
    return "; ".join(str(m) for m in messages)[:_MAX_ERROR_CHARS] or "unspecified error"


async def workspace_client(secrets: Secrets) -> Linear | None:
    """A Linear client, or None when the workspace isn't configured.

    Returns None rather than raising: Linear is optional, and the bridge without
    it is the bridge as it shipped. `config.load_secrets` has already rejected
    half a credential pair, so either both are here or neither is.
    """
    if secrets.linear_client_id is None or secrets.linear_client_secret is None:
        return None
    return Linear(secrets.linear_client_id, secrets.linear_client_secret)
