import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createDiscordTestApp, api, botHeaders, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { snowflake } from "../../helpers.js";

/**
 * Cassette replay oracle (token-free): Discord's own documentation embeds real example responses
 * (discord-api-docs developers/resources/*.mdx). Those are recorded ground truth, independent of
 * the OpenAPI schema, and uniquely catch UNDER-emission — optional fields real Discord always
 * returns but the schema doesn't mark required (so the schema oracle can't require them).
 *
 * For each cassette we drive the emulator to produce the equivalent object and assert every field
 * path the example shows is present (recursively), with structural type checks. Value differences
 * (ids, timestamps, null-vs-populated) are ignored — only field presence + shape matter. When the
 * emulator legitimately cannot carry a field, it is recorded in KNOWN_MISSING with a rationale.
 *
 * Refresh: re-clone discord-api-docs and re-run the extraction noted in CONFORMANCE.md. Swapping
 * these for live-recorded cassettes (when a bot token is available) is a drop-in: same format.
 */

interface Cassette {
  source: string;
  response: Record<string, unknown>;
}

const CASSETTE_DIR = new URL("./cassettes/", import.meta.url);

/**
 * Field paths the emulator legitimately does not carry, with rationale. Each entry is a
 * spec-vs-docs-example difference, not a bug — kept explicit so new gaps can't hide.
 */
const KNOWN_MISSING: Record<string, string> = {
  // The docs user example is a full account with profile cosmetics that the emulator's seeded bot
  // user does not model (newer consumer-profile fields, not part of the bot-facing surface).
  "user.collectibles": "consumer profile cosmetic; not modeled for bot users",
  "user.primary_guild": "consumer profile (guild tag); not modeled for bot users",
  // Conditional channel field: only present once a channel has an explicit thread-archive default;
  // the emulator emits it when set, and the seeded channel has none.
  "channel.default_auto_archive_duration": "conditional; emitted only when explicitly set on the channel",
  // The docs application example is a fully-configured store app; the seeded bot app has no store
  // SKU, cover image, support guild, or per-context oauth2 install params configured.
  "application.cover_image": "conditional; only when a cover image is set",
  "application.guild_id": "conditional; only when linked to a support guild",
  "application.primary_sku_id": "conditional; only for apps with a store SKU",
  "application.slug": "conditional; only for apps with a store listing",
  "application.integration_types_config.0.oauth2_install_params": "conditional; only when default install params are configured",
  "application.integration_types_config.1": "conditional; USER_INSTALL context, declared only when the app supports it",
  // Invite targeting is conditional: only stream (target_type 1) and embedded-app (2) invites carry
  // a target; a plain channel invite has neither.
  "invite.target_type": "conditional; only on stream / embedded-application invites",
  "invite.target_user": "conditional; only on stream invites",
  // Conditional entitlement provenance fields: present only for promotional / gift entitlements.
  "entitlement.promotion_id": "conditional; only for promotional entitlements",
  "entitlement.gift_code_flags": "conditional; only for gift entitlements",
};

type Diff = { path: string; kind: "missing" | "type"; detail?: string };

/** Record where `actual` fails to cover the shape of `expected` (field presence + structural type). */
function collectDiffs(expected: unknown, actual: unknown, path: string, out: Diff[]): void {
  if (expected === null || expected === undefined) return;
  if (actual === null || actual === undefined) return; // emulator null/absent value where the example had data is fine
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, kind: "type", detail: "expected array" });
    } else if (expected.length && actual.length) {
      collectDiffs(expected[0], actual[0], `${path}[0]`, out);
    }
    return;
  }
  if (typeof expected === "object") {
    if (typeof actual !== "object" || Array.isArray(actual)) {
      out.push({ path, kind: "type", detail: "expected object" });
      return;
    }
    const act = actual as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected)) {
      const cp = path ? `${path}.${k}` : k;
      if (!(k in act)) {
        out.push({ path: cp, kind: "missing" });
        continue;
      }
      collectDiffs(v, act[k], cp, out);
    }
    return;
  }
  // primitive expected
  if (typeof actual === "object") {
    out.push({ path, kind: "type", detail: `expected ${typeof expected}, got ${Array.isArray(actual) ? "array" : "object"}` });
  } else if (typeof expected !== typeof actual) {
    out.push({ path, kind: "type", detail: `${typeof expected} vs ${typeof actual}` });
  }
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** Per-cassette drivers: produce the emulator's equivalent response object for the named cassette. */
type Driver = (ctx: {
  app: ReturnType<typeof createDiscordTestApp>["app"];
  ids: ReturnType<typeof seededIds>;
  store: ReturnType<typeof createDiscordTestApp>["store"];
}) => Promise<unknown>;

const get = async (app: ReturnType<typeof createDiscordTestApp>["app"], path: string) =>
  (await app.request(api(path), { headers: botHeaders() }).then((r) => r.json())) as unknown;
const post = async (app: ReturnType<typeof createDiscordTestApp>["app"], path: string, body: unknown) =>
  (await app.request(api(path), { method: "POST", headers: botHeaders(), body: JSON.stringify(body) }).then((r) => r.json())) as unknown;

const DRIVERS: Record<string, Driver> = {
  user: ({ app }) => get(app, "/users/@me"),
  message: ({ app, ids }) => post(app, `/channels/${ids.general}/messages`, { content: "cassette" }),
  channel: ({ app, ids }) => get(app, `/channels/${ids.general}`),
  emoji: ({ app, ids }) => post(app, `/guilds/${ids.guild}/emojis`, { name: "cassette_emoji", image: PNG }),
  webhook: ({ app, ids }) => post(app, `/channels/${ids.general}/webhooks`, { name: "cassette-hook" }),
  guild: ({ app, ids }) => get(app, `/guilds/${ids.guild}`),
  automod_rule: ({ app, ids }) =>
    post(app, `/guilds/${ids.guild}/auto-moderation/rules`, {
      name: "cassette-rule",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ["x"] },
      actions: [{ type: 1, metadata: { custom_message: "blocked by cassette" } }],
    }),
  stage_instance: async ({ app, ids }) => {
    const stage = (await post(app, `/guilds/${ids.guild}/channels`, { name: "cassette-stage", type: 13 })) as { id: string };
    return post(app, `/stage-instances`, { topic: "cassette stage", channel_id: stage.id });
  },
  invite: ({ app, ids }) => post(app, `/channels/${ids.general}/invites`, {}),
  // The docs example is a STANDARD (type 1, packaged) sticker, so fetch one from the catalog.
  sticker: async ({ app }) => {
    const packs = (await get(app, "/sticker-packs")) as { sticker_packs: Array<{ stickers: unknown[] }> };
    return packs.sticker_packs[0]?.stickers[0];
  },
  application: ({ app }) => get(app, "/applications/@me"),
  role: ({ app, ids }) => post(app, `/guilds/${ids.guild}/roles`, { name: "cassette-role" }),
  thread: ({ app, ids }) => post(app, `/channels/${ids.general}/threads`, { name: "cassette-thread", type: 11, auto_archive_duration: 1440 }),
  member: ({ app, ids }) => get(app, `/guilds/${ids.guild}/members/${ids.developer}`),
  soundboard_sound: ({ app, ids }) => post(app, `/guilds/${ids.guild}/soundboard-sounds`, { name: "cassette-sound", sound: "data:audio/ogg;base64,AAAA" }),
  voice_state: async ({ app, ids, store }) => {
    const ds = getDiscordStore(store);
    ds.voiceStates.insert({
      guild_snowflake: ids.guild,
      channel_snowflake: ids.voice,
      user_snowflake: ids.developer,
      session_id: "cassette-session",
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    });
    return get(app, `/guilds/${ids.guild}/voice-states/${ids.developer}`);
  },
  entitlement: async ({ app, ids, store }) => {
    const ds = getDiscordStore(store);
    const sku = ds.skus.insert({ snowflake: snowflake(), application_snowflake: ids.app, type: 5, name: "cassette-sku", slug: "cassette-sku", flags: 0 });
    const ent = ds.entitlements.insert({
      snowflake: snowflake(),
      sku_snowflake: sku.snowflake,
      application_snowflake: ids.app,
      user_snowflake: ids.developer,
      guild_snowflake: ids.guild,
      type: 8,
      deleted: false,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      consumed: false,
      subscription_snowflake: snowflake(),
    });
    return get(app, `/applications/${ids.app}/entitlements/${ent.snowflake}`);
  },
  subscription: async ({ app, ids, store }) => {
    const ds = getDiscordStore(store);
    const skuId = snowflake();
    ds.skus.insert({ snowflake: skuId, application_snowflake: ids.app, type: 5, name: "cassette-sub-sku", slug: "cassette-sub-sku", flags: 0 });
    const sub = ds.subscriptions.insert({
      snowflake: snowflake(),
      user_snowflake: ids.developer,
      sku_snowflakes: [skuId],
      entitlement_snowflakes: [snowflake()],
      renewal_sku_snowflakes: null,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      status: 0,
      canceled_at: null,
    });
    return get(app, `/skus/${skuId}/subscriptions/${sub.snowflake}?user_id=${ids.developer}`);
  },
};

/** Cassettes live at the top level (docs-derived, committed) and optionally under live/ (recorded
 * against real Discord; same format, same drivers). Live cassettes are authoritative when present. */
function loadCassetteFiles(): Array<{ name: string; url: URL; origin: "docs" | "live" }> {
  const out: Array<{ name: string; url: URL; origin: "docs" | "live" }> = [];
  for (const f of readdirSync(CASSETTE_DIR).filter((f) => f.endsWith(".json"))) {
    out.push({ name: f.replace(/\.json$/, ""), url: new URL(f, CASSETTE_DIR), origin: "docs" });
  }
  try {
    const liveDir = new URL("live/", CASSETTE_DIR);
    for (const f of readdirSync(liveDir).filter((f) => f.endsWith(".json"))) {
      out.push({ name: f.replace(/\.json$/, ""), url: new URL(f, liveDir), origin: "live" });
    }
  } catch {
    // no live/ directory — only docs-derived cassettes are present
  }
  return out;
}

describe("cassette replay oracle (recorded Discord responses)", () => {
  const cassettes = loadCassetteFiles();

  it("has a driver for every cassette", () => {
    for (const c of cassettes) expect(DRIVERS[c.name], `missing driver for ${c.origin} cassette ${c.name}`).toBeDefined();
  });

  for (const c of cassettes) {
    it(`emulator ${c.name} response covers the ${c.origin} recording`, async () => {
      const cassette = JSON.parse(readFileSync(c.url, "utf8")) as Cassette;
      const { app, store } = createDiscordTestApp();
      const ids = seededIds(store);
      const actual = await DRIVERS[c.name]({ app, ids, store });

      const diffs: Diff[] = [];
      collectDiffs(cassette.response, actual, "", diffs);
      const unexpected = diffs.filter((d) => !(d.kind === "missing" && `${c.name}.${d.path}` in KNOWN_MISSING));

      const report = unexpected.map((d) => `  ${d.kind} ${c.name}.${d.path}${d.detail ? ` (${d.detail})` : ""}`).join("\n");
      expect(unexpected, `Emulator ${c.name} response diverges from the ${c.origin} recording:\n${report}\nsource: ${cassette.source}`).toHaveLength(0);
    });
  }
});
