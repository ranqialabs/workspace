"""The bot process: discord.py Bot + the webhook server, one event loop."""

import discord
from aiohttp import web
from discord.ext import commands
from githubkit import GitHub

from bridge import store
from bridge.cogs.github_sync import GithubSync
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
        self.store: store.Store | None = None  # set in on_ready (needs the guild)
        self._runner: web.AppRunner | None = None
        self._ready_once = False

    async def setup_hook(self) -> None:
        # Runs before we connect to the gateway, so the guild isn't known yet.
        # Only wire up things that don't need it here.
        self.github = await installation_client(self.secrets, self.config)

        for cog in INITIAL_COGS:
            await self.load_extension(cog)

        self._runner = web.AppRunner(self.webhook.app)
        await self._runner.setup()
        site = web.TCPSite(
            self._runner, self.secrets.webhook_host, self.secrets.webhook_port
        )
        await site.start()

    async def on_ready(self) -> None:
        # Guild-dependent setup. on_ready can fire more than once; guard it.
        if self._ready_once:
            return
        self._ready_once = True

        guild = self.guilds[0]  # the bot lives in exactly one server
        if not guild.chunked:
            await guild.chunk()  # populate the member cache for role reconciliation
        channel = await store.find_or_create_config_channel(guild)
        self.store = store.Store(channel)
        await self.store.load()

        # Sync slash commands to our guild (instant, unlike global sync).
        self.tree.copy_global_to(guild=guild)
        await self.tree.sync(guild=guild)

        # Mirror GitHub into Discord on startup: roles, membership, channel access.
        cog = self.get_cog("GithubSync")
        if isinstance(cog, GithubSync):
            await cog.run_sync(guild)
        await self.store.refresh_panel()  # panel reflects the freshly synced state

    @property
    def guild(self) -> discord.Guild:
        return self.guilds[0]

    async def close(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
        await super().close()
