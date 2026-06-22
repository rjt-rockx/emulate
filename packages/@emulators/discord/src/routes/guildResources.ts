import type { DiscordRouteContext } from "../context.js";
import type {
  APIGuildScheduledEvent,
  APIGuildScheduledEventUser,
  APIStickerPack,
} from "discord-api-types/v10";
import { getDiscordStore, type DiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  snowflake,
  toAPIUser,
  toAPIMember,
  toAPIScheduledEvent,
  toAPISticker,
  recordAudit,
  AuditLogEvent,
  auditReason,
  invalidFormBody,
  unknownScheduledEvent,
} from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { Context, AppEnv, Store } from "@emulators/core";
import type { DiscordScheduledEvent, DiscordSticker } from "../entities.js";

// ---------------------------------------------------------------------------
// Standard sticker packs (read-only catalog)
// ---------------------------------------------------------------------------

interface StaticStickerPack {
  snowflake: string;
  sku_snowflake: string;
  name: string;
  description: string;
  banner_asset_snowflake?: string;
  cover_index?: number;
  stickers: Array<{ snowflake: string; name: string; tags: string; format_type: number; sort_value: number }>;
}

/**
 * A small built-in catalog of standard sticker packs (mirrors the documented Sticker Pack /
 * standard-sticker shapes). The stickers are inserted into the store on first access so that
 * `GET /stickers/:id` resolves them like any other sticker.
 */
const STATIC_PACKS: StaticStickerPack[] = [
  {
    snowflake: "847199849233514549",
    sku_snowflake: "847199849233514547",
    name: "Wumpus Beyond",
    description: "Say hello to Wumpus!",
    banner_asset_snowflake: "761773777976819732",
    cover_index: 0,
    stickers: [
      { snowflake: "749054660769218631", name: "Wave", tags: "wumpus, hello, hi, wave", format_type: 3, sort_value: 0 },
      { snowflake: "749053689419006003", name: "Hug", tags: "wumpus, hug, love", format_type: 3, sort_value: 1 },
    ],
  },
];

const seededStores = new WeakSet<Store>();

/** Ensure the standard pack stickers exist in the store (idempotent, once per store). */
function ensureStandardStickers(ds: DiscordStore, store: Store): void {
  if (seededStores.has(store)) return;
  seededStores.add(store);
  for (const pack of STATIC_PACKS) {
    for (const st of pack.stickers) {
      if (ds.stickers.findOneBy("snowflake", st.snowflake)) continue;
      const row = {
        snowflake: st.snowflake,
        guild_snowflake: "",
        name: st.name,
        description: null,
        tags: st.tags,
        type: 1,
        format_type: st.format_type,
        available: true,
        creator_snowflake: null,
        pack_snowflake: pack.snowflake,
        sort_value: st.sort_value,
      };
      ds.stickers.insert(row as unknown as DiscordSticker);
    }
  }
}

function toAPIStickerPack(pack: StaticStickerPack, ds: DiscordStore): APIStickerPack {
  const stickers = pack.stickers
    .map((st) => ds.stickers.findOneBy("snowflake", st.snowflake))
    .filter((s): s is DiscordSticker => !!s)
    .map((s) => toAPISticker(s, ds));
  const out: Record<string, unknown> = {
    id: pack.snowflake,
    stickers,
    name: pack.name,
    sku_id: pack.sku_snowflake,
    description: pack.description,
  };
  if (pack.cover_index != null) out.cover_sticker_id = pack.stickers[pack.cover_index].snowflake;
  if (pack.banner_asset_snowflake) out.banner_asset_id = pack.banner_asset_snowflake;
  return out as unknown as APIStickerPack;
}

// ---------------------------------------------------------------------------
// Sticker file format inference & validation
// ---------------------------------------------------------------------------

const STICKER_MAX_BYTES = 512 * 1024;

/** Infer the documented Sticker Format Type from an uploaded file (gif=4, lottie/json=3, apng=2, else png=1). */
function inferStickerFormat(file: File): { formatType: number; valid: boolean } {
  const name = (file.name ?? "").toLowerCase();
  const type = (file.type ?? "").toLowerCase();
  if (type.includes("gif") || name.endsWith(".gif")) return { formatType: 4, valid: true };
  if (type.includes("json") || name.endsWith(".json")) return { formatType: 3, valid: true };
  if (type.includes("apng") || name.endsWith(".apng")) return { formatType: 2, valid: true };
  if (type.includes("png") || name.endsWith(".png")) return { formatType: 1, valid: true };
  return { formatType: 1, valid: false };
}

// ---------------------------------------------------------------------------
// Scheduled event helpers
// ---------------------------------------------------------------------------

const ENTITY_STAGE = 1;
const ENTITY_VOICE = 2;
const ENTITY_EXTERNAL = 3;

const STATUS_SCHEDULED = 1;
const STATUS_ACTIVE = 2;
const STATUS_COMPLETED = 3;
const STATUS_CANCELED = 4;

/** The documented legal status transitions; everything else is rejected. */
const LEGAL_TRANSITIONS: Record<number, number[]> = {
  [STATUS_SCHEDULED]: [STATUS_ACTIVE, STATUS_CANCELED],
  [STATUS_ACTIVE]: [STATUS_COMPLETED],
  [STATUS_COMPLETED]: [],
  [STATUS_CANCELED]: [],
};

function isExternalLocation(meta: unknown): meta is { location: string } {
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof (meta as { location?: unknown }).location === "string" &&
    (meta as { location: string }).location.length > 0
  );
}

/**
 * Validate the entity_type field-requirement matrix for a create body. Returns a 50035 response
 * if the body violates the requirements, otherwise null.
 */
function validateEntityMatrix(
  c: Context<AppEnv>,
  entityType: number,
  body: Record<string, unknown>,
): Response | null {
  if (entityType === ENTITY_EXTERNAL) {
    // EXTERNAL: channel_id must be null/absent, entity_metadata.location required, scheduled_end_time required.
    if (!isExternalLocation(body.entity_metadata)) {
      return invalidFormBody(c, { "entity_metadata.location": "This field is required." });
    }
    if (typeof body.scheduled_end_time !== "string") {
      return invalidFormBody(c, { scheduled_end_time: "This field is required for external events." });
    }
    return null;
  }
  if (entityType === ENTITY_STAGE || entityType === ENTITY_VOICE) {
    // STAGE/VOICE: channel_id required.
    if (typeof body.channel_id !== "string" || body.channel_id.length === 0) {
      return invalidFormBody(c, { channel_id: "This field is required." });
    }
    return null;
  }
  return invalidFormBody(c, { entity_type: "Invalid entity type." });
}

/** Serialize a scheduled-event user (subscriber) row, optionally with guild member data. */
function toAPIScheduledEventUser(
  ds: DiscordStore,
  eventSnowflake: string,
  guildSnowflake: string,
  userSnowflake: string,
  withMember: boolean,
): APIGuildScheduledEventUser | null {
  const user = ds.users.findOneBy("snowflake", userSnowflake);
  if (!user) return null;
  const out: Record<string, unknown> = {
    guild_scheduled_event_id: eventSnowflake,
    user: toAPIUser(user),
  };
  if (withMember) {
    const member = ds.members.findBy("guild_snowflake", guildSnowflake).find((m) => m.user_snowflake === userSnowflake);
    if (member) out.member = toAPIMember(member, ds, { withUser: false });
  }
  return out as unknown as APIGuildScheduledEventUser;
}

/** Count subscribers for an event. */
function eventUserCount(ds: DiscordStore, eventSnowflake: string): number {
  return ds.scheduledEventUsers.findBy("event_snowflake", eventSnowflake).length;
}

/** Serialize an event, refreshing user_count from the subscriber model. */
function serializeEvent(e: DiscordScheduledEvent, ds: DiscordStore): APIGuildScheduledEvent {
  const payload = toAPIScheduledEvent({ ...e, user_count: eventUserCount(ds, e.snowflake) }, ds);
  return payload;
}

export function guildResourcesRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ----- Sticker packs (standard catalog) -----
  app.get("/api/v:version/sticker-packs", (c) => {
    const ds = getDiscordStore(store);
    ensureStandardStickers(ds, store);
    return c.json({ sticker_packs: STATIC_PACKS.map((p) => toAPIStickerPack(p, ds)) });
  });

  app.get("/api/v:version/sticker-packs/:packId", (c) => {
    const ds = getDiscordStore(store);
    ensureStandardStickers(ds, store);
    const pack = STATIC_PACKS.find((p) => p.snowflake === c.req.param("packId"));
    if (!pack) return notFound(c);
    return c.json(toAPIStickerPack(pack, ds));
  });

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
    ensureStandardStickers(ds, store);
    const sticker = ds.stickers.findOneBy("snowflake", c.req.param("stickerId"));
    if (!sticker) return notFound(c);
    return c.json(toAPISticker(sticker, ds));
  });

  const dispatchStickersUpdate = (ds: DiscordStore, guildId: string) =>
    bus.publish({
      t: "GUILD_STICKERS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildExpressions,
      d: {
        guild_id: guildId,
        stickers: ds.stickers.findBy("guild_snowflake", guildId).map((s) => toAPISticker(s, ds)),
      },
    });

  app.post("/api/v:version/guilds/:guildId/stickers", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;

    // name: 2-30 characters.
    const name = typeof body.name === "string" ? body.name : "";
    if (name.length < 2 || name.length > 30) {
      return invalidFormBody(c, { name: "Must be between 2 and 30 in length." });
    }
    // description: empty, or 2-100 characters.
    const description = typeof body.description === "string" ? body.description : "";
    if (description.length !== 0 && (description.length < 2 || description.length > 100)) {
      return invalidFormBody(c, { description: "Must be empty or between 2 and 100 in length." });
    }
    // tags: required, max 200 characters (comma-separated autocomplete strings per the doc).
    const tags = typeof body.tags === "string" ? body.tags : "";
    if (tags.length > 200) {
      return invalidFormBody(c, { tags: "Must be 200 or fewer in length." });
    }

    // file: required; must be a PNG/APNG/GIF/Lottie file no larger than 512 KiB. The format_type
    // is inferred from the file (gif=4, lottie/json=3, apng=2, else png=1).
    const fileField = body.file;
    if (!(fileField instanceof File)) {
      return invalidFormBody(c, { file: "This field is required." });
    }
    let formatType = 1;
    {
      const inferred = inferStickerFormat(fileField);
      if (!inferred.valid) {
        return invalidFormBody(c, { file: "Must be a PNG, APNG, GIF, or Lottie JSON file." });
      }
      if ((fileField.size ?? 0) > STICKER_MAX_BYTES) {
        return invalidFormBody(c, { file: "File must be smaller than 512 KiB." });
      }
      formatType = inferred.formatType;
    }

    const sticker = ds.stickers.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      name,
      description: description.length === 0 ? "" : description,
      tags,
      type: 2,
      format_type: formatType,
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
    if (typeof body.name === "string") {
      if (body.name.length < 2 || body.name.length > 30) {
        return invalidFormBody(c, { name: "Must be between 2 and 30 in length." });
      }
      patch.name = body.name;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description === "string") {
        if (body.description.length < 2 || body.description.length > 100) {
          return invalidFormBody(c, { description: "Must be between 2 and 100 in length." });
        }
      }
      patch.description = body.description;
    }
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
  const boolQuery = (c: Context<AppEnv>, key: string): boolean => {
    const v = c.req.query(key);
    return v === "true" || v === "1";
  };

  app.get("/api/v:version/guilds/:guildId/scheduled-events", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const withCount = boolQuery(c, "with_user_count");
    return c.json(
      ds.scheduledEvents.findBy("guild_snowflake", c.req.param("guildId")).map((e) => {
        const payload = serializeEvent(e, ds);
        if (!withCount) delete payload.user_count;
        return payload;
      }),
    );
  });

  app.post("/api/v:version/guilds/:guildId/scheduled-events", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const entityType = typeof body.entity_type === "number" ? body.entity_type : ENTITY_EXTERNAL;
    const matrixError = validateEntityMatrix(c, entityType, body);
    if (matrixError) return matrixError;

    const isExternal = entityType === ENTITY_EXTERNAL;
    const channelSnowflake = isExternal ? null : typeof body.channel_id === "string" ? body.channel_id : null;
    // STAGE/VOICE force entity_metadata to null; EXTERNAL keeps the provided location metadata.
    const entityMetadata = isExternal && isExternalLocation(body.entity_metadata) ? { location: body.entity_metadata.location } : null;

    const event = ds.scheduledEvents.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      channel_snowflake: channelSnowflake,
      creator_snowflake: auth.user?.snowflake ?? null,
      name: typeof body.name === "string" ? body.name : "Event",
      description: typeof body.description === "string" ? body.description : null,
      scheduled_start_time: typeof body.scheduled_start_time === "string" ? body.scheduled_start_time : new Date().toISOString(),
      scheduled_end_time: typeof body.scheduled_end_time === "string" ? body.scheduled_end_time : null,
      privacy_level: typeof body.privacy_level === "number" ? body.privacy_level : 2,
      status: STATUS_SCHEDULED,
      entity_type: entityType,
      user_count: 0,
      entity_snowflake: null,
      entity_metadata: entityMetadata,
      recurrence_rule: body.recurrence_rule ?? null,
      image: typeof body.image === "string" ? body.image : null,
    });
    const payload = serializeEvent(event, ds);
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
    if (!event || event.guild_snowflake !== c.req.param("guildId")) return unknownScheduledEvent(c);
    const payload = serializeEvent(event, ds);
    if (!boolQuery(c, "with_user_count")) delete payload.user_count;
    return c.json(payload);
  });

  app.patch("/api/v:version/guilds/:guildId/scheduled-events/:eventId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== c.req.param("guildId")) return unknownScheduledEvent(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: Record<string, unknown> = {};
    const targetEntityType = typeof body.entity_type === "number" ? body.entity_type : event.entity_type;

    // When entity_type changes on PATCH, re-run the entity matrix validation using a merged view
    // that combines request-body values with existing event values so partial patches are accepted.
    if (typeof body.entity_type === "number" && body.entity_type !== event.entity_type) {
      const mergedForValidation: Record<string, unknown> = {
        channel_id: "channel_id" in body ? body.channel_id : event.channel_snowflake,
        entity_metadata: "entity_metadata" in body ? body.entity_metadata : event.entity_metadata,
        scheduled_end_time: "scheduled_end_time" in body ? body.scheduled_end_time : event.scheduled_end_time,
      };
      const matrixError = validateEntityMatrix(c, body.entity_type, mergedForValidation);
      if (matrixError) return matrixError;

      // Apply side-effects for the new entity type.
      if (body.entity_type === ENTITY_EXTERNAL) {
        patch.channel_snowflake = null;
        const meta = "entity_metadata" in body ? body.entity_metadata : event.entity_metadata;
        patch.entity_metadata = isExternalLocation(meta) ? { location: (meta as { location: string }).location } : null;
      } else {
        // STAGE or VOICE: channel_id from request or existing
        const channelId = typeof body.channel_id === "string" ? body.channel_id : event.channel_snowflake;
        patch.channel_snowflake = channelId;
        patch.entity_metadata = null;
      }
    }

    // Status transition validation.
    if (typeof body.status === "number" && body.status !== event.status) {
      const allowed = LEGAL_TRANSITIONS[event.status] ?? [];
      if (!allowed.includes(body.status)) {
        return invalidFormBody(c, { status: "Invalid Guild Scheduled Event status transition." });
      }
      patch.status = body.status;
    }

    if (typeof body.name === "string") patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (typeof body.scheduled_start_time === "string") patch.scheduled_start_time = body.scheduled_start_time;
    if (typeof body.scheduled_end_time === "string") patch.scheduled_end_time = body.scheduled_end_time;
    if (typeof body.privacy_level === "number") patch.privacy_level = body.privacy_level;
    if (typeof body.entity_type === "number") patch.entity_type = body.entity_type;
    // channel_id / entity_metadata are only directly patched when entity_type is NOT changing (handled above).
    if (typeof body.entity_type !== "number" || body.entity_type === event.entity_type) {
      if (typeof body.channel_id === "string") patch.channel_snowflake = body.channel_id;
      else if (body.channel_id === null) patch.channel_snowflake = null;
      // entity_metadata is silently discarded for non-EXTERNAL events when no type change.
      if (body.entity_metadata !== undefined) {
        patch.entity_metadata = targetEntityType === ENTITY_EXTERNAL && isExternalLocation(body.entity_metadata)
          ? { location: body.entity_metadata.location }
          : null;
      }
    }
    if (typeof body.image === "string") patch.image = body.image;
    if (body.recurrence_rule !== undefined) patch.recurrence_rule = body.recurrence_rule;

    const eventChanges = Object.keys(patch).map((key) => ({
      key,
      old_value: (event as unknown as Record<string, unknown>)[key],
      new_value: patch[key],
    }));
    ds.scheduledEvents.update(event.id, patch);
    const payload = serializeEvent(ds.scheduledEvents.findOneBy("snowflake", event.snowflake)!, ds);
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
    if (!event || event.guild_snowflake !== c.req.param("guildId")) return unknownScheduledEvent(c);
    const payload = serializeEvent(event, ds);
    ds.scheduledEvents.delete(event.id);
    // Remove the event's subscriber rows.
    for (const sub of ds.scheduledEventUsers.findBy("event_snowflake", event.snowflake)) {
      ds.scheduledEventUsers.delete(sub.id);
    }
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

  // ----- Get Guild Scheduled Event Users -----
  app.get("/api/v:version/guilds/:guildId/scheduled-events/:eventId/users", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== guildId) return unknownScheduledEvent(c);

    const withMember = boolQuery(c, "with_member");
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 100;
    const before = c.req.query("before");
    const after = c.req.query("after");

    // Subscribers ordered ascending by user id (numeric snowflake order).
    let rows = ds.scheduledEventUsers
      .findBy("event_snowflake", event.snowflake)
      .slice()
      .sort((a, b) => (BigInt(a.user_snowflake) < BigInt(b.user_snowflake) ? -1 : 1));

    // before takes precedence over after.
    if (before) {
      const b = BigInt(before);
      rows = rows.filter((r) => BigInt(r.user_snowflake) < b);
    } else if (after) {
      const a = BigInt(after);
      rows = rows.filter((r) => BigInt(r.user_snowflake) > a);
    }
    rows = rows.slice(0, limit);

    const users = rows
      .map((r) => toAPIScheduledEventUser(ds, event.snowflake, guildId, r.user_snowflake, withMember))
      .filter((u): u is APIGuildScheduledEventUser => u !== null);
    return c.json(users);
  });

  // ----- Subscribe / unsubscribe (PUT/DELETE .../users/@me) -----
  app.put("/api/v:version/guilds/:guildId/scheduled-events/:eventId/users/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== guildId) return unknownScheduledEvent(c);
    const userSnowflake = auth.user?.snowflake;
    if (!userSnowflake) return unauthorized(c);

    const existing = ds.scheduledEventUsers
      .findBy("event_snowflake", event.snowflake)
      .find((s) => s.user_snowflake === userSnowflake);
    if (!existing) {
      ds.scheduledEventUsers.insert({
        event_snowflake: event.snowflake,
        guild_snowflake: guildId,
        user_snowflake: userSnowflake,
      });
      ds.scheduledEvents.update(event.id, { user_count: eventUserCount(ds, event.snowflake) });
      bus.publish({
        t: "GUILD_SCHEDULED_EVENT_USER_ADD",
        guildId,
        requiredIntents: Intents.GuildScheduledEvents,
        d: { guild_scheduled_event_id: event.snowflake, user_id: userSnowflake, guild_id: guildId },
      });
    }
    return new Response(null, { status: 204 });
  });

  app.delete("/api/v:version/guilds/:guildId/scheduled-events/:eventId/users/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const event = ds.scheduledEvents.findOneBy("snowflake", c.req.param("eventId"));
    if (!event || event.guild_snowflake !== guildId) return unknownScheduledEvent(c);
    const userSnowflake = auth.user?.snowflake;
    if (!userSnowflake) return unauthorized(c);

    const existing = ds.scheduledEventUsers
      .findBy("event_snowflake", event.snowflake)
      .find((s) => s.user_snowflake === userSnowflake);
    if (existing) {
      ds.scheduledEventUsers.delete(existing.id);
      ds.scheduledEvents.update(event.id, { user_count: eventUserCount(ds, event.snowflake) });
      bus.publish({
        t: "GUILD_SCHEDULED_EVENT_USER_REMOVE",
        guildId,
        requiredIntents: Intents.GuildScheduledEvents,
        d: { guild_scheduled_event_id: event.snowflake, user_id: userSnowflake, guild_id: guildId },
      });
    }
    return new Response(null, { status: 204 });
  });
}
