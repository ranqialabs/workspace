"""The bot process: discord.py Bot + the webhook server, one event loop."""

import discord
from aiohttp import web
from discord.ext import commands
from githubkit import GitHub

from bridge import db
from bridge.config import Config, Secrets
from bridge.github_app import installation_client
from bridge.webhook import WebhookServer

INITIAL_COGS = ["bridge.cogs.github_sync", "bridge.cogs.notifications"]


class BridgeBot(commands.Bot):
    def __init__(self, config: Config, secrets: Secrets) -> None:
        intents = discord.Intents.default()
        intents.members = True  # needed to read/edit member roles
        super().__init__(command_prefix="!", intents=intents)
        self.config = config
        self.secrets = secrets
        self.webhook = WebhookServer(secrets.webhook_secret)
        self.github: GitHub | None = None  # set in setup_hook
        self._runner: web.AppRunner | None = None

    async def setup_hook(self) -> None:
        db.init()
        self.github = await installation_client(self.secrets, self.config)

        for cog in INITIAL_COGS:
            await self.load_extension(cog)

        # Serve webhooks on the same loop.
        self._runner = web.AppRunner(self.webhook.app)
        await self._runner.setup()
        site = web.TCPSite(
            self._runner, self.secrets.webhook_host, self.secrets.webhook_port
        )
        await site.start()

        # Sync slash commands to our guild (instant, unlike global sync).
        guild = discord.Object(id=self.config.guild_id)
        self.tree.copy_global_to(guild=guild)
        await self.tree.sync(guild=guild)

    async def close(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
        await super().close()
