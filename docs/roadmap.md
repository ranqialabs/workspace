---
icon: lucide/map
---

# Roadmap

bob was rewritten from a Python process on Fly.io to TypeScript on Cloudflare
Workers, and gained Slack on the way. This page lists what the Python version
did that this one does not do yet, then what comes after.

## Shipped in the rewrite

- [x] **News** for issues, pull requests, reviews, CI and deploys, one card per
      story on every platform that follows the repo.
- [x] **Commands** to map repos and people, and to show the configuration, on
      Discord and Slack.
- [x] **The agent**: answers grounded in the code, a live progress card, Stop,
      a stored conversation, queued asks, and drafts with File issue and Discard.
- [x] **Slack**, on the Free plan.
- [x] **Why did it fail?** on a red checks card, and reminders for a broken
      default branch and for reviews waiting more than a day.
- [x] **Retro**, daily and weekly, with what shipped and what each person did.

## Not yet back from the Python version

- [ ] **Access sync.** A Discord role per repo, filled from GitHub, gating the
      repo's channel. On Slack's Free plan, which has no user groups, the same
      idea becomes inviting people to and removing them from the repo's private
      channel.
- [ ] **Linear tools** for the agent: teams, projects, cycles, issues and
      documents.
- [ ] **`/issue`** and _Draft issue from here_, to ask for an issue explicitly
      from a message link or a right-click.
- [ ] **Edit draft**, a form to change a draft by hand before filing it.
- [ ] **Following a thread** without being mentioned again in it.
- [ ] **Images** shared in the conversation, passed to the model.
- [ ] **Cost in dollars** next to the tokens.

## Next

<div class="grid cards" markdown>

- :lucide-radio:{ .lg .middle } **Slack's agent features**

  ***

  Stream answers with `chat.startStream`, show the tool calls as Slack's own
  task timeline, and use the agent session status and its stop button instead
  of our card.

- :lucide-type:{ .lg .middle } **Streamed answers on Discord**

  ***

  Edit the answer in place as it is written, as the Python version did.

- :lucide-git-pull-request:{ .lg .middle } **More actions**

  ***

  Request a review, label or assign from chat, with the same shape as File issue:
  the model proposes, a person presses the button.

- :lucide-code:{ .lg .middle } **Coding from chat**

  ***

  Hand an issue to a coding agent from the thread where it was discussed. It
  works in a sandbox, posts its plan and its diff as cards, and opens a pull
  request when someone presses the button. The views go in `src/ui`, next to
  the ones that exist.

</div>
