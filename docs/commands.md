---
icon: lucide/terminal
---

# Commands & events

## Slash commands

Admin commands are grouped into two families — **`/map`** for wiring things
together and **`/sync`** for acting on that wiring — so everything the bot does
lives under a name that says what it's for. Alongside them,
[**`/issue`**](agent.md) is the one command anyone can run — and you can skip it
entirely by [just mentioning the bot](agent.md).

| Command | Who can run it |
| :------ | :------------- |
| [`/map repo`](#map-repo), [`/map announce`](#map-announce), [`/map user`](#map-user) | Manage Server |
| [`/sync roles`](#sync-roles), [`/config`](#config) | Manage Server |
| [`/issue`](agent.md), *Draft issue from here*, and [`@`mentioning the bot](agent.md) | anyone in the server |

Admin commands require Discord's **Manage Server** permission; that's the entire
access model, so there's no admin role to create. Discord greys them out for
anyone without it.

And you never touch an ID. Repo and user names come from **autocomplete backed by
the GitHub API** — start typing and the bot offers your org's real repos or
members. Roles and channels are ordinary Discord **mentions**.

!!! info "Access is derived, not mapped"

    There is no `/map team` and no `/map role`. GitHub is the source of truth for
    who can reach a repo, so once you [`/map repo`](#map-repo) it to a channel,
    [`/sync roles`](#sync-roles) *creates* an access role for that repo and keeps
    its membership in step on its own. You only map the two things GitHub can't
    infer: which repo groups into which channel, and who each GitHub user is on
    Discord.

### `/map repo` { #map-repo }

Tie a GitHub repo to a Discord channel.

```text
/map repo repo:‹owner/name› channel:#channel
```

| Parameter | Description |
| :-------- | :---------- |
| `repo` | Autocompletes from the org's repos, private ones included — pick one |
| `channel` | Where that repo's PR and issue notifications should land |

A repo with no mapping is simply skipped — its events arrive and are ignored, no
error.

### `/map announce` { #map-announce }

Route a repo's [announcements](#events) to a channel, separate from its plain
notifications.

```text
/map announce repo:‹owner/name› channel:#channel
```

| Parameter | Description |
| :-------- | :---------- |
| `repo` | Autocompletes from the org's repos — pick one |
| `channel` | Where that repo's announcements land |

**Optional.** With no announce channel mapped, announcements fall back to the
repo's [notifications channel](#map-repo) — so a single `/map repo` still gets
everything. Point several repos at one announce channel to gather them (all your
`*-api` releases in one place, say).

### `/map user` { #map-user }

Tie a GitHub user to a Discord member.

```text
/map user github_login:‹login› member:@member
```

| Parameter | Description |
| :-------- | :---------- |
| `github_login` | Autocompletes from the org's members — pick one |
| `member` | The Discord member behind that account |

This is the join that makes mentions and access sync work: it's how the bridge
knows a PR by `itsmeale` should ping a particular person. The bot confirms with a
small embed showing the GitHub avatar and profile, so you can see at a glance you
picked the right account. Re-mapping a login overwrites the old link.

It does one more job: [`/issue`](agent.md) resolves *"assign it to Ana"* to a
GitHub login through these mappings. An unmapped person can't be assigned by
name — the agent will ask who takes it instead of guessing.

### `/issue` { #issue }

Draft a GitHub issue from a conversation, review it in a thread, then submit it.

You don't need this command to get an issue — [mentioning the bot](agent.md) and
asking for one does the same thing, and reads back as far as it needs to on its
own. `/issue` is for when you want to say exactly which messages to read.

```text
/issue [prompt:‹what it's about›] [since_message:‹link›] [last:20] [repo:‹owner/name›]
```

| Parameter | Description |
| :-------- | :---------- |
| `prompt` | What the issue is about — steers the draft. Optional |
| `since_message` | A message **link**; reads from there forward |
| `last` | How many messages to read (default 20, max 100) |
| `repo` | Force the target repo instead of inferring it from the channel |

Also available as **right-click a message → Apps → Draft issue from here**.

Unlike every other command, this one is open to anyone — filing an issue is
ordinary work, and nothing reaches GitHub without a human clicking Submit.

[:octicons-arrow-right-24: How the agent works, in full](agent.md)

### `/sync roles` { #sync-roles }

Reconcile every mapped repo's access against GitHub, right now. This also runs
automatically on every boot.

```text
/sync roles
```

For each repo you've [mapped to a channel](#map-repo), the bridge:

1. **Ensures an access role** named `‹repo› devs` exists, creating it if missing.
2. **Reconciles membership** against the [linked users](#map-user): it reads
   everyone with effective access to the repo on GitHub — team members, direct
   collaborators, and org owners alike — then *adds* the role to those people and
   *removes* it from
   anyone who no longer has access, so the role always reflects GitHub.
3. **Gates the channel**: it sets permissions so the channel is visible only to
   that access role, and hidden from everyone else.

Then it **prunes what you dropped**: a repo you've removed from [`/map repo`](#map-repo)
has its access role deleted (the channel itself is left untouched).

It replies with what changed — roles created and deleted, members added and
removed, and any GitHub logins it couldn't place because nobody has run
[`/map user`](#map-user) for them yet.

!!! warning "The bot only touches what it manages"

    Membership and channel-permission changes are scoped to the access roles the
    bot itself created and to the channels you've mapped. Roles you made by hand
    and channels the bot doesn't know about are never modified.

### `/config` { #config }

Refresh the live configuration panel.

```text
/config
```

The bridge keeps a single **live panel** in `#bot-config` — one embed listing
every repo→channel (with its access role) and linked user, rendered with real
Discord mentions. It updates itself after each `/map` and each `/sync`, so it never
floods the channel: the bot finds its own panel message and **edits it in place**
rather than posting a new one. `/config` just forces that refresh on demand.

## Events { #events }

The bridge listens for these GitHub webhook events and posts a rich embed to the
repo's [announce channel](#map-announce) — or, if none is mapped, its
[repo channel](#map-repo). When the person involved is [linked](#map-user) they
get an `@mention`; otherwise their GitHub login shows up as plain text, so the
message still makes sense. New issues and PRs-ready also ping the repo's
[`@<repo> devs`](#sync-roles) role.

| Event | Trigger | Message |
| :---- | :------ | :------ |
| `issues` (`opened`/`reopened`) | an issue is opened | title, body, author, assignees, labels — pings `@<repo> devs` + assignees |
| `issues` (`assigned`) | someone is assigned | the card, updated — pings the assignee |
| `issues` (`closed`/`unassigned`) | issue closed or unassigned | the card, updated (✅ completed / 🚫 not planned) — no ping |
| `pull_request` (`opened` non-draft / `ready_for_review`) | a PR is ready for review | title, body, author — pings `@<repo> devs` |
| `pull_request` (`review_requested`) | a review is requested | who wants whom to review — pings the reviewer |
| `pull_request` (`closed`) | a PR is merged or closed | 🟣 merged / 🔴 closed, who did it — pings the author |
| `pull_request_review` (`submitted`) | a review is submitted | reviewer, verdict (✅ approved / 🔴 changes / 💬 comment) + body — pings the PR author |
| `workflow_run` (`completed`) | a workflow on the default branch finishes | a line on the commit's [pipeline card](#pipeline-card): the workflow's name, ✅ passed / ❌ failed, and how long it took |
| `deployment_status` | a deploy changes state | a line on the same card: 🚀 the environment deployed to, 🕒 deploying → ✅ deployed / ❌ failed, linking the live URL and the logs |

Where each message *looks like* is defined in `bridge/render.py` — one pure
function per event — so restyling or adding an event is a self-contained change.

!!! info "Live messages — edited, not repeated"

    An issue and a commit's pipeline each keep **one live message** that the
    bridge *edits* in place as state changes (an issue gets assigned then closed;
    a deploy goes pending → done) — instead of stacking a new message per change.
    It only edits while that message is still recent (under an hour) and still the
    last thing in the channel; once it's buried or stale, the next change posts
    fresh. PRs and reviews always post a new message.

!!! info "An issue submitted from Discord posts once, not twice"

    Clicking Submit on an [`/issue`](agent.md) draft posts the new issue's card
    to the repo channel immediately — ahead of GitHub's own `issues.opened`
    webhook, which arrives a moment later. Both use the same live-message key, so
    the webhook **edits** that card instead of posting a second one.

#### One card per commit, not one message per check { #pipeline-card }

A push runs every workflow that matches it, plus any deploy they trigger, and
each one finishing is its own webhook. Posting a message apiece buried the
channel in near-identical lines that didn't even say *which* check had passed.

So they all write to **one card per commit**, keyed on the repo and the sha, with
a line per step naming it and how long it took:

> ✅ **pipeline · workspace**
> **780ea4c on main**
> by Adeildo
>
> **checks** — ✅ [passed](#) in 14s
> **docs** — ✅ [passed](#) in 24s
> **fly deploy** — ✅ [passed](#) in 44s
> **🚀 deploy: github-pages** — ✅ deploy to `github-pages` — [deployed](#) ([logs](#)), by `docs`

Each new step **edits** the card rather than posting under it, for up to ten
minutes after it appeared — long enough for a push's workflows to land, short
enough that a card you've already scrolled past and read as finished doesn't
reopen. Steps are identified by name, so a deploy going queued → deployed
replaces its own line, and re-running one workflow updates just that line and
notes `attempt 2`.

The card's colour is the whole run's verdict, not the last step's: one failure
turns it red and keeps it red however many steps pass afterwards — unless the
re-run of that very step succeeds, which clears it. Only real verdicts get a
line; cancelled, skipped and stale runs say nothing about the code and are
ignored. The commit author is plain text, since a workflow run carries the git
author's name rather than a GitHub login to mention.
