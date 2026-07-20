---
icon: lucide/terminal
---

# Commands & events

## Slash commands

The commands are grouped into two families — **`/map`** for wiring things
together and **`/sync`** for acting on that wiring — so everything the bot does
lives under a name that says what it's for.

Every command requires the caller to have Discord's **Manage Server**
permission; that's the entire access model, so there's no admin role to create.
Discord greys the commands out for anyone without it.

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
| `check_suite` (`completed`) | the default branch's CI finishes | ✅ passed / ❌ failed, commit sha and author |
| `status`, `deployment_status` | an external deploy (Vercel, …) changes state | 🕒 deploying → ✅ deployed / ❌ failed, with the deploy URL |

Where each message *looks like* is defined in `bridge/render.py` — one pure
function per event — so restyling or adding an event is a self-contained change.

!!! info "Live messages — edited, not repeated"

    An issue and a deploy each keep **one live message** that the bridge *edits*
    in place as state changes (an issue gets assigned then closed; a deploy goes
    pending → done) — instead of stacking a new message per change. It only edits
    while that message is still recent (under an hour) and still the last thing in
    the channel; once it's buried or stale, the next change posts fresh. PRs,
    reviews and CI always post a new message.

!!! info "One line per push, not per workflow"

    `check_suite` is GitHub's *aggregate* of every workflow on a commit, so the
    bridge posts one result per push to the default branch — not one per
    workflow. Only success and failure are announced; cancelled and neutral runs
    are skipped. The commit author is shown as plain text (a check suite carries
    the git author name, not a GitHub login to mention).
