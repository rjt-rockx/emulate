import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  snowflake,
  invalidFormBody,
  toAPIUser,
  recordAudit,
  AuditLogEvent,
  auditReason,
  resolveBotUser,
} from "../helpers.js";
import { Intents } from "../gateway/intents.js";
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

function toAPISound(s: DiscordSoundboardSound, ds: DiscordStore): Record<string, unknown> {
  const creator = s.creator_snowflake ? ds.users.findOneBy("snowflake", s.creator_snowflake) : null;
  return {
    name: s.name,
    sound_id: s.snowflake,
    volume: s.volume,
    emoji_id: s.emoji_snowflake,
    emoji_name: s.emoji_name,
    guild_id: s.guild_snowflake,
    available: s.available,
    user: creator ? toAPIUser(creator) : undefined,
  };
}

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

export function soundboardRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  app.get("/api/v:version/soundboard-default-sounds", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    return c.json(DEFAULT_SOUNDS);
  });

  app.get("/api/v:version/guilds/:guildId/soundboard-sounds", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json({
      items: ds.soundboardSounds.findBy("guild_snowflake", c.req.param("guildId")).map((s) => toAPISound(s, ds)),
    });
  });

  app.get("/api/v:version/guilds/:guildId/soundboard-sounds/:soundId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const sound = ds.soundboardSounds.findOneBy("snowflake", c.req.param("soundId"));
    if (!sound || sound.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    return c.json(toAPISound(sound, ds));
  });

  app.post("/api/v:version/guilds/:guildId/soundboard-sounds", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // name (2-32) is required; sound is a data uri (validated when present — the emulator does
    // not persist the bytes); volume (if present) must be 0-1.
    const nameErr = validateName(body.name);
    if (nameErr) return invalidFormBody(c, { name: nameErr });
    if ("sound" in body && (typeof body.sound !== "string" || body.sound.length === 0)) {
      return invalidFormBody(c, { sound: "Invalid sound data" });
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
    const payload = toAPISound(sound, ds);
    bus.publish({ t: "GUILD_SOUNDBOARD_SOUND_CREATE", guildId, requiredIntents: Intents.GuildExpressions, d: payload });
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
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const sound = ds.soundboardSounds.findOneBy("snowflake", c.req.param("soundId"));
    if (!sound || sound.guild_snowflake !== c.req.param("guildId")) return notFound(c);
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
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const sound = ds.soundboardSounds.findOneBy("snowflake", c.req.param("soundId"));
    if (!sound || sound.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const guildId = sound.guild_snowflake;
    const soundId = sound.snowflake;
    ds.soundboardSounds.delete(sound.id);
    bus.publish({
      t: "GUILD_SOUNDBOARD_SOUND_DELETE",
      guildId,
      requiredIntents: Intents.GuildExpressions,
      d: { sound_id: soundId, guild_id: guildId },
    });
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
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const channel = ds.channels.findOneBy("snowflake", channelId);
    if (!channel) return notFound(c);

    const body = (await c.req.json().catch(() => ({}))) as { sound_id?: string; source_guild_id?: string };
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
