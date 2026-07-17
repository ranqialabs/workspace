---
icon: lucide/settings
---

# Setup

Most bots make you hunt for IDs — copy the server ID, copy each role ID, paste a
channel ID into a config file, keep them in sync forever. This one doesn't. The
**only** thing you configure by hand is the GitHub org name. The server, who's
allowed to run admin commands, and every mapping between GitHub and Discord are
either discovered at runtime or set later with slash commands, using
autocomplete and mentions. You will not paste a single snowflake ID.

There are four stages, and you do them in order: register the
[GitHub App](#1-the-github-app), create the [Discord bot](#2-the-discord-bot),
[deploy](#3-deploy), then [wire everything up from inside Discord](#4-wire-it-up).
Budget twenty minutes the first time.

## 1. The GitHub App

The bridge talks to GitHub as a **GitHub App** installed on your org — not as a
personal token. That matters: an App gets its own identity, its own fine-grained
permissions, and its own webhook deliveries, and it keeps working when the person
who set it up leaves. Create one under **Org Settings → Developer settings →
GitHub Apps → New GitHub App**.

**Identity.** Give it a name (`ranqia-workspace` is fine) and any homepage URL.
Everything under *Identifying and authorizing users* — Callback URL, Setup URL,
the OAuth and Device Flow checkboxes — stays **empty and unchecked**. Those are
for logging users in, and the bridge never does that; it acts as the installation
itself.

**Webhook.** Tick **Active**. The **Webhook URL** is
`https://<your-fly-app>.fly.dev/webhook` — you won't know the exact host until
[stage 3](#3-deploy), so it's fine to come back and fill it in. Set a **Secret**
to a long random string and keep it somewhere; it becomes `GITHUB_WEBHOOK_SECRET`
and is what lets the bridge prove a webhook really came from GitHub.

**Permissions.** All read-only — the bridge observes, it never writes to GitHub:

| Scope | Permission | Why it's needed |
| :---- | :--------- | :-------------- |
| Repository | **Issues** → Read | to hear about opened issues |
| Repository | **Pull requests** → Read | to hear about PRs and review requests |
| Repository | **Metadata** → Read | mandatory; GitHub adds it for you |
| Organization | **Members** → Read | `/sync roles` reads who's in each team |

**Events.** Subscribe to **Pull request** and **Issues**. You do *not* need a
separate "Pull request review" subscription — a requested review arrives as an
action inside the pull_request event.

**Install it.** Under **Where can this app be installed**, choose *Only on this
account*, save, then open **Install App** and install it on the org.

Now collect three things the deploy will need:

1. The **App ID** (a number, shown at the top) → `GITHUB_APP_ID`.
2. A **private key**: scroll to *Private keys* → **Generate a private key**. A
   `.pem` file downloads. Its entire contents are `GITHUB_APP_PRIVATE_KEY`.
3. That **webhook secret** from earlier → `GITHUB_WEBHOOK_SECRET`.

!!! danger "The private key is the `.pem`, not the client secret"

    A GitHub App page shows both a *Client secret* and a *private key*, and it is
    easy to grab the wrong one. The bridge signs a JWT with the **private key** —
    the downloaded file that begins with `-----BEGIN ... PRIVATE KEY-----`. The
    client id and client secret are for OAuth user login and are never used here.
    If you see `Could not parse the provided public key` in the logs, you almost
    certainly stored the client secret (or a mangled key) instead.

## 2. The Discord bot

Head to the [Discord Developer Portal] and create an application.

**Get the token.** Open **Bot**, click **Reset Token**, and copy it — Discord
shows it exactly once. This is `DISCORD_TOKEN`, the credential the bot logs in
with. Treat it like a password; if it leaks, Reset Token again and the old one
dies.

**Turn on the one intent that matters.** Still on the Bot page, under *Privileged
Gateway Intents*, enable **Server Members Intent**. Without it the bot literally
cannot see or change members' roles, and `/sync roles` fails. Leave **Presence**
and **Message Content** off — the bridge uses slash commands, so it never needs
to read message text.

**Invite it.** Go to **OAuth2 → URL Generator**, tick the scopes **`bot`** and
**`applications.commands`**, then under bot permissions tick **Manage Roles**,
**View Channels**, **Send Messages**, **Manage Channels** (so it can create its
own config channel), and **Embed Links**. Copy the URL it builds at the bottom,
open it, and add the bot to your server.

!!! tip "Put the bot's role near the top"

    Discord only lets a bot assign roles that sit **below its own** in the role
    list — a safety rule, not a bug. After inviting, drag the bot's role above the
    team roles it will manage (engineering, design, …), or `/sync roles` will fail
    with *Missing Permissions* even though the permission is granted.

## 3. Deploy

The bridge is one always-on process on [Fly.io]. It can't scale to zero the way a
web app can, because it holds a live WebSocket to Discord the whole time it's
running — drop that connection and the bot goes offline. So `fly.toml` pins one
machine permanently running.

The single non-secret setting lives right in `fly.toml`, in plain sight:

```toml
[env]
  GITHUB_ORG = 'ranqialabs'
  WEBHOOK_PORT = '8080'
```

The four secrets never touch that file — they go through `fly secrets`, which
stores them encrypted:

```bash
fly launch --no-deploy   # first time only: names the app, picks a region
fly secrets set \
  DISCORD_TOKEN=... \
  GITHUB_APP_ID=... \
  GITHUB_WEBHOOK_SECRET=... \
  GITHUB_APP_PRIVATE_KEY="$(cat ranqia-workspace.*.private-key.pem)"
```

!!! danger "Set the key from the file, with the quotes"

    A PEM is multi-line, and pasting it into a shell (or the Fly dashboard)
    usually collapses the newlines, which makes JWT signing blow up. Reading it
    with `"$(cat ...pem)"` keeps the line breaks intact. This one detail is the
    most common reason a first deploy crash-loops.

With the app deployed you'll have its hostname — go back to the GitHub App and
set the **Webhook URL** to `https://<your-fly-app>.fly.dev/webhook`.

**Deploys happen on their own from here.** Every push to `main` that touches the
bot triggers `.github/workflows/fly-deploy.yml`, which runs `flyctl deploy`. It
needs exactly one repository secret: create a token with `fly tokens create
deploy` and add it as `FLY_API_TOKEN` under **Settings → Secrets and variables →
Actions**.

??? note "Running it locally instead"

    ```bash
    cp .env.example .env    # fill it in — and never commit it
    uv sync
    uv run python -m bridge
    ```

    GitHub still needs a public URL to deliver webhooks to, so expose the port
    with a tunnel like [cloudflared] or [ngrok] and point the App's webhook there
    while you test.

## 4. Wire it up

The first time the bot connects it does three things on its own: it **finds or
creates a `#bot-config` channel** (hidden from `@everyone`), registers its slash
commands, and runs a first **sync** to mirror your GitHub teams into Discord.

The guiding idea: **GitHub is the source of truth, Discord reflects it.** You
don't create team roles or juggle channel permissions by hand — the bot derives
those from GitHub. You only tell it the two things GitHub can't know: how you want
repos grouped into channels, and who each GitHub user is on Discord.

Every command requires the **Manage Server** permission, and none ask for an ID —
repos and users come from GitHub-backed autocomplete, channels and members from
normal Discord mentions.

| Command | What it does |
| :------ | :----------- |
| `/map user github_login:‹login› member:@member` | ties a GitHub user to a Discord member (mentions + role sync) |
| `/map repo repo:‹owner/name› channel:#channel` | routes a repo's notifications to a channel; group several repos into one channel |
| `/sync roles` | mirrors teams now: creates roles, syncs membership, gates channels |

So the flow is: [link people](commands.md#map-user) with `/map user`,
[group repos](commands.md#map-repo) into channels with `/map repo`, and let
`/sync roles` do the rest — it creates a
role per GitHub team, adds and removes members to match, and sets each mapped
channel's permissions so only the roles of teams with repo access can see it.
`/sync roles` also runs automatically on every boot.

## Where it keeps state

There's no database and no disk to set up: the `#bot-config` channel the bot
creates *is* its storage, and the live panel there shows your whole configuration
at a glance. You never have to manage it. If you're curious why it works this way,
[Concepts](concepts.md#your-configuration-lives-in-discord) explains it.

[Discord Developer Portal]: https://discord.com/developers/applications
[GitHub App]: https://docs.github.com/en/apps/creating-github-apps
[Fly.io]: https://fly.io/
[cloudflared]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
[ngrok]: https://ngrok.com/
