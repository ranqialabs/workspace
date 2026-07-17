---
icon: lucide/lightbulb
---

# Concepts

The bridge is built on three convictions. None of them are technical trivia —
each one is a choice about how the tool should feel to use, and each one is why a
particular piece of friction you'd expect simply isn't here. Understanding them
is enough to trust what the bot does on its own.

## GitHub is the source of truth

Your org already answers "who's on which team" and "who can touch which repo" —
in GitHub, where that information is actually maintained. Asking you to re-answer
those questions inside Discord would mean two copies of the truth, and two copies
always drift.

So the bridge only ever reads that state and reflects it. It **creates a Discord
role for each GitHub team**, keeps its members in step — adding people who joined,
removing people who left — and makes each **channel visible only to the teams that
can reach its repos**. Delete a team on GitHub and its role disappears; move
someone between teams and their access follows. You never edit a role or a channel
permission by hand, because the moment you did, GitHub and Discord would disagree.

The rule the bot lives by: it only touches what it created — the team roles and
the channels you mapped. Anything you set up yourself is off-limits, so "reflect
GitHub" can never mean "trample your manual work."

## You should never touch an ID

Discord identifies everything by long numeric snowflakes, and most bots make you
copy them — the server ID, each role ID, a channel ID pasted into a config file.
It's tedious and it's a silent trap: one wrong digit and the bot misbehaves in a
way that's miserable to debug.

The bridge refuses that entire category of error. The only thing you configure by
hand is your GitHub org name. Everything else is either **discovered** (the server
is the one the bot is in; an admin is anyone with *Manage Server*) or chosen
through the interface Discord already gives you — you **mention** a channel, you
**pick** a member, and team and repo names come from autocomplete backed by the
live GitHub API. If you can't fat-finger an ID, you can't misconfigure the bridge.

## Your configuration lives in Discord

The bridge keeps no database and no disk. The mappings it can't derive from GitHub
— which repos group into which channel, and who each GitHub user is on Discord —
are stored as ordinary messages in a private `#bot-config` channel it creates for
itself.

This isn't a shortcut, it's a feature. There's nothing to back up or pay for, it
survives every restart and redeploy for nothing, and — best of all — your
configuration is **something you can read**. Scroll the channel to see every
mapping in plain text. Above those lines the bot keeps one **live panel**: a
single message it edits in place (never reposts, so it never floods) showing the
whole current state with real mentions. The channel is both the storage and the
audit log, and they can't disagree because they're the same thing.

## Why this shape

One last idea sits under the code rather than in front of the user, but it's worth
knowing: the bridge is built to **grow without disturbing what works**. Team sync,
notifications — each is a self-contained unit, and the ones coming later (Google
Workspace, voice, knowledge management; see the [roadmap](roadmap.md)) slot in the
same way, without touching the ones already running. That's a promise about the
future more than a feature you use today, but it's why adding the next capability
won't put the last one at risk.
