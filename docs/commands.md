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

And you never touch an ID. Team, repo, and user names come from **autocomplete
backed by the GitHub API** — start typing and the bot offers your org's real
teams, repos, or members. Roles and channels are ordinary Discord **mentions**.

!!! info "Teams are not mapped — they're mirrored"

    There is no `/map team`. GitHub is the source of truth for team membership,
    so [`/sync roles`](#sync-roles) *creates* a Discord role per team and keeps it
    in step on its own. You only map the things GitHub can't infer: which repos
    group into which channel, and who each GitHub user is on Discord.

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

This is the join that makes mentions and role sync work: it's how the bridge
knows a PR by `itsmeale` should ping a particular person. The bot confirms with a
small embed showing the GitHub avatar and profile, so you can see at a glance you
picked the right account. Re-mapping a login overwrites the old link.

### `/sync roles` { #sync-roles }

Mirror the org's GitHub teams into Discord, right now. This also runs
automatically on every boot.

```text
/sync roles
```

For each team in the org, the bridge:

1. **Ensures a role** named after the team exists, creating it if missing.
2. **Reconciles membership** against the [linked users](#map-user): it *adds* the
   role to members who belong to the team and *removes* it from those who no
   longer do — so the role always reflects GitHub.
3. **Gates the mapped channels**: it reads which teams can access each repo on
   GitHub and sets channel permissions so a channel is visible only to the roles
   of teams with access. A role sees a channel if its team can access *any* repo
   mapped there.

It replies with what changed — roles created, members added and removed, and any
GitHub logins it couldn't place because nobody has run [`/map user`](#map-user)
for them yet.

!!! warning "The bot only touches what it manages"

    Removals and channel-permission changes are scoped to the roles the bot
    itself created for teams and to the channels you've mapped. Roles you made by
    hand and channels the bot doesn't know about are never modified.

### `/config` { #config }

Refresh the live configuration panel.

```text
/config
```

The bridge keeps a single **live panel** in `#bot-config` — one embed listing
every team→role, repo→channel, and linked user, rendered with real Discord
mentions. It updates itself after each `/map` and each `/sync`, so it never
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
