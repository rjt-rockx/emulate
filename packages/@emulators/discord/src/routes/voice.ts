import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { requireBot, requireUser, notFound, toAPIVoiceState, invalidFormBody, requirePermission } from "../helpers.js";
import { PermissionFlags } from "../permissions.js";
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
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const state = findState(c.req.param("guildId"), auth.user!.snowflake);
    if (!state) return notFound(c);
    return c.json(toAPIVoiceState(state, ds));
  });

  app.get("/api/v:version/guilds/:guildId/voice-states/:userId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const state = findState(c.req.param("guildId"), c.req.param("userId"));
    if (!state) return notFound(c);
    return c.json(toAPIVoiceState(state, ds));
  });

  // Modify own voice state (suppress / request-to-speak / move within a stage channel).
  app.patch("/api/v:version/guilds/:guildId/voice-states/@me", async (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    const state = findState(guildId, auth.user!.snowflake);
    if (!state) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      channel_id?: string;
      suppress?: boolean;
      request_to_speak_timestamp?: string | null;
    };

    // [V1] When channel_id is provided in the body, it must point to a stage channel (type 13).
    if (body.channel_id !== undefined) {
      const ch = ds.channels.findOneBy("snowflake", body.channel_id);
      if (!ch || ch.type !== 13) {
        return invalidFormBody(c, { channel_id: "Must be a stage channel." });
      }
    }

    // The effective channel for permission checks is the provided channel_id or the existing one.
    const effectiveChannelId = body.channel_id ?? state.channel_snowflake ?? "";

    // [V1] Unsuppressing self requires MUTE_MEMBERS; requesting to speak requires REQUEST_TO_SPEAK.
    if (body.suppress === false) {
      const _p = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.MuteMembers, { channelId: effectiveChannelId });
      if (_p) return _p;
    }
    if (body.request_to_speak_timestamp !== undefined && body.request_to_speak_timestamp !== null) {
      const _p = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.RequestToSpeak, { channelId: effectiveChannelId });
      if (_p) return _p;
    }

    const patch: Record<string, unknown> = {};
    if (body.suppress !== undefined) patch.suppress = body.suppress;
    if (body.request_to_speak_timestamp !== undefined) patch.request_to_speak_timestamp = body.request_to_speak_timestamp;
    if (body.channel_id !== undefined) patch.channel_snowflake = body.channel_id;
    ds.voiceStates.update(state.id, patch);
    const updated = ds.voiceStates.get(state.id)!;
    bus.publish({ t: "VOICE_STATE_UPDATE", guildId, requiredIntents: Intents.GuildVoiceStates, d: toAPIVoiceState(updated, ds) });
    return new Response(null, { status: 204 });
  });

  // Modify another user's voice state (e.g. a moderator suppressing a speaker). Per the docs the
  // only JSON params are `channel_id` and `suppress`; `request_to_speak_timestamp` is NOT accepted
  // here and is instead governed by the suppress caveats below.
  app.patch("/api/v:version/guilds/:guildId/voice-states/:userId", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const state = findState(guildId, userId);
    if (!state) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { channel_id?: string; suppress?: boolean };

    // [V1] When channel_id is provided in the body, it must point to a stage channel (type 13).
    if (body.channel_id !== undefined) {
      const ch = ds.channels.findOneBy("snowflake", body.channel_id);
      if (!ch || ch.type !== 13) {
        return invalidFormBody(c, { channel_id: "Must be a stage channel." });
      }
    }

    // The effective channel for permission checks.
    const effectiveChannelId = body.channel_id ?? state.channel_snowflake ?? "";

    // [V1] Modifying others requires MUTE_MEMBERS.
    { const _p = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.MuteMembers, { channelId: effectiveChannelId }); if (_p) return _p; }

    const patch: Record<string, unknown> = {};
    if (body.channel_id !== undefined) patch.channel_snowflake = body.channel_id;
    if (body.suppress !== undefined) {
      patch.suppress = body.suppress;
      if (body.suppress) {
        // Caveat: when suppressed, the user's request_to_speak_timestamp is removed.
        patch.request_to_speak_timestamp = null;
      } else {
        // Caveat: when unsuppressed, non-bot users get request_to_speak_timestamp set to the
        // current time; bot users do not.
        const target = ds.users.findOneBy("snowflake", userId);
        patch.request_to_speak_timestamp = target?.bot ? null : new Date().toISOString();
      }
    }
    ds.voiceStates.update(state.id, patch);
    const updated = ds.voiceStates.get(state.id)!;
    bus.publish({ t: "VOICE_STATE_UPDATE", guildId, requiredIntents: Intents.GuildVoiceStates, d: toAPIVoiceState(updated, ds) });
    return new Response(null, { status: 204 });
  });
}
