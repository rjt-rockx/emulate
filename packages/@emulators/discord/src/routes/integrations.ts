import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  unknownGuild,
  unknownIntegration,
  toAPIUser,
  recordAudit,
  AuditLogEvent,
  auditReason,
  snowflake,
} from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordIntegration } from "../entities.js";

/** Serialize a stored integration to the documented Integration wire object. */
function toAPIIntegration(integ: DiscordIntegration, ds: DiscordStore): Record<string, unknown> {
  const user = integ.user_snowflake ? ds.users.findOneBy("snowflake", integ.user_snowflake) : null;
  const obj: Record<string, unknown> = {
    id: integ.snowflake,
    name: integ.name,
    type: integ.type,
    enabled: integ.enabled,
    account: integ.account,
  };
  if (integ.syncing !== undefined) obj.syncing = integ.syncing;
  if (integ.role_snowflake !== undefined) obj.role_id = integ.role_snowflake ?? null;
  if (integ.enable_emoticons !== undefined) obj.enable_emoticons = integ.enable_emoticons;
  if (integ.expire_behavior !== undefined) obj.expire_behavior = integ.expire_behavior;
  if (integ.expire_grace_period !== undefined) obj.expire_grace_period = integ.expire_grace_period;
  if (user) obj.user = toAPIUser(user);
  if (integ.synced_at !== undefined) obj.synced_at = integ.synced_at;
  if (integ.subscriber_count !== undefined) obj.subscriber_count = integ.subscriber_count;
  if (integ.revoked !== undefined) obj.revoked = integ.revoked;
  if (integ.application_snowflake !== undefined) {
    const application = integ.application_snowflake
      ? ds.applications.findOneBy("snowflake", integ.application_snowflake)
      : null;
    obj.application = application
      ? { id: application.snowflake, name: application.name, description: application.description, icon: application.icon }
      : null;
  }
  if (integ.scopes !== undefined) obj.scopes = integ.scopes;
  return obj;
}

export function integrationsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // -------------------------------------------------------------------------
  // GET /guilds/:guildId/integrations
  // -------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId/integrations", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);

    // A maximum of 50 integrations is returned.
    const integrations = ds.integrations
      .findBy("guild_snowflake", guildId)
      .slice(0, 50)
      .map((integ) => toAPIIntegration(integ, ds));
    return c.json(integrations);
  });

  // -------------------------------------------------------------------------
  // POST /guilds/:guildId/integrations  (create an integration)
  // -------------------------------------------------------------------------

  app.post("/api/v:version/guilds/:guildId/integrations", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      id: string;
      name: string;
      type: string;
      enabled: boolean;
      role_id: string | null;
      enable_emoticons: boolean;
      expire_behavior: number;
      expire_grace_period: number;
      account: { id: string; name: string };
      scopes: string[];
      application_id: string | null;
    }>;

    const integ = ds.integrations.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      name: body.name ?? "Integration",
      type: body.type ?? "discord",
      enabled: body.enabled ?? true,
      role_snowflake: body.role_id ?? null,
      enable_emoticons: body.enable_emoticons,
      expire_behavior: body.expire_behavior,
      expire_grace_period: body.expire_grace_period,
      user_snowflake: auth.user?.snowflake ?? null,
      account: body.account ?? { id: body.id ?? snowflake(), name: body.name ?? "Integration" },
      scopes: body.scopes,
      application_snowflake: body.application_id ?? null,
    });

    bus.publish({
      t: "INTEGRATION_CREATE",
      guildId,
      requiredIntents: Intents.GuildIntegrations,
      d: { ...toAPIIntegration(integ, ds), guild_id: guildId },
    });
    bus.publish({
      t: "GUILD_INTEGRATIONS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildIntegrations,
      d: { guild_id: guildId },
    });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.IntegrationCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: integ.snowflake,
      changes: [
        { key: "name", new_value: integ.name },
        { key: "type", new_value: integ.type },
      ],
      reason: auditReason(c),
    });
    return c.json(toAPIIntegration(integ, ds), 201);
  });

  // -------------------------------------------------------------------------
  // GET /guilds/:guildId/integrations/:integrationId
  // -------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId/integrations/:integrationId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const integ = ds.integrations.findOneBy("snowflake", c.req.param("integrationId"));
    if (!integ || integ.guild_snowflake !== guildId) return unknownIntegration(c);
    return c.json(toAPIIntegration(integ, ds));
  });

  // -------------------------------------------------------------------------
  // PATCH /guilds/:guildId/integrations/:integrationId  (modify an integration)
  // -------------------------------------------------------------------------

  app.patch("/api/v:version/guilds/:guildId/integrations/:integrationId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const integ = ds.integrations.findOneBy("snowflake", c.req.param("integrationId"));
    if (!integ || integ.guild_snowflake !== guildId) return unknownIntegration(c);
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      name: string;
      enabled: boolean;
      enable_emoticons: boolean;
      expire_behavior: number;
      expire_grace_period: number;
    }>;
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.enable_emoticons !== undefined) patch.enable_emoticons = body.enable_emoticons;
    if (body.expire_behavior !== undefined) patch.expire_behavior = body.expire_behavior;
    if (body.expire_grace_period !== undefined) patch.expire_grace_period = body.expire_grace_period;
    if (Object.keys(patch).length > 0) ds.integrations.update(integ.id, patch);
    const updated = ds.integrations.findOneBy("snowflake", integ.snowflake)!;

    bus.publish({
      t: "INTEGRATION_UPDATE",
      guildId,
      requiredIntents: Intents.GuildIntegrations,
      d: { ...toAPIIntegration(updated, ds), guild_id: guildId },
    });
    bus.publish({
      t: "GUILD_INTEGRATIONS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildIntegrations,
      d: { guild_id: guildId },
    });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.IntegrationUpdate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: integ.snowflake,
      changes: Object.keys(patch).map((key) => ({ key, new_value: patch[key] })),
      reason: auditReason(c),
    });
    return c.json(toAPIIntegration(updated, ds));
  });

  // -------------------------------------------------------------------------
  // DELETE /guilds/:guildId/integrations/:integrationId
  // -------------------------------------------------------------------------

  app.delete("/api/v:version/guilds/:guildId/integrations/:integrationId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const integrationId = c.req.param("integrationId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const integ = ds.integrations.findOneBy("snowflake", integrationId);
    if (!integ || integ.guild_snowflake !== guildId) return unknownIntegration(c);

    ds.integrations.delete(integ.id);

    bus.publish({
      t: "INTEGRATION_DELETE",
      guildId,
      requiredIntents: Intents.GuildIntegrations,
      d: {
        id: integrationId,
        guild_id: guildId,
        application_id: integ.application_snowflake ?? undefined,
      },
    });
    bus.publish({
      t: "GUILD_INTEGRATIONS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildIntegrations,
      d: { guild_id: guildId },
    });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.IntegrationDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: integrationId,
      reason: auditReason(c),
    });

    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // GET /users/@me/connections
  // -------------------------------------------------------------------------

  app.get("/api/v:version/users/@me/connections", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const user = auth.user;
    if (!user) return unauthorized(c);

    const ds = getDiscordStore(store);
    const connections = ds.connections.findBy("user_snowflake", user.snowflake).map((conn) => {
      const obj: Record<string, unknown> = {
        id: conn.connection_id,
        name: conn.name,
        type: conn.type,
        verified: conn.verified,
        friend_sync: conn.friend_sync,
        show_activity: conn.show_activity,
        two_way_link: conn.two_way_link,
        visibility: conn.visibility,
        integrations: [],
      };
      if (conn.revoked !== undefined) obj.revoked = conn.revoked;
      return obj;
    });

    return c.json(connections);
  });

}
