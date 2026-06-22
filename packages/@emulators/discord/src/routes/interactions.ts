import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, discordError, toAPIMessage, redactMessageContent } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import { buildInteraction, type TriggerInput } from "../interactions/trigger.js";
import {
  routeInteraction,
  applyInteractionResponse,
  getOriginalResponse,
  hasInvalidResponseFlags,
  type InteractionResponse,
} from "../interactions/dispatch.js";

export function interactionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // Respond to an interaction (used by Gateway bots after INTERACTION_CREATE).
  app.post("/api/v:version/interactions/:interactionId/:token/callback", async (c) => {
    const ds = getDiscordStore(store);
    const interaction = ds.interactions.findOneBy("snowflake", c.req.param("interactionId"));
    // Unknown id/token, or a token whose 15-minute window has elapsed -> 10062.
    if (!interaction || interaction.token !== c.req.param("token") || new Date(interaction.expires_at).getTime() < Date.now()) {
      return discordError(c, 404, "Unknown interaction", 10062);
    }
    // The initial response may be sent exactly once; a second ack -> 40060.
    if (interaction.callback_used) {
      return discordError(c, 400, "Interaction has already been acknowledged.", 40060);
    }
    const response = (await c.req.json().catch(() => ({ type: 1 }))) as InteractionResponse;

    // Validate flags on message-bearing callbacks.
    const callbackType = response.type;
    if (callbackType === 4 || callbackType === 5 || callbackType === 7) {
      const flags = typeof response.data?.flags === "number" ? response.data.flags : 0;
      if (flags !== 0 && hasInvalidResponseFlags(flags)) {
        return discordError(c, 400, "Invalid Form Body", 50035, {
          errors: {
            data: {
              flags: {
                _errors: [{ code: "MESSAGE_FLAG_NOT_SETTABLE", message: "This flag cannot be set on an interaction response." }],
              },
            },
          },
        });
      }
    }

    const result = applyInteractionResponse(ds, bus, store, interaction, response);

    if (c.req.query("with_response") === "true") {
      const msgSnowflake = result.message?.snowflake;
      const msgFlags = result.message?.flags ?? 0;
      const isEph = (msgFlags & 64) !== 0;
      const message = msgSnowflake ? ds.messages.findOneBy("snowflake", msgSnowflake) : undefined;
      return c.json({
        interaction: {
          id: interaction.snowflake,
          type: interaction.type,
          ...(msgSnowflake ? { response_message_id: msgSnowflake, response_message_ephemeral: isEph } : {}),
        },
        resource: {
          type: callbackType,
          ...(message ? { message: toAPIMessage(message, ds) } : {}),
        },
      });
    }
    return new Response(null, { status: 204 });
  });

  // Original interaction response (the message created by the first callback).
  const resolveOriginal = (token: string) => {
    const ds = getDiscordStore(store);
    const messageSnowflake = getOriginalResponse(store, token);
    return messageSnowflake ? ds.messages.findOneBy("snowflake", messageSnowflake) : undefined;
  };

  app.get("/api/v:version/webhooks/:appId/:token/messages/@original", (c) => {
    const ds = getDiscordStore(store);
    const message = resolveOriginal(c.req.param("token"));
    if (!message) return notFound(c);
    return c.json(toAPIMessage(message, ds));
  });

  app.patch("/api/v:version/webhooks/:appId/:token/messages/@original", async (c) => {
    const ds = getDiscordStore(store);
    const message = resolveOriginal(c.req.param("token"));
    if (!message) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = { edited_timestamp: new Date().toISOString() };
    if (typeof body.content === "string") patch.content = body.content;
    if (body.embeds !== undefined) patch.embeds = body.embeds;
    if (body.components !== undefined) patch.components = body.components;
    ds.messages.update(message.id, patch);
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

  app.delete("/api/v:version/webhooks/:appId/:token/messages/@original", (c) => {
    const ds = getDiscordStore(store);
    const message = resolveOriginal(c.req.param("token"));
    if (!message) return notFound(c);
    ds.messages.delete(message.id);
    return new Response(null, { status: 204 });
  });

  // Note: POST /webhooks/:id/:token (interaction followup OR webhook execute) is handled in
  // webhooks.ts, which disambiguates by whether the token is an interaction or webhook token.

  app.get("/api/v:version/webhooks/:appId/:token/messages/:messageId", (c) => {
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message) return notFound(c);
    return c.json(toAPIMessage(message, ds));
  });

  app.patch("/api/v:version/webhooks/:appId/:token/messages/:messageId", async (c) => {
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = { edited_timestamp: new Date().toISOString() };
    if (typeof body.content === "string") patch.content = body.content;
    if (body.embeds !== undefined) patch.embeds = body.embeds;
    if (body.components !== undefined) patch.components = body.components;
    ds.messages.update(message.id, patch);
    return c.json(toAPIMessage(ds.messages.findOneBy("snowflake", message.snowflake)!, ds));
  });

  app.delete("/api/v:version/webhooks/:appId/:token/messages/:messageId", (c) => {
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message) return notFound(c);
    ds.messages.delete(message.id);
    return new Response(null, { status: 204 });
  });

  // Emulator control plane: simulate a user triggering an interaction. Not a real Discord
  // route. Routes the interaction to the bot over the Gateway and/or the HTTP endpoint.
  app.post("/__emulate/interactions", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const input = (await c.req.json().catch(() => ({}))) as TriggerInput;
    const built = buildInteraction(ds, input);
    if (!built) return notFound(c);
    const result = await routeInteraction(bus, built.application, built.payload);
    if (result.httpResponse) applyInteractionResponse(ds, bus, store, built.record, result.httpResponse);
    return c.json({
      id: built.record.snowflake,
      token: built.record.token,
      interaction: built.payload,
      response: result.httpResponse ?? null,
      delivered: result.delivered,
    });
  });
}
