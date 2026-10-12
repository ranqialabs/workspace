---
icon: lucide/cable
---

# bob

bob connects the ranqialabs GitHub organization to the team's chat, on
Discord and Slack at the same time. It runs on Cloudflare Workers: a Worker
receives GitHub webhooks, Slack's requests and Discord's interactions, and a few
Durable Objects keep the state, each in its own SQLite database.

## What it does

<div class="grid cards" markdown>

- :lucide-bell:{ .lg .middle } **GitHub news, one card per thing**

  ***

  Issues, pull requests, reviews, CI and deploys post a card to the repo's
  channel. Each issue, pull request and commit keeps one card that is edited
  as it changes, and the people involved are mentioned in a reply.

  [:octicons-arrow-right-24: News](commands.md#news)

- :lucide-message-circle:{ .lg .middle } **An agent you mention**

  ***

  Mention bob and it reads the code on GitHub to answer, showing each step it
  takes on a live card. Ask for an issue and you get a draft with **File
  issue** and **Discard** buttons. Nothing reaches GitHub until whoever asked
  presses File issue.

  [:octicons-arrow-right-24: The agent](agent.md)

- :lucide-settings:{ .lg .middle } **Configuration you can ask for**

  ***

  Which channel follows which repo, and who each GitHub login is, live in
  SQLite. `/config` on Discord or `/bob config` on Slack shows all of it at any
  time.

  [:octicons-arrow-right-24: Commands](commands.md)

- :lucide-split:{ .lg .middle } **Discord and Slack, same code**

  ***

  Everything above the platform layer is shared. Configure one platform, or
  both: a repo can post its news to a Discord channel and a Slack channel at
  once.

  [:octicons-arrow-right-24: Concepts](concepts.md)

</div>

## Where to start

- [Concepts](concepts.md) explains how bob is put together and why.
- [Setup](configuration.md) deploys it: the GitHub App, Cloudflare, Discord
  and Slack.
- [Commands & news](commands.md) lists the commands and every card bob posts.
- [Cards](cards.md) is the visual language: kinds, colours, marks and wording.
- [The agent](agent.md) covers talking to bob and drafting issues.
- [Roadmap](roadmap.md) lists what the Python version did that this one does
  not yet, and what comes next.
