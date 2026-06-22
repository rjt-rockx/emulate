import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake, toAPIUser, toAPIMessage, redactMessageContent, recordAudit, AuditLogEvent, isEphemeral } from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import { getOriginalResponse, setOriginalResponse } from "../interactions/dispatch.js";
import type { DiscordWebhook } from "../entities.js";

function toAPIWebhook(w: DiscordWebhook, ds: DiscordStore, baseUrl: string): Record<string, unknown> {
  const creator = w.user_snowflake ? ds.users.findOneBy("snowflake", w.user_snowflake) : null;
  return {
    id: w.snowflake,
    type: w.type,
    guild_id: w.guild_snowflake,
    channel_id: w.channel_snowflake,
    user: creator ? toAPIUser(creator) : undefined,
    name: w.name,
    avatar: w.avatar,
    token: w.token,
    application_id: w.application_snowflake,
    url: `${baseUrl}/api/v10/webhooks/${w.snowflake}/${w.token}`,
  };
}

export function webhooksRoutes(ctx: DiscordRouteContext): void {
  const { app, store, baseUrl, bus } = ctx;

  // ----- Channel / guild webhook management -----
  app.post("/api/v:version/channels/:channelId/webhooks", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; avatar?: string | null };
    const webhook = ds.webhooks.insert({
      snowflake: snowflake(),
      type: 1,
      guild_snowflake: channel.guild_snowflake,
      channel_snowflake: channel.snowflake,
      user_snowflake: auth.user?.snowflake ?? null,
      name: body.name ?? "Captain Hook",
      avatar: body.avatar ?? null,
      token: `whk_${snowflake()}_${Math.random().toString(36).slice(2)}`,
      application_snowflake: auth.application?.snowflake ?? null,
    });
    recordAudit(ds, {
      guildSnowflake: channel.guild_snowflake,
      actionType: AuditLogEvent.WebhookCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: webhook.snowflake,
      changes: [{ key: "name", new_value: webhook.name }],
    });
    return c.json(toAPIWebhook(webhook, ds, baseUrl), 200);
  });

  app.get("/api/v:version/channels/:channelId/webhooks", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const hooks = ds.webhooks.findBy("channel_snowflake", c.req.param("channelId")).map((w) => toAPIWebhook(w, ds, baseUrl));
    return c.json(hooks);
  });

  app.get("/api/v:version/guilds/:guildId/webhooks", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const hooks = ds.webhooks
      .all()
      .filter((w) => w.guild_snowflake === c.req.param("guildId"))
      .map((w) => toAPIWebhook(w, ds, baseUrl));
    return c.json(hooks);
  });

  app.get("/api/v:version/webhooks/:webhookId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", c.req.param("webhookId"));
    if (!webhook) return notFound(c);
    return c.json(toAPIWebhook(webhook, ds, baseUrl));
  });

  app.get("/api/v:version/webhooks/:webhookId/:token", (c) => {
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", c.req.param("webhookId"));
    if (!webhook || webhook.token !== c.req.param("token")) return notFound(c);
    return c.json(toAPIWebhook(webhook, ds, baseUrl));
  });

  const modify = async (c: Context<AppEnv>, requireToken: boolean) => {
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", c.req.param("webhookId"));
    if (!webhook) return notFound(c);
    if (requireToken && webhook.token !== c.req.param("token")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; avatar?: string | null; channel_id?: string };
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (!requireToken && body.channel_id !== undefined) patch.channel_snowflake = body.channel_id;
    ds.webhooks.update(webhook.id, patch);
    return c.json(toAPIWebhook(ds.webhooks.findOneBy("snowflake", webhook.snowflake)!, ds, baseUrl));
  };

  app.patch("/api/v:version/webhooks/:webhookId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return modify(c, false);
  });
  app.patch("/api/v:version/webhooks/:webhookId/:token", (c) => modify(c, true));

  const remove = (c: Context<AppEnv>, requireToken: boolean, actorSnowflake?: string | null) => {
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", c.req.param("webhookId"));
    if (!webhook) return notFound(c);
    if (requireToken && webhook.token !== c.req.param("token")) return notFound(c);
    ds.webhooks.delete(webhook.id);
    recordAudit(ds, {
      guildSnowflake: webhook.guild_snowflake,
      actionType: AuditLogEvent.WebhookDelete,
      actorSnowflake: actorSnowflake ?? null,
      targetSnowflake: webhook.snowflake,
      changes: [{ key: "name", old_value: webhook.name }],
    });
    return new Response(null, { status: 204 });
  };

  app.delete("/api/v:version/webhooks/:webhookId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return remove(c, false, auth.user?.snowflake ?? null);
  });
  app.delete("/api/v:version/webhooks/:webhookId/:token", (c) => remove(c, true));

  // ----- Unified POST /webhooks/:id/:token: interaction followup OR webhook execute -----
  app.post("/api/v:version/webhooks/:id/:token", async (c) => {
    const ds = getDiscordStore(store);
    const id = c.req.param("id");
    const token = c.req.param("token");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Interaction followup: the token matches a stored interaction.
    const interaction = ds.interactions.findOneBy("token", token);
    if (interaction) {
      const application = ds.applications.findOneBy("snowflake", id) ?? ds.applications.all()[0];
      if (!interaction.channel_snowflake || !application) return notFound(c);
      const message = createMessage(ds, {
        channelSnowflake: interaction.channel_snowflake,
        guildSnowflake: interaction.guild_snowflake,
        authorSnowflake: application.bot_user_snowflake,
        content: typeof body.content === "string" ? body.content : "",
        embeds: (body.embeds as unknown[]) ?? [],
        components: (body.components as unknown[]) ?? [],
        flags: typeof body.flags === "number" ? body.flags : 0,
      });
      if (!getOriginalResponse(store, token)) setOriginalResponse(store, token, message.snowflake);
      const payload = toAPIMessage(message, ds);
      // Ephemeral followups reach only the invoking user — never broadcast them.
      if (!isEphemeral(typeof body.flags === "number" ? body.flags : 0)) {
        bus.publish({
          t: "MESSAGE_CREATE",
          guildId: message.guild_snowflake,
          requiredIntents: message.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
          d: payload,
          redactedData: redactMessageContent(payload),
          messageAuthorId: application.bot_user_snowflake,
        });
      }
      return c.json(payload);
    }

    // Webhook execute.
    const webhook = ds.webhooks.findOneBy("snowflake", id);
    if (!webhook || webhook.token !== token) return notFound(c);
    const message = createMessage(ds, {
      channelSnowflake: webhook.channel_snowflake,
      guildSnowflake: webhook.guild_snowflake,
      authorSnowflake: webhook.user_snowflake ?? ds.applications.all()[0]?.bot_user_snowflake ?? "",
      content: typeof body.content === "string" ? body.content : "",
      embeds: (body.embeds as unknown[]) ?? [],
      components: (body.components as unknown[]) ?? [],
      webhookSnowflake: webhook.snowflake,
    });
    const payload = toAPIMessage(message, ds);
    bus.publish({
      t: "MESSAGE_CREATE",
      guildId: webhook.guild_snowflake,
      requiredIntents: webhook.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
      d: payload,
      redactedData: redactMessageContent(payload),
      messageAuthorId: message.author_snowflake,
    });
    // ?wait=true returns the created message; otherwise Discord returns 204.
    if (c.req.query("wait") === "true") return c.json(payload);
    return new Response(null, { status: 204 });
  });
}
