---
icon: lucide/layout-template
---

# Cards

Everything bob posts is a card, a reply, or both. This page is the visual
language they share. The code is in `src/ui`: `glyphs.ts` holds every emoji,
and each view (`news.ts`, `progress.ts`, `draft.ts`, `commands.ts`) draws one
kind of card.

## Anatomy

```text
▌ 🐛 Open issue in ada-api              kicker: kind emoji, state, repo
▌ Fix the login redirect #12            title: links to GitHub
▌ The callback drops the state param…   body
▌ Opened by @ana     Assignees @beto    fields
▌ Today at 14:02                        time of the last change
```

On Discord the bar on the left takes the card's colour. Block Kit has no bar,
so on Slack the colour leads the kicker as a dot: `🟢 🐛 Open issue in ada-api`.

## Kind, state and colour

The kicker's emoji says what the card is about and never changes. The colour
says its state, following GitHub's own colours where GitHub has one.

| Kind               | Emoji | States and colours                                                    |
| :----------------- | :---- | :-------------------------------------------------------------------- |
| Issue              | 🐛    | open 🟢, closed 🟣, closed as not planned ⚪                          |
| Pull request       | 🔀    | open or approved 🟢, merged 🟣, closed 🔴                             |
| Checks of a commit | 🚦    | running 🔵, passed 🟢, failed 🔴                                      |
| The agent at work  | 🤖    | thinking or working 🔵, answered or drafted 🟢, stopped ⚪, failed 🔴 |
| Issue draft        | 📝    | waiting for review 🔵, filed 🟢, discarded or replaced ⚪             |
| Configuration      | ⚙️    | Discord's brand colour, no dot                                        |
| Retro              | 📊    | Discord's brand colour, no dot                                        |

A deploy is a line on its commit's checks card, marked 🚀.

## Marks

A line in a list starts with a mark for how that one thing went, so lines
align and a failure stands out in a column of passes.

| Mark | Means                                           |
| :--- | :---------------------------------------------- |
| ✅   | done, passed, approved                          |
| ❌   | failed, changes requested                       |
| ⏳   | running, waiting, queued                        |
| ⚠️   | an agent's tool call failed and the run went on |
| 💬   | comments                                        |

```text
`a1b2c3d` by @ana
✅ CI / lint passed in 41s
❌ CI / test failed in 2m 3s
⏳ 🚀 production deploying
```

## Writing

- **Sentence case, plain verbs.** "Open issue in ada-api", "Read issue #12 in
  web", "Approved by @ana, with 2 comments".
- **Titles read like GitHub's.** The title first, then the number:
  `Fix the login redirect #12`.
- **A repo is named by its short name.** The org is always the same, so
  `ada-api`, not `ranqialabs/ada-api`.
- **A button and its reply use the same verb.** File issue, then "Filed #12 in
  web". Discard, then "Discarded draft".
- **A mistake says how to fix it.** "No repo called `wbe` in the org. Check the
  spelling, and that the GitHub App is installed on it."
- **People are mentioned in a reply under the card**, never in the card, so
  editing a card never pings anyone twice.
