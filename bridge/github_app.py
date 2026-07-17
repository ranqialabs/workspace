"""GitHub App client: authenticate as the app, act as the org installation."""

from githubkit import AppAuthStrategy, GitHub

from bridge.config import Config, Secrets


async def installation_client(secrets: Secrets, config: Config) -> GitHub:
    """
    A GitHub client authenticated as the app's installation on the org.

    Resolves the org installation id, then returns a client scoped to it.
    """
    app = GitHub(AppAuthStrategy(secrets.github_app_id, secrets.github_private_key))
    resp = await app.rest.apps.async_get_org_installation(config.org)
    return app.with_auth(app.auth.as_installation(resp.parsed_data.id))
