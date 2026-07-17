---
icon: lucide/workflow
---

# How it works

The bridge is a single Python process that runs a [discord.py] bot and an
[aiohttp] webhook server on the **same event loop**. It authenticates to GitHub
as a [GitHub App] installed on the org.

[discord.py]: https://discordpy.readthedocs.io/
[aiohttp]: https://docs.aiohttp.org/
[GitHub App]: https://docs.github.com/en/apps

## The pieces

| Module                         | Responsibility                                           |
| :----------------------------- | :------------------------------------------------------- |
| `bridge/__main__.py`           | Entrypoint — loads config, starts the bot                |
| `bridge/config.py`             | Reads `config.toml` (routing) and env vars (secrets)     |
| `bridge/db.py`                 | SQLite identity map: `github_login ↔ discord_id`         |
| `bridge/github_app.py`         | GitHub App client, authenticated as the org installation |
| `bridge/bot.py`                | The bot: loads cogs, starts the webhook server           |
| `bridge/webhook.py`            | Verifies webhook signatures, dispatches events           |
| `bridge/cogs/github_sync.py`   | `/link`, `/sync-roles`                                   |
| `bridge/cogs/notifications.py` | Turns GitHub events into Discord messages                |

## Cogs: one domain, one file

The bot is organized into [cogs] — discord.py's native extension mechanism. Each
cog owns its commands, listeners, and state. Adding a feature means adding a cog,
not editing the existing ones.

[cogs]: https://discordpy.readthedocs.io/en/stable/ext/commands/cogs.html

```python title="bridge/bot.py"
INITIAL_COGS = ["bridge.cogs.github_sync", "bridge.cogs.notifications"]
```

To add, say, Google Workspace later, you write `bridge/cogs/workspace.py` and add
it to that list. Nothing else changes.

## Events: a dispatch table, not a chain of ifs

The webhook server keeps a table of `event name → handlers`. Cogs register their
handlers on startup:

```python title="bridge/cogs/notifications.py"
bot.webhook.register("pull_request", self.on_pull_request)
bot.webhook.register("issues", self.on_issues)
```

Every incoming webhook is checked against its signature first (HMAC-SHA256 with
the shared secret) and rejected with `401` if it doesn't match. Only then is it
dispatched. Unknown events are ignored with `204`.

## Identity map

Notifications and role sync both need to know which Discord user a GitHub login
belongs to. That mapping lives in a tiny SQLite table, populated by the
[`/link`](commands.md#link) command:

```sql
CREATE TABLE identity (
    github_login TEXT PRIMARY KEY,
    discord_id   INTEGER NOT NULL
);
```

If a login isn't linked, `/sync-roles` reports it as unmapped and notifications
fall back to showing the plain GitHub login instead of a mention.
