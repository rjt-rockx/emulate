import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake, toAPIUser, recordAudit, AuditLogEvent, auditReason } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordSticker, DiscordScheduledEvent } from "../entities.js";

function toAPISticker(s: DiscordSticker, ds: DiscordStore): Record<string, unknown> {
  const creator = s.creator_snowflake ? ds.users.findOneBy("snowflake", s.creator_snowflake) : null;
  return {
    id: s.snowflake,
    guild_id: s.guild_snowflake,
    name: s.name,
    description: s.description,
    tags: s.tags,
    type: s.type,
    format_type: s.format_type,
    available: s.available,
    user: creator ? toAPIUser(creator) : undefined,
  };
}

function toAPIScheduledEvent(e: DiscordScheduledEvent, ds: DiscordStore): Record<string, unknown> {
  const creator = e.creator_snowflake ? ds.users.findOneBy("snowflake", e.creator_snowflake) : null;
  return {
    id: e.snowflake,
    guild_id: e.guild_snowflake,
    channel_id: e.channel_snowflake,
    creator_id: e.creator_snowflake,
    creator: creator ? toAPIUser(creator) : undefined,
    name: e.name,
    description: e.description,
    scheduled_start_time: e.scheduled_start_time,
    scheduled_end_time: e.scheduled_end_time,
    privacy_level: e.privacy_level,
    status: e.status,
    entity_type: e.entity_type,
    entity_id: null,
    entity_metadata: null,
    user_count: e.user_count,
  };
}

export function guildResourcesRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ----- Stickers -----
  app.get("/api/v:version/guilds/:guildId/stickers", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json(ds.stickers.findBy("guild_snowflake", c.req.param("guildId")).map((s) => toAPISticker(s, ds)));
  });

  app.get("/api/v:version/guilds/:guildId/stickers/:stickerId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const sticker = ds.stickers.findOneBy("snowflake", c.req.param("stickerId"));
    if (!sticker || sticker.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    return c.json(toAPISticker(sticker, ds));
  });

  app.get("/api/v:version/stickers/:stickerId", (c) => {
    const ds = getDiscordStore(store);
    const sticker = ds.stickers.findOneBy("snowflake", c.req.param("stickerId"));
    if (!sticker) return notFound(c);
    return c.json(toAPISticker(sticker, ds));
  });

  const dispatchStickersUpdate = (ds: DiscordStore, guildId: string) =>
    bus.publish({
      t: "GUILD_STICKERS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildExpressions,
      d: { guild_id: guildId, stickers: ds.stickers.findBy("guild_snowflake", guildId).map((s) => toAPISticker(s, ds)) },
    });

  app.post("/api/v:version/guilds/:guildId/stickers", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const sticker = ds.stickers.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      name: typeof body.name === "string" ? body.name : "sticker",
      description: typeof body.description === "string" ? body.description : null,
      tags: typeof body.tags === "string" ? body.tags : "",
      type: 2,
      format_type: 1,
      available: true,
      creator_snowflake: auth.user?.snowflake ?? null,
    });
    dispatchStickersUpdate(ds, guildId);
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.StickerCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: sticker.snowflake,
      changes: [{ key: "name", new_value: sticker.name }],
      reason: auditReason(c),
    });
    return c.json(toAPISticker(sticker, ds), 201);
  });

  app.patch("/api/v:version/guilds/:guildId/stickers/:stickerId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const sticker = ds.stickers.findOneBy("snowflake", c.req.param("stickerId"));
    if (!sticker || sticker.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (typeof body.tags === "string") patch.tags = body.tags;
    const stickerChanges = Object.keys(patch).map((key) => ({
      key,
      old_value: (sticker as unknown as Record<string, unknown>)[key],
      new_value: patch[key],
    }));
    ds.stickers.update(sticker.id, patch);
    dispatchStickersUpdate(ds, sticker.guild_snowflake);
    if (stickerChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: sticker.guild_snowflake,
        actionType: AuditLogEvent.StickerUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: sticker.snowflake,
        changes: stickerChanges,
        reason: auditReason(c),
      });
    }
    return c.json(toAPISticker(ds.stickers.findOneBy("snowflake", sticker.snowflake)!, ds));
  });

  app.delete("/api/v:version/guilds/:guildId/stickers/:stickerId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const sticker = ds.stickers.findOneBy("snowflake", c.req.param("stickerId"));
    if (!sticker || sticker.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const guildId = sticker.guild_snowflake;
    ds.stickers.delete(sticker.id);
    dispatchStickersUpdate(ds, guildId);
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.StickerDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: sticker.snowflake,
      changes: [{ key: "name", old_value: sticker.name }],
      reason: auditReason(c),
    });
    return new Response(null, { status: 204 });
  });

  // ----- Scheduled events -----
  app.get("/api/v:version/guilds/:guildId/scheduled-events", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json(ds.scheduledEvents.findBy("guild_snowflake", c.req.param("guildId")).map((e) => toAPIScheduledEvent(e, ds)));
  });

  app.post("/api/v:version/guilds/:guildId/scheduled-events", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const event = ds.scheduledEvents.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      channel_snowflake: typeof body.channel_id === "string" ? body.channel_id : null,
      creator_snowflake: auth.user?.snowflake ?? null,
      name: typeof body.name === "string" ? body.name : "Event",
      description: typeof body.description === "string" ? body.description : null,
      scheduled_start_time: typeof body.scheduled_start_time === "string" ? body.scheduled_start_time : new Date().toISOString(),
      scheduled_end_time: typeof body.scheduled_end_time === "string" ? body.scheduled_end_time : null,
      privacy_level: typeof body.privacy_level === "number" ? body.privacy_level : 2,
      status: 1,
      entity_type: typeof body.entity_type === "number" ? body.entity_type : 3,
      user_count: 0,
    });
    const payload = toAPIScheduledEvent(event, ds);
    bus.publish({ t: "GUILD_SCHEDULED_EVENT_CREATE", guildId, requiredIntents: Intents.GuildScheduledEvents, d: payload });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.GuildScheduledEventCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: event.snowflake,
      changes: [{ key: "name", new_value: event.name }],
      reason: auditReason(c),
    });
    return c.json(payload, 201);
  });

  app.get("/api/v:version/guilds/:guildId/scheduled-events/:eventId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    return c.json(toAPIScheduledEvent(event, ds));
  });

  app.patch("/api/v:version/guilds/:guildId/scheduled-events/:eventId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (typeof body.status === "number") patch.status = body.status;
    if (typeof body.scheduled_start_time === "string") patch.scheduled_start_time = body.scheduled_start_time;
    const eventChanges = Object.keys(patch).map((key) => ({
      key,
      old_value: (event as unknown as Record<string, unknown>)[key],
      new_value: patch[key],
    }));
    ds.scheduledEvents.update(event.id, patch);
    const payload = toAPIScheduledEvent(ds.scheduledEvents.findOneBy("snowflake", event.snowflake)!, ds);
    bus.publish({
      t: "GUILD_SCHEDULED_EVENT_UPDATE",
      guildId: event.guild_snowflake,
      requiredIntents: Intents.GuildScheduledEvents,
      d: payload,
    });
    if (eventChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: event.guild_snowflake,
        actionType: AuditLogEvent.GuildScheduledEventUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: event.snowflake,
        changes: eventChanges,
        reason: auditReason(c),
      });
    }
    return c.json(payload);
  });

  app.delete("/api/v:version/guilds/:guildId/scheduled-events/:eventId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const payload = toAPIScheduledEvent(event, ds);
    ds.scheduledEvents.delete(event.id);
    bus.publish({
      t: "GUILD_SCHEDULED_EVENT_DELETE",
      guildId: event.guild_snowflake,
      requiredIntents: Intents.GuildScheduledEvents,
      d: payload,
    });
    recordAudit(ds, bus, {
      guildSnowflake: event.guild_snowflake,
      actionType: AuditLogEvent.GuildScheduledEventDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: event.snowflake,
      changes: [{ key: "name", old_value: event.name }],
      reason: auditReason(c),
    });
    return new Response(null, { status: 204 });
  });
}
