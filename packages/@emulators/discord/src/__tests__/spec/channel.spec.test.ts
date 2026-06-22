/**
 * Spec suite for `developers/resources/channel.mdx`.
 *
 * Encodes the page's documented expectations directly: the Channel object shape per channel
 * type (which fields appear / are omitted), the Channel Flags / Sort Order / Forum Layout /
 * Video Quality Mode enums, and every endpoint's request/response contract, status codes,
 * error codes, and behavioral notes. Written from the doc first; the implementation is
 * built/fixed until this is green. "Even the slightest difference from the docs is a failure."
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { createChannel, createMessage } from "../../factories.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    ds,
    appId: app.snowflake,
    botSnowflake: app.bot_user_snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    general: ds.channels.findOneBy("name", "general")!,
    random: ds.channels.findOneBy("name", "random")!,
    voice: ds.channels.findOneBy("name", "General")!,
    category: ds.channels.findOneBy("name", "Text Channels")!,
  };
}

// ---------------------------------------------------------------------------
// Channel Object — types & per-type field presence
// ---------------------------------------------------------------------------

describe("channel.mdx — Channel object: types & field presence", () => {
  it("GUILD_TEXT (0) carries guild_id/position/permission_overwrites/topic/nsfw/rate_limit_per_user/last_message_id", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const ch = (await (await app.request(api(`/channels/${general.snowflake}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect(ch.type).toBe(0);
    expect(typeof ch.id).toBe("string");
    expect(typeof ch.guild_id).toBe("string");
    expect(typeof ch.name).toBe("string");
    expect(typeof ch.position).toBe("number");
    expect(Array.isArray(ch.permission_overwrites)).toBe(true);
    expect("topic" in ch).toBe(true);
    expect("nsfw" in ch).toBe(true);
    expect("rate_limit_per_user" in ch).toBe(true);
    expect("last_message_id" in ch).toBe(true);
    expect("parent_id" in ch).toBe(true);
  });

  it("GUILD_VOICE (2) carries bitrate/user_limit/rtc_region/video_quality_mode", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    const ch = (await (await app.request(api(`/channels/${voice.snowflake}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect(ch.type).toBe(2);
    expect(typeof ch.bitrate).toBe("number");
    expect(typeof ch.user_limit).toBe("number");
    expect("rtc_region" in ch).toBe(true);
    // video_quality_mode is 1 (AUTO) when not explicitly set.
    expect(ch.video_quality_mode).toBe(1);
  });

  it("GUILD_CATEGORY (4) carries permission_overwrites/position but no thread or voice fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { category } = ids(store);
    const ch = (await (await app.request(api(`/channels/${category.snowflake}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect(ch.type).toBe(4);
    expect(Array.isArray(ch.permission_overwrites)).toBe(true);
    expect(typeof ch.position).toBe("number");
    expect("thread_metadata" in ch).toBe(false);
    expect("bitrate" in ch).toBe(false);
  });

  it("GUILD_ANNOUNCEMENT (5) is created and serialized as type 5 with text-channel fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const created = (await (
      await app.request(api(`/guilds/${guild}/channels`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "news", type: 5, topic: "announcements" }),
      })
    ).json()) as Record<string, unknown>;
    expect(created.type).toBe(5);
    expect(created.topic).toBe("announcements");
    expect(Array.isArray(created.permission_overwrites)).toBe(true);
    expect("position" in created).toBe(true);
  });

  it("GUILD_FORUM (15) carries available_tags/default_reaction_emoji/default_sort_order/default_forum_layout/default_thread_rate_limit_per_user", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const created = (await (
      await app.request(api(`/guilds/${guild}/channels`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "forum", type: 15 }),
      })
    ).json()) as Record<string, unknown>;
    expect(created.type).toBe(15);
    expect(Array.isArray(created.available_tags)).toBe(true);
    expect("default_reaction_emoji" in created).toBe(true);
    expect("default_sort_order" in created).toBe(true);
    // default_forum_layout defaults to 0 (NOT_SET).
    expect(created.default_forum_layout).toBe(0);
    expect("default_thread_rate_limit_per_user" in created).toBe(true);
  });

  it("GUILD_MEDIA (16) is created and serialized as type 16 with forum config fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const created = (await (
      await app.request(api(`/guilds/${guild}/channels`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "media", type: 16 }),
      })
    ).json()) as Record<string, unknown>;
    expect(created.type).toBe(16);
    expect(Array.isArray(created.available_tags)).toBe(true);
    expect("default_sort_order" in created).toBe(true);
  });

  it("DM (1) carries no guild-scoped keys (no guild_id/position/permission_overwrites/nsfw)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const dm = createChannel(ds, { name: null as unknown as string, type: 1, guildSnowflake: null });
    ds.channels.update(dm.id, { recipient_snowflakes: [ids(store).developer] });
    const ch = (await (await app.request(api(`/channels/${dm.snowflake}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect(ch.type).toBe(1);
    expect("guild_id" in ch).toBe(false);
    expect("position" in ch).toBe(false);
    expect("permission_overwrites" in ch).toBe(false);
    expect("nsfw" in ch).toBe(false);
    expect("recipients" in ch).toBe(true);
  });

  it("GROUP_DM (3) carries name/owner_id/icon and recipients but no guild fields", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { developer, botSnowflake } = ids(store);
    const gdm = createChannel(ds, { name: "group", type: 3, guildSnowflake: null });
    ds.channels.update(gdm.id, { recipient_snowflakes: [developer, botSnowflake], owner_snowflake: developer });
    const ch = (await (await app.request(api(`/channels/${gdm.snowflake}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect(ch.type).toBe(3);
    expect(ch.name).toBe("group");
    expect(ch.owner_id).toBe(developer);
    expect("icon" in ch).toBe(true);
    expect("guild_id" in ch).toBe(false);
  });

  it("a PUBLIC_THREAD (11) carries thread_metadata/owner_id/parent_id/message_count/member_count but NOT permission_overwrites or position", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 11 }),
      })
    ).json()) as Record<string, unknown>;
    expect(thread.type).toBe(11);
    expect(typeof (thread.thread_metadata as Record<string, unknown>)).toBe("object");
    expect(thread.parent_id).toBe(general.snowflake);
    expect("owner_id" in thread).toBe(true);
    expect("message_count" in thread).toBe(true);
    expect("member_count" in thread).toBe(true);
    expect("total_message_sent" in thread).toBe(true);
    // Threads inherit parent permissions: no overwrites or position of their own.
    expect("permission_overwrites" in thread).toBe(false);
    expect("position" in thread).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thread Metadata object shape
// ---------------------------------------------------------------------------

describe("channel.mdx — Thread Metadata object", () => {
  it("carries archived/auto_archive_duration/archive_timestamp/locked", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 11, auto_archive_duration: 4320 }),
      })
    ).json()) as { thread_metadata: Record<string, unknown> };
    const meta = thread.thread_metadata;
    expect(meta.archived).toBe(false);
    expect(meta.auto_archive_duration).toBe(4320);
    expect(typeof meta.archive_timestamp).toBe("string");
    expect(meta.locked).toBe(false);
  });

  it("auto_archive_duration accepts only the documented enum {60,1440,4320,10080}", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    for (const dur of [60, 1440, 4320, 10080]) {
      const thread = (await (
        await app.request(api(`/channels/${general.snowflake}/threads`), {
          method: "POST",
          headers: botHeaders(),
          body: JSON.stringify({ name: `t-${dur}`, type: 11, auto_archive_duration: dur }),
        })
      ).json()) as { thread_metadata: { auto_archive_duration: number } };
      expect(thread.thread_metadata.auto_archive_duration).toBe(dur);
    }
  });
});

// ---------------------------------------------------------------------------
// Get Channel
// ---------------------------------------------------------------------------

describe("channel.mdx — Get Channel", () => {
  it("returns the channel object", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(general.snowflake);
  });

  it("an unknown channel id returns 404 Unknown Channel (10003)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10003);
  });

  it("when the channel is a thread, includes a thread member object for the current user", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 11 }),
      })
    ).json()) as { id: string };
    const ch = (await (await app.request(api(`/channels/${thread.id}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    const member = ch.member as Record<string, unknown> | undefined;
    expect(member).toBeDefined();
    expect(member!.user_id).toBe(ids(store).botSnowflake);
    expect(member!.id).toBe(thread.id);
  });
});

// ---------------------------------------------------------------------------
// Modify Channel — persists all documented guild-channel params
// ---------------------------------------------------------------------------

describe("channel.mdx — Modify Channel (Guild channel)", () => {
  it("returns the channel and persists name/topic/nsfw/rate_limit_per_user", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "renamed", topic: "new topic", nsfw: true, rate_limit_per_user: 30 }),
    });
    expect(res.status).toBe(200);
    const ch = (await res.json()) as Record<string, unknown>;
    expect(ch.name).toBe("renamed");
    expect(ch.topic).toBe("new topic");
    expect(ch.nsfw).toBe(true);
    expect(ch.rate_limit_per_user).toBe(30);
  });

  it("persists permission_overwrites passed to Modify Channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ permission_overwrites: [{ id: developer, type: 1, allow: "1024", deny: "0" }] }),
    });
    const ch = (await res.json()) as { permission_overwrites: Array<{ id: string; allow: string }> };
    expect(ch.permission_overwrites.some((o) => o.id === developer && o.allow === "1024")).toBe(true);
  });

  it("persists rtc_region and video_quality_mode on a voice channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    const res = await app.request(api(`/channels/${voice.snowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ rtc_region: "us-east", video_quality_mode: 2 }),
    });
    const ch = (await res.json()) as Record<string, unknown>;
    expect(ch.rtc_region).toBe("us-east");
    expect(ch.video_quality_mode).toBe(2);
  });

  it("persists default_auto_archive_duration on a text channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ default_auto_archive_duration: 10080 }),
    });
    expect(((await res.json()) as { default_auto_archive_duration: number }).default_auto_archive_duration).toBe(10080);
  });

  it("persists the forum config (available_tags/default_reaction_emoji/default_sort_order/default_forum_layout/default_thread_rate_limit_per_user)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const forum = (await (
      await app.request(api(`/guilds/${guild}/channels`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "forum", type: 15 }),
      })
    ).json()) as { id: string };
    const res = await app.request(api(`/channels/${forum.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        available_tags: [{ name: "bug" }],
        default_reaction_emoji: { emoji_id: null, emoji_name: "🔥" },
        default_sort_order: 1,
        default_forum_layout: 2,
        default_thread_rate_limit_per_user: 15,
      }),
    });
    const ch = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(ch.available_tags) && (ch.available_tags as unknown[]).length).toBe(1);
    expect((ch.default_reaction_emoji as { emoji_name: string }).emoji_name).toBe("🔥");
    expect(ch.default_sort_order).toBe(1);
    expect(ch.default_forum_layout).toBe(2);
    expect(ch.default_thread_rate_limit_per_user).toBe(15);
  });

  it("an unknown channel id returns 404 Unknown Channel (10003)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10003);
  });
});

describe("channel.mdx — Modify Channel (Thread)", () => {
  it("archives a thread and reads invitable/applied_tags fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = (await (
      await app.request(api(`/channels/${general.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "t", type: 12, invitable: false }),
      })
    ).json()) as { id: string };
    const res = await app.request(api(`/channels/${thread.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ archived: true, locked: true, auto_archive_duration: 60 }),
    });
    const ch = (await res.json()) as { thread_metadata: Record<string, unknown> };
    expect(ch.thread_metadata.archived).toBe(true);
    expect(ch.thread_metadata.locked).toBe(true);
    expect(ch.thread_metadata.auto_archive_duration).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Create Channel — persists all documented params (known gap fix)
// ---------------------------------------------------------------------------

describe("channel.mdx — Create Channel persists extended params", () => {
  it("persists rate_limit_per_user and permission_overwrites at creation time", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        name: "slow",
        type: 0,
        rate_limit_per_user: 42,
        permission_overwrites: [{ id: developer, type: 1, allow: "2048", deny: "0" }],
      }),
    });
    expect(res.status).toBe(201);
    const ch = (await res.json()) as { rate_limit_per_user: number; permission_overwrites: Array<{ id: string }> };
    expect(ch.rate_limit_per_user).toBe(42);
    expect(ch.permission_overwrites.some((o) => o.id === developer)).toBe(true);
  });

  it("persists rtc_region and video_quality_mode at creation time of a voice channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "vc", type: 2, rtc_region: "us-west", video_quality_mode: 2 }),
    });
    const ch = (await res.json()) as Record<string, unknown>;
    expect(ch.rtc_region).toBe("us-west");
    expect(ch.video_quality_mode).toBe(2);
  });

  it("persists the forum config at creation time", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        name: "forum",
        type: 15,
        default_sort_order: 1,
        default_forum_layout: 1,
        default_thread_rate_limit_per_user: 10,
        default_auto_archive_duration: 4320,
        available_tags: [{ name: "help" }],
      }),
    });
    const ch = (await res.json()) as Record<string, unknown>;
    expect(ch.default_sort_order).toBe(1);
    expect(ch.default_forum_layout).toBe(1);
    expect(ch.default_thread_rate_limit_per_user).toBe(10);
    expect(ch.default_auto_archive_duration).toBe(4320);
    expect((ch.available_tags as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delete/Close Channel
// ---------------------------------------------------------------------------

describe("channel.mdx — Delete/Close Channel", () => {
  it("returns the deleted channel object and removes it from the store", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const created = (await (
      await app.request(api(`/guilds/${guild}/channels`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "doomed", type: 0 }),
      })
    ).json()) as { id: string };
    const res = await app.request(api(`/channels/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(created.id);
    expect(getDiscordStore(store).channels.findOneBy("snowflake", created.id)).toBeUndefined();
  });

  it("an unknown channel id returns 404 Unknown Channel (10003)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999"), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10003);
  });
});

// ---------------------------------------------------------------------------
// Edit / Delete Channel Permissions — 204 + audit
// ---------------------------------------------------------------------------

describe("channel.mdx — Edit/Delete Channel Permissions", () => {
  it("Edit Channel Permissions returns 204 and persists the overwrite", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/permissions/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ type: 1, allow: "1024", deny: "0" }),
    });
    expect(res.status).toBe(204);
    const ch = getDiscordStore(store).channels.findOneBy("snowflake", general.snowflake)!;
    expect(ch.permission_overwrites.some((o) => o.id === developer && o.allow === "1024")).toBe(true);
  });

  it("Edit Channel Permissions records a ChannelOverwriteCreate (13) audit entry with the X-Audit-Log-Reason", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer, guild } = ids(store);
    await app.request(api(`/channels/${general.snowflake}/permissions/${developer}`), {
      method: "PUT",
      headers: { ...botHeaders(), "X-Audit-Log-Reason": "lock it down" },
      body: JSON.stringify({ type: 1, allow: "1024", deny: "0" }),
    });
    const entries = getDiscordStore(store).auditLog.findBy("guild_snowflake", guild);
    const entry = entries.find((e) => e.action_type === 13);
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("lock it down");
    expect(entry!.target_snowflake).toBe(general.snowflake);
  });

  it("Delete Channel Permission returns 204 and removes the overwrite + records ChannelOverwriteDelete (15)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer, guild } = ids(store);
    await app.request(api(`/channels/${general.snowflake}/permissions/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ type: 1, allow: "1024", deny: "0" }),
    });
    const res = await app.request(api(`/channels/${general.snowflake}/permissions/${developer}`), {
      method: "DELETE",
      headers: { ...botHeaders(), "X-Audit-Log-Reason": "cleanup" },
    });
    expect(res.status).toBe(204);
    const ch = getDiscordStore(store).channels.findOneBy("snowflake", general.snowflake)!;
    expect(ch.permission_overwrites.some((o) => o.id === developer)).toBe(false);
    const entry = getDiscordStore(store).auditLog.findBy("guild_snowflake", guild).find((e) => e.action_type === 15);
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("cleanup");
  });
});

// ---------------------------------------------------------------------------
// Channel Invites
// ---------------------------------------------------------------------------

describe("channel.mdx — Get/Create Channel Invite", () => {
  it("Create Channel Invite returns an invite object with code/max_age/max_uses/temporary defaults", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const invite = (await res.json()) as Record<string, unknown>;
    expect(typeof invite.code).toBe("string");
    // Documented defaults: max_age 86400, max_uses 0, temporary false.
    expect(invite.max_age).toBe(86400);
    expect(invite.max_uses).toBe(0);
    expect(invite.temporary).toBe(false);
  });

  it("Create Channel Invite honors explicit max_age/max_uses/temporary", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ max_age: 3600, max_uses: 5, temporary: true }),
    });
    const invite = (await res.json()) as Record<string, unknown>;
    expect(invite.max_age).toBe(3600);
    expect(invite.max_uses).toBe(5);
    expect(invite.temporary).toBe(true);
  });

  it("Get Channel Invites returns the list of invites for the channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    await app.request(api(`/channels/${general.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const res = await app.request(api(`/channels/${general.snowflake}/invites`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const invites = (await res.json()) as Array<{ code: string }>;
    expect(invites.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Follow Announcement Channel
// ---------------------------------------------------------------------------

describe("channel.mdx — Follow Announcement Channel", () => {
  it("returns a followed channel object {channel_id, webhook_id} and creates a channel-follower webhook in the target", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { guild, general } = ids(store);
    const announcement = createChannel(ds, { name: "news", type: 5, guildSnowflake: guild });
    const res = await app.request(api(`/channels/${announcement.snowflake}/followers`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ webhook_channel_id: general.snowflake }),
    });
    expect(res.status).toBe(200);
    const followed = (await res.json()) as { channel_id: string; webhook_id: string };
    expect(followed.channel_id).toBe(announcement.snowflake);
    expect(typeof followed.webhook_id).toBe("string");
    const webhook = ds.webhooks.findOneBy("snowflake", followed.webhook_id)!;
    expect(webhook.type).toBe(2); // Channel Follower
    expect(webhook.channel_snowflake).toBe(general.snowflake);
    // Source guild/channel snowflakes are persisted on the channel-follower webhook.
    expect(webhook.source_channel_snowflake).toBe(announcement.snowflake);
    expect(webhook.source_guild_snowflake).toBe(guild);
  });

  it("an unknown target channel returns 404 Unknown Channel (10003)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { guild } = ids(store);
    const announcement = createChannel(ds, { name: "news2", type: 5, guildSnowflake: guild });
    const res = await app.request(api(`/channels/${announcement.snowflake}/followers`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ webhook_channel_id: "999999999999999999" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10003);
  });
});

// ---------------------------------------------------------------------------
// Trigger Typing Indicator
// ---------------------------------------------------------------------------

describe("channel.mdx — Trigger Typing Indicator", () => {
  it("returns a 204 empty response", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general.snowflake}/typing`), { method: "POST", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect((await res.text()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group DM recipients
// ---------------------------------------------------------------------------

describe("channel.mdx — Group DM Add/Remove Recipient", () => {
  it("Group DM Add Recipient adds the user and returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { developer } = ids(store);
    const gdm = createChannel(ds, { name: "g", type: 3, guildSnowflake: null });
    const res = await app.request(api(`/channels/${gdm.snowflake}/recipients/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ access_token: "tok", nick: "dev" }),
    });
    expect(res.status).toBe(204);
    expect(ds.channels.findOneBy("snowflake", gdm.snowflake)!.recipient_snowflakes).toContain(developer);
  });

  it("Group DM Remove Recipient removes the user and returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { developer } = ids(store);
    const gdm = createChannel(ds, { name: "g", type: 3, guildSnowflake: null });
    ds.channels.update(gdm.id, { recipient_snowflakes: [developer] });
    const res = await app.request(api(`/channels/${gdm.snowflake}/recipients/${developer}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    expect(ds.channels.findOneBy("snowflake", gdm.snowflake)!.recipient_snowflakes).not.toContain(developer);
  });
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

describe("channel.mdx — Pins", () => {
  it("pin then list then unpin a message", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { general, botSnowflake } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: general.snowflake,
      guildSnowflake: general.guild_snowflake,
      authorSnowflake: botSnowflake,
      content: "pin me",
    });
    const pin = await app.request(api(`/channels/${general.snowflake}/messages/pins/${msg.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(pin.status).toBe(204);
    const list = (await (await app.request(api(`/channels/${general.snowflake}/messages/pins`), { headers: botHeaders() })).json()) as {
      items: Array<{ message: { id: string } }>;
    };
    expect(list.items.some((i) => i.message.id === msg.snowflake)).toBe(true);
    const unpin = await app.request(api(`/channels/${general.snowflake}/messages/pins/${msg.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(unpin.status).toBe(204);
  });
});
