---
name: discord
description: Emulated Discord API (REST + Gateway WebSocket) for local development and testing. Use when the user needs to run or test Discord bots and apps locally, emulate guilds/channels/messages/members/roles, test slash commands and message components (interactions), Discord OAuth2, or webhooks, without hitting the real Discord API. Triggers include "Discord API", "emulate Discord", "mock Discord", "discord.js", "discord.py", "Discord bot", "slash commands", "Discord interactions", "Discord gateway", "test Discord OAuth", or any task requiring a local Discord API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Discord API Emulator

Fully stateful Discord API emulation: a REST API under `/api/v10` plus a real Gateway
WebSocket on the same port, so real clients like discord.js and discord.py connect and run
against it. Covers users, guilds (roles, members, emojis), channels, messages, reactions,
OAuth2, application commands, and interactions (slash commands and message components) over
both the Gateway (`INTERACTION_CREATE`) and the HTTP interactions endpoint (Ed25519 signed),
plus channel webhooks. REST mutations dispatch the matching Gateway events to connected bots,
filtered by intents and guild membership; message content is gated by the `MESSAGE_CONTENT`
intent exactly as real Discord does. The Gateway supports `zlib-stream` transport compression
(discord.py's default).

## Start

```bash
# Discord only
npx emulate --service discord

# Default port (when run alone): http://localhost:4000
# REST base:  http://localhost:4000/api/v10
# Gateway:    ws://localhost:4000/  (advertised by GET /api/v10/gateway/bot)
```

## Auth

Pass a bot token as `Authorization: Bot <token>` (OAuth bearer tokens use `Authorization:
Bearer <token>`). A `test_bot_token` Bot token is seeded by default, mapped to the seeded
application's bot user. The Gateway `IDENTIFY` validates the same bot tokens.

```bash
curl http://localhost:4000/api/v10/users/@me -H "Authorization: Bot test_bot_token"
```

## Pointing your bot at the emulator

discord.js: override the REST base URL and let it read the Gateway URL from `GET /gateway/bot`.

```js
import { Client, GatewayIntentBits } from "discord.js";
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { api: "http://localhost:4000/api" },
});
client.on("ready", () => console.log("ready as", client.user.tag));
client.on("messageCreate", (m) => console.log("message:", m.content));
await client.login("test_bot_token");
```

discord.py: override the REST base and the (otherwise hardcoded) gateway host. discord.py
connects with `compress=zlib-stream` by default, which the emulator supports.

```python
import yarl, discord

PORT = 4000
discord.http.Route.BASE = f"http://localhost:{PORT}/api/v10"
discord.gateway.DiscordWebSocket.DEFAULT_GATEWAY = yarl.URL(f"ws://localhost:{PORT}/")

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print("ready as", client.user)

client.run("test_bot_token")
```

## Seed config

```yaml
discord:
  application:
    name: My Discord App
    bot_token: test_bot_token
    bot_username: my-bot
    # public_key / private_key (Ed25519) are auto-generated if omitted
    interactions_endpoint_url: http://localhost:3000/api/interactions
  oauth_apps:
    - client_id: my-client-id
      client_secret: example_client_secret
      name: My Discord App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/discord
      scopes: [identify, email, guilds]
  users:
    - username: alice
      global_name: Alice
      email: alice@example.com
  guilds:
    - name: My Server
      owner: alice
      roles:
        - name: Admin
          permissions: "8"
      channels:
        - name: general
          type: 0
        - name: voice
          type: 2
      members: [alice]
  application_commands:
    - name: ping
      description: Replies with pong
```

## REST endpoints (under `/api/v10`)

- Users: `GET/PATCH /users/@me`, `GET /users/:id`, `GET /users/@me/guilds`, `POST /users/@me/channels`
- Guilds: `GET/POST/PATCH/DELETE /guilds/:id`; roles, members, emojis subroutes
- Channels: `GET/POST /guilds/:id/channels`, `GET/PATCH/DELETE /channels/:id`, `POST /channels/:id/typing`
- Messages: `GET/POST /channels/:id/messages`, `GET/PATCH/DELETE /channels/:id/messages/:mid`, `bulk-delete`
- Reactions: `PUT/DELETE .../reactions/:emoji/@me`, list/remove-all
- Application commands: `GET/POST/PATCH/DELETE/PUT /applications/:appId/commands` and guild variants
- Interactions: `POST /interactions/:id/:token/callback`, followups + `@original` via `/webhooks/:appId/:token`
- Webhooks: `POST /channels/:id/webhooks`, manage, and execute `POST /webhooks/:id/:token` (`?wait=true`)
- OAuth2: `GET /oauth2/authorize`, `POST /api/oauth2/token`, `GET /api/v10/oauth2/@me`
- Gateway bootstrap: `GET /api/v10/gateway`, `GET /api/v10/gateway/bot`

## Gateway events

REST writes dispatch the matching Gateway events to connected bots: `READY`, `GUILD_CREATE`,
`GUILD_UPDATE/DELETE`, `CHANNEL_*`, `MESSAGE_*`, `MESSAGE_REACTION_*`, `GUILD_MEMBER_*`,
`GUILD_ROLE_*`, `TYPING_START`, and `INTERACTION_CREATE`. Events are filtered by the
connection's intents and guild membership.

## Triggering interactions in tests

There is no real Discord client to click a button, so a control endpoint simulates a user
triggering an interaction (slash command, button, select, modal). It routes the interaction
over the Gateway and/or the configured HTTP interactions endpoint:

```bash
curl -X POST http://localhost:4000/__emulate/interactions \
  -H "Authorization: Bot test_bot_token" -H "Content-Type: application/json" \
  -d '{"type":2,"commandName":"ping"}'
```

## Current limits

JSON encoding only (no ETF); `zlib-stream` compression is supported, `zstd-stream` is not.
Voice connections, sharding, gateway resume replay buffering, threads, stickers, scheduled
events, invites, audit logs, permission enforcement (403s), and exact rate limiting are not
yet implemented.
