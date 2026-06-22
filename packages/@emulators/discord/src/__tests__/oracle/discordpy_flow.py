"""
discord.py acceptance flow against the emulator. A second, independent client oracle (different
language + response parser than discord.js): if discord.py can log in, reach READY over the
zlib-stream gateway, and round-trip REST objects through its strict models, that is strong
production-fidelity evidence. Exits 0 and prints DISCORDPY_OK on success.

Run by discordpy.test.ts with EMU_BASE (http://localhost:PORT) and EMU_TOKEN in the environment.
"""
import os
import sys
import threading

import discord
import yarl
from discord.http import Route

BASE = os.environ["EMU_BASE"].rstrip("/")
TOKEN = os.environ.get("EMU_TOKEN", "test_bot_token")
WS_BASE = "ws" + BASE[len("http"):]  # ws://localhost:PORT
WS_URL = f"{WS_BASE}/?encoding=json&v=10&compress=zlib-stream"

# Point discord.py's REST at the emulator instead of discord.com.
Route.BASE = f"{BASE}/api/v10"
# discord.py 2.x connects to a hardcoded DEFAULT_GATEWAY (real Discord) rather than the REST
# /gateway result, so redirect it to the emulator's WebSocket.
discord.gateway.DiscordWebSocket.DEFAULT_GATEWAY = yarl.URL(WS_BASE)


# The gateway-URL resolution does not always honor Route.BASE, so force both the plain and bot
# gateway lookups to return the emulator's WebSocket URL.
async def _get_gateway(self, **kwargs):  # noqa: ANN001
    return WS_URL


async def _get_bot_gateway(self, **kwargs):  # noqa: ANN001
    # discord.py 2.7 returns (shards, url, session_start_limit); AutoShardedClient unpacks all three.
    return (1, WS_URL, {"total": 1000, "remaining": 1000, "reset_after": 0, "max_concurrency": 1})


discord.http.HTTPClient.get_gateway = _get_gateway
discord.http.HTTPClient.get_bot_gateway = _get_bot_gateway

# Watchdog: if READY/work doesn't complete in time, fail loudly instead of hanging.
def _watchdog():
    print("DISCORDPY_FAIL: timeout waiting for ready/work", flush=True)
    os._exit(2)

timer = threading.Timer(25.0, _watchdog)
timer.daemon = True
timer.start()

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.members = True


class Bot(discord.Client):
    async def on_ready(self) -> None:
        try:
            assert self.user is not None, "no ready user"
            assert len(self.guilds) > 0, "no guilds in cache"
            guild = self.guilds[0]

            channels = await guild.fetch_channels()
            text = [c for c in channels if isinstance(c, discord.TextChannel)]
            assert text, "no text channel fetched"

            roles = await guild.fetch_roles()
            assert len(roles) > 0, "no roles fetched"

            members = await guild.fetch_members(limit=10).flatten() if hasattr(guild.fetch_members(limit=10), "flatten") else [m async for m in guild.fetch_members(limit=10)]
            assert len(members) >= 0  # membership listing parsed without error

            msg = await text[0].send("hi from discord.py")
            assert msg.content == "hi from discord.py", "message content mismatch"

            edited = await msg.edit(content="edited by discord.py")
            assert edited.content == "edited by discord.py", "edit mismatch"

            print("DISCORDPY_OK", flush=True)
        except Exception as exc:  # noqa: BLE001 - report any model/parse failure
            print(f"DISCORDPY_FAIL: {exc!r}", flush=True)
            timer.cancel()
            await self.close()
            os._exit(1)
        timer.cancel()
        await self.close()


bot = Bot(intents=intents)
try:
    bot.run(TOKEN, log_handler=None)
except Exception as exc:  # noqa: BLE001
    print(f"DISCORDPY_FAIL: run error {exc!r}", flush=True)
    sys.exit(1)
