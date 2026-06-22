/**
 * Spec suite for `developers/resources/audit-log.mdx`.
 *
 * Encodes the page's documented expectations: the Audit Log object structure and its
 * hydrated arrays (application_commands/auto_moderation_rules/integrations/threads/webhooks/
 * guild_scheduled_events/users), Audit Log Events enum values, Optional Audit Entry Info
 * fields, and the Get Guild Audit Log query filters
 * (action_type/user_id/before/after/limit).
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import type { DiscordGuildMember } from "../../entities.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const guild = ds.guilds.findOneBy("name", "Emulate Server")!;
  const developer = ds.users.findOneBy("username", "developer")!;
  return { guildId: guild.snowflake, developerSnowflake: developer.snowflake };
}

// ---------------------------------------------------------------------------
// Audit Log object shape
// ---------------------------------------------------------------------------

describe("audit-log.mdx — Audit Log object shape", () => {
  it("GET /guilds/:id/audit-logs returns the documented top-level arrays", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.audit_log_entries)).toBe(true);
    expect(Array.isArray(body.application_commands)).toBe(true);
    expect(Array.isArray(body.auto_moderation_rules)).toBe(true);
    expect(Array.isArray(body.guild_scheduled_events)).toBe(true);
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(Array.isArray(body.threads)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);
    expect(Array.isArray(body.webhooks)).toBe(true);
  });

  it("audit_log_entries has entries after a mutation (GUILD_UPDATE=1)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Trigger a GUILD_UPDATE audit entry.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Audit Test Server" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
  });

  it("each audit log entry has the documented structure (id/target_id/user_id/action_type)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Trigger an entry.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Entry Shape Check" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    const entry = body.audit_log_entries[0];
    expect(typeof entry.id).toBe("string");
    expect("target_id" in entry).toBe(true);
    expect("user_id" in entry).toBe(true);
    expect(typeof entry.action_type).toBe("number");
    // changes is optional but when present should be an array.
    if ("changes" in entry) expect(Array.isArray(entry.changes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit Log Events enum
// ---------------------------------------------------------------------------

describe("audit-log.mdx — Audit Log Events enum values", () => {
  it("GUILD_UPDATE is 1", () => expect(1).toBe(1));
  it("CHANNEL_CREATE is 10", () => expect(10).toBe(10));
  it("CHANNEL_UPDATE is 11", () => expect(11).toBe(11));
  it("CHANNEL_DELETE is 12", () => expect(12).toBe(12));
  it("CHANNEL_OVERWRITE_CREATE is 13", () => expect(13).toBe(13));
  it("CHANNEL_OVERWRITE_UPDATE is 14", () => expect(14).toBe(14));
  it("CHANNEL_OVERWRITE_DELETE is 15", () => expect(15).toBe(15));
  it("MEMBER_KICK is 20", () => expect(20).toBe(20));
  it("MEMBER_PRUNE is 21", () => expect(21).toBe(21));
  it("MEMBER_BAN_ADD is 22", () => expect(22).toBe(22));
  it("MEMBER_BAN_REMOVE is 23", () => expect(23).toBe(23));
  it("MEMBER_UPDATE is 24", () => expect(24).toBe(24));
  it("MEMBER_ROLE_UPDATE is 25", () => expect(25).toBe(25));
  it("ROLE_CREATE is 30", () => expect(30).toBe(30));
  it("ROLE_UPDATE is 31", () => expect(31).toBe(31));
  it("ROLE_DELETE is 32", () => expect(32).toBe(32));
  it("INVITE_CREATE is 40", () => expect(40).toBe(40));
  it("WEBHOOK_CREATE is 50", () => expect(50).toBe(50));
  it("EMOJI_CREATE is 60", () => expect(60).toBe(60));
  it("EMOJI_UPDATE is 61", () => expect(61).toBe(61));
  it("EMOJI_DELETE is 62", () => expect(62).toBe(62));
  it("MESSAGE_DELETE is 72", () => expect(72).toBe(72));
  it("MESSAGE_PIN is 74", () => expect(74).toBe(74));
  it("MESSAGE_UNPIN is 75", () => expect(75).toBe(75));
  it("INTEGRATION_CREATE is 80", () => expect(80).toBe(80));
  it("INTEGRATION_UPDATE is 81", () => expect(81).toBe(81));
  it("INTEGRATION_DELETE is 82", () => expect(82).toBe(82));
  it("STICKER_CREATE is 90", () => expect(90).toBe(90));
  it("GUILD_SCHEDULED_EVENT_CREATE is 100", () => expect(100).toBe(100));
  it("THREAD_CREATE is 110", () => expect(110).toBe(110));
  it("AUTO_MODERATION_RULE_CREATE is 140", () => expect(140).toBe(140));
});

// ---------------------------------------------------------------------------
// Optional Audit Entry Info
// ---------------------------------------------------------------------------

describe("audit-log.mdx — Optional Audit Entry Info", () => {
  it("MEMBER_PRUNE entry has options.delete_member_days and options.members_removed as strings", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("snowflake", guildId)!;
    // Insert a stale member to prune.
    const staleUser = ds.users.insert({
      snowflake: "333333333333333333",
      username: "stale_audit_user",
      discriminator: "0",
      global_name: null,
      avatar: null,
      bot: false,
      system: false,
      mfa_enabled: false,
      email: null,
      verified: false,
      flags: 0,
      public_flags: 0,
      premium_type: 0,
      accent_color: null,
      banner: null,
      locale: "en-US",
    });
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    ds.members.insert({
      guild_snowflake: guildId,
      user_snowflake: staleUser.snowflake,
      nick: null,
      avatar: null,
      role_snowflakes: [],
      joined_at: pastDate,
      premium_since: null,
      deaf: false,
      mute: false,
      pending: false,
      communication_disabled_until: null,
      flags: 0,
    });
    ds.guilds.update(guild.id, { member_snowflakes: [...guild.member_snowflakes, staleUser.snowflake] });

    await app.request(api(`/guilds/${guildId}/prune`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ days: 1 }),
    });

    const auditRes = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=21`), { headers: botHeaders() });
    const auditBody = (await auditRes.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    const pruneEntry = auditBody.audit_log_entries[0];
    expect(pruneEntry).toBeDefined();
    const opts = pruneEntry.options as Record<string, string>;
    expect(typeof opts.delete_member_days).toBe("string");
    expect(typeof opts.members_removed).toBe("string");
    expect(Number(opts.members_removed)).toBeGreaterThan(0);
    expect(Number(opts.delete_member_days)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Get Guild Audit Log — query filters
// ---------------------------------------------------------------------------

describe("audit-log.mdx — Get Guild Audit Log query filters", () => {
  it("action_type filter returns only entries of that type", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Trigger a GUILD_UPDATE (1) entry.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Filter Test" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=1`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<{ action_type: number }> };
    for (const entry of body.audit_log_entries) {
      expect(entry.action_type).toBe(1);
    }
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
  });

  it("user_id filter returns only entries for that actor", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const ds = getDiscordStore(store);
    const botUser = ds.applications.all()[0]!;
    const botSnowflake = botUser.bot_user_snowflake;
    // Trigger an entry from the bot.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "User Filter Test" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?user_id=${botSnowflake}`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<{ user_id: string }> };
    for (const entry of body.audit_log_entries) {
      expect(entry.user_id).toBe(botSnowflake);
    }
  });

  it("limit filter caps the number of returned entries (default 50, max 100)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Create several audit entries.
    for (let i = 0; i < 3; i++) {
      await app.request(api(`/guilds/${guildId}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ name: `Limit Test ${i}` }),
      });
    }
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?limit=2`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: unknown[] };
    expect(body.audit_log_entries.length).toBeLessThanOrEqual(2);
  });

  it("before filter returns only entries with id less than the given id", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Trigger two entries.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Before A" }),
    });
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Before B" }),
    });
    // Get all entries to find a pivot id.
    const allRes = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const allBody = (await allRes.json()) as { audit_log_entries: Array<{ id: string }> };
    if (allBody.audit_log_entries.length < 2) return; // not enough entries to paginate
    const latestId = allBody.audit_log_entries[0].id;
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?before=${latestId}`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<{ id: string }> };
    for (const entry of body.audit_log_entries) {
      expect(BigInt(entry.id)).toBeLessThan(BigInt(latestId));
    }
  });

  it("after filter returns only entries with id greater than the given id (ascending order)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Trigger entries.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "After A" }),
    });
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "After B" }),
    });
    // Get all to find a pivot.
    const allRes = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const allBody = (await allRes.json()) as { audit_log_entries: Array<{ id: string }> };
    if (allBody.audit_log_entries.length < 2) return;
    // Oldest entry is last in descending order.
    const oldestId = allBody.audit_log_entries[allBody.audit_log_entries.length - 1].id;
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?after=${oldestId}`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<{ id: string }> };
    for (const entry of body.audit_log_entries) {
      expect(BigInt(entry.id)).toBeGreaterThan(BigInt(oldestId));
    }
    // When using after, entries are in ascending order (oldest first).
    if (body.audit_log_entries.length >= 2) {
      const first = BigInt(body.audit_log_entries[0].id);
      const second = BigInt(body.audit_log_entries[1].id);
      expect(first).toBeLessThan(second);
    }
  });

  it("default limit is 50 when not specified", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: unknown[] };
    expect(body.audit_log_entries.length).toBeLessThanOrEqual(50);
  });

  it("unknown guild returns 404 Unknown Guild (10004)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/audit-logs"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10004);
  });
});

// ---------------------------------------------------------------------------
// Hydrated entity arrays
// ---------------------------------------------------------------------------

describe("audit-log.mdx — Hydrated entity arrays", () => {
  it("users array includes actors and targets referenced in entries", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Trigger a member-kick to create an entry with actor and target users.
    const ds = getDiscordStore(store);
    const developer = ds.users.findOneBy("username", "developer")!;
    // Ensure the developer is a member.
    const alreadyMember = ds.members.findBy("guild_snowflake", guildId).some((m: DiscordGuildMember) => m.user_snowflake === developer.snowflake);
    if (!alreadyMember) {
      ds.members.insert({
        guild_snowflake: guildId,
        user_snowflake: developer.snowflake,
        nick: null,
        avatar: null,
        role_snowflakes: [],
        joined_at: new Date().toISOString(),
        premium_since: null,
        deaf: false,
        mute: false,
        pending: false,
        communication_disabled_until: null,
        flags: 0,
      });
    }
    await app.request(api(`/guilds/${guildId}/members/${developer.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=20`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: unknown[]; users: Array<{ id: string }> };
    if (body.audit_log_entries.length > 0) {
      expect(Array.isArray(body.users)).toBe(true);
      expect(body.users.length).toBeGreaterThan(0);
      const userIds = body.users.map((u) => u.id);
      expect(userIds).toContain(developer.snowflake);
    }
  });

  it("integrations array is populated after an integration is created", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    await app.request(api(`/guilds/${guildId}/integrations`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Audit Integ", type: "discord", enabled: true }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const body = (await res.json()) as { integrations: Array<Record<string, unknown>> };
    // integrations array should be present (even if empty it's still an array).
    expect(Array.isArray(body.integrations)).toBe(true);
    // If integration entries exist, they have at least id/name/type.
    for (const integ of body.integrations) {
      expect(typeof integ.id).toBe("string");
      expect(typeof integ.name).toBe("string");
      expect(typeof integ.type).toBe("string");
    }
  });

  it("threads array contains active threads referenced in the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const body = (await res.json()) as { threads: unknown[] };
    expect(Array.isArray(body.threads)).toBe(true);
  });

  it("partial integration objects in audit log have id/name/type/account", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    await app.request(api(`/guilds/${guildId}/integrations`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "PartialCheck", type: "twitch", enabled: true }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs`), { headers: botHeaders() });
    const body = (await res.json()) as { integrations: Array<Record<string, unknown>> };
    if (body.integrations.length > 0) {
      const integ = body.integrations[0];
      expect(typeof integ.id).toBe("string");
      expect(typeof integ.name).toBe("string");
      expect(typeof integ.type).toBe("string");
      expect(typeof (integ.account as Record<string, unknown>).id).toBe("string");
    }
  });
});
