---
icon: lucide/map
---

# Roadmap

Phase 1 is the GitHub ↔ Discord bridge described in these docs. What follows is
what's planned — each new capability is added without disturbing the ones already
running.

## Coming next

<div class="grid cards" markdown>

- :lucide-git-pull-request:{ .lg .middle } **More commands**

  ***

  `/create-issue` and `/request-review` — act on GitHub straight from Discord.

- :lucide-webhook:{ .lg .middle } **Sync on GitHub events**

  ***

  Re-sync automatically when a team's membership or repo access changes on
  GitHub, instead of only on boot and `/sync roles`.

- :simple-google:{ .lg .middle } **Google Workspace**

  ***

  Pull data from Google Workspace into the bridge — a `workspace` cog.

- :lucide-mic:{ .lg .middle } **Voice & knowledge**

  ***

  Voice transcription, summarization, and knowledge management — one cog each.

</div>

## Known limitations (Phase 1)

- **Review requests only mention individuals**, not teams.
- **Identity mapping is manual** via `/map user` — there's no GitHub/Discord OAuth
  to match accounts automatically.
- **Mappings are replayed from a channel on boot** — great up to low hundreds of
  entries, but a much larger server would want a real store.

## Design principle

> Adding a domain must not touch the code of the existing ones.

That's why everything is a cog and events go through a dispatch table. When the
second and third domains arrive, the right boundaries will already be there —
without a plugin framework or an event bus we don't need yet.
