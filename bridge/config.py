"""
Configuration from environment variables.

Almost everything is discovered at runtime: the guild is the only one the bot is
in, admins are whoever has "Manage Server", and all mappings live in a Discord
channel (see store.py). The only real config is the org and the secrets.
"""

import os
from dataclasses import dataclass
from pathlib import Path

# The bot finds (or creates) this channel by name; it stores all mappings.
CONFIG_CHANNEL_NAME = "bot-config"


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
    org: str


def load() -> Config:
    return Config(org=os.environ["GITHUB_ORG"])


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
