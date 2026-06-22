/**
 * Live cassette recorder (token-gated). Captures real Discord API responses for the core objects
 * and writes them to ./cassettes/live/<name>.json in the same format the replay oracle
 * (cassettes.test.ts) consumes. When live cassettes are present they are validated alongside the
 * docs-derived ones, with `live` treated as authoritative.
 *
 * Usage (needs a throwaway bot that is a member of a test guild):
 *   DISCORD_BOT_TOKEN=... DISCORD_TEST_GUILD_ID=... \
 *     node src/__tests__/oracle/recordCassettes.mjs
 *
 * Without those env vars this is a no-op (prints usage, exits 0) so CI never depends on a token.
 * The replay comparison ignores values (only field presence + structural type matter), so recorded
 * cassettes may be value-redacted before committing without weakening the oracle.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://discord.com/api/v10";
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_TEST_GUILD_ID;

const LIVE_DIR = new URL("./cassettes/live/", import.meta.url);

/** Pick a representative element from a list response. */
const first = (b) => (Array.isArray(b) ? b[0] : b);
const lastRole = (b) => (Array.isArray(b) ? b[b.length - 1] : b);
const firstTextChannel = (b) => (Array.isArray(b) ? (b.find((c) => c?.type === 0) ?? b[0]) : b);

/** @type {Array<{name:string, endpoint:(ctx:Record<string,unknown>)=>string|null, select?:(b:unknown)=>unknown, stash?:(b:unknown,ctx:Record<string,unknown>)=>void}>} */
const PICKS = [
  { name: "user", endpoint: () => `/users/@me` },
  { name: "application", endpoint: () => `/applications/@me` },
  { name: "guild", endpoint: () => `/guilds/${guildId}` },
  {
    name: "channel",
    endpoint: () => `/guilds/${guildId}/channels`,
    select: firstTextChannel,
    stash: (b, ctx) => (ctx.channelId = firstTextChannel(b)?.id),
  },
  { name: "role", endpoint: () => `/guilds/${guildId}/roles`, select: lastRole },
  { name: "emoji", endpoint: () => `/guilds/${guildId}/emojis`, select: first },
  { name: "webhook", endpoint: (ctx) => (ctx.channelId ? `/channels/${ctx.channelId}/webhooks` : null), select: first },
];

if (!token || !guildId) {
  console.log("recordCassettes: set DISCORD_BOT_TOKEN and DISCORD_TEST_GUILD_ID to record live cassettes. Skipping.");
  process.exit(0);
}

mkdirSync(LIVE_DIR, { recursive: true });
const headers = { Authorization: `Bot ${token}` };
const ctx = {};
const now = new Date().toISOString();

for (const pick of PICKS) {
  const endpoint = pick.endpoint(ctx);
  if (!endpoint) {
    console.log(`skip ${pick.name} (no endpoint resolvable)`);
    continue;
  }
  const res = await fetch(`${BASE}${endpoint}`, { headers });
  if (!res.ok) {
    console.log(`skip ${pick.name} (${res.status} from ${endpoint})`);
    continue;
  }
  const body = await res.json();
  pick.stash?.(body, ctx);
  const response = pick.select ? pick.select(body) : body;
  if (response == null) {
    console.log(`skip ${pick.name} (empty)`);
    continue;
  }
  writeFileSync(new URL(`${pick.name}.json`, LIVE_DIR), JSON.stringify({ source: `live capture ${now} (GET ${endpoint})`, response }, null, 2) + "\n");
  console.log(`recorded ${pick.name}.json`);
}
