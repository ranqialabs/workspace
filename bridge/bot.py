"""The bot process: discord.py Bot + the webhook server, one event loop."""

import logging

import discord
from aiohttp import web
from discord.ext import commands
from githubkit import GitHub
from pydantic_ai import Agent
from pydantic_ai.exceptions import UserError

from bridge import store
from bridge.cogs.github_sync import GithubSync
from bridge.config import Config, Secrets
from bridge.github_app import installation_client
from bridge.agent import core as agent_core
from bridge.agent import view as agent_view
from bridge.agent.core import Reply
from bridge.agent.tools import Deps
from bridge.live import LiveMessages
from bridge.webhook import WebhookServer

log = logging.getLogger(__name__)

INITIAL_COGS = [
    "bridge.cogs.github_sync",
    "bridge.cogs.notifications",
    "bridge.cogs.issues",
    "bridge.cogs.mentions",
]


class BridgeBot(commands.Bot):
    def __init__(self, config: Config, secrets: Secrets) -> None:
        intents = discord.Intents.default()
        intents.members = True  # needed to read/edit member roles
        intents.message_content = True  # mentions and /issue read what people wrote
        super().__init__(command_prefix="!", intents=intents)
        self.config = config
        self.secrets = secrets
        self.webhook = WebhookServer(secrets.webhook_secret)
        self.live = LiveMessages()  # one live message per entity (dedup + edit)
        self.github: GitHub | None = None  # set in setup_hook
        self.store: store.Store | None = None  # set in on_ready (needs the guild)
        self.agent: Agent[Deps, Reply] | None = None  # set in setup_hook
        self._runner: web.AppRunner | None = None
        self._ready_once = False

    async def setup_hook(self) -> None:
        # Runs before we connect to the gateway, so the guild isn't known yet.
        # Only wire up things that don't need it here.
        self.github = await installation_client(self.secrets, self.config)

        # An unknown model string or a missing provider key disables /issue rather
        # than stopping the bridge, which does plenty without drafting.
        try:
            self.agent = agent_core.build(self.config.agent_model)
        except ValueError, UserError:
            log.exception("agent unavailable; mentions and /issue are disabled")

        for cog in INITIAL_COGS:
            await self.load_extension(cog)

        # Draft buttons outlive this process: discord.py rebuilds each one from
        # its custom_id, so they keep working across a restart.
        for button in agent_view.BUTTONS:
            self.add_dynamic_items(button)

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
