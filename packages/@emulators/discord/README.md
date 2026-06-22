# @emulators/discord

Stateful Discord API emulation: the REST API under `/api/v10` plus a **Gateway WebSocket** served on
the same port, so real bots (discord.js, discord.py, JDA, serenity, discordgo, Eris, discordrb, …)
log in, reach `READY`, heartbeat, and receive pushed events against a local server instead of Discord.
Guild, channel, message, role, member, reaction, emoji, thread, invite, ban, webhook, application
command, scheduled event, auto-moderation, sticker, soundboard, poll, monetization, and integration
state is held in memory; REST mutations publish gateway events filtered by intents and guild
membership. Interactions are delivered both over the gateway (`INTERACTION_CREATE`) and via the
Ed25519-signed HTTP endpoint. OAuth2 supports the authorization-code and client-credentials flows.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for
CI and no-network sandboxes. For full usage (seeding, triggering interactions, the control plane) see
the [docs page](https://emulate.dev/discord) and `skills/discord/SKILL.md`.

## Install

```bash
npm install @emulators/discord
```

## Pointing a bot at the emulator

A bot connects exactly as it would to Discord — only the base URL changes. Most libraries read the
gateway URL from `GET /api/v10/gateway/bot`, which the emulator answers with its own `ws://` address.

```js
// discord.js
const client = new Client({ intents: [...], rest: { api: "http://localhost:4000/api" } });
await client.login("test_bot_token");
```

```python
# discord.py (override the otherwise-hardcoded gateway host too)
discord.http.Route.BASE = f"http://localhost:{PORT}/api/v10"
discord.gateway.DiscordWebSocket.DEFAULT_GATEWAY = yarl.URL(f"ws://localhost:{PORT}/")
```

## Endpoints

REST under `/api/v10`:

- **Users** — current user, user by id, DM channels, guilds list, connections, application role connection
- **Guilds** — CRUD, roles, members (roles, nick, search), bans (+ bulk), emojis, audit log, templates, welcome screen, onboarding, widget, join requests, voice states
- **Channels** — CRUD, permission overwrites, pins, invites, typing, followers, threads (active + archived), thread members
- **Messages** — CRUD, bulk delete, reactions, crosspost, polls
- **Webhooks** — create/execute (+ GitHub/Slack variants), edit `@original`/followups
- **Interactions** — callback, followups; application commands (global + guild) and command permissions
- **OAuth2** — authorize, token (authorization-code + client-credentials), `@me`, userinfo, keys
- **Monetization** — entitlements, SKUs, subscriptions
- **Other** — stage instances, scheduled events, auto-moderation rules, stickers + packs, soundboard, integrations, lobbies, application management, inspector

Gateway (same port): `GET /api/v10/gateway` and `/gateway/bot` advertise `ws://<host>/`. The socket
does the `HELLO → IDENTIFY → READY → GUILD_CREATE` handshake, heartbeats, intent-filtered dispatch,
and `RESUME`, over JSON or ETF with `zlib-stream` / `zstd-stream` transport compression.

## Links

- [Full documentation](https://emulate.dev/discord)
- [GitHub](https://github.com/vercel-labs/emulate)
