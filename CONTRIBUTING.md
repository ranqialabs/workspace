# Setup

1. Have [Bun](https://bun.com) installed.
2. Run `bun install`. It installs the dependencies and the prek pre-commit hooks.
3. Run `bun run check` to see that everything passes: `wrangler types --check`,
   oxlint (type-aware), oxfmt and the tests.

# Contributing

1. we use [semantic commit](https://www.conventionalcommits.org/en/v1.0.0/#summary) for all our commits.
2. we do not have a `dev`/`staging` branch, all PR's are on top of main.
3. the PR's titles must folow semantic commit pattern as well, since the merge strategy is _squash_.
4. DO NOT use "co-authored by: some shit ai model".
5. DO NOT BYPASS the pre commit hook verification.
