"""
GitHub webhook listener: verify signature, dispatch by event name.
"""

import hashlib
import hmac
from collections.abc import Awaitable, Callable

from aiohttp import web

Handler = Callable[[dict], Awaitable[None]]


def _valid_signature(secret: str, body: bytes, header: str | None) -> bool:
    if not header:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


class WebhookServer:
    def __init__(self, secret: str) -> None:
        self._secret = secret
        self._handlers: dict[str, list[Handler]] = {}
        self.app = web.Application()
        self.app.router.add_post("/webhook", self._handle)

    def register(self, event: str, handler: Handler) -> None:
        self._handlers.setdefault(event, []).append(handler)

    async def _handle(self, request: web.Request) -> web.Response:
        body = await request.read()
        # Trust boundary: reject anything not signed with our secret.
        if not _valid_signature(
            self._secret, body, request.headers.get("X-Hub-Signature-256")
        ):
            return web.Response(status=401, text="bad signature")

        event = request.headers.get("X-GitHub-Event", "")
        handlers = self._handlers.get(event)
        if not handlers:
            return web.Response(status=204)

        payload = await request.json()
        for handler in handlers:
            await handler(payload)
        return web.Response(status=200)
