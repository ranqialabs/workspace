---
icon: lucide/settings
---

# Configuration

The bridge reads two things: a **`config.toml`** for non-secret routing, and
**environment variables** for secrets. Secrets never go in the TOML.

## 1. Create the GitHub App

Create a [GitHub App] on the org and install it. It needs:

- **Repository permissions:** Issues (read), Pull requests (read)
- **Organization permissions:** Members (read)
- **Webhook events:** `pull_request`, `issues`
- A **webhook URL** pointing at where the bridge runs (`https://.../webhook`)
- A **webhook secret** (any random string — you'll reuse it below)
- A generated **private key** (`.pem`)

[GitHub App]: https://docs.github.com/en/apps/creating-github-apps

## 2. Create the Discord bot

Create an application in the [Discord Developer Portal], add a bot, and enable
the **Server Members Intent** (needed to assign roles). Invite it to the server
with the `bot` and `applications.commands` scopes.

[Discord Developer Portal]: https://discord.com/developers/applications

## 3. `config.toml`

Copy `config.example.toml` to `config.toml` and fill in the IDs. In Discord,
enable Developer Mode to right-click and _Copy ID_.

```toml
guild_id = 000000000000000000       # discord server id
admin_role_id = 000000000000000000  # role allowed to run /link and /sync-roles
org = "ranqialabs"                   # github org slug

[team_to_role]        # github team slug -> discord role id
"engineering" = 000000000000000000
"design" = 000000000000000000

[repo_to_channel]     # "owner/repo" -> discord channel id
"ranqialabs/workspace" = 000000000000000000
```

!!! tip "What maps to what"

    - `team_to_role` drives `/sync-roles`: members of the GitHub team get the
      Discord role.
    - `repo_to_channel` decides which channel a repo's notifications land in.
      A repo with no entry is silently skipped.

## 4. Secrets (`.env`)

Copy `.env.example` to `.env`. Never commit it.

```bash
DISCORD_TOKEN=            # bot token from the Discord portal
GITHUB_APP_ID=            # numeric app id
GITHUB_APP_PRIVATE_KEY=   # PEM contents, or a path to the .pem file
GITHUB_WEBHOOK_SECRET=    # same secret you set on the GitHub App webhook
WEBHOOK_HOST=0.0.0.0
WEBHOOK_PORT=8080
```

## 5. Run it

```bash
uv sync
uv run python -m bridge
```

On startup the bridge creates the SQLite database, loads the cogs, starts the
webhook server, and syncs slash commands to your guild. The commands appear in
Discord within seconds.

!!! warning "The webhook needs a public URL"

    GitHub must be able to reach `WEBHOOK_PORT`. For local testing, expose it
    with a tunnel such as [cloudflared] or [ngrok] and point the App's webhook
    URL at the tunnel.

[cloudflared]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
[ngrok]: https://ngrok.com/
