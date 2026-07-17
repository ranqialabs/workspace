---
icon: lucide/settings
---

# Configuration

The bridge is configured entirely through **environment variables** — nothing is
read from disk. Non-secret routing lives in `fly.toml`'s `[env]`; secrets go
through `fly secrets`. For local runs, put everything in a `.env` file.

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

## 3. Environment variables

In Discord, enable Developer Mode to right-click and _Copy ID_.

| Variable | Secret? | Description |
| :------- | :------ | :---------- |
| `GITHUB_ORG` | no | GitHub org slug, e.g. `ranqialabs` |
| `GUILD_ID` | no | Discord server id |
| `ADMIN_ROLE_ID` | no | Role allowed to run `/link` and `/sync-roles` |
| `TEAM_TO_ROLE` | no | JSON: github team slug → discord role id |
| `REPO_TO_CHANNEL` | no | JSON: `"owner/repo"` → discord channel id |
| `DISCORD_TOKEN` | **yes** | Bot token from the Discord portal |
| `GITHUB_APP_ID` | **yes** | Numeric app id |
| `GITHUB_APP_PRIVATE_KEY` | **yes** | PEM contents, or a path to the `.pem` |
| `GITHUB_WEBHOOK_SECRET` | **yes** | Same secret set on the App webhook |
| `WEBHOOK_HOST` / `WEBHOOK_PORT` | no | Defaults `0.0.0.0` / `8080` |

The two maps are JSON objects:

```bash
TEAM_TO_ROLE='{"engineering":111,"design":222}'
REPO_TO_CHANNEL='{"ranqialabs/workspace":333}'
```

!!! tip "What maps to what"

    - `TEAM_TO_ROLE` drives `/sync-roles`: members of the GitHub team get the
      Discord role.
    - `REPO_TO_CHANNEL` decides which channel a repo's notifications land in.
      A repo with no entry is silently skipped.

## 4. Run it locally

Copy `.env.example` to `.env`, fill it in (never commit it), then:

```bash
uv sync
uv run python -m bridge
```

On startup the bridge creates the SQLite database, loads the cogs, starts the
webhook server, and syncs slash commands to your guild. The commands appear in
Discord within seconds.

!!! warning "The webhook needs a public URL"

    GitHub must be able to reach the webhook port. For local testing, expose it
    with a tunnel such as [cloudflared] or [ngrok] and point the App's webhook
    URL at the tunnel.

## 5. Deploy to Fly.io

The bot runs as a single always-on machine on [Fly.io]. It can't scale to zero —
it holds a live Discord gateway connection — so `fly.toml` keeps one machine
running.

**One-time setup:**

```bash
fly launch --no-deploy          # if you haven't already; picks app name + region
fly secrets set \
  DISCORD_TOKEN=... \
  GITHUB_APP_ID=... \
  GITHUB_APP_PRIVATE_KEY="$(cat app.private-key.pem)" \
  GITHUB_WEBHOOK_SECRET=...
```

Put the non-secret ids in `fly.toml`'s `[env]` block (already stubbed with
placeholders). Point the GitHub App's webhook URL at
`https://<your-app>.fly.dev/webhook`.

**Continuous deploy:** pushing to `main` triggers
`.github/workflows/fly-deploy.yml`, which runs `flyctl deploy`. It needs one repo
secret — create a deploy token with `fly tokens create deploy` and add it as
`FLY_API_TOKEN` under **Settings → Secrets and variables → Actions**.

[Fly.io]: https://fly.io/
[cloudflared]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
[ngrok]: https://ngrok.com/
