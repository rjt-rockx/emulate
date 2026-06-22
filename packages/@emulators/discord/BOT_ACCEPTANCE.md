# Real-bot acceptance campaign

The strongest fidelity signal for a Discord API double is a **real third-party bot** driving it: the
client library parses every byte through its own strict models and fails on any wire divergence.
This file tracks bots run against the emulator (via `launch-emulator.mjs` on a fixed port, with the
client's REST base pointed at it and the gateway resolved from `GET /gateway(/bot)`), and the
fidelity gaps each surfaced.

Control-plane hooks used by these tests (not real Discord routes): `POST /__emulate/interactions`
(trigger a slash/component/modal interaction), `POST /__emulate/messages` (post a message as an
arbitrary human user, so message/prefix command handlers — which ignore bot authors — can run),
`POST /__emulate/voice-state` (place a user in a voice channel, so voice-gated music-bot commands can
run), `POST /__emulate/poll-vote`.

## Round 1 — library diversity (templates) → 6 fixes

| Bot / lib | Lang | Outcome |
|---|---|---|
| TFAGaming/DiscordJS-V14-Bot-Template (discord.js 14) | JS | READY + full interaction lifecycle (slash/buttons/selects/modals/autocomplete/context menus, guild+global command deploy, ephemeral flags, 40060) — clean. |
| kkrypt0nn/Python-Discord-Bot-Template (discord.py 2.7) | Py | on_ready + sync of 28 app commands + REST round-trips + interaction dispatch — clean. |
| bwmarrin/discordgo examples (discordgo 0.29) | Go | Open()+Ready, command CRUD, full message + interaction round-trips after fixes. |

Fixes driven by round 1 (commit `065a2ba`):
1. **[discordgo, critical]** Identify-level `compress:true` was served via the streaming
   zlib-stream compressor (shared context); now each payload is an independent zlib block.
2. **[discordgo, high]** command create 500'd on `choices:null` / 400'd on `channel_types:null`
   (discordgo emits null for every option, no omitempty) — null is now treated as "not set".
3. **[discord.py, high]** interaction callback returned 204 instead of the resource for
   `with_response=1` (only matched `=true`; discord.py 2.7+ sends `1`).
4. **[discord.js]** `application.id` now equals the bot user id (one shared snowflake), as on Discord.
5. **[discord.js]** added `__emulate/messages` so message/prefix commands are testable.
6. **[discord.py, low]** reject opening a DM with yourself (50007).

## Round 2 — more libraries + real-world bots (in progress)

Libraries: JDA (Java), Eris (JS), discordrb (Ruby), a discord.py feature bot.
Real-world bots: JMusicBot (jagrosh, JDA), Discord Tickets (discord-tickets/bot, discord.js).

Findings so far:
- **Eris 0.18 (high)** — the gateway READY payload omitted `private_channels`. Eris iterates it
  unconditionally (`Shard.js`), so it threw before setting `client.application`, breaking all command
  registration. Real Discord always sends it (`[]` for bots). Fixed: READY now includes
  `private_channels: []`. (Note: Eris also can't target a plaintext `http://host:port` REST endpoint
  without monkeypatching `https.request` — an Eris-config artifact, not an emulator bug.)
- **discord.py feature bot — Milo, ~80 commands (high)** — everything worked (tree sync of 55
  commands, embeds, reactions, multipart file uploads, edit/delete, bulk-delete, component
  round-trip, on_message/on_message_delete) EXCEPT permission-gated commands: the `INTERACTION_CREATE`
  member omitted the resolved `permissions` field, which discord.py's `has_permissions` reads
  exclusively — so every moderation/automod command was rejected even for the guild owner. Real
  Discord always resolves it. Fixed: `buildInteraction` now sets `member.permissions` (channel-level).
- **discordrb 3.8 (medium, cross-library robustness)** — the emulator emitted the gateway HELLO
  synchronously inside the `ws` connection callback, so on loopback the kernel coalesced the HTTP 101
  and HELLO into one TCP segment; discordrb routes its entire first read into the handshake parser and
  discarded HELLO, hanging forever. (Root cause is a discordrb bug, but real Discord sends HELLO in a
  separate segment.) Fixed: HELLO is now deferred one tick so the 101 flushes first. discordrb
  otherwise connected, registered a guild command, and round-tripped messages/interactions, with
  correct intent-based content redaction.
- **JMusicBot — JDA 4.4.1 (no bug)** — logged in, reached READY, and handled every prefix command
  end-to-end (ping/about/settings/help-as-DM/setgame/nowplaying/setdj) with zero REST or gateway
  fidelity gaps; MESSAGE_CONTENT intent gating was correctly observed. `play` stopped at the bot's
  own "must be in a voice channel" guard. Enhancement added in response: `POST /__emulate/voice-state`
  control plane (place a user in voice + dispatch VOICE_STATE_UPDATE) so voice-gated music-bot
  commands can be driven. (Real-time audio transport remains out of scope — signaling/state only.)

## Backlog (from the curated lists)

Deployable, modern, prioritized by tractability in a no-network-egress-to-Discord, no-Lavalink,
no-API-key sandbox:
- Red-DiscordBot (Python, cogs) — high value; scripted setup.
- ModBot / aternosorg/modbot (Node, MIT) — moderation, tractable.
- PaulMarisOUMary/Discord-Bot (discord.py 2.7) — full bot, Docker.
- MonitoRSS (RSS) — needs MongoDB.
- Loritta (multipurpose) — large.

Blocked by heavy infra (tracked, lower priority): YAGPDB (Postgres+Redis), Lavamusic / Music-Disc /
VectoBeat (Lavalink), GPTDiscord (OpenAI key), YueBot / MODUS / Rostra (Postgres/Redis/dashboards).
For these, the testable surface is login + command registration + the non-music/non-AI command paths;
music/AI features fail at their own subsystem, not the emulator.
