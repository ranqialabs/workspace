# bob

GitHub news and an agent that reads your code, in **Discord and Slack**, on
Cloudflare Workers.

- **News.** Issues, pull requests, reviews, CI and deploys post one card per
  story to the repo's channel, edited as the story changes. The people involved
  are mentioned in a reply.
- **An agent you mention.** It reads the code on GitHub to answer, showing each
  step on a live card. Ask for an issue and you get a draft; nothing reaches
  GitHub until whoever asked presses **Submit**, because the model has no tool
  that writes.
- **Configuration you can ask for.** Repo channels and people live in SQLite;
  `/config` or `/bob config` shows them at any time.

One Worker checks signatures and routes. Durable Objects keep the state: one
for the org's configuration and news, one for the Discord gateway connection,
and one per conversation with the agent.

## Documentation

The full docs are in [`docs/`](docs/index.md):
[concepts](docs/concepts.md), [setup](docs/configuration.md),
[commands & news](docs/commands.md), [the agent](docs/agent.md) and the
[roadmap](docs/roadmap.md).

## Development

```sh
bun install      # dependencies and the prek hooks
bun run dev      # the Worker, locally
bun run check    # wrangler types, oxlint, oxfmt and the tests
bun run docs     # the docs site
```
