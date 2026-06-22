/**
 * Spec suite for `developers/topics/threads.mdx` (and the thread endpoints documented in
 * `developers/resources/channel.mdx`).
 *
 * Encodes the page's documented expectations directly: which parent channel types can spawn
 * threads (and which are rejected), the thread types produced per parent, the thread-member
 * lifecycle (join/leave/add/remove/get/list), the archived-thread list routes, forum/media
 * thread creation with a nested message, and the behavioral notes (events, 204s, auto-join).
 * Written from the doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { createChannel, createMessage } from "../../factories.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    ds,
    botSnowflake: app.bot_user_snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    general: ds.channels.findOneBy("name", "general")!,
    voice: ds.channels.findOneBy("name", "General")!,
    category: ds.channels.findOneBy("name", "Text Channels")!,
  };
}

// ---------------------------------------------------------------------------
// Start Thread from Message
// ---------------------------------------------------------------------------

describe("threads.mdx — Start Thread from Message", () => {
  it("on a GUILD_TEXT (0) parent creates a PUBLIC_THREAD (11) sharing the source message id, status 201", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, botSnowflake } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: general.snowflake,
      guildSnowflake: general.guild_snowflake,
      authorSnowflake: botSnowflake,
      content: "root",
    });
    const res = await app.request(api(`/channels/${general.snowflake}/messages/${msg.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "discuss" }),
    });
    expect(res.status).toBe(201);
    const thread = await json<{ id: string; type: number; parent_id: string }>(res);
    expect(thread.type).toBe(11);
    // The created thread shares the id of the source message.
    expect(thread.id).toBe(msg.snowflake);
    expect(thread.parent_id).toBe(general.snowflake);
  });

  it("on a GUILD_ANNOUNCEMENT (5) parent creates an ANNOUNCEMENT_THREAD (10)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, botSnowflake } = ids(store);
    const announcement = createChannel(ds, { name: "news", type: 5, guildSnowflake: guild });
    const msg = createMessage(ds, {
      channelSnowflake: announcement.snowflake,
      guildSnowflake: guild,
      authorSnowflake: botSnowflake,
      content: "root",
    });
    const res = await app.request(api(`/channels/${announcement.snowflake}/messages/${msg.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "discuss" }),
    });
    expect(res.status).toBe(201);
    expect((await json<{ type: number }>(res)).type).toBe(10);
  });

  it("attaches the current user's thread member object and auto-joins the creator", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, botSnowflake } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: general.snowflake,
      guildSnowflake: general.guild_snowflake,
      authorSnowflake: botSnowflake,
      content: "root",
    });
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/messages/${msg.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "discuss" }),
      })
    ).json()) as { id: string; member_count: number; member?: { user_id: string } };
    expect(thread.member_count).toBe(1);
    expect(thread.member).toBeDefined();
    expect(thread.member!.user_id).toBe(botSnowflake);
  });

  it("does NOT work on a GUILD_FORUM (15) parent — rejected with 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, botSnowflake } = ids(store);
    const forum = createChannel(ds, { name: "forum", type: 15, guildSnowflake: guild });
    const msg = createMessage(ds, {
      channelSnowflake: forum.snowflake,
      guildSnowflake: guild,
      authorSnowflake: botSnowflake,
      content: "root",
    });
    const res = await app.request(api(`/channels/${forum.snowflake}/messages/${msg.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("a second thread from the same message is rejected (a message can only have a single thread)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, botSnowflake } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: general.snowflake,
      guildSnowflake: general.guild_snowflake,
      authorSnowflake: botSnowflake,
      content: "root",
    });
    await app.request(api(`/channels/${general.snowflake}/messages/${msg.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "first" }),
    });
    const second = await app.request(api(`/channels/${general.snowflake}/messages/${msg.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "second" }),
    });
    expect(second.status).toBe(400);
  });

  it("an unknown source message returns 404 Unknown Message (10008)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/messages/999999999999999999/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });
});

// ---------------------------------------------------------------------------
// Start Thread without Message
// ---------------------------------------------------------------------------

describe("threads.mdx — Start Thread without Message", () => {
  it("defaults the thread type to PRIVATE_THREAD (12) when type is omitted", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "private-thread" }),
    });
    expect(res.status).toBe(201);
    expect((await json<{ type: number }>(res)).type).toBe(12);
  });

  it("creates a PUBLIC_THREAD (11) when type 11 is requested on a text channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "public-thread", type: 11 }),
    });
    expect((await json<{ type: number }>(res)).type).toBe(11);
  });

  it("reads invitable into private-thread metadata", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "p", type: 12, invitable: false }),
    });
    const thread = await json<{ thread_metadata: { invitable?: boolean } }>(res);
    expect(thread.thread_metadata.invitable).toBe(false);
  });

  it("rejects a GUILD_VOICE (2) parent with 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    const res = await app.request(api(`/channels/${voice.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a GUILD_CATEGORY (4) parent with 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { category } = ids(store);
    const res = await app.request(api(`/channels/${category.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a DM (1) parent with 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const dm = createChannel(ds, { name: null as unknown as string, type: 1, guildSnowflake: null });
    const res = await app.request(api(`/channels/${dm.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("an unknown parent channel returns 404 Unknown Channel (10003)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999/threads"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10003);
  });
});

// ---------------------------------------------------------------------------
// Start Thread in Forum or Media Channel
// ---------------------------------------------------------------------------

describe("threads.mdx — Start Thread in Forum or Media Channel", () => {
  it("on a GUILD_FORUM (15) parent creates a PUBLIC_THREAD (11) with a nested message object", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ids(store);
    const forum = createChannel(ds, { name: "forum", type: 15, guildSnowflake: guild });
    const res = await app.request(api(`/channels/${forum.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "post", message: { content: "first post" } }),
    });
    expect(res.status).toBe(201);
    const thread = await json<{ id: string; type: number; message: { content: string; channel_id: string } }>(res);
    expect(thread.type).toBe(11);
    expect(thread.message).toBeDefined();
    expect(thread.message.content).toBe("first post");
    // The created message has the same id as the thread (shares the channel id).
    expect(thread.message.channel_id).toBe(thread.id);
  });

  it("on a GUILD_MEDIA (16) parent creates a thread with a nested message object", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ids(store);
    const media = createChannel(ds, { name: "media", type: 16, guildSnowflake: guild });
    const res = await app.request(api(`/channels/${media.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "post", message: { content: "hi" } }),
    });
    expect(res.status).toBe(201);
    const thread = await json<{ type: number; message: { content: string }; message_count: number }>(res);
    expect(thread.type).toBe(11);
    expect(thread.message.content).toBe("hi");
    expect(thread.message_count).toBe(1);
  });

  it("reads applied_tags onto the created forum thread", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ids(store);
    const forum = createChannel(ds, { name: "forum", type: 15, guildSnowflake: guild });
    const res = await app.request(api(`/channels/${forum.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "post", message: { content: "x" }, applied_tags: ["123", "456"] }),
    });
    const thread = await json<{ applied_tags: string[] }>(res);
    expect(thread.applied_tags).toEqual(["123", "456"]);
  });

  it("rejects a forum thread without a message providing any content with 400 (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ids(store);
    const forum = createChannel(ds, { name: "forum", type: 15, guildSnowflake: guild });
    const res = await app.request(api(`/channels/${forum.snowflake}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "post" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

// ---------------------------------------------------------------------------
// Thread Members — join/leave/add/remove/get/list
// ---------------------------------------------------------------------------

describe("threads.mdx — Thread Members", () => {
  async function newThread(app: ReturnType<typeof createDiscordTestApp>["app"], parent: string) {
    return (await (
      await app.request(api(`/channels/${parent}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 11 }),
      })
    ).json()) as { id: string };
  }

  it("Join Thread (@me) returns 204 and adds the current user", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, botSnowflake } = ids(store);
    const thread = await newThread(app, general.snowflake);
    // creator already joined; leave then re-join to exercise the route.
    await app.request(api(`/channels/${thread.id}/thread-members/@me`), { method: "DELETE", headers: botHeaders() });
    const res = await app.request(api(`/channels/${thread.id}/thread-members/@me`), { method: "PUT", headers: botHeaders() });
    expect(res.status).toBe(204);
    const members = getDiscordStore(store).threadMembers.findBy("thread_snowflake", thread.id);
    expect(members.some((m) => m.user_snowflake === botSnowflake)).toBe(true);
  });

  it("Add Thread Member returns 204 (and is idempotent when already a member)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const thread = await newThread(app, general.snowflake);
    const first = await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "PUT", headers: botHeaders() });
    expect(first.status).toBe(204);
    const second = await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "PUT", headers: botHeaders() });
    expect(second.status).toBe(204);
  });

  it("Get Thread Member returns the member, and 404 if not a member", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const thread = await newThread(app, general.snowflake);
    const missing = await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { headers: botHeaders() });
    expect(missing.status).toBe(404);
    await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "PUT", headers: botHeaders() });
    const res = await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const member = await json<{ id: string; user_id: string; join_timestamp: string; flags: number }>(res);
    expect(member.user_id).toBe(developer);
    expect(member.id).toBe(thread.id);
    expect(typeof member.join_timestamp).toBe("string");
    expect(member.flags).toBe(0);
  });

  it("Get Thread Member with_member=true nests a guild member object", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const thread = await newThread(app, general.snowflake);
    await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "PUT", headers: botHeaders() });
    const res = await app.request(api(`/channels/${thread.id}/thread-members/${developer}?with_member=true`), { headers: botHeaders() });
    const member = await json<{ member?: { roles: string[] } }>(res);
    expect(member.member).toBeDefined();
    expect(Array.isArray(member.member!.roles)).toBe(true);
  });

  it("List Thread Members returns the array of members", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer, botSnowflake } = ids(store);
    const thread = await newThread(app, general.snowflake);
    await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "PUT", headers: botHeaders() });
    const res = await app.request(api(`/channels/${thread.id}/thread-members`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = await json<Array<{ user_id: string }>>(res);
    expect(members.some((m) => m.user_id === developer)).toBe(true);
    expect(members.some((m) => m.user_id === botSnowflake)).toBe(true);
  });

  it("List Thread Members with_member=true nests a guild member object on each entry", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = await newThread(app, general.snowflake);
    const res = await app.request(api(`/channels/${thread.id}/thread-members?with_member=true`), { headers: botHeaders() });
    const members = await json<Array<{ member?: unknown }>>(res);
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.member !== undefined)).toBe(true);
  });

  it("Leave Thread (@me) returns 204 and removes the current user", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, botSnowflake } = ids(store);
    const thread = await newThread(app, general.snowflake);
    const res = await app.request(api(`/channels/${thread.id}/thread-members/@me`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).threadMembers.findBy("thread_snowflake", thread.id).some((m) => m.user_snowflake === botSnowflake)).toBe(false);
  });

  it("Remove Thread Member returns 204 and removes the user", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const thread = await newThread(app, general.snowflake);
    await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "PUT", headers: botHeaders() });
    const res = await app.request(api(`/channels/${thread.id}/thread-members/${developer}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).threadMembers.findBy("thread_snowflake", thread.id).some((m) => m.user_snowflake === developer)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Archived thread enumeration
// ---------------------------------------------------------------------------

describe("threads.mdx — Archived thread enumeration", () => {
  async function newThread(app: ReturnType<typeof createDiscordTestApp>["app"], parent: string, type: number) {
    return (await (
      await app.request(api(`/channels/${parent}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type }),
      })
    ).json()) as { id: string };
  }

  it("List Public Archived Threads returns {threads, members, has_more} with only archived public threads", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const pub = await newThread(app, general.snowflake, 11);
    // archive it
    await app.request(api(`/channels/${pub.id}`), { method: "PATCH", headers: botHeaders(), body: JSON.stringify({ archived: true }) });
    const res = await app.request(api(`/channels/${general.snowflake}/threads/archived/public`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ threads: Array<{ id: string; type: number }>; members: unknown[]; has_more: boolean }>(res);
    expect(Array.isArray(body.threads)).toBe(true);
    expect(Array.isArray(body.members)).toBe(true);
    expect(typeof body.has_more).toBe("boolean");
    expect(body.threads.some((t) => t.id === pub.id && t.type === 11)).toBe(true);
  });

  it("List Public Archived Threads excludes active (non-archived) threads", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const active = await newThread(app, general.snowflake, 11);
    const res = await app.request(api(`/channels/${general.snowflake}/threads/archived/public`), { headers: botHeaders() });
    const body = await json<{ threads: Array<{ id: string }> }>(res);
    expect(body.threads.some((t) => t.id === active.id)).toBe(false);
  });

  it("List Private Archived Threads returns archived PRIVATE_THREAD (12) threads", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const priv = await newThread(app, general.snowflake, 12);
    await app.request(api(`/channels/${priv.id}`), { method: "PATCH", headers: botHeaders(), body: JSON.stringify({ archived: true }) });
    const res = await app.request(api(`/channels/${general.snowflake}/threads/archived/private`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ threads: Array<{ id: string; type: number }> }>(res);
    expect(body.threads.some((t) => t.id === priv.id && t.type === 12)).toBe(true);
  });

  it("List Joined Private Archived Threads only returns private archived threads the user has joined", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const joined = await newThread(app, general.snowflake, 12); // creator auto-joined
    await app.request(api(`/channels/${joined.id}`), { method: "PATCH", headers: botHeaders(), body: JSON.stringify({ archived: true }) });
    const res = await app.request(api(`/channels/${general.snowflake}/users/@me/threads/archived/private`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ threads: Array<{ id: string }> }>(res);
    expect(body.threads.some((t) => t.id === joined.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// List Active Guild Threads
// ---------------------------------------------------------------------------

describe("threads.mdx — List Active Guild Threads", () => {
  it("returns active threads in the guild and excludes archived ones", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, guild } = ids(store);
    const active = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "active", type: 11 }),
      })
    ).json()) as { id: string };
    const archived = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "archived", type: 11 }),
      })
    ).json()) as { id: string };
    await app.request(api(`/channels/${archived.id}`), { method: "PATCH", headers: botHeaders(), body: JSON.stringify({ archived: true }) });

    const res = await app.request(api(`/guilds/${guild}/threads/active`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ threads: Array<{ id: string }>; has_more: boolean }>(res);
    expect(body.threads.some((t) => t.id === active.id)).toBe(true);
    expect(body.threads.some((t) => t.id === archived.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thread archive_timestamp refresh (TH1)
// ---------------------------------------------------------------------------

describe("threads.mdx — archive_timestamp refreshes on archive/unarchive", () => {
  it("archive_timestamp is updated when a thread is archived", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "ts-test", type: 11 }),
      })
    ).json()) as { id: string; thread_metadata: { archive_timestamp: string } };
    const originalTs = thread.thread_metadata.archive_timestamp;

    // Small delay to ensure a different timestamp.
    await new Promise((r) => setTimeout(r, 10));

    const patched = (await (
      await app.request(api(`/channels/${thread.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ archived: true }),
      })
    ).json()) as { thread_metadata: { archive_timestamp: string; archived: boolean } };

    expect(patched.thread_metadata.archived).toBe(true);
    expect(patched.thread_metadata.archive_timestamp).not.toBe(originalTs);
  });

  it("archive_timestamp is updated when a thread is unarchived", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "ts-unarchive", type: 11 }),
      })
    ).json()) as { id: string };

    // Archive first.
    await app.request(api(`/channels/${thread.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ archived: true }),
    });

    const archived = (await (await app.request(api(`/channels/${thread.id}`), { headers: botHeaders() })).json()) as {
      thread_metadata: { archive_timestamp: string };
    };
    const archivedTs = archived.thread_metadata.archive_timestamp;

    await new Promise((r) => setTimeout(r, 10));

    const unarchived = (await (
      await app.request(api(`/channels/${thread.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ archived: false }),
      })
    ).json()) as { thread_metadata: { archive_timestamp: string; archived: boolean } };

    expect(unarchived.thread_metadata.archived).toBe(false);
    expect(unarchived.thread_metadata.archive_timestamp).not.toBe(archivedTs);
  });

  it("archive_timestamp updates when auto_archive_duration changes", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "ts-dur", type: 11, auto_archive_duration: 60 }),
      })
    ).json()) as { id: string; thread_metadata: { archive_timestamp: string } };
    const originalTs = thread.thread_metadata.archive_timestamp;

    await new Promise((r) => setTimeout(r, 10));

    const patched = (await (
      await app.request(api(`/channels/${thread.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ auto_archive_duration: 1440 }),
      })
    ).json()) as { thread_metadata: { archive_timestamp: string } };

    expect(patched.thread_metadata.archive_timestamp).not.toBe(originalTs);
  });
});

// ---------------------------------------------------------------------------
// Thread modify: applied_tags <= 5
// ---------------------------------------------------------------------------

describe("threads.mdx — Thread modify applied_tags limit", () => {
  it("rejects applied_tags with more than 5 entries on thread modify", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 11 }),
      })
    ).json()) as { id: string };
    const res = await app.request(api(`/channels/${thread.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ applied_tags: ["1", "2", "3", "4", "5", "6"] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts applied_tags with exactly 5 entries", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 11 }),
      })
    ).json()) as { id: string };
    const res = await app.request(api(`/channels/${thread.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ applied_tags: ["1", "2", "3", "4", "5"] }),
    });
    expect(res.status).toBe(200);
  });
});
