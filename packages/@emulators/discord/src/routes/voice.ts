import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIVoiceState } from "../helpers.js";
import { Intents } from "../gateway/intents.js";

/**
 * Voice-state REST endpoints. Voice states themselves are created/updated/removed by the
 * gateway when a client sends a Voice State Update (op 4) — see gateway/server.ts. These
 * endpoints read and mutate that state (e.g. a bot un-suppressing itself to speak on a
 * stage, or moving/disconnecting a member).
 */
export function voiceRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const findState = (guildId: string, userId: string) => {
    const ds = getDiscordStore(store);
    return ds.voiceStates.findBy("guild_snowflake", guildId).find((v) => v.user_snowflake === userId);
  };

  app.get("/api/v:version/guilds/:guildId/voice-states/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const state = findState(c.req.param("guildId"), auth.user.snowflake);
    if (!state) return notFound(c);
    return c.json(toAPIVoiceState(state, ds));
  });

  app.get("/api/v:version/guilds/:guildId/voice-states/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const state = findState(c.req.param("guildId"), c.req.param("userId"));
    if (!state) return notFound(c);
    return c.json(toAPIVoiceState(state, ds));
  });

  // Modify own voice state (suppress / request-to-speak / move within a stage channel).
  app.patch("/api/v:version/guilds/:guildId/voice-states/@me", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const state = findState(guildId, auth.user.snowflake);
    if (!state) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      channel_id?: string;
      suppress?: boolean;
      request_to_speak_timestamp?: string | null;
    };
    const patch: Record<string, unknown> = {};
    if (body.suppress !== undefined) patch.suppress = body.suppress;
    if (body.request_to_speak_timestamp !== undefined) patch.request_to_speak_timestamp = body.request_to_speak_timestamp;
    if (body.channel_id !== undefined) patch.channel_snowflake = body.channel_id;
    ds.voiceStates.update(state.id, patch);
    const updated = ds.voiceStates.get(state.id)!;
    bus.publish({ t: "VOICE_STATE_UPDATE", guildId, requiredIntents: Intents.GuildVoiceStates, d: toAPIVoiceState(updated, ds) });
    return new Response(null, { status: 204 });
  });

  // Modify another user's voice state (e.g. a moderator suppressing a speaker).
  app.patch("/api/v:version/guilds/:guildId/voice-states/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const state = findState(guildId, c.req.param("userId"));
    if (!state) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { channel_id?: string; suppress?: boolean };
    const patch: Record<string, unknown> = {};
    if (body.suppress !== undefined) patch.suppress = body.suppress;
    if (body.channel_id !== undefined) patch.channel_snowflake = body.channel_id;
    ds.voiceStates.update(state.id, patch);
    const updated = ds.voiceStates.get(state.id)!;
    bus.publish({ t: "VOICE_STATE_UPDATE", guildId, requiredIntents: Intents.GuildVoiceStates, d: toAPIVoiceState(updated, ds) });
    return new Response(null, { status: 204 });
  });
}
