import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createDiscordTestApp, api, botHeaders, seededIds } from "../helpers.js";

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
type Driver = (ctx: { app: ReturnType<typeof createDiscordTestApp>["app"]; ids: ReturnType<typeof seededIds> }) => Promise<unknown>;

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
};

describe("cassette replay oracle (docs example responses)", () => {
  const files = readdirSync(CASSETTE_DIR).filter((f) => f.endsWith(".json"));

  it("has a driver for every cassette", () => {
    for (const f of files) expect(DRIVERS[f.replace(/\.json$/, "")], `missing driver for ${f}`).toBeDefined();
  });

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    it(`emulator response covers the documented ${name} example`, async () => {
      const cassette = JSON.parse(readFileSync(new URL(file, CASSETTE_DIR), "utf8")) as Cassette;
      const { app, store } = createDiscordTestApp();
      const ids = seededIds(store);
      const actual = await DRIVERS[name]({ app, ids });

      const diffs: Diff[] = [];
      collectDiffs(cassette.response, actual, "", diffs);
      const unexpected = diffs.filter((d) => !(d.kind === "missing" && `${name}.${d.path}` in KNOWN_MISSING));

      const report = unexpected.map((d) => `  ${d.kind} ${name}.${d.path}${d.detail ? ` (${d.detail})` : ""}`).join("\n");
      expect(unexpected, `Emulator ${name} response diverges from the documented example:\n${report}\nsource: ${cassette.source}`).toHaveLength(0);
    });
  }
});
