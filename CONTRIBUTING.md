# Setup

1. Have [uv](https://docs.astral.sh/uv/#installation) installed.
2. Run `uv sync` to install deps.
3. Run `uv run prek install --prepare-hooks` to install pre-commit hooks.


# Contributing
1. we use [semantic commit](https://www.conventionalcommits.org/en/v1.0.0/#summary) for all our commits.
2. we do not have a `dev`/`staging` branch, all PR's are on top of main.
3. the PR's titles must folow semantic commit pattern as well, since the merge strategy is _squash_.
4. DO NOT use "co-authored by: some shit ai model".
5. DO NOT BYPASS the pre commit hook verification.
