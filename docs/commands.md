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

1. **Ensures an access role** named `🔒 ‹repo›` exists, creating it if missing.
2. **Reconciles membership** against the [linked users](#map-user): it reads
   everyone with effective access to the repo on GitHub — team members and direct
   collaborators alike — then *adds* the role to those people and *removes* it from
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

The bridge listens for these GitHub webhook events and posts to the channel the
repo is [mapped](#map-repo) to. When the person involved is [linked](#map-user)
they get an `@mention`; otherwise their GitHub login shows up as plain text, so
the message still makes sense.

| Event | Trigger | Message |
| :---- | :------ | :------ |
| `pull_request` (`opened`) | a PR is opened | title, author, link |
| `pull_request` (`review_requested`) | a reviewer is requested | @mentions the requested reviewer |
| `issues` (`opened`) | an issue is opened | title, author, link |

!!! info "Review requested from a team"

    Only individual reviewers are mentioned for now. When a review is requested
    from a whole team, GitHub sends a different field, and wiring that up is
    [on the roadmap](roadmap.md).
