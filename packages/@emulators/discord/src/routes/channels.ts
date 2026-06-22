import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  toAPIChannel,
  toAPIMessage,
  redactMessageContent,
  recordAudit,
  AuditLogEvent,
  snowflake,
} from "../helpers.js";
import { createChannel } from "../factories.js";
import { Intents } from "../gateway/intents.js";

/** Message flag bit for a crossposted (published) announcement message. */
const MESSAGE_FLAG_CROSSPOSTED = 1 << 1;

export function channelsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  app.get("/api/v:version/guilds/:guildId/channels", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const channels = ds.channels
      .findBy("guild_snowflake", guildId)
      .sort((a, b) => a.position - b.position)
      .map(toAPIChannel);
    return c.json(channels);
  });

  app.post("/api/v:version/guilds/:guildId/channels", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const channel = createChannel(ds, {
      name: (body.name as string | undefined) ?? "new-channel",
      type: (body.type as number | undefined) ?? 0,
      guildSnowflake: guildId,
      topic: (body.topic as string | null | undefined) ?? null,
      parentSnowflake: (body.parent_id as string | null | undefined) ?? null,
      nsfw: (body.nsfw as boolean | undefined) ?? false,
      position: body.position as number | undefined,
      bitrate: body.bitrate as number | undefined,
      userLimit: body.user_limit as number | undefined,
    });
    const payload = toAPIChannel(channel);
    bus.publish({ t: "CHANNEL_CREATE", guildId, requiredIntents: Intents.Guilds, d: payload });
    recordAudit(ds, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.ChannelCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: channel.snowflake,
      changes: [{ key: "name", new_value: channel.name }],
    });
    return c.json(payload, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/channels", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    let body: Array<{ id: string; position?: number; parent_id?: string | null }> = [];
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    for (const entry of Array.isArray(body) ? body : []) {
      const channel = ds.channels.findOneBy("snowflake", entry.id);
      if (!channel) continue;
      const patch: Record<string, unknown> = {};
      if (entry.position !== undefined) patch.position = entry.position;
      if (entry.parent_id !== undefined) patch.parent_snowflake = entry.parent_id;
      if (Object.keys(patch).length > 0) ds.channels.update(channel.id, patch);
    }
    return new Response(null, { status: 204 });
  });

  app.get("/api/v:version/channels/:channelId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    return c.json(toAPIChannel(channel));
  });

  app.patch("/api/v:version/channels/:channelId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.topic !== undefined) patch.topic = body.topic;
    if (body.position !== undefined) patch.position = body.position;
    if (body.nsfw !== undefined) patch.nsfw = body.nsfw;
    if (body.parent_id !== undefined) patch.parent_snowflake = body.parent_id;
    if (body.rate_limit_per_user !== undefined) patch.rate_limit_per_user = body.rate_limit_per_user;
    if (body.bitrate !== undefined) patch.bitrate = body.bitrate;
    if (body.user_limit !== undefined) patch.user_limit = body.user_limit;
    const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    if (isThread && (body.archived !== undefined || body.locked !== undefined || body.auto_archive_duration !== undefined)) {
      patch.thread_metadata = {
        ...(channel.thread_metadata ?? { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false }),
        ...(body.archived !== undefined ? { archived: !!body.archived } : {}),
        ...(body.locked !== undefined ? { locked: !!body.locked } : {}),
        ...(body.auto_archive_duration !== undefined ? { auto_archive_duration: body.auto_archive_duration } : {}),
      };
    }
    const channelChanges = Object.keys(patch)
      .filter((key) => key !== "thread_metadata")
      .map((key) => ({
        key,
        old_value: (channel as unknown as Record<string, unknown>)[key],
        new_value: patch[key],
      }));
    if (Object.keys(patch).length > 0) ds.channels.update(channel.id, patch);
    const updated = ds.channels.findOneBy("snowflake", channel.snowflake)!;
    const payload = toAPIChannel(updated);
    bus.publish({
      t: isThread ? "THREAD_UPDATE" : "CHANNEL_UPDATE",
      guildId: updated.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: payload,
    });
    if (!isThread && channelChanges.length > 0) {
      recordAudit(ds, {
        guildSnowflake: updated.guild_snowflake,
        actionType: AuditLogEvent.ChannelUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: updated.snowflake,
        changes: channelChanges,
      });
    }
    return c.json(payload);
  });

  app.delete("/api/v:version/channels/:channelId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const payload = toAPIChannel(channel);
    const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    for (const m of ds.messages.findBy("channel_snowflake", channel.snowflake)) ds.messages.delete(m.id);
    ds.channels.delete(channel.id);
    bus.publish({
      t: isThread ? "THREAD_DELETE" : "CHANNEL_DELETE",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: payload,
    });
    if (!isThread) {
      recordAudit(ds, {
        guildSnowflake: channel.guild_snowflake,
        actionType: AuditLogEvent.ChannelDelete,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: channel.snowflake,
        changes: [{ key: "name", old_value: channel.name }],
      });
    }
    return c.json(payload);
  });

  app.post("/api/v:version/channels/:channelId/typing", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    bus.publish({
      t: "TYPING_START",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.GuildMessageTyping,
      d: {
        channel_id: channel.snowflake,
        guild_id: channel.guild_snowflake ?? undefined,
        user_id: auth.user.snowflake,
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Permission overwrites
  // ---------------------------------------------------------------------------

  app.put("/api/v:version/channels/:channelId/permissions/:overwriteId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const overwriteId = c.req.param("overwriteId");
    const body = (await c.req.json().catch(() => ({}))) as { type?: number; allow?: string; deny?: string };
    const overwrite = {
      id: overwriteId,
      type: body.type ?? 0,
      allow: body.allow ?? "0",
      deny: body.deny ?? "0",
    };
    const overwrites = channel.permission_overwrites.filter((o) => o.id !== overwriteId);
    overwrites.push(overwrite);
    ds.channels.update(channel.id, { permission_overwrites: overwrites });
    const updated = ds.channels.findOneBy("snowflake", channel.snowflake)!;
    bus.publish({ t: "CHANNEL_UPDATE", guildId: updated.guild_snowflake, requiredIntents: Intents.Guilds, d: toAPIChannel(updated) });
    return new Response(null, { status: 204 });
  });

  app.delete("/api/v:version/channels/:channelId/permissions/:overwriteId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const overwriteId = c.req.param("overwriteId");
    ds.channels.update(channel.id, {
      permission_overwrites: channel.permission_overwrites.filter((o) => o.id !== overwriteId),
    });
    const updated = ds.channels.findOneBy("snowflake", channel.snowflake)!;
    bus.publish({ t: "CHANNEL_UPDATE", guildId: updated.guild_snowflake, requiredIntents: Intents.Guilds, d: toAPIChannel(updated) });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Announcement channels: crosspost + follow
  // ---------------------------------------------------------------------------

  app.post("/api/v:version/channels/:channelId/messages/:messageId/crosspost", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message || message.channel_snowflake !== channelId) return notFound(c);
    ds.messages.update(message.id, { flags: message.flags | MESSAGE_FLAG_CROSSPOSTED });
    const updated = ds.messages.findOneBy("snowflake", message.snowflake)!;
    const payload = toAPIMessage(updated, ds);
    bus.publish({
      t: "MESSAGE_UPDATE",
      guildId: updated.guild_snowflake,
      requiredIntents: updated.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
      d: payload,
      redactedData: redactMessageContent(payload),
      messageAuthorId: updated.author_snowflake,
    });
    return c.json(payload);
  });

  // Follow an announcement channel: creates a channel-follower webhook in the target channel.
  app.post("/api/v:version/channels/:channelId/followers", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const source = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!source) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { webhook_channel_id?: string };
    const targetId = body.webhook_channel_id ?? "";
    const target = ds.channels.findOneBy("snowflake", targetId);
    if (!target) return notFound(c);
    const webhook = ds.webhooks.insert({
      snowflake: snowflake(),
      type: 2, // Channel Follower
      guild_snowflake: target.guild_snowflake,
      channel_snowflake: target.snowflake,
      user_snowflake: auth.user?.snowflake ?? null,
      name: source.name,
      avatar: null,
      token: `whk_${snowflake()}`,
      application_snowflake: auth.application?.snowflake ?? null,
    });
    return c.json({ channel_id: source.snowflake, webhook_id: webhook.snowflake });
  });

  // ---------------------------------------------------------------------------
  // Pins (current API under /messages/pins)
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/channels/:channelId/messages/pins", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    if (!ds.channels.findOneBy("snowflake", channelId)) return notFound(c);
    const items = ds.messages
      .findBy("channel_snowflake", channelId)
      .filter((m) => m.pinned)
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1))
      .map((m) => ({ pinned_at: m.updated_at ?? m.timestamp, message: toAPIMessage(m, ds) }));
    return c.json({ items, has_more: false });
  });

  const setPinnedNew = (channelIdParam: string, messageIdParam: string, pinned: boolean, c: Context<AppEnv>) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", messageIdParam);
    if (!message || message.channel_snowflake !== channelIdParam) return notFound(c);
    ds.messages.update(message.id, { pinned });
    bus.publish({
      t: "CHANNEL_PINS_UPDATE",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { guild_id: message.guild_snowflake ?? undefined, channel_id: channelIdParam, last_pin_timestamp: new Date().toISOString() },
    });
    return new Response(null, { status: 204 });
  };

  app.put("/api/v:version/channels/:channelId/messages/pins/:messageId", (c) =>
    setPinnedNew(c.req.param("channelId"), c.req.param("messageId"), true, c),
  );
  app.delete("/api/v:version/channels/:channelId/messages/pins/:messageId", (c) =>
    setPinnedNew(c.req.param("channelId"), c.req.param("messageId"), false, c),
  );

  // ---------------------------------------------------------------------------
  // Group DM recipients + voice channel status
  // ---------------------------------------------------------------------------

  app.put("/api/v:version/channels/:channelId/recipients/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    const user = ds.users.findOneBy("snowflake", c.req.param("userId"));
    if (!channel || !user) return notFound(c);
    if (!channel.recipient_snowflakes.includes(user.snowflake)) {
      ds.channels.update(channel.id, { recipient_snowflakes: [...channel.recipient_snowflakes, user.snowflake] });
    }
    return new Response(null, { status: 204 });
  });

  app.delete("/api/v:version/channels/:channelId/recipients/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const userId = c.req.param("userId");
    ds.channels.update(channel.id, { recipient_snowflakes: channel.recipient_snowflakes.filter((s) => s !== userId) });
    return new Response(null, { status: 204 });
  });

  // Set a voice channel's status string.
  app.put("/api/v:version/channels/:channelId/voice-status", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string | null };
    store.setData(`discord.voice_status.${channel.snowflake}`, body.status ?? null);
    bus.publish({
      t: "VOICE_CHANNEL_STATUS_UPDATE",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { id: channel.snowflake, guild_id: channel.guild_snowflake ?? undefined, status: body.status ?? null },
    });
    return new Response(null, { status: 204 });
  });
}
