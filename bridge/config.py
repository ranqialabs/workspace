"""
Static config (config.toml) + secrets (env vars).

Config is versioned, non-secret routing. Secrets never live in the TOML.
"""

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("BRIDGE_CONFIG", "config.toml"))


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


def load(path: Path = CONFIG_PATH) -> Config:
    with path.open("rb") as f:
        raw = tomllib.load(f)
    return Config(
        guild_id=int(raw["guild_id"]),
        admin_role_id=int(raw["admin_role_id"]),
        org=str(raw["org"]),
        team_to_role={k: int(v) for k, v in raw.get("team_to_role", {}).items()},
        repo_to_channel={k: int(v) for k, v in raw.get("repo_to_channel", {}).items()},
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
