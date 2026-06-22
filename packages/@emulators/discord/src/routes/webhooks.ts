import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, discordError, invalidFormBody, unknownChannel, unknownWebhook, snowflake, toAPIUser, toAPIMessage, redactMessageContent, recordAudit, AuditLogEvent, isEphemeral, parseMessageBody, MessageFlags } from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import { getOriginalResponse, setOriginalResponse } from "../interactions/dispatch.js";
import type { DiscordWebhook } from "../entities.js";

function toAPIWebhook(w: DiscordWebhook, ds: DiscordStore, baseUrl: string, opts: { withUser?: boolean } = {}): Record<string, unknown> {
  const creator = opts.withUser !== false && w.user_snowflake ? ds.users.findOneBy("snowflake", w.user_snowflake) : null;
  const out: Record<string, unknown> = {
    id: w.snowflake,
    type: w.type,
    guild_id: w.guild_snowflake,
    channel_id: w.channel_snowflake,
    name: w.name,
    avatar: w.avatar,
    token: w.token,
    application_id: w.application_snowflake,
    url: `${baseUrl}/api/v10/webhooks/${w.snowflake}/${w.token}`,
  };
  // The docs specify "not returned when getting a webhook with its token".
  if (opts.withUser !== false && creator) {
    out.user = toAPIUser(creator);
  }
  return out;
}

export function webhooksRoutes(ctx: DiscordRouteContext): void {
  const { app, store, baseUrl, bus } = ctx;

  const emitWebhooksUpdate = (guildId: string | null, channelId: string): void => {
    bus.publish({
      t: "WEBHOOKS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildWebhooks,
      d: { guild_id: guildId ?? undefined, channel_id: channelId },
    });
  };

  // ----- Channel / guild webhook management -----
  app.post("/api/v:version/channels/:channelId/webhooks", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return unknownChannel(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; avatar?: string | null };
    const webhookName = body.name ?? "Captain Hook";
    // Validate webhook name: must be 1-80 chars and must not contain "clyde" or "discord" (case-insensitive).
    if (webhookName.length < 1 || webhookName.length > 80) {
      return invalidFormBody(c, { name: "Must be between 1 and 80 in length." });
    }
    if (/clyde|discord/i.test(webhookName)) {
      return invalidFormBody(c, { name: "Webhook names cannot contain 'clyde' or 'discord'." });
    }
    const webhook = ds.webhooks.insert({
      snowflake: snowflake(),
      type: 1,
      guild_snowflake: channel.guild_snowflake,
      channel_snowflake: channel.snowflake,
      user_snowflake: auth.user?.snowflake ?? null,
      name: webhookName,
      avatar: body.avatar ?? null,
      token: `whk_${snowflake()}_${Math.random().toString(36).slice(2)}`,
      application_snowflake: auth.application?.snowflake ?? null,
    });
    recordAudit(ds, bus, {
      guildSnowflake: channel.guild_snowflake,
      actionType: AuditLogEvent.WebhookCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: webhook.snowflake,
      changes: [{ key: "name", new_value: webhook.name }],
    });
    emitWebhooksUpdate(channel.guild_snowflake, channel.snowflake);
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
    if (!webhook) return unknownWebhook(c);
    return c.json(toAPIWebhook(webhook, ds, baseUrl));
  });

  app.get("/api/v:version/webhooks/:webhookId/:token", (c) => {
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", c.req.param("webhookId"));
    if (!webhook || webhook.token !== c.req.param("token")) return unknownWebhook(c);
    // Per docs: "does not return a user in the webhook object" when fetching with token.
    return c.json(toAPIWebhook(webhook, ds, baseUrl, { withUser: false }));
  });

  const modify = async (c: Context<AppEnv>, requireToken: boolean) => {
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", c.req.param("webhookId"));
    if (!webhook) return unknownWebhook(c);
    if (requireToken && webhook.token !== c.req.param("token")) return unknownWebhook(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; avatar?: string | null; channel_id?: string };
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (!requireToken && body.channel_id !== undefined) patch.channel_snowflake = body.channel_id;
    ds.webhooks.update(webhook.id, patch);
    const saved = ds.webhooks.findOneBy("snowflake", webhook.snowflake)!;
    emitWebhooksUpdate(saved.guild_snowflake, saved.channel_snowflake);
    // Token-based modify does not return user.
    return c.json(toAPIWebhook(saved, ds, baseUrl, { withUser: !requireToken }));
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
    if (!webhook) return unknownWebhook(c);
    if (requireToken && webhook.token !== c.req.param("token")) return unknownWebhook(c);
    ds.webhooks.delete(webhook.id);
    recordAudit(ds, bus, {
      guildSnowflake: webhook.guild_snowflake,
      actionType: AuditLogEvent.WebhookDelete,
      actorSnowflake: actorSnowflake ?? null,
      targetSnowflake: webhook.snowflake,
      changes: [{ key: "name", old_value: webhook.name }],
    });
    emitWebhooksUpdate(webhook.guild_snowflake, webhook.channel_snowflake);
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
    // Accept JSON or multipart/form-data (file uploads).
    const { body, attachments: uploaded } = await parseMessageBody(c, baseUrl, id);

    // Interaction followup: the token matches a stored interaction.
    const interaction = ds.interactions.findOneBy("token", token);
    if (interaction) {
      const application = ds.applications.findOneBy("snowflake", id) ?? ds.applications.all()[0];
      if (!interaction.channel_snowflake || !application) return notFound(c);

      // Per doc (mdx:479): when the first followup POST arrives right after a
      // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5) response, this endpoint
      // behaves like Edit Original Interaction Response — it edits the loading
      // placeholder in place rather than creating a new message. A registered
      // @original whose message still has the Loading flag (1<<7 = 128) is the
      // signal that the deferred placeholder has not yet been replaced.
      const existingOriginalSnowflake = getOriginalResponse(store, token);
      if (existingOriginalSnowflake) {
        const existingOriginal = ds.messages.findOneBy("snowflake", existingOriginalSnowflake);
        if (existingOriginal && (existingOriginal.flags & MessageFlags.Loading) !== 0) {
          // Edit the loading placeholder in place (clear Loading flag, apply new content).
          const patch: Record<string, unknown> = {
            edited_timestamp: new Date().toISOString(),
            flags: existingOriginal.flags & ~MessageFlags.Loading,
          };
          if (typeof body.content === "string") patch.content = body.content;
          if (body.embeds !== undefined) patch.embeds = body.embeds;
          if (body.components !== undefined) patch.components = body.components;
          ds.messages.update(existingOriginal.id, patch);
          const updated = ds.messages.findOneBy("snowflake", existingOriginalSnowflake)!;
          const payload = toAPIMessage(updated, ds);
          if (!isEphemeral(updated.flags)) {
            bus.publish({
              t: "MESSAGE_UPDATE",
              guildId: updated.guild_snowflake,
              requiredIntents: updated.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
              d: payload,
              redactedData: redactMessageContent(payload),
              messageAuthorId: updated.author_snowflake,
            });
          }
          return c.json(payload);
        }
      }

      // Normal followup: create a new message in the channel.
      const message = createMessage(ds, {
        channelSnowflake: interaction.channel_snowflake,
        guildSnowflake: interaction.guild_snowflake,
        authorSnowflake: application.bot_user_snowflake,
        content: typeof body.content === "string" ? body.content : "",
        embeds: (body.embeds as unknown[]) ?? [],
        components: (body.components as unknown[]) ?? [],
        attachments: uploaded,
        flags: typeof body.flags === "number" ? body.flags : 0,
      });
      if (!existingOriginalSnowflake) setOriginalResponse(store, token, message.snowflake);
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
    if (!webhook || webhook.token !== token) return unknownWebhook(c);

    const rawFlags = typeof body.flags === "number" ? body.flags : 0;
    const isComponentsV2 = (rawFlags & MessageFlags.IsComponentsV2) !== 0;

    // Per doc (L256-257): when IS_COMPONENTS_V2 is set, content/embeds/files/poll must not be provided.
    if (isComponentsV2) {
      const hasContentV2 = typeof body.content === "string" && body.content.length > 0;
      const hasEmbedsV2 = Array.isArray(body.embeds) && body.embeds.length > 0;
      const hasFilesV2 = uploaded.length > 0;
      const hasPollV2 = body.poll != null;
      if (hasContentV2 || hasEmbedsV2 || hasFilesV2 || hasPollV2) {
        return discordError(c, 400, "Cannot mix IS_COMPONENTS_V2 with content, embeds, files, or poll.", 50035);
      }
    }

    // Per doc (L252): the `with_components` query param gates components for non-app-owned webhooks.
    // Application-owned webhooks (application_snowflake set) can always send components.
    // Non-owned webhooks need with_components=true to include components.
    const withComponents = c.req.query("with_components") === "true";
    const isAppOwned = webhook.application_snowflake != null;
    const resolvedComponents = (Array.isArray(body.components) ? body.components : []) as unknown[];
    const effectiveComponents = (isAppOwned || withComponents) ? resolvedComponents : [];

    // Per docs: "you must provide a value for at least one of content, embeds, components, file, or poll".
    const hasContent = typeof body.content === "string" && body.content.length > 0;
    const hasEmbeds = Array.isArray(body.embeds) && body.embeds.length > 0;
    const hasComponents = effectiveComponents.length > 0;
    const hasPoll = body.poll != null;
    const hasFiles = uploaded.length > 0;
    if (!hasContent && !hasEmbeds && !hasComponents && !hasPoll && !hasFiles) {
      return discordError(c, 400, "Cannot send an empty message", 50006);
    }

    // ?thread_id (or body.thread_id) posts into a thread under the webhook's channel.
    const threadId = c.req.query("thread_id") ?? (typeof body.thread_id === "string" ? body.thread_id : undefined);
    const targetChannel = threadId && ds.channels.findOneBy("snowflake", threadId) ? threadId : webhook.channel_snowflake;
    const message = createMessage(ds, {
      channelSnowflake: targetChannel,
      guildSnowflake: webhook.guild_snowflake,
      authorSnowflake: webhook.user_snowflake ?? ds.applications.all()[0]?.bot_user_snowflake ?? "",
      content: typeof body.content === "string" ? body.content : "",
      embeds: (body.embeds as unknown[]) ?? [],
      components: effectiveComponents,
      attachments: uploaded,
      tts: body.tts === true,
      flags: rawFlags,
      webhookSnowflake: webhook.snowflake,
      webhookUsername: typeof body.username === "string" ? body.username : (webhook.name ?? null),
      webhookAvatar: typeof body.avatar_url === "string" ? body.avatar_url : webhook.avatar,
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
