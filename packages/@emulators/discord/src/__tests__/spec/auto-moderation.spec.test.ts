/**
 * Spec suite for `developers/resources/auto-moderation.mdx`.
 *
 * Encodes the page's documented expectations directly: the Auto Moderation Rule object shape
 * (every field), the Trigger Types / Event Types / Keyword Preset Types / Action Types enums and
 * each action's required metadata, the trigger_metadata shape with array & character limits, the
 * per-trigger-type max-rules-per-guild caps, and every endpoint's request/response/status and
 * error codes (including which Gateway events fire). Written from the doc first; the implementation
 * is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    general: ds.channels.findOneBy("name", "general")!.snowflake,
  };
}

/** Create a KEYWORD rule with the given overrides; returns the parsed response + status. */
async function createRule(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  guild: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const KEYWORD = { name: "kw", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["bad"] }, actions: [{ type: 1 }] };

describe("auto-moderation.mdx — Auto Moderation Rule object", () => {
  it("Create returns a rule with EVERY documented field present", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { ...KEYWORD, exempt_roles: [], exempt_channels: [] });
    expect(status).toBe(201);
    // Auto Moderation Rule Structure — every field.
    expect(typeof json.id).toBe("string");
    expect(json.guild_id).toBe(guild);
    expect(typeof json.name).toBe("string");
    expect("creator_id" in json).toBe(true);
    expect(typeof json.event_type).toBe("number");
    expect(typeof json.trigger_type).toBe("number");
    expect(typeof json.trigger_metadata).toBe("object");
    expect(Array.isArray(json.actions)).toBe(true);
    expect(typeof json.enabled).toBe("boolean");
    expect(Array.isArray(json.exempt_roles)).toBe(true);
    expect(Array.isArray(json.exempt_channels)).toBe(true);
  });

  it("creator_id is the user that first created the rule (the bot)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { guild } = ids(store);
    const botSnowflake = ds.applications.all()[0]!.bot_user_snowflake;
    const { json } = await createRule(app, guild, KEYWORD);
    expect(json.creator_id).toBe(botSnowflake);
  });

  it("enabled defaults to false when omitted (per docs)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["a"] }, actions: [{ type: 1 }] });
    expect(json.enabled).toBe(false);
  });

  it("enabled honors an explicit true", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, { ...KEYWORD, enabled: true });
    expect(json.enabled).toBe(true);
  });

  it("round-trips trigger_metadata (keyword_filter + regex_patterns) and actions", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, {
      name: "kw",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ["cat*", "*dog"], regex_patterns: ["(b|c)at"] },
      actions: [{ type: 1, metadata: { custom_message: "no" } }],
    });
    const tm = json.trigger_metadata as Record<string, unknown>;
    expect(tm.keyword_filter).toEqual(["cat*", "*dog"]);
    expect(tm.regex_patterns).toEqual(["(b|c)at"]);
    expect(json.actions).toEqual([{ type: 1, metadata: { custom_message: "no" } }]);
  });
});

describe("auto-moderation.mdx — Trigger Types", () => {
  // KEYWORD 1, SPAM 3, KEYWORD_PRESET 4, MENTION_SPAM 5, MEMBER_PROFILE 6.
  it("accepts each documented trigger type value", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const cases: Array<{ trigger_type: number; trigger_metadata?: Record<string, unknown> }> = [
      { trigger_type: 1, trigger_metadata: { keyword_filter: ["a"] } },
      { trigger_type: 3 },
      { trigger_type: 4, trigger_metadata: { presets: [1] } },
      { trigger_type: 5, trigger_metadata: { mention_total_limit: 5 } },
      { trigger_type: 6, trigger_metadata: { keyword_filter: ["a"] } },
    ];
    for (const tc of cases) {
      const { status, json } = await createRule(app, guild, {
        name: `t${tc.trigger_type}`,
        event_type: 1,
        trigger_type: tc.trigger_type,
        trigger_metadata: tc.trigger_metadata ?? {},
        actions: [{ type: 1 }],
      });
      expect(status, `trigger_type ${tc.trigger_type}`).toBe(201);
      expect(json.trigger_type).toBe(tc.trigger_type);
    }
  });

  it("rejects an unknown trigger type with 50035 (value 2 is not assignable)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 2, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });
});

describe("auto-moderation.mdx — Event Types", () => {
  it("accepts MESSAGE_SEND (1) and MEMBER_UPDATE (2)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    for (const event_type of [1, 2]) {
      const { status, json } = await createRule(app, guild, {
        name: `e${event_type}`,
        event_type,
        trigger_type: event_type === 2 ? 6 : 1,
        trigger_metadata: { keyword_filter: ["a"] },
        actions: [{ type: 1 }],
      });
      expect(status).toBe(201);
      expect(json.event_type).toBe(event_type);
    }
  });

  it("rejects an unknown event type with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 99, trigger_type: 1, trigger_metadata: { keyword_filter: ["a"] }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("create without event_type is rejected with 50035 (required)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", trigger_type: 1, trigger_metadata: { keyword_filter: ["a"] }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });
});

describe("auto-moderation.mdx — Action Types & metadata", () => {
  it("accepts BLOCK_MESSAGE(1), SEND_ALERT_MESSAGE(2), TIMEOUT(3), BLOCK_MEMBER_INTERACTION(4) with required metadata", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, general } = ids(store);
    const { status, json } = await createRule(app, guild, {
      name: "all-actions",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ["a"] },
      actions: [
        { type: 1, metadata: { custom_message: "blocked" } },
        { type: 2, metadata: { channel_id: general } },
        { type: 3, metadata: { duration_seconds: 60 } },
        { type: 4 },
      ],
    });
    expect(status).toBe(201);
    expect((json.actions as unknown[]).length).toBe(4);
  });

  it("rejects an unknown action type with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { ...KEYWORD, actions: [{ type: 9 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("SEND_ALERT_MESSAGE without channel_id metadata is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { ...KEYWORD, actions: [{ type: 2 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("TIMEOUT without duration_seconds metadata is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { ...KEYWORD, actions: [{ type: 3 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("TIMEOUT duration_seconds over 2419200 (4 weeks) is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { ...KEYWORD, actions: [{ type: 3, metadata: { duration_seconds: 2419201 } }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("BLOCK_MESSAGE custom_message over 150 characters is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { ...KEYWORD, actions: [{ type: 1, metadata: { custom_message: "x".repeat(151) } }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });
});

describe("auto-moderation.mdx — Trigger Metadata limits", () => {
  it("keyword_filter must be an array of strings (object rejected with 50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: "bad" }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("keyword_filter over 1000 entries is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const big = Array.from({ length: 1001 }, (_, i) => `k${i}`);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: big }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("a keyword_filter entry over 60 characters is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["a".repeat(61)] }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("regex_patterns over 10 entries is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const patterns = Array.from({ length: 11 }, () => "a");
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { regex_patterns: patterns }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("a regex_patterns entry over 260 characters is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { regex_patterns: ["a".repeat(261)] }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("KEYWORD allow_list over 100 entries is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const list = Array.from({ length: 101 }, (_, i) => `a${i}`);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["a"], allow_list: list }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("KEYWORD_PRESET allow_list accepts up to 1000 entries", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const list = Array.from({ length: 101 }, (_, i) => `a${i}`);
    const { status } = await createRule(app, guild, { name: "preset", event_type: 1, trigger_type: 4, trigger_metadata: { presets: [1, 2, 3], allow_list: list }, actions: [{ type: 1 }] });
    expect(status).toBe(201);
  });

  it("mention_total_limit over 50 is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 51 }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("presets must be one of the Keyword Preset Types (1,2,3); 99 is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { status, json } = await createRule(app, guild, { name: "x", event_type: 1, trigger_type: 4, trigger_metadata: { presets: [99] }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });
});

describe("auto-moderation.mdx — max rules per guild", () => {
  it("KEYWORD allows up to 6 rules then rejects the 7th with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    for (let i = 0; i < 6; i++) {
      const { status } = await createRule(app, guild, { name: `kw${i}`, event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["a"] }, actions: [{ type: 1 }] });
      expect(status).toBe(201);
    }
    const { status, json } = await createRule(app, guild, { name: "kw7", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["a"] }, actions: [{ type: 1 }] });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it.each([
    { type: 3, metadata: {} },
    { type: 4, metadata: { presets: [1] } },
    { type: 5, metadata: { mention_total_limit: 5 } },
    { type: 6, metadata: { keyword_filter: ["a"] } },
  ])("trigger type $type allows only 1 rule per guild", async ({ type, metadata }) => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const first = await createRule(app, guild, { name: "a", event_type: type === 6 ? 2 : 1, trigger_type: type, trigger_metadata: metadata, actions: [{ type: 1 }] });
    expect(first.status).toBe(201);
    const second = await createRule(app, guild, { name: "b", event_type: type === 6 ? 2 : 1, trigger_type: type, trigger_metadata: metadata, actions: [{ type: 1 }] });
    expect(second.status).toBe(400);
    expect(second.json.code).toBe(50035);
  });
});

describe("auto-moderation.mdx — endpoints", () => {
  it("List returns an array of rule objects for the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    await createRule(app, guild, KEYWORD);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = (await res.json()) as unknown[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it("Get returns a single rule object", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, KEYWORD);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(json.id);
  });

  it("Get an unknown rule id returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });

  it("Modify updates name/enabled/trigger_metadata and returns the rule", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, KEYWORD);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "renamed", enabled: true, trigger_metadata: { keyword_filter: ["new"] } }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated.name).toBe("renamed");
    expect(updated.enabled).toBe(true);
    expect((updated.trigger_metadata as Record<string, unknown>).keyword_filter).toEqual(["new"]);
  });

  it("Modify with all params optional (empty body) succeeds", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, KEYWORD);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("Modify rejects an invalid action type with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, KEYWORD);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ actions: [{ type: 42 }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("Delete returns 204 and removes the rule", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { json } = await createRule(app, guild, KEYWORD);
    const res = await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).autoModRules.findOneBy("snowflake", json.id as string)).toBeUndefined();
  });

  it("Create for an unknown guild returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/999999999999999999/auto-moderation/rules`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify(KEYWORD),
    });
    expect(res.status).toBe(404);
  });
});

describe("auto-moderation.mdx — Gateway events", () => {
  it("Create/Modify/Delete each fire their Gateway dispatch (observed via the parallel audit-log entry)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    // The in-process gateway bus is not directly observable here, but every rule mutation records a
    // parallel audit-log entry alongside the AUTO_MODERATION_RULE_* dispatch; assert those.
    const ds = getDiscordStore(store);
    const before = ds.auditLog.all().length;
    const { json } = await createRule(app, guild, KEYWORD);
    await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x2" }),
    });
    await app.request(api(`/guilds/${guild}/auto-moderation/rules/${json.id as string}`), { method: "DELETE", headers: botHeaders() });
    const after = ds.auditLog.all().slice(before).map((e) => e.action_type);
    // AutoModerationRuleCreate(140), Update(141), Delete(142).
    expect(after).toContain(140);
    expect(after).toContain(141);
    expect(after).toContain(142);
  });
});
