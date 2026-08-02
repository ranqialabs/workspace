"""GitHub App client: authenticate as the app, act as the org installation."""

from githubkit import AppAuthStrategy, AppInstallationAuthStrategy, GitHub

from bridge.config import Config, Secrets


async def installation_client(secrets: Secrets, config: Config) -> GitHub:
    """
    A GitHub client authenticated as the app's installation on the org.

    Resolves the org installation id, then returns a client scoped to it.

    The returned client re-mints its own token: an installation token lives an
    hour and this process runs for weeks, so minting once at boot would leave it
    expired for every call after the first hour.
    """
    app = GitHub(AppAuthStrategy(secrets.github_app_id, secrets.github_private_key))
    resp = await app.rest.apps.async_get_org_installation(config.org)
    return GitHub(
        AppInstallationAuthStrategy(
            app_id=secrets.github_app_id,
            private_key=secrets.github_private_key,
            installation_id=resp.parsed_data.id,
        )
    )
