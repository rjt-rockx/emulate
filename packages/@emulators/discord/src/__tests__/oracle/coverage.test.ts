import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { createDiscordTestApp, api, botHeaders, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { createUser } from "../../factories.js";
import { checkResponse, specOperations, findOverEmission } from "./specValidator.js";

/**
 * Systematic GET coverage sweep: enumerate EVERY GET operation in the official spec, fill its path
 * params from a seeded + freshly-created resource map, probe each reachable one, and validate the
 * response against the spec. This walks the long tail automatically instead of hand-listing probes.
 */

const KNOWN: Array<{ path: RegExp; error: string }> = [
  // Preview spec types deprecated guild.region as string; real Discord returns null (see CONFORMANCE.md).
  { path: /\/guilds\/\d+/, error: "/region must be string" },
  // Preview spec types role-connection platform_name non-null; the docs/real Discord return null
  // when the user has no connection.
  { path: /\/role-connection$/, error: "/platform_name must be string" },
];
const isKnown = (p: string, e: string) => KNOWN.some((k) => k.path.test(p.split("?")[0]) && e.includes(k.error));

/**
 * Over-emitted keys that are real-but-context-specific and accepted (the OpenAPI spec scopes them
 * more narrowly than reality / discord-api-types). Each is a valid optional field per
 * discord-api-types, so emitting it does not violate the typed contract:
 *  - message `guild_id`: optional on APIMessage; gateway MESSAGE_* events carry it (gateway shares
 *    the REST serializer), and discord-api-types types it as an optional message field.
 *  - application command `default_permission`: a documented (deprecated) command field still present
 *    on APIApplicationCommand; the OpenAPI spec dropped it but the docs/types retain it.
 */
const OVER_EMISSION_KNOWN = new Set(["guild_id", "default_permission"]);
const normalizeKey = (k: string): string => k.replace(/^.*?(\w+)$/, "$1");

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("OpenAPI GET coverage sweep", () => {
  it("validates every GET operation reachable from a seeded param map", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);

    const postId = async (path: string, body: unknown): Promise<string | undefined> => {
      const res = await app.request(api(path), { method: "POST", headers: botHeaders(), body: JSON.stringify(body) });
      const b = (await res.json().catch(() => ({}))) as { id?: string; code?: string };
      return b.id ?? b.code;
    };

    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 7_200_000).toISOString();

    const map: Record<string, string | undefined> = {
      guild_id: ids.guild,
      channel_id: ids.general,
      application_id: ids.app,
      // A real seeded user (also a guild member) rather than @me, so member/user lookups resolve.
      user_id: ids.developer,
      role_id: await postId(`/guilds/${ids.guild}/roles`, { name: "cov-role" }),
      message_id: await postId(`/channels/${ids.general}/messages`, { content: "cov" }),
      emoji_id: await postId(`/guilds/${ids.guild}/emojis`, { name: "cov_emoji", image: PNG }),
      webhook_id: await postId(`/channels/${ids.general}/webhooks`, { name: "cov-hook" }),
      guild_scheduled_event_id: await postId(`/guilds/${ids.guild}/scheduled-events`, {
        name: "Cov Event",
        privacy_level: 2,
        scheduled_start_time: startsAt,
        scheduled_end_time: endsAt,
        entity_type: 3,
        entity_metadata: { location: "x" },
      }),
      auto_moderation_rule_id: await postId(`/guilds/${ids.guild}/auto-moderation/rules`, {
        name: "cov-rule",
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: { keyword_filter: ["x"] },
        actions: [{ type: 1 }],
      }),
      command_id: await postId(`/applications/${ids.app}/commands`, { name: "cov-cmd", description: "d", type: 1 }),
      invite_code: await postId(`/channels/${ids.general}/invites`, {}),
      thread_id: await postId(`/channels/${ids.general}/threads`, { name: "cov-thread", type: 11, auto_archive_duration: 1440 }),
    };
    map.overwrite_id = map.role_id;

    // Resources whose param NAME collides with a differently-typed resource (e.g. an application
    // emoji vs a guild emoji both use {emoji_id}). Seeded separately and applied per-op below.
    const stageChannelId = await postId(`/guilds/${ids.guild}/channels`, { name: "cov-stage", type: 13 });
    await postId(`/stage-instances`, { topic: "cov stage", channel_id: stageChannelId });
    const appEmojiId = await postId(`/applications/${ids.app}/emojis`, { name: "cov_app_emoji", image: PNG });
    const guildCommandId = await postId(`/applications/${ids.app}/guilds/${ids.guild}/commands`, {
      name: "cov-gcmd",
      description: "d",
      type: 1,
    });

    // Seed state directly so endpoints that depend on it become reachable and their response shapes
    // get validated (the store is the source of truth — seeding it is legitimate test setup).
    const ds = getDiscordStore(store);
    const bannedUser = createUser(ds, { username: "cov-banned" });
    ds.bans.insert({ guild_snowflake: ids.guild, user_snowflake: bannedUser.snowflake, reason: "cov" });
    const seedVoiceState = (userSf: string) =>
      ds.voiceStates.insert({
        guild_snowflake: ids.guild,
        channel_snowflake: ids.voice,
        user_snowflake: userSf,
        session_id: `cov-${userSf}`,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_video: false,
        suppress: false,
        request_to_speak_timestamp: null,
      });
    seedVoiceState(ids.bot); // for voice-states/@me
    seedVoiceState(ids.developer); // for voice-states/{user_id}
    if (guildCommandId) {
      ds.commandPermissions.insert({
        application_snowflake: ids.app,
        guild_snowflake: ids.guild,
        command_snowflake: guildCommandId,
        permissions: [{ id: ids.guild, type: 1, permission: true }],
      });
    }
    // Per-op path-param overrides: the same param name resolves to a different resource depending
    // on the parent path (thread vs channel, application vs guild emoji/command, stage channel).
    const PATH_PARAM_OVERRIDES: Record<string, Record<string, string | undefined>> = {
      "/channels/{channel_id}/thread-members": { channel_id: map.thread_id },
      "/channels/{channel_id}/thread-members/{user_id}": { channel_id: map.thread_id, user_id: ids.bot },
      "/applications/{application_id}/emojis/{emoji_id}": { emoji_id: appEmojiId },
      "/applications/{application_id}/guilds/{guild_id}/commands/{command_id}": { command_id: guildCommandId },
      "/applications/{application_id}/guilds/{guild_id}/commands/{command_id}/permissions": { command_id: guildCommandId },
      "/stage-instances/{channel_id}": { channel_id: stageChannelId },
      "/guilds/{guild_id}/bans/{user_id}": { user_id: bannedUser.snowflake },
    };

    const gets = specOperations().filter((o) => o.method === "GET");
    const results: Array<{ path: string; concrete: string; status: number; validated: boolean; errors: string[] }> = [];
    const overEmission = new Map<string, string[]>();
    let unmappable = 0;
    for (const op of gets) {
      const ov = PATH_PARAM_OVERRIDES[op.path] ?? {};
      const resolve = (p: string): string | undefined => ov[p] ?? map[p];
      const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!params.every((p) => resolve(p))) {
        unmappable++;
        continue;
      }
      const concrete = op.path.replace(/\{(\w+)\}/g, (_, p) => resolve(p)!);
      const res = await app.request(api(concrete), { headers: botHeaders() });
      const body = await res.json().catch(() => null);
      const r = checkResponse("GET", concrete, res.status, body);
      const errors = r.errors.filter((e) => !isKnown(concrete, e));
      results.push({ path: op.path, concrete, status: res.status, validated: r.validated, errors });
      if (res.status >= 200 && res.status < 300) {
        const extras = findOverEmission("GET", concrete, res.status, body).filter((k) => !OVER_EMISSION_KNOWN.has(normalizeKey(k)));
        if (extras.length) overEmission.set(op.path, extras);
      }
    }

    const ok2xx = results.filter((r) => r.status >= 200 && r.status < 300);
    const validated = ok2xx.filter((r) => r.validated);
    const failing = validated.filter((r) => r.errors.length > 0);
    const gaps = results.filter((r) => r.status >= 400);

    const lines = [
      `GET ops total=${gets.length} probed=${results.length} unmappable=${unmappable} validated=${validated.length} divergent=${failing.length} gaps(4xx)=${gaps.length}`,
    ];
    for (const f of failing) {
      lines.push(`DIVERGENCE GET ${f.path} [${f.status}]`);
      for (const e of f.errors.slice(0, 10)) lines.push(`    - ${e}`);
    }
    for (const gp of gaps) lines.push(`GAP        GET ${gp.path} [${gp.status}]`);
    writeFileSync("/tmp/conformance-coverage-report.txt", lines.join("\n") + "\n");

    // Over-emission report (keys we emit that the spec never declares). Written for review; the
    // assertion below enforces zero modulo OVER_EMISSION_KNOWN (spec gaps, documented divergences).
    const oeLines = [`OVER-EMISSION endpoints=${overEmission.size}`];
    for (const [p, keys] of overEmission) oeLines.push(`${p}\n    ${keys.join("\n    ")}`);
    writeFileSync("/tmp/conformance-overemission.txt", oeLines.join("\n") + "\n");

    expect(validated.length).toBeGreaterThanOrEqual(15);
    expect(failing, `Unexpected spec divergences:\n${lines.join("\n")}`).toHaveLength(0);
    expect(overEmission.size, `Unexpected over-emission (keys absent from the spec):\n${oeLines.join("\n")}`).toBe(0);
  });
});
