---
icon: lucide/terminal
---

# Commands & events

## Slash commands

Both commands require the caller to have the **admin role** configured as
[`ADMIN_ROLE_ID`](configuration.md#3-environment-variables). Anyone else gets a polite
refusal.

### `/link` { #link }

Map a GitHub login to a Discord member.

```
/link github_login:<login> member:@someone
```

| Parameter      | Description                          |
| :------------- | :----------------------------------- |
| `github_login` | The GitHub username, e.g. `itsmeale` |
| `member`       | The Discord member to map it to      |

Stored in the SQLite identity map. Re-linking the same login overwrites the old
mapping. This is what makes `/sync-roles` and @mentions work.

### `/sync-roles` { #sync-roles }

Read GitHub team membership and assign matching Discord roles.

```
/sync-roles
```

For each `team → role` pair in [`TEAM_TO_ROLE`](configuration.md#3-environment-variables),
the bridge lists the team's members, looks each one up in the identity map, and
adds the role to the linked Discord member if they don't have it yet. It replies
with a summary: how many roles were added, and which GitHub logins have no
`/link` yet.

!!! note "Phase 1 only adds roles"

    It never removes roles. Removing a role when someone leaves a team is
    [on the roadmap](roadmap.md) behind a flag, to avoid accidental removals.

## Events { #events }

The bridge listens for these GitHub webhook events and posts to the repo's
channel (from [`REPO_TO_CHANNEL`](configuration.md#3-environment-variables)). If the actor
is linked, they're @mentioned; otherwise their GitHub login is shown as text.

| Event                               | Trigger                 | Message                          |
| :---------------------------------- | :---------------------- | :------------------------------- |
| `pull_request` (`opened`)           | A PR is opened          | Posts title, author, link        |
| `pull_request` (`review_requested`) | A reviewer is requested | @mentions the requested reviewer |
| `issues` (`opened`)                 | An issue is opened      | Posts title, author, link        |

!!! info "Review requested by team"

    Right now only individual reviewers are mentioned. If a review is requested
    from a whole team, GitHub sends a different field — handling that is on the
    [roadmap](roadmap.md).
