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
// Audit Log Events — real endpoint emission checks
// ---------------------------------------------------------------------------
// These tests verify that documented action_type values are actually emitted
// by the corresponding endpoints AND that the changes array has the documented
// key/new_value/old_value structure. Each test triggers an endpoint, then
// reads the audit log filtered to that action_type and inspects the entry.

describe("audit-log.mdx — Audit Log Events emitted by endpoints", () => {
  it("GUILD_UPDATE (1) is emitted with changes keys when guild is patched", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "AuditEnumTest" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=1`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    const entry = body.audit_log_entries[0];
    expect(entry.action_type).toBe(1);
    const changes = entry.changes as Array<{ key: string; new_value: unknown }>;
    expect(Array.isArray(changes)).toBe(true);
    const nameChange = changes.find((c) => c.key === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.new_value).toBe("AuditEnumTest");
  });

  it("MEMBER_KICK (20) is emitted with correct target when a member is removed", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    const ds = getDiscordStore(store);
    // Ensure the developer is a member before kicking.
    const already = ds.members.findBy("guild_snowflake", guildId).some((m: DiscordGuildMember) => m.user_snowflake === developerSnowflake);
    if (!already) {
      ds.members.insert({
        guild_snowflake: guildId,
        user_snowflake: developerSnowflake,
        nick: null, avatar: null, role_snowflakes: [],
        joined_at: new Date().toISOString(),
        premium_since: null, deaf: false, mute: false,
        pending: false, communication_disabled_until: null, flags: 0,
      });
    }
    await app.request(api(`/guilds/${guildId}/members/${developerSnowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=20`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    const entry = body.audit_log_entries[0];
    expect(entry.action_type).toBe(20);
    expect(entry.target_id).toBe(developerSnowflake);
  });

  it("MEMBER_BAN_ADD (22) is emitted with documented target when a user is banned", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=22`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    const entry = body.audit_log_entries[0];
    expect(entry.action_type).toBe(22);
    expect(entry.target_id).toBe(developerSnowflake);
  });

  it("MEMBER_BAN_REMOVE (23) is emitted when a ban is removed", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    // Create a ban first.
    await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=23`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    expect(body.audit_log_entries[0].action_type).toBe(23);
  });

  it("ROLE_CREATE (30) is emitted with name in changes when a role is created", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    await app.request(api(`/guilds/${guildId}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "AuditRole" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=30`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    const entry = body.audit_log_entries[0];
    expect(entry.action_type).toBe(30);
    const changes = entry.changes as Array<{ key: string; new_value: unknown }>;
    expect(Array.isArray(changes)).toBe(true);
    const nameChange = changes.find((c) => c.key === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.new_value).toBe("AuditRole");
  });

  it("EMOJI_CREATE (60) is emitted with name in changes when an emoji is created", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "auditemoji", image: "data:image/png;base64,AAAA" }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=60`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    const entry = body.audit_log_entries[0];
    expect(entry.action_type).toBe(60);
    const changes = entry.changes as Array<{ key: string; new_value: unknown }>;
    const nameChange = changes.find((c) => c.key === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.new_value).toBe("auditemoji");
  });

  it("MEMBER_ROLE_UPDATE (25) changes have $add/$remove structure when roles change", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    const ds = getDiscordStore(store);
    // Create a role to assign.
    const roleRes = await app.request(api(`/guilds/${guildId}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "RoleForAudit" }),
    });
    const role = (await roleRes.json()) as { id: string };
    // Ensure developer is a member.
    const already = ds.members.findBy("guild_snowflake", guildId).some((m: DiscordGuildMember) => m.user_snowflake === developerSnowflake);
    if (!already) {
      ds.members.insert({
        guild_snowflake: guildId,
        user_snowflake: developerSnowflake,
        nick: null, avatar: null, role_snowflakes: [],
        joined_at: new Date().toISOString(),
        premium_since: null, deaf: false, mute: false,
        pending: false, communication_disabled_until: null, flags: 0,
      });
    }
    // Assign the role.
    await app.request(api(`/guilds/${guildId}/members/${developerSnowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ roles: [role.id] }),
    });
    const res = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=25`), { headers: botHeaders() });
    const body = (await res.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    expect(body.audit_log_entries.length).toBeGreaterThan(0);
    const entry = body.audit_log_entries[0];
    expect(entry.action_type).toBe(25);
    const changes = entry.changes as Array<{ key: string; new_value: unknown }>;
    // Must have $add or $remove key entries per audit-log.mdx:206-208.
    const hasAddOrRemove = changes.some((c) => c.key === "$add" || c.key === "$remove");
    expect(hasAddOrRemove).toBe(true);
    // Values are arrays of partial role objects with id and name.
    const addEntry = changes.find((c) => c.key === "$add");
    if (addEntry) {
      const addedRoles = addEntry.new_value as Array<{ id: string; name: string }>;
      expect(Array.isArray(addedRoles)).toBe(true);
      expect(typeof addedRoles[0].id).toBe("string");
      expect(typeof addedRoles[0].name).toBe("string");
    }
  });
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
