import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIChannel, recordAudit, AuditLogEvent } from "../helpers.js";
import { createChannel } from "../factories.js";
import { Intents } from "../gateway/intents.js";

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
}
