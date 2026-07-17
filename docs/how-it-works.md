---
icon: lucide/workflow
---

# How it works

The bridge is a single Python process. Inside it, a [discord.py] bot and an
[aiohttp] webhook server share **one event loop** — the bot holds its live
connection to Discord while the same loop answers HTTP calls from GitHub. One
process, one deploy, one place for everything to talk to everything else. It
authenticates to GitHub as a [GitHub App] installed on the org.

[discord.py]: https://discordpy.readthedocs.io/
[aiohttp]: https://docs.aiohttp.org/
[GitHub App]: https://docs.github.com/en/apps

## The pieces

| Module | Responsibility |
| :----- | :------------- |
| `bridge/__main__.py` | Entrypoint — reads config, starts the bot |
| `bridge/config.py` | The tiny bit of static config: the org and the secrets |
| `bridge/store.py` | All mappings, held in memory, persisted to `#bot-config` |
| `bridge/github_app.py` | GitHub App client, authenticated as the org installation |
| `bridge/bot.py` | The bot: discovers the server, loads cogs, starts the webhook |
| `bridge/webhook.py` | Verifies webhook signatures, dispatches events |
| `bridge/cogs/github_sync.py` | The mapping commands and role sync |
| `bridge/cogs/notifications.py` | Turns GitHub events into Discord messages |

## Nothing to configure

The design goal was that a human sets one value — the org name — and the bot
works the rest out for itself. So on startup the bot **discovers** what other
bots make you type:

- **Which server?** The bot is only ever in one, so it takes that one.
- **Who's an admin?** Whoever has Discord's native *Manage Server* permission.
  No bespoke admin role, no ID to store.
- **Where does state live?** It looks for a `#bot-config` channel and creates one
  (hidden from `@everyone`) if it's missing.

What's left — which team maps to which role, which repo posts to which channel,
which GitHub user is which Discord member — can't be guessed, so those are set
with commands. But even there you never handle an ID: see [Commands](commands.md).

## Cogs: one domain, one file

The bot is organized into [cogs] — discord.py's native extension mechanism. A cog
bundles a feature's commands, listeners, and state in one file, isolated from the
others. Growth is additive: you drop in a new file rather than picking apart the
old ones.

[cogs]: https://discordpy.readthedocs.io/en/stable/ext/commands/cogs.html

```python title="bridge/bot.py"
INITIAL_COGS = ["bridge.cogs.github_sync", "bridge.cogs.notifications"]
```

When Google Workspace or voice transcription lands, it's a `bridge/cogs/…` file
added to that list — and nothing else has to change. That's the whole point of
the arrangement.

## Events: a dispatch table, not a chain of ifs

The webhook server keeps a plain table of `event name → handlers`, and cogs
register into it as they load:

```python title="bridge/cogs/notifications.py"
bot.webhook.register("pull_request", self.on_pull_request)
bot.webhook.register("issues", self.on_issues)
```

A new event type is a new entry in the table, not another branch in a growing
`if/elif`. Before anything is dispatched, each incoming request is checked
against its signature — HMAC-SHA256 over the body with the shared secret — and
rejected with `401` if it doesn't match, so an unsigned or forged call never
reaches a handler. Events nobody registered for are quietly ignored with `204`.

## Persistence: the channel is the store

Everything the bot needs to remember — the three mappings — lives in the
`#bot-config` channel as ordinary messages. **There is no database and no disk.**
Each mapping is one line:

```text
identity  itsmeale             123456789012345678
team      engineering          456789012345678901
repo      ranqialabs/workspace 789012345678901234
```

On boot, `store.py` replays that channel's history oldest-first and rebuilds three
dictionaries in memory; later lines win, so re-mapping just appends. Every command
does the same two steps — post a line, update the dict — so memory and the channel
never drift apart.

This buys a lot for very little. It costs nothing (Discord already stores the
messages), it survives every restart and redeploy without a volume to mount or
back up, and it's transparent: the configuration is right there to read, and you
can fix an entry by hand just by posting the line yourself.

```python title="bridge/store.py"
async def load(self) -> None:
    async for message in self._channel.history(limit=None, oldest_first=True):
        m = _LINE.match(message.content.strip())
        if m:
            self._apply(m["kind"], m["key"], int(m["value"]))
```

!!! note "When to outgrow it"

    A channel replayed on boot is perfect for tens or low hundreds of entries. If
    this ever reached thousands, the boot read would get slow and a real store
    would earn its keep — but that's a problem for a much bigger server than this
    is built for.

When a login isn't linked, the system degrades gracefully rather than breaking:
`/sync roles` lists it as unmapped, and a notification falls back to showing the
plain GitHub login instead of a mention.
