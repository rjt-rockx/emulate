import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { createDiscordTestApp, api, botHeaders, seededIds } from "../helpers.js";
import { checkResponse, specOperations, generateRequestBody, findOverEmission } from "./specValidator.js";

/**
 * Systematic WRITE sweep: enumerate every POST/PATCH operation in the spec, synthesize a minimal
 * request body from its request schema, fill path params from a seeded + created resource map, and
 * validate any 2xx response against the spec. Operations whose generated body fails the emulator's
 * (stricter, semantic) validation return 4xx and are reported as "needs-body", not divergences —
 * the value here is catching write-RESPONSE shape divergences automatically.
 */

// Over-emitted keys accepted as real-but-context-specific (see coverage.test.ts for rationale):
// optional fields per discord-api-types the OpenAPI spec scopes more narrowly. `icon_hash` is
// documented as "returned when in the template object" but the spec's serialized template-guild
// schema under-declares it (spec gap), so it appears here only under serialized_source_guild.
const OVER_EMISSION_KNOWN = new Set(["guild_id", "default_permission", "icon_hash"]);
const normalizeKey = (k: string): string => k.replace(/^.*?(\w+)$/, "$1");

const KNOWN: Array<{ path: RegExp; error: string }> = [
  { path: /\/guilds\/\d+/, error: "/region must be string" },
  // Guild-template serialized channels use INTEGER placeholder ids; the docs state "placeholder IDs
  // are given as integers" and the official example shows `"parent_id": 1`. The OpenAPI spec types
  // parent_id as null|Snowflake(string), contradicting Discord's own docs — spec imprecision.
  { path: /\/templates\//, error: "parent_id" },
];
const isKnown = (p: string, e: string) => KNOWN.some((k) => k.path.test(p.split("?")[0]) && e.includes(k.error));

describe("OpenAPI WRITE sweep (POST/PATCH responses)", () => {
  it("validates every POST/PATCH response reachable with a generated body", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);

    const postFull = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await app.request(api(path), { method: "POST", headers: botHeaders(), body: JSON.stringify(body) });
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    };
    const postId = async (path: string, body: unknown): Promise<string | undefined> =>
      (await postFull(path, body)).id as string | undefined;
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 7_200_000).toISOString();
    const roleId = await postId(`/guilds/${ids.guild}/roles`, { name: "ws-role" });
    const autoModRuleId = await postId(`/guilds/${ids.guild}/auto-moderation/rules`, {
      name: "ws-rule",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ["x"] },
      actions: [{ type: 1 }],
    });
    const webhook = await postFull(`/channels/${ids.general}/webhooks`, { name: "ws-hook" });
    const sound = await postFull(`/guilds/${ids.guild}/soundboard-sounds`, { name: "ws-sound", sound: "data:audio/ogg;base64,AAAA" });
    const template = await postFull(`/guilds/${ids.guild}/templates`, { name: "ws-template" });
    const stageChannelId = await postId(`/guilds/${ids.guild}/channels`, { name: "ws-stage", type: 13 });
    const map: Record<string, string | undefined> = {
      guild_id: ids.guild,
      channel_id: ids.general,
      application_id: ids.app,
      user_id: ids.developer,
      recipient_id: ids.developer,
      role_id: roleId,
      overwrite_id: roleId,
      message_id: await postId(`/channels/${ids.general}/messages`, { content: "ws" }),
      command_id: await postId(`/applications/${ids.app}/commands`, { name: "ws-cmd", description: "d", type: 1 }),
      webhook_id: webhook.id as string | undefined,
      webhook_token: webhook.token as string | undefined,
      emoji_id: await postId(`/guilds/${ids.guild}/emojis`, { name: "ws_emoji", image: png }),
      auto_moderation_rule_id: autoModRuleId,
      rule_id: autoModRuleId,
      sound_id: sound.sound_id as string | undefined,
      code: template.code as string | undefined,
      lobby_id: await postId(`/lobbies`, {}),
      guild_scheduled_event_id: await postId(`/guilds/${ids.guild}/scheduled-events`, {
        name: "WS Event",
        privacy_level: 2,
        scheduled_start_time: startsAt,
        scheduled_end_time: endsAt,
        entity_type: 3,
        entity_metadata: { location: "x" },
      }),
      thread_id: await postId(`/channels/${ids.general}/threads`, { name: "ws-thread", type: 11, auto_archive_duration: 1440 }),
    };
    // Resolve id-shaped body fields (recipient_id, channel_id, ...) to real ids when we have them.
    const idFor = (field: string): string | undefined => map[field];

    // Hand-crafted valid bodies for create endpoints whose semantic validation the minimal
    // generated body can't satisfy — so the sweep can validate their real 2xx response shapes.
    const BODY_OVERRIDES: Record<string, unknown> = {
      "POST /channels/{channel_id}/messages": { content: "oracle sweep" },
      "POST /applications/{application_id}/commands": { name: "sweepcmd", description: "d", type: 1 },
      "POST /applications/{application_id}/guilds/{guild_id}/commands": { name: "sweepgcmd", description: "d", type: 1 },
      "POST /guilds/{guild_id}/auto-moderation/rules": {
        name: "sweep-rule",
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: { keyword_filter: ["x"] },
        actions: [{ type: 1 }],
      },
      "POST /guilds/{guild_id}/scheduled-events": {
        name: "Sweep Event",
        privacy_level: 2,
        scheduled_start_time: startsAt,
        scheduled_end_time: endsAt,
        entity_type: 3,
        entity_metadata: { location: "x" },
      },
      "POST /stage-instances": { topic: "oracle stage", channel_id: stageChannelId },
    };

    const ops = specOperations().filter((o) => o.method === "POST" || o.method === "PATCH");
    const results: Array<{ op: string; status: number; validated: boolean; errors: string[] }> = [];
    const unmappableOps: string[] = [];
    const needsBodyOps: Array<{ op: string; status: number }> = [];
    const overEmission = new Map<string, string[]>();
    for (const op of ops) {
      const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!params.every((p) => map[p])) {
        unmappableOps.push(`${op.method} ${op.path}`);
        continue;
      }
      const concrete = op.path.replace(/\{(\w+)\}/g, (_, p) => map[p]!);
      const overrideKey = `${op.method} ${op.path}`;
      const body = overrideKey in BODY_OVERRIDES ? BODY_OVERRIDES[overrideKey] : generateRequestBody(op.path, op.method, idFor);
      const res = await app.request(api(concrete), {
        method: op.method,
        headers: botHeaders(),
        body: body == null ? undefined : JSON.stringify(body),
      });
      if (res.status >= 400) {
        needsBodyOps.push({ op: `${op.method} ${op.path}`, status: res.status });
        continue; // generated body insufficient for the emulator's semantic validation
      }
      const respBody = await res.json().catch(() => null);
      const r = checkResponse(op.method, concrete, res.status, respBody);
      const errors = r.errors.filter((e) => !isKnown(concrete, e));
      results.push({ op: `${op.method} ${op.path}`, status: res.status, validated: r.validated, errors });
      const extras = findOverEmission(op.method, concrete, res.status, respBody).filter((k) => !OVER_EMISSION_KNOWN.has(normalizeKey(k)));
      if (extras.length) overEmission.set(`${op.method} ${op.path}`, extras);
    }

    const validated = results.filter((r) => r.validated);
    const failing = validated.filter((r) => r.errors.length > 0);
    const lines = [
      `WRITE ops total=${ops.length} reached2xx=${results.length} validated=${validated.length} divergent=${failing.length} needsBody=${needsBodyOps.length} unmappable=${unmappableOps.length}`,
    ];
    for (const f of failing) {
      lines.push(`DIVERGENCE ${f.op} [${f.status}]`);
      for (const e of f.errors.slice(0, 10)) lines.push(`    - ${e}`);
    }
    lines.push("", "--- needsBody (generated body rejected 4xx) ---");
    for (const n of needsBodyOps) lines.push(`  [${n.status}] ${n.op}`);
    lines.push("", "--- unmappable (no id for a path param) ---");
    for (const u of unmappableOps) lines.push(`  ${u}`);
    lines.push("", `--- over-emission (keys absent from spec) endpoints=${overEmission.size} ---`);
    for (const [op, keys] of overEmission) lines.push(`  ${op}: ${keys.join(", ")}`);
    writeFileSync("/tmp/conformance-write-sweep.txt", lines.join("\n") + "\n");

    expect(validated.length).toBeGreaterThanOrEqual(5);
    expect(failing, `Unexpected write-response divergences:\n${lines.join("\n")}`).toHaveLength(0);
    expect(overEmission.size, `Unexpected write-response over-emission:\n${[...overEmission].map(([o, k]) => `${o}: ${k.join(", ")}`).join("\n")}`).toBe(0);
  });
});
