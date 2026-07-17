---
icon: lucide/map
---

# Roadmap

Phase 1 is the GitHub ↔ Discord bridge described in these docs. What follows is
what's planned. Each new capability is a **cog** — it plugs in without touching
what already works.

## Coming next

<div class="grid cards" markdown>

- :lucide-git-pull-request:{ .lg .middle } **More commands**

  ***

  `/create-issue` and `/request-review` — act on GitHub straight from Discord.

- :lucide-user-minus:{ .lg .middle } **Role removal**

  ***

  Optionally remove a Discord role when someone leaves a GitHub team. Behind a
  flag, off by default.

- :simple-google:{ .lg .middle } **Google Workspace**

  ***

  Pull data from Google Workspace into the bridge — a `workspace` cog.

- :lucide-mic:{ .lg .middle } **Voice & knowledge**

  ***

  Voice transcription, summarization, and knowledge management — one cog each.

</div>

## Known limitations (Phase 1)

- **Review requests only mention individuals**, not teams.
- **The webhook needs a public URL** — no hosting is set up yet; the process
  must run somewhere reachable by GitHub.
- **Identity mapping is manual** via `/link`. No GitHub/Discord OAuth.

## Design principle

> Adding a domain must not touch the code of the existing ones.

That's why everything is a cog and events go through a dispatch table. When the
second and third domains arrive, the right boundaries will already be there —
without a plugin framework or an event bus we don't need yet.
