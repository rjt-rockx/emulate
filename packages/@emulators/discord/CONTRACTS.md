# @emulators/discord — implementation contracts (for route agents)

You are implementing ONE route module + its test for a stateful Discord API emulator.
The foundation already exists and is type-checked. Build ONLY against these contracts.
Do NOT modify shared files (entities/store/helpers/factories/context/index/seed/gateway).
Touch only your assigned `src/routes/<x>.ts` and `src/__tests__/<x>.test.ts`.

## Reference truth
- Docs: `/home/user/discord-api-docs/developers/resources/*.mdx`, `.../events/gateway-events.mdx`
- Types: `/home/user/discord-api-types/payloads/v10/*.ts`, `.../rest/v10/*.ts`
- Match real Discord response shapes (snowflake ids are strings).

## Route registration
- Every route is registered on `ctx.app` with the versioned prefix: `"/api/v:version/<path>"`.
  The `:version` segment is captured but ignored. Example:
  `app.get("/api/v:version/users/@me", (c) => { ... })`.
- Router (Hono-compatible, core): `app.get/post/patch/put/delete(path, (c) => Response)`.
  - Path params: `c.req.param("channelId")`. Query: `c.req.query("limit")`.
  - Body: `await c.req.json()` (wrap in try/catch; may be empty).
  - Respond: `c.json(obj, status?)`. Status defaults to 200.
- Path params capture `[^/]+`. For `@me` literal segments just write them literally.

## Route context (`ctx: DiscordRouteContext` from `../context.js`)
```ts
{ app, store, webhooks, baseUrl, bus }
```

## Store & entities
- `import { getDiscordStore } from "../store.js"` → `const ds = getDiscordStore(ctx.store)`.
- Collections: `ds.users, applications, oauthApps, guilds, roles, members, channels,
  messages, reactions, emojis, commands, tokens, webhooks, interactions`.
- Collection API: `insert(data)`, `get(id)`, `all()`, `findBy(field,value): T[]`,
  `findOneBy(field,value): T|undefined`, `update(id, partial)`, `delete(id)`,
  `query({filter,sort,page,per_page})`. The numeric `id` is internal; look entities up by
  their snowflake string field (e.g. `ds.channels.findOneBy("snowflake", channelId)`).
- Entity shapes are in `../entities.js` (every entity has a `snowflake`/`*_snowflake` field).

## Factories (`../factories.js`) — PREFER THESE over raw inserts
`createUser, createApplication, createToken, createGuild, createRole, addGuildMember,
createChannel, createMessage, createEmoji`. They fill defaults and maintain invariants
(e.g. `createMessage` updates `channel.last_message_snowflake`; `addGuildMember` updates
`guild.member_snowflakes`).

## Helpers (`../helpers.js`)
- `snowflake()` → new id string.
- `getAuth(c, store): DiscordAuth | null` → `{ token, scheme, type:"bot"|"bearer", user, application, scopes }`.
  Use it for auth. Bot routes: require `auth && auth.type==="bot"`.
- Errors: `unauthorized(c)` (401), `forbidden(c)` (403), `notFound(c)` (404),
  `discordError(c, status, message, code?)`. Discord error envelope is `{ message, code }`.
- Serializers (entity → wire object): `toAPIUser(u, self?)`, `toAPIGuild(g, ds, {full?,withCounts?})`,
  `toAPIChannel(c)`, `toAPIMessage(m, ds, meSnowflake?)`, `toAPIRole(r)`, `toAPIMember(m, ds)`,
  `toAPIEmoji(e, ds)`, `aggregateReactions(ds, messageSnowflake, me?)`, `redactMessageContent(msg)`.
  ALWAYS return serialized objects from routes (never raw store entities).

## Publishing gateway events (REST mutation → connected bots)
`import { Intents } from "../gateway/intents.js"`, then:
```ts
ctx.bus.publish({ t: "MESSAGE_CREATE", guildId: msg.guild_snowflake, requiredIntents: Intents.GuildMessages, d: toAPIMessage(msg, ds), redactedData: redactMessageContent(toAPIMessage(msg, ds)) });
```
- `guildId`: the guild snowflake the event belongs to (or `null` for DMs). The gateway only
  delivers a guild-scoped event to bots that are members of that guild.
- `requiredIntents`: the intent gating delivery (0 = ungated). Mapping:
  - MESSAGE_CREATE/UPDATE/DELETE → `Intents.GuildMessages` (guild) — also set `redactedData`
    (stripped content) so bots without MESSAGE_CONTENT get the redacted payload.
  - MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL → `Intents.GuildMessageReactions`.
  - CHANNEL_CREATE/UPDATE/DELETE, GUILD_UPDATE/DELETE, GUILD_ROLE_CREATE/UPDATE/DELETE → `Intents.Guilds`.
  - GUILD_MEMBER_ADD/UPDATE/REMOVE → `Intents.GuildMembers`.
  - TYPING_START → `Intents.GuildMessageTyping`.
- Event payload `d` shapes (from gateway-events.mdx):
  - MESSAGE_CREATE: the full message object (`toAPIMessage`).
  - MESSAGE_DELETE: `{ id, channel_id, guild_id? }`.
  - GUILD_ROLE_CREATE/UPDATE: `{ guild_id, role }`. GUILD_ROLE_DELETE: `{ guild_id, role_id }`.
  - GUILD_MEMBER_ADD: member object + `{ guild_id }`. GUILD_MEMBER_REMOVE: `{ guild_id, user }`.
  - CHANNEL_*: the channel object. MESSAGE_REACTION_ADD: `{ user_id, channel_id, message_id, guild_id?, emoji:{id,name} }`.
  - TYPING_START: `{ channel_id, guild_id?, user_id, timestamp }`.

## Tests (`src/__tests__/<x>.test.ts`)
- `import { createDiscordTestApp, api, botHeaders, BOT_TOKEN } from "./helpers.js"`.
- `const { app, store } = createDiscordTestApp()` (seeds defaults: an application + bot user,
  a `test_bot_token` Bot token, a "developer" user, and an "Emulate Server" guild with
  channels #general/#random (text) and General (voice)).
- Make requests: `await app.request(api("/users/@me"), { headers: botHeaders() })`.
  `api(path)` prepends the base + `/api/v10`. Assert `res.status` and the JSON body shape.
- For events, you can subscribe: `ctx.bus` isn't exposed on the test app, so to assert an
  event fired, import and use the in-process store/state, OR (preferred) assert the REST
  result + persisted store state. A dedicated gateway fan-out test already exists separately;
  your test should focus on REST correctness and that mutations persist.
- Use Discord-faithful assertions (ids are strings, etc).

## House style
No emojis. Em dashes (not `--`) in prose/comments. Keep code in the style of the existing
foundation files. Run `pnpm --filter @emulators/discord type-check` mentally — your file must
compile against the contracts above.
