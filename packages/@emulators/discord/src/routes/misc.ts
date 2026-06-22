import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIMessage, redactMessageContent } from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";

// A 1x1 transparent PNG, used for the guild widget image.
const WIDGET_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export function miscRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ----- Webhook platform-compatibility endpoints (GitHub / Slack) -----
  const executeCompat = async (id: string, token: string, content: string, wait: boolean) => {
    const ds = getDiscordStore(store);
    const webhook = ds.webhooks.findOneBy("snowflake", id);
    if (!webhook || webhook.token !== token) return null;
    const message = createMessage(ds, {
      channelSnowflake: webhook.channel_snowflake,
      guildSnowflake: webhook.guild_snowflake,
      authorSnowflake: webhook.user_snowflake ?? ds.applications.all()[0]?.bot_user_snowflake ?? "",
      content,
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
    return wait ? payload : null;
  };

  app.post("/api/v:version/webhooks/:webhookId/:token/github", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "event";
    const repo = (body.repository as { full_name?: string } | undefined)?.full_name ?? "repository";
    const result = await executeCompat(c.req.param("webhookId"), c.req.param("token"), `GitHub: ${action} on ${repo}`, c.req.query("wait") === "true");
    if (result === null && c.req.query("wait") === "true") return notFound(c);
    return result ? c.json(result) : new Response(null, { status: 204 });
  });

  app.post("/api/v:version/webhooks/:webhookId/:token/slack", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const result = await executeCompat(c.req.param("webhookId"), c.req.param("token"), body.text ?? "", c.req.query("wait") === "true");
    if (result === null && c.req.query("wait") === "true") return notFound(c);
    return result ? c.json(result) : new Response(null, { status: 204 });
  });

  // ----- Guild message search (returns grouped matches like Discord's search API) -----
  app.get("/api/v:version/guilds/:guildId/messages/search", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const content = (c.req.query("content") ?? "").toLowerCase();
    const authorId = c.req.query("author_id");
    const channelId = c.req.query("channel_id");
    const matches = ds.messages
      .findBy("guild_snowflake", guildId)
      .filter((m) => (!content || m.content.toLowerCase().includes(content)) && (!authorId || m.author_snowflake === authorId) && (!channelId || m.channel_snowflake === channelId))
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1));
    return c.json({ messages: matches.map((m) => [toAPIMessage(m, ds)]), total_results: matches.length });
  });

  // ----- Delete the current user's application role connection -----
  app.delete("/api/v:version/users/@me/applications/:appId/role-connection", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const existing = ds.roleConnections
      .findBy("application_snowflake", appId)
      .find((r) => r.user_snowflake === auth.user!.snowflake);
    if (existing) ds.roleConnections.delete(existing.id);
    return new Response(null, { status: 204 });
  });

  // ----- Guild incident (safety) actions -----
  app.put("/api/v:version/guilds/:guildId/incident-actions", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { invites_disabled_until?: string | null; dms_disabled_until?: string | null };
    const data = {
      invites_disabled_until: body.invites_disabled_until ?? null,
      dms_disabled_until: body.dms_disabled_until ?? null,
      dm_spam_detected_at: null,
      raid_detected_at: null,
    };
    // Persist onto the guild entity so GET /guilds/:id round-trips incidents_data.
    ds.guilds.update(guild.id, { incidents_data: data });
    return c.json(data);
  });

  // ----- Guild widget image -----
  app.get("/api/v:version/guilds/:guildId/widget.png", (c) => {
    const ds = getDiscordStore(store);
    if (!ds.guilds.findOneBy("snowflake", c.req.param("guildId"))) return notFound(c);
    return new Response(WIDGET_PNG, { status: 200, headers: { "content-type": "image/png" } });
  });

  // ----- Embedded activity instance -----
  app.get("/api/v:version/applications/:appId/activity-instances/:instanceId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const instanceId = c.req.param("instanceId");
    return c.json({
      application_id: c.req.param("appId"),
      instance_id: instanceId,
      launch_id: instanceId,
      location: { id: instanceId, kind: "gc", channel_id: null, guild_id: null },
      users: [],
    });
  });

  // ----- Invite target users (Social SDK) -----
  app.get("/api/v:version/invites/:code/target-users", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    return c.json({ target_users: [] });
  });
  app.put("/api/v:version/invites/:code/target-users", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const body = (await c.req.json().catch(() => ({}))) as { target_user_ids?: string[] };
    return c.json({ target_users: body.target_user_ids ?? [] });
  });
  app.get("/api/v:version/invites/:code/target-users/job-status", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    // Doc (invite.mdx:227-246): status is an integer enum 0-3 (0=NOT_STARTED, 1=IN_PROGRESS,
    // 2=COMPLETED, 3=ERROR). The stub returns 2 (COMPLETED) with all documented fields present.
    return c.json({
      status: 2,
      total_users: 0,
      processed_users: 0,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: null,
    });
  });
}
