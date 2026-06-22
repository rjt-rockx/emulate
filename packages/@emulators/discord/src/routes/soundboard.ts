import type { DiscordRouteContext } from "../context.js";
import type { DiscordStore } from "../store.js";
import {
  requireBot,
  getAuth,
  unauthorized,
  notFound,
  snowflake,
  invalidFormBody,
  toAPISound,
  recordAudit,
  AuditLogEvent,
  auditReason,
  resolveBotUser,
  requirePermission,
} from "../helpers.js";
import { PermissionFlags, computeGuildPermissions, hasPermission } from "../permissions.js";
import { Intents } from "../gateway/intents.js";
import { getDiscordStore } from "../store.js";
import type { DiscordSoundboardSound } from "../entities.js";

/**
 * The default soundboard sounds available to all users. These mirror the real Discord set:
 * stable integer string ids, a unicode emoji, full volume, and no guild_id. Discord ships a
 * larger catalog; this covers the well-known sounds while keeping the documented object shape.
 */
const DEFAULT_SOUNDS: Array<Record<string, unknown>> = [
  { name: "quack", sound_id: "1", volume: 1, emoji_id: null, emoji_name: "\u{1F986}", available: true },
  { name: "you can do it!", sound_id: "2", volume: 1, emoji_id: null, emoji_name: "\u{1F44D}", available: true },
  { name: "yawn", sound_id: "3", volume: 1, emoji_id: null, emoji_name: "\u{1F971}", available: true },
  { name: "airhorn", sound_id: "4", volume: 1, emoji_id: null, emoji_name: "\u{1F4EF}", available: true },
  { name: "applause", sound_id: "5", volume: 1, emoji_id: null, emoji_name: "\u{1F44F}", available: true },
  { name: "dun dun dunnn!", sound_id: "6", volume: 1, emoji_id: null, emoji_name: "\u{1F628}", available: true },
  { name: "rocket", sound_id: "7", volume: 1, emoji_id: null, emoji_name: "\u{1F680}", available: true },
  { name: "wow", sound_id: "8", volume: 1, emoji_id: null, emoji_name: "\u{1F62E}", available: true },
  { name: "ahooga", sound_id: "9", volume: 1, emoji_id: null, emoji_name: "\u{1F697}", available: true },
  { name: "tada", sound_id: "10", volume: 1, emoji_id: null, emoji_name: "\u{1F389}", available: true },
  { name: "ba dum tss", sound_id: "11", volume: 1, emoji_id: null, emoji_name: "\u{1F941}", available: true },
  { name: "sad trombone", sound_id: "12", volume: 1, emoji_id: null, emoji_name: "\u{1F3BA}", available: true },
];

// ---------------------------------------------------------------------------
// Validation (name 2-32, sound data uri required, volume 0-1)
// ---------------------------------------------------------------------------

function validateName(name: unknown): string | null {
  if (typeof name !== "string") return "This field is required";
  if (name.length < 2 || name.length > 32) return "Must be between 2 and 32 in length.";
  return null;
}

function validateVolume(volume: unknown): string | null {
  if (volume == null) return null;
  if (typeof volume !== "number" || Number.isNaN(volume)) return "Value of type double is required";
  if (volume < 0 || volume > 1) return "double value should be between 0.0 and 1.0.";
  return null;
}

function dispatchSoundsUpdate(bus: DiscordRouteContext["bus"], ds: DiscordStore, guildId: string): void {
  bus.publish({
    t: "GUILD_SOUNDBOARD_SOUNDS_UPDATE",
    guildId,
    requiredIntents: Intents.GuildExpressions,
    d: {
      guild_id: guildId,
      soundboard_sounds: ds.soundboardSounds.findBy("guild_snowflake", guildId).map((s) => toAPISound(s, ds)),
    },
  });
}

export function soundboardRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  app.get("/api/v:version/soundboard-default-sounds", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    return c.json(DEFAULT_SOUNDS);
  });

  // [S-2] Helper: whether caller has CREATE/MANAGE_GUILD_EXPRESSIONS (to include user field).
  const hasExpressionPerm = (userSnowflake: string | undefined, guildId: string): boolean => {
    if (!userSnowflake) return false;
    const ds = getDiscordStore(store);
    const perms = computeGuildPermissions(ds, userSnowflake, guildId);
    return hasPermission(perms, PermissionFlags.CreateGuildExpressions) || hasPermission(perms, PermissionFlags.ManageGuildExpressions);
  };

  app.get("/api/v:version/guilds/:guildId/soundboard-sounds", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // [S-2] Include user field only when caller has expression permissions.
    const includeUser = hasExpressionPerm(auth.user?.snowflake, guildId);
    return c.json({
      items: ds.soundboardSounds.findBy("guild_snowflake", guildId).map((s) => toAPISound(s, ds, includeUser)),
    });
  });

  app.get("/api/v:version/guilds/:guildId/soundboard-sounds/:soundId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    const sound = ds.soundboardSounds.findOneBy("snowflake", c.req.param("soundId"));
    if (!sound || sound.guild_snowflake !== guildId) return notFound(c);
    // [S-2] Include user field only when caller has expression permissions.
    const includeUser = hasExpressionPerm(auth.user?.snowflake, guildId);
    return c.json(toAPISound(sound, ds, includeUser));
  });

  app.post("/api/v:version/guilds/:guildId/soundboard-sounds", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    // [S-1] Create requires CREATE_GUILD_EXPRESSIONS or MANAGE_GUILD_EXPRESSIONS.
    {
      const _p = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.CreateGuildExpressions, { guildId });
      if (_p) {
        const _p2 = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuildExpressions, { guildId });
        if (_p2) return _p2;
      }
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // name (2-32) is required; sound is a data uri required on Create; volume (if present) must be 0-1.
    const nameErr = validateName(body.name);
    if (nameErr) return invalidFormBody(c, { name: nameErr });
    // [S-4] `sound` (data uri) is required on Create.
    if (typeof body.sound !== "string" || body.sound.length === 0) {
      return invalidFormBody(c, { sound: "This field is required." });
    }
    const volErr = validateVolume(body.volume);
    if (volErr) return invalidFormBody(c, { volume: volErr });

    const sound = ds.soundboardSounds.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      name: body.name as string,
      volume: typeof body.volume === "number" ? body.volume : 1,
      emoji_name: typeof body.emoji_name === "string" ? body.emoji_name : null,
      emoji_snowflake: typeof body.emoji_id === "string" ? body.emoji_id : null,
      available: true,
      creator_snowflake: auth.user?.snowflake ?? null,
    });
    // [S-2] Include user only when caller has expression permissions (which they do here since
    // Create requires them — so always true at this point when enforcement is on).
    const includeUser = hasExpressionPerm(auth.user?.snowflake, guildId);
    const payload = toAPISound(sound, ds, includeUser);
    bus.publish({ t: "GUILD_SOUNDBOARD_SOUND_CREATE", guildId, requiredIntents: Intents.GuildExpressions, d: toAPISound(sound, ds) });
    dispatchSoundsUpdate(bus, ds, guildId);
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.SoundboardSoundCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: sound.snowflake,
      changes: [{ key: "name", new_value: sound.name }],
      reason: auditReason(c),
    });
    return c.json(payload, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/soundboard-sounds/:soundId", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // [S-1] Modify requires CREATE_GUILD_EXPRESSIONS or MANAGE_GUILD_EXPRESSIONS.
    {
      const _p = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.CreateGuildExpressions, { guildId });
      if (_p) {
        const _p2 = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuildExpressions, { guildId });
        if (_p2) return _p2;
      }
    }
    const sound = ds.soundboardSounds.findOneBy("snowflake", c.req.param("soundId"));
    if (!sound || sound.guild_snowflake !== guildId) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // All params are optional, but when present they must satisfy the same constraints.
    if (body.name !== undefined) {
      const nameErr = validateName(body.name);
      if (nameErr) return invalidFormBody(c, { name: nameErr });
    }
    if (body.volume !== undefined && body.volume !== null) {
      const volErr = validateVolume(body.volume);
      if (volErr) return invalidFormBody(c, { volume: volErr });
    }

    const patch: Partial<DiscordSoundboardSound> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.volume === "number") patch.volume = body.volume;
    if (body.emoji_id !== undefined) patch.emoji_snowflake = typeof body.emoji_id === "string" ? body.emoji_id : null;
    if (body.emoji_name !== undefined) patch.emoji_name = typeof body.emoji_name === "string" ? body.emoji_name : null;
    const soundChanges = (Object.keys(patch) as Array<keyof DiscordSoundboardSound>).map((key) => ({
      key,
      old_value: sound[key],
      new_value: patch[key],
    }));
    ds.soundboardSounds.update(sound.id, patch);
    const payload = toAPISound(ds.soundboardSounds.findOneBy("snowflake", sound.snowflake)!, ds);
    bus.publish({
      t: "GUILD_SOUNDBOARD_SOUND_UPDATE",
      guildId: sound.guild_snowflake,
      requiredIntents: Intents.GuildExpressions,
      d: payload,
    });
    dispatchSoundsUpdate(bus, ds, sound.guild_snowflake);
    if (soundChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: sound.guild_snowflake,
        actionType: AuditLogEvent.SoundboardSoundUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: sound.snowflake,
        changes: soundChanges,
        reason: auditReason(c),
      });
    }
    return c.json(payload);
  });

  app.delete("/api/v:version/guilds/:guildId/soundboard-sounds/:soundId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // [S-1] Delete requires CREATE_GUILD_EXPRESSIONS or MANAGE_GUILD_EXPRESSIONS.
    {
      const _p = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.CreateGuildExpressions, { guildId });
      if (_p) {
        const _p2 = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuildExpressions, { guildId });
        if (_p2) return _p2;
      }
    }
    const sound = ds.soundboardSounds.findOneBy("snowflake", c.req.param("soundId"));
    if (!sound || sound.guild_snowflake !== guildId) return notFound(c);
    const soundId = sound.snowflake;
    ds.soundboardSounds.delete(sound.id);
    bus.publish({
      t: "GUILD_SOUNDBOARD_SOUND_DELETE",
      guildId,
      requiredIntents: Intents.GuildExpressions,
      d: { sound_id: soundId, guild_id: guildId },
    });
    dispatchSoundsUpdate(bus, ds, guildId);
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.SoundboardSoundDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: soundId,
      changes: [{ key: "name", old_value: sound.name }],
      reason: auditReason(c),
    });
    return new Response(null, { status: 204 });
  });

  app.post("/api/v:version/channels/:channelId/send-soundboard-sound", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channelId = c.req.param("channelId");
    const channel = ds.channels.findOneBy("snowflake", channelId);
    if (!channel) return notFound(c);

    const body = (await c.req.json().catch(() => ({}))) as { sound_id?: string; source_guild_id?: string };
    // [S-3] sound_id is required.
    if (!body.sound_id) {
      return invalidFormBody(c, { sound_id: "This field is required." });
    }
    const user = resolveBotUser(ds, auth);

    // Resolve the volume from a guild sound when known, otherwise default to full volume.
    const stored = body.sound_id ? ds.soundboardSounds.findOneBy("snowflake", body.sound_id) : null;
    const soundVolume = stored ? stored.volume : 1;

    // Fires a Voice Channel Effect Send gateway event for the voice channel.
    bus.publish({
      t: "VOICE_CHANNEL_EFFECT_SEND",
      guildId: channel.guild_snowflake ?? undefined,
      requiredIntents: Intents.GuildVoiceStates,
      d: {
        channel_id: channelId,
        guild_id: channel.guild_snowflake ?? body.source_guild_id ?? null,
        user_id: user?.snowflake ?? null,
        sound_id: body.sound_id ?? null,
        sound_volume: soundVolume,
      },
    });
    return new Response(null, { status: 204 });
  });
}
