import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIMessage, redactMessageContent } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import { buildInteraction, type TriggerInput } from "../interactions/trigger.js";
import { routeInteraction, applyInteractionResponse, getOriginalResponse } from "../interactions/dispatch.js";

export function interactionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // Respond to an interaction (used by Gateway bots after INTERACTION_CREATE).
  app.post("/api/v:version/interactions/:interactionId/:token/callback", async (c) => {
    const ds = getDiscordStore(store);
    const interaction = ds.interactions.findOneBy("snowflake", c.req.param("interactionId"));
    if (!interaction || interaction.token !== c.req.param("token")) return notFound(c);
    const response = (await c.req.json().catch(() => ({ type: 1 }))) as { type: number; data?: Record<string, unknown> };
    applyInteractionResponse(ds, bus, store, interaction, response);
    if (c.req.query("with_response") === "true") {
      return c.json({ interaction: { id: interaction.snowflake }, resource: {} });
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
