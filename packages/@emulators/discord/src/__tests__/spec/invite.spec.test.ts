/**
 * Spec suite for `developers/resources/invite.mdx` (plus the Create/Get/Delete Channel Invite
 * and Get Guild Invites endpoints from `channel.mdx` / `guild.mdx` that operate on the same
 * Invite object).
 *
 * Encodes the page's documented expectations directly: the Invite object shape (code, type,
 * channel, inviter, target_type, target_user, target_application, approximate_member_count,
 * approximate_presence_count, expires_at, guild_scheduled_event, flags), the Invite Types and
 * Invite Target Types enumerations, the invite-metadata fields, and every invite endpoint's
 * request/response contract, query params, range clamps, status codes, and error codes. Written
 * from the doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { createMessage } from "../../factories.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    ds,
    appId: app.snowflake,
    botSnowflake: app.bot_user_snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    textChannel: ds.channels.findOneBy("name", "general")!.snowflake, // type 0
    voiceChannel: ds.channels.findOneBy("name", "General")!.snowflake, // type 2
  };
}

/** Create an invite on a channel and return the parsed invite object. */
async function createInvite(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  channelId: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await app.request(api(`/channels/${channelId}/invites`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Invite object
// ---------------------------------------------------------------------------

describe("invite.mdx — Invite object", () => {
  it("Create Channel Invite returns an invite with code(string), type 0, channel, inviter, and metadata", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel, botSnowflake } = ids(store);
    const inv = await createInvite(app, textChannel);
    // code is the unique invite ID (string).
    expect(typeof inv.code).toBe("string");
    expect((inv.code as string).length).toBeGreaterThan(0);
    // type: GUILD = 0.
    expect(inv.type).toBe(0);
    // channel is a partial channel object (id/name/type).
    const channel = inv.channel as Record<string, unknown>;
    expect(channel.id).toBe(textChannel);
    expect(typeof channel.name).toBe("string");
    expect(channel.type).toBe(0);
    // inviter is the bot that created it.
    expect((inv.inviter as Record<string, unknown>).id).toBe(botSnowflake);
    // invite metadata fields.
    expect(inv.uses).toBe(0);
    expect("max_uses" in inv).toBe(true);
    expect("max_age" in inv).toBe(true);
    expect("temporary" in inv).toBe(true);
    expect(typeof inv.created_at).toBe("string");
  });

  it("the guild on the invite is a partial guild object with id/name/features", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel, guild } = ids(store);
    const inv = await createInvite(app, textChannel);
    const g = inv.guild as Record<string, unknown>;
    expect(g.id).toBe(guild);
    expect(typeof g.name).toBe("string");
    expect(Array.isArray(g.features)).toBe(true);
  });

  it("expires_at is an ISO8601 timestamp when max_age > 0 and null when max_age is 0 (never)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const expiring = await createInvite(app, textChannel, { max_age: 3600, unique: true });
    expect(typeof expiring.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(expiring.expires_at as string))).toBe(false);
    const never = await createInvite(app, textChannel, { max_age: 0, unique: true });
    expect(never.expires_at).toBeNull();
  });

  it("a non-target invite omits target_type/target_user/target_application", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const inv = await createInvite(app, textChannel);
    expect("target_type" in inv).toBe(false);
    expect("target_user" in inv).toBe(false);
    expect("target_application" in inv).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invite Types & Invite Target Types
// ---------------------------------------------------------------------------

describe("invite.mdx — Invite Types & Target Types", () => {
  it("guild invites carry Invite Type GUILD (0)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const inv = await createInvite(app, textChannel);
    expect(inv.type).toBe(0);
  });

  it("STREAM target (target_type 1) persists target_type and emits target_user", async () => {
    const { app, store } = createDiscordTestApp();
    const { voiceChannel, developer } = ids(store);
    const inv = await createInvite(app, voiceChannel, { target_type: 1, target_user_id: developer });
    // Invite Target Types: STREAM = 1.
    expect(inv.target_type).toBe(1);
    expect((inv.target_user as Record<string, unknown>).id).toBe(developer);
  });

  it("EMBEDDED_APPLICATION target (target_type 2) persists target_type and emits target_application", async () => {
    const { app, store } = createDiscordTestApp();
    const { voiceChannel, appId } = ids(store);
    const inv = await createInvite(app, voiceChannel, { target_type: 2, target_application_id: appId });
    // Invite Target Types: EMBEDDED_APPLICATION = 2.
    expect(inv.target_type).toBe(2);
    const targetApp = inv.target_application as Record<string, unknown>;
    expect(targetApp.id).toBe(appId);
    expect(typeof targetApp.name).toBe("string");
  });

  it("an invalid target_type is rejected with 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { voiceChannel } = ids(store);
    const res = await app.request(api(`/channels/${voiceChannel}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ target_type: 5 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });
});

// ---------------------------------------------------------------------------
// Create Channel Invite — params, defaults, range clamps, unique
// ---------------------------------------------------------------------------

describe("channel.mdx — Create Channel Invite params", () => {
  it("defaults: max_age 86400, max_uses 0, temporary false", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const inv = await createInvite(app, textChannel);
    expect(inv.max_age).toBe(86400);
    expect(inv.max_uses).toBe(0);
    expect(inv.temporary).toBe(false);
  });

  it("persists max_age / max_uses / temporary when provided", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const inv = await createInvite(app, textChannel, { max_age: 3600, max_uses: 5, temporary: true, unique: true });
    expect(inv.max_age).toBe(3600);
    expect(inv.max_uses).toBe(5);
    expect(inv.temporary).toBe(true);
  });

  it("accepts max_age boundary values 0 and 604800", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const low = await createInvite(app, textChannel, { max_age: 0, unique: true });
    expect(low.max_age).toBe(0);
    const high = await createInvite(app, textChannel, { max_age: 604800, unique: true });
    expect(high.max_age).toBe(604800);
  });

  it("rejects max_age > 604800 with 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ max_age: 604801 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: number; errors?: Record<string, unknown> };
    expect(body.code).toBe(50035);
    expect(body.errors).toBeDefined();
  });

  it("rejects a negative max_age with 400 (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ max_age: -1 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("accepts max_uses boundary values 0 and 100", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const low = await createInvite(app, textChannel, { max_uses: 0, unique: true });
    expect(low.max_uses).toBe(0);
    const high = await createInvite(app, textChannel, { max_uses: 100, unique: true });
    expect(high.max_uses).toBe(100);
  });

  it("rejects max_uses > 100 with 400 (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ max_uses: 101 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("without unique, reuses an equivalent invite; with unique, creates a fresh code", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const first = await createInvite(app, textChannel, { max_age: 1800, max_uses: 3 });
    const reused = await createInvite(app, textChannel, { max_age: 1800, max_uses: 3 });
    expect(reused.code).toBe(first.code);
    const fresh = await createInvite(app, textChannel, { max_age: 1800, max_uses: 3, unique: true });
    expect(fresh.code).not.toBe(first.code);
  });

  it("Create Channel Invite on an unknown channel returns 404 Unknown Channel (10003)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999/invites"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10003);
  });

  it("requires authorization (401 without a token)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/invites`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Get Invite — with_counts, guild_scheduled_event_id
// ---------------------------------------------------------------------------

describe("invite.mdx — Get Invite", () => {
  it("GET /invites/{code} returns the invite object for a valid code (no auth required)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const res = await app.request(api(`/invites/${created.code}`));
    expect(res.status).toBe(200);
    const inv = (await res.json()) as Record<string, unknown>;
    expect(inv.code).toBe(created.code);
    expect(inv.type).toBe(0);
  });

  it("without with_counts, approximate_member_count/approximate_presence_count are absent", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const inv = (await (await app.request(api(`/invites/${created.code}`))).json()) as Record<string, unknown>;
    expect("approximate_member_count" in inv).toBe(false);
    expect("approximate_presence_count" in inv).toBe(false);
  });

  it("with_counts=true adds approximate_member_count and approximate_presence_count", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const inv = (await (await app.request(api(`/invites/${created.code}?with_counts=true`))).json()) as Record<string, unknown>;
    expect(typeof inv.approximate_member_count).toBe("number");
    expect(typeof inv.approximate_presence_count).toBe("number");
  });

  it("guild_scheduled_event_id includes a guild_scheduled_event object when the id is valid", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, textChannel, voiceChannel, guild, developer } = ids(store);
    const event = ds.scheduledEvents.insert({
      snowflake: "9001",
      guild_snowflake: guild,
      channel_snowflake: voiceChannel,
      creator_snowflake: developer,
      name: "Launch Party",
      description: null,
      scheduled_start_time: "2099-01-01T00:00:00.000Z",
      scheduled_end_time: null,
      privacy_level: 2,
      status: 1,
      entity_type: 2,
      user_count: 0,
    });
    const created = await createInvite(app, textChannel);
    const inv = (await (
      await app.request(api(`/invites/${created.code}?guild_scheduled_event_id=${event.snowflake}`))
    ).json()) as Record<string, unknown>;
    const gse = inv.guild_scheduled_event as Record<string, unknown>;
    expect(gse).toBeDefined();
    expect(gse.id).toBe(event.snowflake);
    expect(gse.name).toBe("Launch Party");
  });

  it("guild_scheduled_event is absent when no guild_scheduled_event_id is supplied", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const inv = (await (await app.request(api(`/invites/${created.code}`))).json()) as Record<string, unknown>;
    expect("guild_scheduled_event" in inv).toBe(false);
  });

  it("an invalid guild_scheduled_event_id is ignored (no guild_scheduled_event key)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const inv = (await (
      await app.request(api(`/invites/${created.code}?guild_scheduled_event_id=404040404040404040`))
    ).json()) as Record<string, unknown>;
    expect("guild_scheduled_event" in inv).toBe(false);
  });

  it("Get Invite for an unknown code returns 404 Unknown Invite (10006)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/invites/does-not-exist"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10006);
  });
});

// ---------------------------------------------------------------------------
// Delete Invite
// ---------------------------------------------------------------------------

describe("invite.mdx — Delete Invite", () => {
  it("DELETE /invites/{code} returns the deleted invite object and removes it", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const res = await app.request(api(`/invites/${created.code}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(200);
    const deleted = (await res.json()) as Record<string, unknown>;
    expect(deleted.code).toBe(created.code);
    // The invite is gone afterwards.
    const after = await app.request(api(`/invites/${created.code}`));
    expect(after.status).toBe(404);
  });

  it("Delete Invite for an unknown code returns 404 Unknown Invite (10006)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/invites/nope"), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10006);
  });

  it("Delete Invite requires authorization (401)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const res = await app.request(api(`/invites/${created.code}`), { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Get Channel Invites & Get Guild Invites
// ---------------------------------------------------------------------------

describe("channel/guild — list invites", () => {
  it("Get Channel Invites returns the invites for that channel as an array", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const created = await createInvite(app, textChannel);
    const res = await app.request(api(`/channels/${textChannel}/invites`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((i) => i.code === created.code)).toBe(true);
  });

  it("Get Guild Invites returns every invite in the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel, voiceChannel, guild } = ids(store);
    const a = await createInvite(app, textChannel, { unique: true });
    const b = await createInvite(app, voiceChannel, { unique: true });
    const res = await app.request(api(`/guilds/${guild}/invites`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    const codes = list.map((i) => i.code);
    expect(codes).toContain(a.code);
    expect(codes).toContain(b.code);
  });

  it("Get Channel Invites requires authorization (401)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/invites`));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Invite target-users endpoints (Social SDK) — live in misc.ts
// ---------------------------------------------------------------------------

describe("invite.mdx — target-users endpoints", () => {
  it("GET /invites/{code}/target-users requires authorization (401) and returns a body when authorized", async () => {
    const { app } = createDiscordTestApp();
    const noAuth = await app.request(api("/invites/abc/target-users"));
    expect(noAuth.status).toBe(401);
    const ok = await app.request(api("/invites/abc/target-users"), { headers: botHeaders() });
    expect(ok.status).toBe(200);
  });

  it("PUT /invites/{code}/target-users echoes the provided user ids", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/invites/abc/target-users"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ target_user_ids: ["1", "2"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target_users: string[] };
    expect(body.target_users).toEqual(["1", "2"]);
  });

  it("GET /invites/{code}/target-users/job-status returns a status payload", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/invites/abc/target-users/job-status"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect("status" in ((await res.json()) as Record<string, unknown>)).toBe(true);
  });

  it("GET /invites/{code}/target-users/job-status: status is an integer enum 0-3 with all documented fields", async () => {
    // Doc (invite.mdx:227-246): status is an integer (0=NOT_STARTED,1=IN_PROGRESS,2=COMPLETED,3=ERROR).
    // The response must also carry total_users, processed_users, created_at, completed_at, error_message.
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/invites/abc/target-users/job-status"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.status).toBe("number");
    expect(body.status).toBeGreaterThanOrEqual(0);
    expect(body.status).toBeLessThanOrEqual(3);
    expect("total_users" in body).toBe(true);
    expect("processed_users" in body).toBe(true);
    expect("created_at" in body).toBe(true);
    expect("completed_at" in body).toBe(true);
    expect("error_message" in body).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ban + delete_message_seconds (extras.ts owns the ban endpoints)
// ---------------------------------------------------------------------------

describe("guild — Create Guild Ban with delete_message_seconds", () => {
  it("deletes the banned user's recent messages within the window", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: textChannel,
      guildSnowflake: guild,
      authorSnowflake: developer,
      content: "soon to be deleted",
    });
    const res = await app.request(api(`/guilds/${guild}/bans/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ delete_message_seconds: 604800 }),
    });
    expect(res.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", msg.snowflake)).toBeUndefined();
  });

  it("with delete_message_seconds 0 (default) keeps the user's messages", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: textChannel,
      guildSnowflake: guild,
      authorSnowflake: developer,
      content: "kept",
    });
    const res = await app.request(api(`/guilds/${guild}/bans/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", msg.snowflake)).not.toBeNull();
  });
});
