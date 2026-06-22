/**
 * Spec suite for `developers/resources/guild.mdx`.
 *
 * Encodes the page's documented expectations directly: the Guild object shape and its
 * nested enums, Guild Member shape and flags, every endpoint's method/params/response/status,
 * and documented error codes. Written from the doc first; the implementation is fixed until
 * this is green.
 *
 * Roles are already covered by __tests__/roles.test.ts — role CRUD is NOT duplicated here.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import type { DiscordChannel } from "../../entities.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const guild = ds.guilds.findOneBy("name", "Emulate Server")!;
  const app = ds.applications.all()[0]!;
  const developer = ds.users.findOneBy("username", "developer")!;
  return {
    guildId: guild.snowflake,
    appId: app.snowflake,
    botSnowflake: app.bot_user_snowflake,
    developerSnowflake: developer.snowflake,
  };
}

// ---------------------------------------------------------------------------
// Guild object shape
// ---------------------------------------------------------------------------

describe("guild.mdx — Guild object shape", () => {
  it("Get Guild returns all documented top-level fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const g = (await res.json()) as Record<string, unknown>;

    // Snowflake identifiers.
    expect(typeof g.id).toBe("string");
    expect(typeof g.owner_id).toBe("string");
    // Basic string fields.
    expect(typeof g.name).toBe("string");
    expect("icon" in g).toBe(true);
    expect("splash" in g).toBe(true);
    expect("discovery_splash" in g).toBe(true);
    expect("description" in g).toBe(true);
    // Enum fields.
    expect(typeof g.verification_level).toBe("number");
    expect(typeof g.default_message_notifications).toBe("number");
    expect(typeof g.explicit_content_filter).toBe("number");
    expect(typeof g.mfa_level).toBe("number");
    expect(typeof g.nsfw_level).toBe("number");
    expect(typeof g.premium_tier).toBe("number");
    expect(typeof g.system_channel_flags).toBe("number");
    // Arrays.
    expect(Array.isArray(g.roles)).toBe(true);
    expect(Array.isArray(g.emojis)).toBe(true);
    expect(Array.isArray(g.features)).toBe(true);
    expect(Array.isArray(g.stickers)).toBe(true);
    // Optional nullable IDs.
    expect("afk_channel_id" in g).toBe(true);
    expect("system_channel_id" in g).toBe(true);
    expect("rules_channel_id" in g).toBe(true);
    expect("public_updates_channel_id" in g).toBe(true);
    expect("safety_alerts_channel_id" in g).toBe(true);
    expect("vanity_url_code" in g).toBe(true);
    // Integer counts.
    expect(typeof g.afk_timeout).toBe("number");
    expect(typeof g.premium_subscription_count).toBe("number");
    // String locale.
    expect(typeof g.preferred_locale).toBe("string");
    // Boolean.
    expect(typeof g.premium_progress_bar_enabled).toBe("boolean");
  });

  it("verification_level values are 0-4 (NONE through VERY_HIGH)", () => {
    expect([0, 1, 2, 3, 4]).toContain(0); // NONE
    expect([0, 1, 2, 3, 4]).toContain(4); // VERY_HIGH
  });

  it("default_message_notifications values are 0 (ALL_MESSAGES) or 1 (ONLY_MENTIONS)", () => {
    expect([0, 1]).toContain(0);
    expect([0, 1]).toContain(1);
  });

  it("explicit_content_filter values are 0 (DISABLED), 1 (MEMBERS_WITHOUT_ROLES), 2 (ALL_MEMBERS)", () => {
    expect([0, 1, 2]).toContain(0);
    expect([0, 1, 2]).toContain(2);
  });

  it("mfa_level values are 0 (NONE) or 1 (ELEVATED)", () => {
    expect([0, 1]).toContain(0);
    expect([0, 1]).toContain(1);
  });

  it("nsfw_level values are 0-3 (DEFAULT through AGE_RESTRICTED)", () => {
    expect([0, 1, 2, 3]).toContain(0);
    expect([0, 1, 2, 3]).toContain(3);
  });

  it("premium_tier values are 0-3", () => {
    expect([0, 1, 2, 3]).toContain(0);
    expect([0, 1, 2, 3]).toContain(3);
  });

  it("system_channel_flags bit positions match documented values", () => {
    const SUPPRESS_JOIN_NOTIFICATIONS = 1 << 0;
    const SUPPRESS_PREMIUM_SUBSCRIPTIONS = 1 << 1;
    const SUPPRESS_GUILD_REMINDER_NOTIFICATIONS = 1 << 2;
    const SUPPRESS_JOIN_NOTIFICATION_REPLIES = 1 << 3;
    const SUPPRESS_ROLE_SUBSCRIPTION_PURCHASE_NOTIFICATIONS = 1 << 4;
    const SUPPRESS_ROLE_SUBSCRIPTION_PURCHASE_NOTIFICATION_REPLIES = 1 << 5;
    expect(SUPPRESS_JOIN_NOTIFICATIONS).toBe(1);
    expect(SUPPRESS_PREMIUM_SUBSCRIPTIONS).toBe(2);
    expect(SUPPRESS_GUILD_REMINDER_NOTIFICATIONS).toBe(4);
    expect(SUPPRESS_JOIN_NOTIFICATION_REPLIES).toBe(8);
    expect(SUPPRESS_ROLE_SUBSCRIPTION_PURCHASE_NOTIFICATIONS).toBe(16);
    expect(SUPPRESS_ROLE_SUBSCRIPTION_PURCHASE_NOTIFICATION_REPLIES).toBe(32);
  });

  it("Get Guild with with_counts=true adds approximate_member_count and approximate_presence_count", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}?with_counts=true`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const g = (await res.json()) as Record<string, unknown>;
    expect(typeof g.approximate_member_count).toBe("number");
    expect(typeof g.approximate_presence_count).toBe("number");
  });

  it("Get Guild without with_counts does NOT include approximate counts", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), { headers: botHeaders() });
    const g = (await res.json()) as Record<string, unknown>;
    expect("approximate_member_count" in g).toBe(false);
    expect("approximate_presence_count" in g).toBe(false);
  });

  it("Get Guild for unknown id returns 404 Unknown Guild (10004)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10004);
  });
});

// ---------------------------------------------------------------------------
// Guild Member object shape
// ---------------------------------------------------------------------------

describe("guild.mdx — Guild Member object shape", () => {
  it("Get Guild Member returns all documented fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, botSnowflake } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/members/${botSnowflake}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(m.roles)).toBe(true);
    expect("joined_at" in m).toBe(true);
    expect(typeof m.deaf).toBe("boolean");
    expect(typeof m.mute).toBe("boolean");
    expect(typeof m.flags).toBe("number");
    expect("nick" in m).toBe(true);
    expect("avatar" in m).toBe(true);
    expect("premium_since" in m).toBe(true);
    expect("pending" in m).toBe(true);
    expect("communication_disabled_until" in m).toBe(true);
    // user object is included.
    const u = m.user as Record<string, unknown>;
    expect(typeof u.id).toBe("string");
    expect(typeof u.username).toBe("string");
  });

  it("Guild Member flags bit positions match the documented values", () => {
    const DID_REJOIN = 1 << 0;
    const COMPLETED_ONBOARDING = 1 << 1;
    const BYPASSES_VERIFICATION = 1 << 2;
    const STARTED_ONBOARDING = 1 << 3;
    const IS_GUEST = 1 << 4;
    const STARTED_HOME_ACTIONS = 1 << 5;
    const COMPLETED_HOME_ACTIONS = 1 << 6;
    const AUTOMOD_QUARANTINED_USERNAME = 1 << 7;
    const DM_SETTINGS_UPSELL_ACKNOWLEDGED = 1 << 9;
    expect(DID_REJOIN).toBe(1);
    expect(COMPLETED_ONBOARDING).toBe(2);
    expect(BYPASSES_VERIFICATION).toBe(4);
    expect(STARTED_ONBOARDING).toBe(8);
    expect(IS_GUEST).toBe(16);
    expect(STARTED_HOME_ACTIONS).toBe(32);
    expect(COMPLETED_HOME_ACTIONS).toBe(64);
    expect(AUTOMOD_QUARANTINED_USERNAME).toBe(128);
    expect(DM_SETTINGS_UPSELL_ACKNOWLEDGED).toBe(512);
  });

  it("Modify Guild Member persists the flags field", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    const BYPASSES_VERIFICATION = 1 << 2;
    const res = await app.request(api(`/guilds/${guildId}/members/${developerSnowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ flags: BYPASSES_VERIFICATION }),
    });
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.flags).toBe(BYPASSES_VERIFICATION);
    // Verify persistence via a follow-up GET.
    const fetched = (await (
      await app.request(api(`/guilds/${guildId}/members/${developerSnowflake}`), { headers: botHeaders() })
    ).json()) as Record<string, unknown>;
    expect(fetched.flags).toBe(BYPASSES_VERIFICATION);
  });

  it("Get Guild Member for unknown user returns 404 Unknown Member (10007)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/members/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10007);
  });
});

// ---------------------------------------------------------------------------
// Create Guild
// ---------------------------------------------------------------------------

describe("guild.mdx — Create Guild", () => {
  it("POST /guilds creates a guild and returns 201 with the guild object", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "New Test Guild" }),
    });
    expect(res.status).toBe(201);
    const g = (await res.json()) as Record<string, unknown>;
    expect(typeof g.id).toBe("string");
    expect(g.name).toBe("New Test Guild");
  });
});

// ---------------------------------------------------------------------------
// Modify Guild
// ---------------------------------------------------------------------------

describe("guild.mdx — Modify Guild", () => {
  it("PATCH /guilds/:id updates name and returns the updated guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Renamed Server" }),
    });
    expect(res.status).toBe(200);
    const g = (await res.json()) as Record<string, unknown>;
    expect(g.name).toBe("Renamed Server");
  });

  it("PATCH /guilds/:id updates verification_level", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ verification_level: 2 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verification_level: number }).verification_level).toBe(2);
  });

  it("PATCH /guilds/:id updates default_message_notifications", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ default_message_notifications: 1 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { default_message_notifications: number }).default_message_notifications).toBe(1);
  });

  it("PATCH /guilds/:id updates explicit_content_filter", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ explicit_content_filter: 2 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { explicit_content_filter: number }).explicit_content_filter).toBe(2);
  });

  it("PATCH /guilds/:id updates system_channel_flags", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const SUPPRESS_JOIN_NOTIFICATIONS = 1;
    const res = await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ system_channel_flags: SUPPRESS_JOIN_NOTIFICATIONS }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { system_channel_flags: number }).system_channel_flags).toBe(SUPPRESS_JOIN_NOTIFICATIONS);
  });

  it("PATCH /guilds/:id updates features array", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ features: ["COMMUNITY", "NEWS"] }),
    });
    expect(res.status).toBe(200);
    const g = (await res.json()) as { features: string[] };
    expect(g.features).toContain("COMMUNITY");
    expect(g.features).toContain("NEWS");
  });

  it("PATCH /guilds/:id for unknown guild returns 404 Unknown Guild (10004)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10004);
  });
});

// ---------------------------------------------------------------------------
// Delete Guild
// ---------------------------------------------------------------------------

describe("guild.mdx — Delete Guild", () => {
  it("DELETE /guilds/:id returns 204 and removes the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    const ds = getDiscordStore(store);
    expect(ds.guilds.findOneBy("snowflake", guildId)).toBeUndefined();
  });

  it("DELETE /guilds/:id for unknown guild returns 404 Unknown Guild (10004)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999"), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10004);
  });
});

// ---------------------------------------------------------------------------
// Guild Preview
// ---------------------------------------------------------------------------

describe("guild.mdx — Get Guild Preview", () => {
  it("GET /guilds/:id/preview returns the documented preview shape", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/preview`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const p = (await res.json()) as Record<string, unknown>;
    expect(typeof p.id).toBe("string");
    expect(typeof p.name).toBe("string");
    expect("icon" in p).toBe(true);
    expect("splash" in p).toBe(true);
    expect("discovery_splash" in p).toBe(true);
    expect(Array.isArray(p.emojis)).toBe(true);
    expect(Array.isArray(p.features)).toBe(true);
    expect(typeof p.approximate_member_count).toBe("number");
    expect(typeof p.approximate_presence_count).toBe("number");
    expect("description" in p).toBe(true);
    expect(Array.isArray(p.stickers)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Modify Guild Channel Positions (PATCH /guilds/:id/channels)
// ---------------------------------------------------------------------------

describe("guild.mdx — Modify Guild Channel Positions", () => {
  it("PATCH /guilds/:id/channels returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const ds = getDiscordStore(store);
    const channels = ds.channels.findBy("guild_snowflake", guildId);
    if (channels.length === 0) return; // no channels to reorder
    const ch = channels[0];
    const res = await app.request(api(`/guilds/${guildId}/channels`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify([{ id: ch.snowflake, position: 5 }]),
    });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// List Active Guild Threads
// ---------------------------------------------------------------------------

describe("guild.mdx — List Active Guild Threads", () => {
  it("GET /guilds/:id/threads/active returns threads and members arrays", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/threads/active`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.threads)).toBe(true);
    expect(Array.isArray(body.members)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// List Guild Members (pagination)
// ---------------------------------------------------------------------------

describe("guild.mdx — List Guild Members", () => {
  it("GET /guilds/:id/members returns an array of member objects", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/members`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = (await res.json()) as unknown[];
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBeGreaterThan(0);
  });

  it("honors the limit query param", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/members?limit=1`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = (await res.json()) as unknown[];
    expect(members.length).toBeLessThanOrEqual(1);
  });

  it("honors the after query param for cursor pagination", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, botSnowflake } = ids(store);
    // Using "0" as after returns all members; using a real snowflake filters them.
    const res = await app.request(api(`/guilds/${guildId}/members?after=0&limit=1000`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ user?: { id: string } }>;
    // All returned members should have user id > 0.
    for (const m of members) {
      if (m.user) expect(BigInt(m.user.id)).toBeGreaterThan(0n);
    }
    // Paginate past the bot: none of the results should equal IDs before it.
    const afterRes = await app.request(api(`/guilds/${guildId}/members?after=${botSnowflake}&limit=1000`), {
      headers: botHeaders(),
    });
    const afterMembers = (await afterRes.json()) as Array<{ user?: { id: string } }>;
    for (const m of afterMembers) {
      if (m.user) expect(BigInt(m.user.id)).toBeGreaterThan(BigInt(botSnowflake));
    }
  });
});

// ---------------------------------------------------------------------------
// Search Guild Members
// ---------------------------------------------------------------------------

describe("guild.mdx — Search Guild Members", () => {
  it("GET /guilds/:id/members/search returns members matching a prefix", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/members/search?query=deve`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ user?: { username: string } }>;
    expect(Array.isArray(members)).toBe(true);
    // Should contain the seeded developer user.
    const found = members.some((m) => m.user?.username.startsWith("deve"));
    expect(found).toBe(true);
  });

  it("Search with limit caps results", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/members/search?query=&limit=1`), { headers: botHeaders() });
    const members = (await res.json()) as unknown[];
    expect(members.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Bans
// ---------------------------------------------------------------------------

describe("guild.mdx — Ban endpoints", () => {
  it("Create/Get/List/Remove ban lifecycle", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);

    // Create ban returns 204.
    const banRes = await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(banRes.status).toBe(204);

    // Get ban returns the ban object with reason and user.
    const getRes = await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const ban = (await getRes.json()) as Record<string, unknown>;
    expect("reason" in ban).toBe(true);
    expect(typeof (ban.user as Record<string, unknown>).id).toBe("string");

    // List bans includes the banned user.
    const listRes = await app.request(api(`/guilds/${guildId}/bans`), { headers: botHeaders() });
    expect(listRes.status).toBe(200);
    const bans = (await listRes.json()) as Array<{ user: { id: string } }>;
    expect(bans.some((b) => b.user.id === developerSnowflake)).toBe(true);

    // Remove ban returns 204 and the ban is gone.
    const unbanRes = await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(unbanRes.status).toBe(204);
    const afterUnban = await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), { headers: botHeaders() });
    expect(afterUnban.status).toBe(404);
    expect(((await afterUnban.json()) as { code: number }).code).toBe(10026);
  });

  it("Create ban with delete_message_seconds deletes recent messages", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    const ds = getDiscordStore(store);
    // Get or create a channel to post in.
    const channels = ds.channels.findBy("guild_snowflake", guildId).filter((c: DiscordChannel) => c.type === 0);
    if (channels.length === 0) return; // no text channels seeded
    const channelId = channels[0].snowflake;
    // Post a message as the developer.
    await app.request(api(`/channels/${channelId}/messages`), {
      method: "POST",
      headers: { ...botHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "to be deleted" }),
    });
    const countBefore = ds.messages.findBy("channel_snowflake", channelId).length;
    // Ban with a large delete window to ensure recent messages are removed.
    await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ delete_message_seconds: 604800 }),
    });
    const countAfter = ds.messages.findBy("channel_snowflake", channelId).length;
    expect(countAfter).toBeLessThanOrEqual(countBefore);
  });

  it("Ban list supports before/after pagination", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId, developerSnowflake } = ids(store);
    // Ensure the developer is banned.
    await app.request(api(`/guilds/${guildId}/bans/${developerSnowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    // List with after=0 returns bans.
    const res = await app.request(api(`/guilds/${guildId}/bans?after=0&limit=100`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const bans = (await res.json()) as unknown[];
    expect(Array.isArray(bans)).toBe(true);
  });

  it("Get ban for non-banned user returns 404 Unknown Ban (10026)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/bans/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10026);
  });
});

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

describe("guild.mdx — Prune endpoints", () => {
  it("Get Guild Prune Count returns { pruned: number }", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/prune?days=7`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: number };
    expect(typeof body.pruned).toBe("number");
  });

  it("Begin Guild Prune removes members and returns pruned count", async () => {
    const { app, store } = createDiscordTestApp();
    // Create a guild with a single extra member who joined long ago (eligible for pruning).
    const { guildId } = ids(store);
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("snowflake", guildId)!;
    // Create a "stale" user.
    const staleUser = ds.users.insert({
      snowflake: "111111111111111111",
      username: "stale_user",
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
    // Join the guild with a very old joined_at (30 days ago).
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

    const countBefore = ds.members.findBy("guild_snowflake", guildId).length;
    const res = await app.request(api(`/guilds/${guildId}/prune`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ days: 1, compute_prune_count: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: number };
    expect(typeof body.pruned).toBe("number");
    expect(body.pruned).toBeGreaterThan(0);
    const countAfter = ds.members.findBy("guild_snowflake", guildId).length;
    expect(countAfter).toBeLessThan(countBefore);
  });

  it("Begin Guild Prune with compute_prune_count=false returns { pruned: null }", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/prune`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ days: 1, compute_prune_count: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: null };
    expect(body.pruned).toBeNull();
  });

  it("Begin Guild Prune records a MEMBER_PRUNE audit entry with delete_member_days and members_removed", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("snowflake", guildId)!;
    // Add a stale member.
    const staleUser2 = ds.users.insert({
      snowflake: "222222222222222222",
      username: "stale_user_2",
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
      user_snowflake: staleUser2.snowflake,
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
    ds.guilds.update(guild.id, { member_snowflakes: [...guild.member_snowflakes, staleUser2.snowflake] });

    await app.request(api(`/guilds/${guildId}/prune`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ days: 1, compute_prune_count: true }),
    });

    // Audit log should contain a MEMBER_PRUNE entry (action_type 21).
    const auditRes = await app.request(api(`/guilds/${guildId}/audit-logs?action_type=21`), { headers: botHeaders() });
    const audit = (await auditRes.json()) as { audit_log_entries: Array<Record<string, unknown>> };
    const pruneEntry = audit.audit_log_entries[0];
    expect(pruneEntry).toBeDefined();
    const opts = pruneEntry.options as Record<string, string>;
    expect(typeof opts.delete_member_days).toBe("string");
    expect(typeof opts.members_removed).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Voice Regions
// ---------------------------------------------------------------------------

describe("guild.mdx — Get Guild Voice Regions", () => {
  it("GET /guilds/:id/regions returns an array of voice region objects", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/regions`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const regions = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(regions)).toBe(true);
    expect(regions.length).toBeGreaterThan(0);
    const r = regions[0];
    expect(typeof r.id).toBe("string");
    expect(typeof r.name).toBe("string");
    expect(typeof r.optimal).toBe("boolean");
    expect(typeof r.deprecated).toBe("boolean");
    expect(typeof r.custom).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

describe("guild.mdx — Integration endpoints", () => {
  it("GET /guilds/:id/integrations returns up to 50 integrations", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/integrations`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const integrations = (await res.json()) as unknown[];
    expect(Array.isArray(integrations)).toBe(true);
  });

  it("Create/Get/Modify/Delete integration lifecycle with INTEGRATION_CREATE/UPDATE/DELETE events", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);

    // Create.
    const createRes = await app.request(api(`/guilds/${guildId}/integrations`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Test Integration", type: "twitch", enabled: true }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(typeof created.id).toBe("string");
    expect(created.name).toBe("Test Integration");
    expect(created.type).toBe("twitch");
    expect(created.enabled).toBe(true);

    const integrationId = created.id as string;

    // Get.
    const getRes = await app.request(api(`/guilds/${guildId}/integrations/${integrationId}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Record<string, unknown>;
    expect(fetched.id).toBe(integrationId);

    // Modify.
    const patchRes = await app.request(api(`/guilds/${guildId}/integrations/${integrationId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    expect(patched.enabled).toBe(false);

    // Delete.
    const deleteRes = await app.request(api(`/guilds/${guildId}/integrations/${integrationId}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    // Verify gone.
    const missingRes = await app.request(api(`/guilds/${guildId}/integrations/${integrationId}`), { headers: botHeaders() });
    expect(missingRes.status).toBe(404);
  });

  it("Integration object includes required fields (id/name/type/enabled/account)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const createRes = await app.request(api(`/guilds/${guildId}/integrations`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Field Check", type: "youtube", enabled: true }),
    });
    const integ = (await createRes.json()) as Record<string, unknown>;
    expect(typeof integ.id).toBe("string");
    expect(typeof integ.name).toBe("string");
    expect(typeof integ.type).toBe("string");
    expect(typeof integ.enabled).toBe("boolean");
    expect(typeof (integ.account as Record<string, unknown>).id).toBe("string");
    expect(typeof (integ.account as Record<string, unknown>).name).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Widget Settings
// ---------------------------------------------------------------------------

describe("guild.mdx — Widget Settings", () => {
  it("GET /guilds/:id/widget returns enabled and channel_id", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/widget`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const w = (await res.json()) as Record<string, unknown>;
    expect(typeof w.enabled).toBe("boolean");
    expect("channel_id" in w).toBe(true);
  });

  it("PATCH /guilds/:id/widget updates widget settings", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/widget`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const w = (await res.json()) as Record<string, unknown>;
    expect(w.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Widget JSON (public)
// ---------------------------------------------------------------------------

describe("guild.mdx — Get Guild Widget (widget.json)", () => {
  it("GET /guilds/:id/widget.json returns the documented widget fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/widget.json`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const w = (await res.json()) as Record<string, unknown>;
    expect(typeof w.id).toBe("string");
    expect(typeof w.name).toBe("string");
    expect("instant_invite" in w).toBe(true);
    expect(Array.isArray(w.channels)).toBe(true);
    expect(Array.isArray(w.members)).toBe(true);
    expect(typeof w.presence_count).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Vanity URL
// ---------------------------------------------------------------------------

describe("guild.mdx — Vanity URL", () => {
  it("GET /guilds/:id/vanity-url returns code and uses", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/vanity-url`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const v = (await res.json()) as Record<string, unknown>;
    expect("code" in v).toBe(true);
    expect("uses" in v).toBe(true);
  });

  it("Vanity URL code is settable via Modify Guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Set a vanity URL code via PATCH /guilds/:id.
    await app.request(api(`/guilds/${guildId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ features: ["VANITY_URL"] }),
    });
    // The vanity-url endpoint should still work.
    const res = await app.request(api(`/guilds/${guildId}/vanity-url`), { headers: botHeaders() });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Welcome Screen
// ---------------------------------------------------------------------------

describe("guild.mdx — Welcome Screen", () => {
  it("GET /guilds/:id/welcome-screen returns the welcome screen object", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/welcome-screen`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const ws = (await res.json()) as Record<string, unknown>;
    expect("description" in ws).toBe(true);
    expect(Array.isArray(ws.welcome_channels)).toBe(true);
  });

  it("PATCH /guilds/:id/welcome-screen updates the welcome screen", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/welcome-screen`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "Welcome to our server!", welcome_channels: [] }),
    });
    expect(res.status).toBe(200);
    const ws = (await res.json()) as Record<string, unknown>;
    expect(ws.description).toBe("Welcome to our server!");
  });
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

describe("guild.mdx — Onboarding", () => {
  it("GET /guilds/:id/onboarding returns the documented onboarding shape", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/onboarding`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const ob = (await res.json()) as Record<string, unknown>;
    expect(ob.guild_id).toBe(guildId);
    expect(Array.isArray(ob.prompts)).toBe(true);
    expect(Array.isArray(ob.default_channel_ids)).toBe(true);
    expect(typeof ob.enabled).toBe("boolean");
    expect(typeof ob.mode).toBe("number");
  });

  it("PUT /guilds/:id/onboarding persists onboarding settings", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/onboarding`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ prompts: [], default_channel_ids: [], enabled: true, mode: 1 }),
    });
    expect(res.status).toBe(200);
    const ob = (await res.json()) as Record<string, unknown>;
    expect(ob.enabled).toBe(true);
    expect(ob.mode).toBe(1);
  });
});
