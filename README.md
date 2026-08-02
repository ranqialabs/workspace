# ranqialabs workspace

An opinionated workflow for developing private projects, with discussions,
permissions, decisions and knowledge tracked on top of:

- **GitHub Organization**: repositories, teams, permissions
- **Discord Server**: roles, channels, bots, notifications
- **Google Workspace**: commercial discussions, transcriptions, docs

It runs as a single bot process (`bridge/`) that holds a Discord gateway
connection and an HTTP webhook listener on **one event loop**. No cron, no
separate web service, no polling. There is no database and no disk: every
mapping lives as an ordinary message in a private `#bot-config` channel.

## What it does

**Access mirrors GitHub.** Map a repo to a channel and the bridge creates a
`‹repo› devs` role, fills it with everyone who can reach that repo on GitHub, and
makes the channel visible only to that role. Grant access on GitHub and the
channel opens; revoke it and it closes.

**GitHub activity lands in Discord.** Issues, pull requests, reviews, CI and
deploys post rich embeds to the repo's channel, `@mentioning` the people
involved. Issues and deploys keep one message that gets *edited* in place rather
than stacking a new one per state change.

**`/issue` drafts a GitHub issue from a conversation.** Point it at a discussion
and an agent reads the messages, greps the actual code to ground them, checks for
duplicates, and proposes a draft in a thread. Nothing reaches GitHub until
whoever asked clicks **Submit**: the agent has no write tool at all, so that
isn't policy, it's the shape of the code. Talk in the thread to revise it.

## Documentation

<div align="center">

### 👉 [ranqialabs.github.io/workspace](https://ranqialabs.github.io/workspace/) 👈

</div>

Concepts, setup, every command and event, and the roadmap. The sources live in
[`docs/`](docs/).

## Running it locally

```bash
cp .env.example .env    # fill it in, and never commit it
uv sync
uv run python -m bridge
```

GitHub needs a public URL to deliver webhooks to, so expose the port with a
tunnel (cloudflared, ngrok) and point the App's webhook there while you test.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: conventional commits, PRs
on top of `main`, and don't bypass the pre-commit hooks.

---

This project is under heavy development. Despite being public, **we will not help
you set anything up or help you use it.**

If you're a developer (a real one) seeing this and you want to use it, pay
attention to what we actually do under the hood. Do not trust blindly.

See ya.
