---
icon: lucide/bot
---

# The agent

Mention bob and it answers. It reads the code on GitHub before it says
anything about it, and cites `path/to/file.ts:line` so you can check. Ask it
for an issue and it proposes a draft for you to submit.

## Talking to it

=== "Discord"

    Mention `@bob` in a channel or a thread, or reply to something it said. The
    conversation is the channel or thread you are in.

=== "Slack"

    Mention `@bob` in a channel it was invited to. It answers in a thread under
    your message, and the thread is the conversation from then on: mention it
    there again to keep going.

On a conversation's first turn bob gets the eight messages before your mention,
to orient itself. If they are not enough it reads further back with
`read_conversation`, as far as it decides it needs to.

After that the conversation is **stored**: the next turn sees everything the
model saw before, including what each tool returned. The model reads back the
last twenty turns; older ones stay stored.

### The progress card

Each answer starts with a card that lists bob's tool calls, one line each, and
is edited as they run:

```text
🤖 bob
Working…
📄 web reading `src/auth.ts`
🔎 searching code `useSession`
⏳ web reading issue #12
```

A line turns ⚠️ with the reason when a call fails. When the run ends the card
says _Answered_ or _Drafted an issue_, with the tokens it used, and the answer
arrives as a reply.

**Stop** on the card ends the run. Only whoever asked can press it.

### One answer at a time

Mention bob while it is still answering in the same conversation and your
message is queued: it replies `💭 queued` and takes it up when the current
answer lands. Everything that queued up goes in as one turn. Other
conversations are not affected.

## Drafting an issue

Say you want one: _"vamos abrir uma issue pra isso"_, _"file this"_. Describing
a bug is not asking for an issue; when the two are hard to tell apart, bob
answers and asks.

Before drafting, bob reads what the repo published: its
`.github/ISSUE_TEMPLATE`, `CLAUDE.md` and `CONTRIBUTING.md`. The draft arrives as
a card:

| Button      | What it does                                                                                                |
| :---------- | :---------------------------------------------------------------------------------------------------------- |
| **Submit**  | Creates the issue on GitHub, with a link back to the conversation, and turns the card into the issue's card |
| **Discard** | Drops the draft; nothing reaches GitHub                                                                     |

Only whoever asked for the draft can press them. Anyone else gets a private
note saying so.

Keep talking to change it: _"scope it to Safari"_, _"assign it to me"_. Each
revision is a new card, and the previous one loses its buttons and says it was
replaced. A question in front of a draft leaves the draft alone.

### Where an issue can go

The repos mapped to the channel you are in, and to a thread's parent channel,
are the candidates. With one candidate the draft goes there; with several, bob
picks one of them; when the channel has none, any repo with a home channel on
this platform. A draft for any other repo goes back to the model to fix before
you ever see it.

### Why nothing is filed by mistake

The model has **no write tool**. `propose_issue` records a draft and ends the
run; it does not reach GitHub. Creating the issue is ordinary code behind a
button, and the button checks who pressed it. A confused model can waste tokens,
but cannot open an issue.

## What it can read

| Tool                                                                                   | Reads                                                       |
| :------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| `list_repos`                                                                           | the repos the app can see                                   |
| `search_code`, `read_file`, `list_dir`                                                 | code, at any ref                                            |
| `recent_commits`, `get_commit`, `compare_refs`                                         | history                                                     |
| `list_issues`, `get_issue`, `similar_issues`, `repo_labels`                            | issues, filtered by assignee, label or state                |
| `list_pull_requests`, `get_pull_request`, `pull_request_files`, `pull_request_reviews` | pull requests and their reviews                             |
| `check_runs`, `check_failures`                                                         | CI on a branch or commit, and its error messages            |
| `teammates`                                                                            | the people bob knows, with their GitHub and Linear accounts |
| `read_conversation`                                                                    | earlier messages of the conversation                        |

GitHub's code search misses repos it has not indexed, so bob is told that an
empty result is not proof something is absent, and to read the file where it
would be instead.

## Cost

The model is set by `AGENT_MODEL` in `wrangler.jsonc`. Each answer's card shows
the tokens it used, cached tokens included.
