import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake, toAPIUser, recordAudit, AuditLogEvent, auditReason } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordSoundboardSound } from "../entities.js";

const DEFAULT_SOUNDS = [
  { sound_id: "1", name: "quack", volume: 1, emoji_id: null, emoji_name: "\u{1F986}" },
  { sound_id: "2", name: "pop", volume: 1, emoji_id: null, emoji_name: "\u{1F4A5}" },
];

function toAPISound(s: DiscordSoundboardSound, ds: DiscordStore): Record<string, unknown> {
  const creator = s.creator_snowflake ? ds.users.findOneBy("snowflake", s.creator_snowflake) : null;
  return {
    sound_id: s.snowflake,
    name: s.name,
    volume: s.volume,
    emoji_id: s.emoji_snowflake,
    emoji_name: s.emoji_name,
    guild_id: s.guild_snowflake,
    available: s.available,
    user: creator ? toAPIUser(creator) : undefined,
  };
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
    return c.json({ items: ds.soundboardSounds.findBy("guild_snowflake", c.req.param("guildId")).map((s) => toAPISound(s, ds)) });
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
    const sound = ds.soundboardSounds.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      name: typeof body.name === "string" ? body.name : "sound",
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
    const patch: Partial<DiscordSoundboardSound> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.volume === "number") patch.volume = body.volume;
    const soundChanges = (Object.keys(patch) as Array<keyof DiscordSoundboardSound>).map((key) => ({
      key,
      old_value: sound[key],
      new_value: patch[key],
    }));
    ds.soundboardSounds.update(sound.id, patch);
    const payload = toAPISound(ds.soundboardSounds.findOneBy("snowflake", sound.snowflake)!, ds);
    bus.publish({ t: "GUILD_SOUNDBOARD_SOUND_UPDATE", guildId: sound.guild_snowflake, requiredIntents: Intents.GuildExpressions, d: payload });
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
    bus.publish({ t: "GUILD_SOUNDBOARD_SOUND_DELETE", guildId, requiredIntents: Intents.GuildExpressions, d: { sound_id: soundId, guild_id: guildId } });
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
    if (!ds.channels.findOneBy("snowflake", c.req.param("channelId"))) return notFound(c);
    return new Response(null, { status: 204 });
  });
}
