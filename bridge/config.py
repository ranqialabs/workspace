"""
Configuration from environment variables.

Scalars are plain env vars; the two routing maps are JSON env vars. Non-secret
routing (guild/role/channel ids) lives in fly.toml's [env]; secrets go through
`fly secrets`. Nothing is read from disk.
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Secrets:
    discord_token: str
    github_app_id: str
    github_private_key: str
    webhook_secret: str
    webhook_host: str = "0.0.0.0"
    webhook_port: int = 8080


@dataclass(frozen=True)
class Config:
    guild_id: int
    admin_role_id: int
    org: str
    team_to_role: dict[str, int]  # github team slug -> discord role id
    repo_to_channel: dict[str, int]  # "owner/repo" -> discord channel id


def _int_map(env_var: str) -> dict[str, int]:
    """Parse a JSON object env var into a str->int map (empty if unset)."""
    raw = os.environ.get(env_var, "{}")
    return {k: int(v) for k, v in json.loads(raw).items()}


def load() -> Config:
    return Config(
        guild_id=int(os.environ["GUILD_ID"]),
        admin_role_id=int(os.environ["ADMIN_ROLE_ID"]),
        org=os.environ["GITHUB_ORG"],
        team_to_role=_int_map("TEAM_TO_ROLE"),
        repo_to_channel=_int_map("REPO_TO_CHANNEL"),
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
    )
