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
- [x] **[The agent](agent.md)** — `@` the bot and it answers, grounded in the
      code, streaming as it writes. Ask it for an issue and you get a draft in a
      thread to review and submit with a click.

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
- **Identity mapping is manual** via `/map github` — there's no GitHub/Discord OAuth
  to match accounts automatically.
- **Mappings are replayed from a channel on boot** — great up to low hundreds of
  entries, but a much larger server would want a real store.

**The agent**

- **A rebuilt conversation loses the agent's tool history**, only the prose comes
  back — so a revision after a restart may re-read a file it had already read.
- **A recovered draft's body is the preview text**, so one over 1500 characters
  comes back truncated. Every other field is exact.
- **It reads one channel.** A mention can only read back in the channel it
  happened in, so a question spanning two channels needs the context pasted.

**Linear**

- **Read-only.** The app holds the `read` scope and nothing else, so an issue can't
  be filed, moved or assigned in Linear from Discord. Issues still get drafted for
  GitHub, where a human clicks Submit.
- **The rate limit is per app token**, and the token is shared: everyone's questions
  spend the same quota, with no per-user backoff. When it runs out, the agent is told
  to stop asking and say what it couldn't check.
- **The app sees only the teams it was granted**, so an ungranted team is
  indistinguishable from an absent one at the API. The agent is told to say which it
  can't rule out rather than report absence.
- **Linear teams don't become Discord roles.** Access roles are filled from GitHub
  only; a second source of truth over the same roles is its own design question.

## Design principle

> Adding a domain must not touch the code of the existing ones.

That's why everything is a cog and events go through a dispatch table. When the
second and third domains arrive, the right boundaries will already be there —
without a plugin framework or an event bus we don't need yet.
