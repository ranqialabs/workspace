---
icon: lucide/terminal
---

# Commands & news

## Commands

The same commands exist on both platforms. On Discord they are slash commands
with autocomplete for repos and GitHub logins. On Slack they are subcommands of
`/bob`. Replies are shown only to whoever ran the command.

| Discord                         | Slack                                     | What it does                                                                                 |
| :------------------------------ | :---------------------------------------- | :------------------------------------------------------------------------------------------- |
| `/config`                       | `/bob config` (or just `/bob`)            | Shows every repo channel and every person bob knows on this platform                         |
| `/map repo repo: channel:`      | `/bob map repo owner/name [#channel]`     | Makes the channel the repo's **home**: its news, and the repo an issue drafted there goes to |
| `/map announce repo: channel:`  | `/bob map announce owner/name [#channel]` | Sends the repo's news to another channel than its home                                       |
| `/map github login: member:`    | `/bob map github login @person`           | Says who a GitHub login is, so news mentions them and the agent can assign them              |
| `/map linear email: member:`    | `/bob map linear email @person`           | The same for a Linear account                                                                |
| `/unmap repo repo: [announce:]` | `/bob unmap repo owner/name [announce]`   | Forgets the home channel, or the announce channel                                            |
| `/unmap github member:`         | `/bob unmap github @person`               | Forgets someone's GitHub login                                                               |
| `/unmap linear member:`         | `/bob unmap linear @person`               | Forgets someone's Linear account                                                             |

On Slack, leaving the channel out of `map repo` means the channel you run it in.

### Coming from the Python version

`/import channel:#bot-config` (Discord, Manage Server) reads the channel where
the Python bob kept its configuration and applies every line once: home and
announce channels, access roles, and GitHub and Linear accounts. Running it
again is harmless; later lines win, as they did before. The channel is not
touched and can be archived afterwards.

### Who can run them

- **Discord.** `/map` and `/unmap` need the **Manage Server** permission;
  Discord greys them out for everyone else. `/config` is open to everyone.
- **Slack.** Changing a mapping needs a workspace admin or owner. `/bob config`
  is open to everyone.

### What gets checked

A repo must exist in the org, spelled any way: `/map repo web` maps
`ranqialabs/web`. A GitHub login must belong to an org member. Linear emails are
stored as given. Mapping a login that someone else holds moves it to the new
person, and linking the same login from Discord and from Slack makes the two
accounts one person.

## News { #news }

GitHub events reach every channel that follows the repo, on each platform. A
repo's news goes to its announce channel when it has one, and to its home
channel otherwise.

### Issues

One card per issue, edited as it changes: opened, assigned, closed as completed
or not planned, reopened. Opening or reopening mentions the repo's people and
the assignees; assigning mentions the new assignee.

### Pull requests

One card per pull request. Opening it (or marking a draft ready) mentions the
repo's people; a review request mentions the reviewer; a review mentions the
author, unless they reviewed their own; merging or closing mentions the author.
Draft pull requests post nothing until they are ready.

### Pipelines { #pipeline-card }

One card per commit pushed to a branch, holding everything the push set off:
each workflow's jobs as one line each, check runs, and deployments with their
environment. The card is titled with the commit's subject and credits its
author.

### When a card is posted again

A card is edited in place while it is fresh: an hour for issues and pull
requests, ten minutes for a pipeline. A later change posts a new card rather
than editing one that has scrolled away. Cards older than thirty days are
forgotten.

Mentions always go in a reply under the card, not in the card, so editing a card
never pings anyone twice and a ping always notifies.
