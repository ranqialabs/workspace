"""The `"owner/name"` convention used as a key everywhere."""


def split_repo(repo: str, org: str) -> tuple[str, str]:
    """Split `"owner/name"`, falling back to the org when only a name is given."""
    owner, _, name = repo.rpartition("/")
    return owner or org, name


def short_name(repo: str) -> str:
    """Just the repo's own name — what a card or a role calls it."""
    return repo.rpartition("/")[2]
