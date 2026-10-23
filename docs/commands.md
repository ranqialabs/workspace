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
| `/map retro channel:`           | `/bob map retro [#channel]`               | Posts the daily and weekly [retros](#retro) in the channel                                   |
| `/unmap retro`                  | `/bob unmap retro`                        | Stops posting the retros                                                                     |
| `/retro [period:]`              | `/bob retro [week]`                       | Posts what shipped today, or this week so far, in the channel you are in                     |

On Slack, leaving the channel out of `map repo` or `map retro` means the
channel you run it in.

Mapping a repo to a home channel also gates that channel on Discord. bob keeps
an access role named `<repo> devs`, filled from GitHub, and leaves the channel
visible only to it. It refreshes after every deploy and after any command that
changes the configuration.

### Coming from the Python version

`/import channel:#bot-config` (Discord, Manage Server) reads the channel where
the Python bob kept its configuration and applies every line once: home and
announce channels, access roles, and GitHub and Linear accounts. Running it
again is harmless; later lines win, as they did before. The channel is not
touched and can be archived afterwards.

### Who can run them

- **Discord.** `/map` and `/unmap` need the **Manage Server** permission;
  Discord greys them out for everyone else. `/config` and `/retro` are open to
  everyone.
- **Slack.** Changing a mapping needs a workspace admin or owner. `/bob config`
  and `/bob retro` are open to everyone.

### What gets checked

A repo must exist in the org, spelled any way: `/map repo web` maps
`ranqialabs/web`. A GitHub login must belong to an org member. Linear emails are
stored as given. Mapping a login that someone else holds moves it to the new
person, and linking the same login from Discord and from Slack makes the two
accounts one person.

## News { #news }

GitHub events reach every channel that follows the repo, on each platform. A
repo's news goes to its announce channel when it has one, and to its home
channel otherwise. [Cards](cards.md) shows how each card looks and what its
colours mean.

### Issues

One 🐛 card per issue, edited as it changes: opened, assigned, closed as
completed or not planned, reopened. Opening or reopening mentions the repo's people and
the assignees; assigning mentions the new assignee.

### Pull requests

One 🔀 card per pull request. Opening it (or marking a draft ready) mentions the
repo's people; a review request mentions the reviewer; a review mentions the
author, unless they reviewed their own; merging or closing mentions the author.
Draft pull requests post nothing until they are ready.

### Pipelines { #pipeline-card }

One 🚦 card per commit pushed to a branch, holding everything the push set off:
each workflow's jobs as one line each, check runs, and deployments (🚀) with
their environment. The card is titled with the commit's subject and credits its
author.

### Why did it fail?

A red 🚦 card has a **Why did it fail?** button. Pressing it asks the agent, in
the card's thread, as if you had asked there: it reads the failing jobs' errors
and what the commit changed, and answers with the cause, citing files, and what
would fix it. The button goes away once the checks pass.

### What shipped to production

When a deploy to an environment with `prod` in its name succeeds, bob compares
the commit with the one the previous production deploy shipped and replies under
the 🚦 card with what went out, in a few plain bullets the model writes from the
commit subjects. The first deploy bob sees only sets the starting point, and a
rollback announces nothing.

```text
🚀 What shipped to production
- Login no longer loops on Safari (#31)
- Stripe webhooks retry on failure (#8)
```

### Reminders

- **The default branch turns red.** The author of the commit that broke it is
  mentioned under the card, once. Later failures on the same commit stay quiet.
- **A review waits more than a day.** The reviewer is mentioned under the pull
  request's card, at most once a day, until they review or the pull request
  closes.

Reminders go out on working days, 9:00 to 18:00 in `TIMEZONE` (set in
`wrangler.jsonc`), and only to people bob can mention on that platform.

### When a card is posted again

A card is edited in place while it is fresh: an hour for issues and pull
requests, ten minutes for a pipeline. A later change posts a new card rather
than editing one that has scrolled away. Cards older than thirty days are
forgotten.

Mentions always go in a reply under the card, not in the card, so editing a card
never pings anyone twice and a ping always notifies.

## Retro { #retro }

A 📊 card for a channel the whole org reads, saying what shipped across every
project. On working days at 18:00 in `TIMEZONE` it goes to the channel set with
`map retro`: the day's retro Monday to Thursday, the week's on Friday. A day
where nothing was merged, closed or deployed posts nothing. `/retro` posts one
at any time, in the channel you run it in.

```text
▌ 📊 Weekly retro
▌ What shipped the week of October 19
▌ Hedy, our own ChatGPT collector, gained jobs and cost dashboards.
▌ - **Hedy replaces BrightData as collector**: Ada can get answers from it...
▌ **51 pull requests merged** · 131 commits · +29.3k / −9.7k lines · 41 min of CI
▌ **💥 Breaking changes**
▌ - **hedy** one resource, POST /v1/answers over the jobs [#11](...)
▌ …
▌ **The rest of the list is in the reply below.**
▌ 🚀 in production   ⏳ waiting for a deploy
```

- **The reading** opens the card: the model's overview and the themes it found
  in the merged pull requests, each with the pull requests behind it. It is told
  to invent nothing; without a DeepSeek key the changelog stands alone.
- **The numbers** come from GitHub's search: pull requests merged, commits and
  lines, CI time, and how much of the work reached production.
- **The changelog** groups every merged pull request by its conventional-commit
  kind, links it, and marks whether it reached production (🚀) or is waiting for
  a deploy (⏳). "Still open" lists pull requests opened in the period that are
  still open.
- **The rest** of a long list follows as a reply under the card, because Discord
  stops at 4096 characters per card. The two messages read in order.
- **The picture** on the card draws the same numbers as a ledger, the merge
  timeline, the repositories, the deploy state and the people, and shows the
  model's themes and highlights. A picture taller than 2000 px is drawn without
  the summary, which the card already has; if drawing still fails, only the
  numbers, the people and the highlights go. The card always carries the
  one-line numbers.

A day is the team's calendar day in `TIMEZONE`, and a week runs Monday to
Sunday.
