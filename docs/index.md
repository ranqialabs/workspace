---
icon: lucide/cable
---

# Ranqia Workspace

A bridge between the **ranqialabs GitHub organization** and the **ranqialabs
Discord server**. It runs as a single bot process that keeps the two in sync and
turns GitHub activity into Discord notifications — mentioning the right people.

## What it does today (Phase 1)

<div class="grid cards" markdown>

- :lucide-users:{ .lg .middle } **Sync teams → roles**

  ***

  An admin runs `/sync-roles` and members get the Discord role that matches
  their GitHub team.

  [:octicons-arrow-right-24: Commands](commands.md#sync-roles)

- :lucide-link:{ .lg .middle } **Link identities**

  ***

  `/link github_login @member` maps a GitHub account to a Discord user, so
  mentions and sync work.

  [:octicons-arrow-right-24: Commands](commands.md#link)

- :lucide-bell:{ .lg .middle } **Live notifications**

  ***

  When a PR is opened, a review is requested, or an issue is opened, the
  bridge posts to the repo's channel and @mentions the person involved.

  [:octicons-arrow-right-24: Events](commands.md#events)

- :lucide-blocks:{ .lg .middle } **Built to grow**

  ***

  Each domain is a cog. New domains — voice, summarization, Google Workspace —
  plug in without touching the existing ones.

  [:octicons-arrow-right-24: Roadmap](roadmap.md)

</div>

## How it hangs together

```mermaid
graph LR
  GH[GitHub org] -- webhook --> W[Webhook listener]
  W --> N[notifications cog]
  N -- post + mention --> DC[Discord channel]
  A[Admin] -- /sync-roles, /link --> S[github_sync cog]
  S -- read teams --> GH
  S -- assign roles --> DC
  S <--> DB[(SQLite identity map)]
  N <--> DB
```

The webhook listener and the Discord bot run in **one process, one event loop**.
No cron, no separate web service, no polling.

## Next steps

- New here? Read [How it works](how-it-works.md).
- Setting it up? Go to [Configuration](configuration.md).
- Want to know what's coming? See the [Roadmap](roadmap.md).
