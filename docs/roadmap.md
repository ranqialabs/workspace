---
icon: lucide/map
---

# Roadmap

The GitHub ↔ Discord bridge described in these docs is what runs today. What
follows is what's planned — each new capability is added without disturbing the
ones already running.

## Shipped

- [x] **Access sync** — a role per repo, filled from GitHub, gating its channel.
- [x] **Notifications** — issues, PRs, reviews, CI and deploys, with live cards
      that get edited rather than repeated.
- [x] **[`/issue`](issues.md)** — draft a GitHub issue from a conversation,
      review it in a thread, submit it with a click.

## Coming next

<div class="grid cards" markdown>

- :lucide-git-pull-request:{ .lg .middle } **More actions**

  ***

  `/request-review` and friends — act on GitHub straight from Discord, with the
  same human-in-the-way shape `/issue` established.

- :lucide-webhook:{ .lg .middle } **Sync on GitHub events**

  ***

  Re-sync automatically when a repo's collaborators or a team's membership change
  on GitHub, instead of only on boot and `/sync roles`.

- :simple-google:{ .lg .middle } **Google Workspace**

  ***

  Pull data from Google Workspace into the bridge — a `workspace` cog.

- :lucide-mic:{ .lg .middle } **Voice & knowledge**

  ***

  Voice transcription, summarization, and knowledge management — one cog each.

</div>

## Known limitations

**Bridge**

- **Review requests only mention individuals**, not teams.
- **Identity mapping is manual** via `/map user` — there's no GitHub/Discord OAuth
  to match accounts automatically.
- **Mappings are replayed from a channel on boot** — great up to low hundreds of
  entries, but a much larger server would want a real store.

**Drafting**

- **Drafts don't survive a restart as conversations.** The buttons keep working
  and the draft is recovered from its own card, but the agent's history is gone,
  so revising by talking stops working. See [Drafting issues](issues.md).
- **Three concurrent drafts**, since each holds its images and history in memory.
- **A recovered draft's body is the preview text**, so one over 1500 characters
  comes back truncated. Every other field is exact.

## Design principle

> Adding a domain must not touch the code of the existing ones.

That's why everything is a cog and events go through a dispatch table. When the
second and third domains arrive, the right boundaries will already be there —
without a plugin framework or an event bus we don't need yet.
