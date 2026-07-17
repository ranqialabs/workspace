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

### `/map team` { #map-team }

Tie a GitHub team to a Discord role.

```text
/map team team:‹slug› role:@Role
```

| Parameter | Description |
| :-------- | :---------- |
| `team` | Autocompletes from the org's GitHub teams — pick one |
| `role` | The Discord role members of that team should get |

This is what [`/sync roles`](#sync-roles) acts on. Mapping a team again just
updates it.

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

Bring Discord roles in line with GitHub team membership, right now.

```text
/sync roles
```

For each mapped team, the bridge lists its GitHub members, looks each one up
among the linked users, and adds the mapped role to the matching Discord member
if they don't have it yet. It replies with a summary — how many roles it granted,
and which GitHub logins it couldn't place because nobody has run
[`/map user`](#map-user) for them yet.

!!! note "Phase 1 only adds roles"

    It never removes them. Taking a role away when someone leaves a team is
    [on the roadmap](roadmap.md), gated behind a flag, so an accidental team
    change can't silently strip access.

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
