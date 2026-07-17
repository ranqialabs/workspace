"""
SQLite identity map: github_login <-> discord_id.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path("bridge.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS identity (
    github_login TEXT PRIMARY KEY COLLATE NOCASE,
    discord_id   INTEGER NOT NULL
)
"""


def _connect(path: Path = DB_PATH) -> sqlite3.Connection:
    return sqlite3.connect(path)


def init(path: Path = DB_PATH) -> None:
    with _connect(path) as conn:
        conn.execute(_SCHEMA)


def link(github_login: str, discord_id: int, path: Path = DB_PATH) -> None:
    with _connect(path) as conn:
        conn.execute(
            "INSERT INTO identity (github_login, discord_id) VALUES (?, ?) "
            "ON CONFLICT(github_login) DO UPDATE SET discord_id = excluded.discord_id",
            (github_login, discord_id),
        )


def discord_id_for(github_login: str, path: Path = DB_PATH) -> int | None:
    with _connect(path) as conn:
        row = conn.execute(
            "SELECT discord_id FROM identity WHERE github_login = ?",
            (github_login,),
        ).fetchone()
    return row[0] if row else None


def all_links(path: Path = DB_PATH) -> dict[str, int]:
    with _connect(path) as conn:
        rows = conn.execute("SELECT github_login, discord_id FROM identity").fetchall()
    return {login: discord_id for login, discord_id in rows}
