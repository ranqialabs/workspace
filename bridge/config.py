"""
Configuration from environment variables.

Almost everything is discovered at runtime: the guild is the only one the bot is
in, admins are whoever has "Manage Server", and all mappings live in a Discord
channel (see store.py). The only real config is the org and the secrets.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# The bot finds (or creates) this channel by name; it stores all mappings.
CONFIG_CHANNEL_NAME = "bot-config"

# The model behind the agent — answering questions as well as drafting issues.
DEFAULT_AGENT_MODEL = "openai:gpt-5.6-terra"


@dataclass(frozen=True)
class Secrets:
    discord_token: str
    github_app_id: str
    github_private_key: str
    webhook_secret: str
    webhook_host: str = "0.0.0.0"
    webhook_port: int = 8080
    # Linear is optional: unset, its tools say so and the rest of the bridge is
    # unchanged. Both or neither — one alone cannot mint a token.
    linear_client_id: str | None = None
    linear_client_secret: str | None = None


@dataclass(frozen=True)
class Config:
    org: str
    agent_model: str = DEFAULT_AGENT_MODEL


def load() -> Config:
    return Config(
        org=os.environ["GITHUB_ORG"],
        agent_model=os.getenv("AGENT_MODEL", DEFAULT_AGENT_MODEL),
    )


def load_secrets() -> Secrets:
    key = os.environ["GITHUB_APP_PRIVATE_KEY"]
    # ponytail: accept either the PEM inline or a path to it.
    if key and not key.lstrip().startswith("-----") and Path(key).is_file():
        key = Path(key).read_text()
    return Secrets(
        discord_token=os.environ["DISCORD_TOKEN"],
        github_app_id=os.environ["GITHUB_APP_ID"],
        github_private_key=key,
        webhook_secret=os.environ["GITHUB_WEBHOOK_SECRET"],
        webhook_host=os.environ.get("WEBHOOK_HOST", "0.0.0.0"),
        webhook_port=int(os.environ.get("WEBHOOK_PORT", "8080")),
        **_linear(),
    )


def _linear() -> dict[str, str | None]:
    """The Linear app's credentials, or a pair of Nones.

    `.get`, not `[...]`: the bridge boots fine without Linear. And half a pair is
    the same as none — it cannot mint anything, so treating it as configured would
    turn a typo in one variable name into a 401 at the first tool call, far from
    the cause. Naming it here means the boot log says it once.
    """
    client_id = os.environ.get("LINEAR_CLIENT_ID") or None
    client_secret = os.environ.get("LINEAR_CLIENT_SECRET") or None
    if bool(client_id) != bool(client_secret):
        log.warning(
            "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must both be set; "
            "Linear is switched off"
        )
        return {"linear_client_id": None, "linear_client_secret": None}
    return {"linear_client_id": client_id, "linear_client_secret": client_secret}
