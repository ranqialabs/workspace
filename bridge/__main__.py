"""Entrypoint: python -m bridge."""

import asyncio

from bridge import config
from bridge.bot import BridgeBot


async def main() -> None:
    cfg = config.load()
    secrets = config.load_secrets()
    async with BridgeBot(cfg, secrets) as bot:
        await bot.start(secrets.discord_token)


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
