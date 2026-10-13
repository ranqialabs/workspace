---
icon: lucide/wrench
---

# Setup

bob needs a GitHub App, a Cloudflare account on **Workers Paid** (the Discord
gateway keeps one Durable Object in memory around the clock, which the Free plan
does not allow), and at least one of Discord and Slack. Each platform switches
on when its secrets are set; leave one out and bob runs on the other alone.

## 1. The GitHub App

Create an app owned by the org and install it on the repos bob should see.

| Permission             | Access         | Why                                              |
| :--------------------- | :------------- | :----------------------------------------------- |
| Contents               | Read           | the agent reads code and history                 |
| Issues                 | Read and write | news, and **File issue** creates the issue       |
| Pull requests          | Read           | news, and the agent reads PRs                    |
| Checks, Actions        | Read           | pipeline cards, and the agent reads CI failures  |
| Deployments            | Read           | deploy lines on pipeline cards                   |
| Members (organization) | Read           | `/map` checks logins, autocomplete lists members |

Subscribe to **Issues**, **Pull request**, **Pull request review**, **Workflow
run**, **Check run** and **Deployment status**, with the webhook URL
`https://<your worker>/github/webhook` and a secret of your choice.

The private key GitHub gives you is PKCS#1 (`BEGIN RSA PRIVATE KEY`). bob turns
it into the PKCS#8 that WebCrypto needs, so paste it as downloaded. A key pasted
on one line with `\n` in it works too.

## 2. Cloudflare

Put the secrets in `.dev.vars`, one `NAME="value"` per line (write a
multi-line value such as the private key with `\n`), then deploy with them:

```sh
bun install
bun run secrets:push                  # checks the wrangler login, lists the names, asks
bun run secrets:push --with-discord   # also sends DISCORD_TOKEN, which starts the gateway
```

The script refuses to run unless wrangler is logged in as `admin@ranqia.com`
(set `CLOUDFLARE_EMAIL` for another login). A Worker that does not exist yet
cannot get secrets before its first deploy, so the secrets go with
`wrangler deploy --secrets-file`; on an existing Worker the ones left out stay
as they are.

`wrangler.jsonc` sets five variables:

| Variable      | Meaning                                                          |
| :------------ | :--------------------------------------------------------------- |
| `GITHUB_ORG`  | the org whose repos and people bob follows                       |
| `BOB_REPO`    | bob's own repo, whose home channel hears about bob's own deploys |
| `PUBLIC_URL`  | where bob answers on the web, for the services' OAuth callbacks  |
| `AGENT_MODEL` | the OpenAI model behind the agent                                |
| `TIMEZONE`    | the team's time zone, for working hours and the retro's days     |

When a new version of bob runs, a card in `BOB_REPO`'s home channel says how
long it took from the commit to the build, to running, and to the slash
commands; it deletes itself after five minutes. bob takes the head of the
default branch as the deployed commit. To make it exact, have Workers Builds
deploy with `npx wrangler deploy --tag $WORKERS_CI_COMMIT_SHA`.

For local work, put the same names in `.dev.vars` and run `bun run dev`.

## 3. Discord

In the [developer portal](https://discord.com/developers/applications):

1. Under **Bot**, turn on the **Message Content** intent. Without it bob sees
   mentions but not what they say.
2. Under **General Information**, set the **Interactions Endpoint URL** to
   `https://<your worker>/discord/interactions`.
3. Invite the bot with the `bot` and `applications.commands` scopes and the
   permissions View Channels, Send Messages, Send Messages in Threads, Embed
   Links and Read Message History.

```sh
bunx wrangler secret put DISCORD_TOKEN
bunx wrangler secret put DISCORD_PUBLIC_KEY
# Optional: register the commands on one server, where they appear at once.
bunx wrangler secret put DISCORD_GUILD_ID
```

The gateway connects within five minutes of the first deploy, when the cron
first runs, and registers the slash commands when Discord says it is ready.
After later deploys, changed commands reach Discord within a heartbeat, about
forty seconds.

## 4. Slack

Create an app from [`slack/manifest.json`](https://github.com/ranqialabs/workspace/blob/main/slack/manifest.json)
after replacing `YOUR-WORKER` with your Worker's host, and install it in the
workspace. Install it as an app of your own workspace rather than distributing
it: Slack limits `conversations.history` to one request a minute for apps
distributed outside the Marketplace, and the agent reads history.

```sh
bunx wrangler secret put SLACK_BOT_TOKEN       # xoxb-…, under OAuth & Permissions
bunx wrangler secret put SLACK_SIGNING_SECRET  # under Basic Information
```

Invite bob to the channels it should post to or answer in: `/invite @bob`.

## 5. Sauron (optional)

For the agent to read production, give it a token for
[Sauron](https://sauron.ranqia.io), the team's Grafana. In Grafana, under
**Administration > Users and access > Service accounts**, create one with the
**Viewer** role, add a token, and put it in `.dev.vars`:

```sh
SAURON_TOKEN="glsa_..."
# SAURON_URL="https://sauron.ranqia.io"   # the default
```

Then `bun run secrets:push`. Without the token the Sauron tools stay out of the
agent. What they read is in [The agent](agent.md#production-through-sauron).

## 6. Outside services (optional)

Dorothy connects with its API key, the same as its MCP server's:

```sh
DOROTHY_API_KEY="dorothy_..."
```

Cloudflare and PostHog need no secret: someone runs `/connect` and authorizes
bob in the browser, and the OAuth callback comes back to `PUBLIC_URL` in
`wrangler.jsonc`. To use a key instead, set `CLOUDFLARE_MCP_TOKEN` (a Cloudflare
API token) or `POSTHOG_MCP_TOKEN` (a personal API key with the MCP Server
preset). See [The agent](agent.md#outside-services).

## 7. Tell bob where things go

Repos and people are mapped from chat; see [Commands](commands.md).

```text
/map repo repo:acme/web channel:#web          (Discord)
/bob map repo acme/web #web                    (Slack)
/map github login:ana-gh member:@Ana           (Discord)
/bob map github ana-gh @Ana                    (Slack)
```

## Development

```sh
bun install        # also installs the prek hooks
bun run check      # wrangler types, oxlint, oxfmt and the tests, as CI runs them
bun run docs       # this site, at http://localhost:8000
```

The hooks run oxlint (type-aware), oxfmt and the tests before each commit.
Tests run on Bun with an in-memory SQLite standing in for Durable Object storage
and a scripted model standing in for OpenAI, so they need no network and no
Cloudflare account.
