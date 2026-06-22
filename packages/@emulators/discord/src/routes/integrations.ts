import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser } from "../helpers.js";
import { Intents } from "../gateway/intents.js";

// ---------------------------------------------------------------------------
// Static sticker packs (Discord's default packs are a fixed list)
// ---------------------------------------------------------------------------

const STICKER_PACKS = [
  {
    id: "847199849233514566",
    name: "Wumpus Beyond",
    sku_id: "847199849233514567",
    cover_sticker_id: "749054660769218631",
    description: "Wumpus ventures into the future.",
    banner_asset_id: "761773501734911007",
    stickers: [],
  },
  {
    id: "847199849233514568",
    name: "Noticeably Nitro",
    sku_id: "847199849233514569",
    cover_sticker_id: "749054660769218633",
    description: "Show off your Nitro pride.",
    banner_asset_id: "761773501734911009",
    stickers: [],
  },
] as const;

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
    if (!guild) return notFound(c);

    const integrations = ds.integrations.findBy("guild_snowflake", guildId).map((integ) => {
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
    });

    return c.json(integrations);
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
    if (!guild) return notFound(c);
    const integ = ds.integrations.findOneBy("snowflake", integrationId);
    if (!integ || integ.guild_snowflake !== guildId) return notFound(c);

    ds.integrations.delete(integ.id);

    bus.publish({
      t: "INTEGRATION_DELETE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: {
        id: integrationId,
        guild_id: guildId,
        application_id: integ.application_snowflake ?? undefined,
      },
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

  // -------------------------------------------------------------------------
  // GET /sticker-packs
  // -------------------------------------------------------------------------

  app.get("/api/v:version/sticker-packs", (c) => {
    return c.json({ sticker_packs: STICKER_PACKS });
  });

  // -------------------------------------------------------------------------
  // GET /sticker-packs/:packId
  // -------------------------------------------------------------------------

  app.get("/api/v:version/sticker-packs/:packId", (c) => {
    const packId = c.req.param("packId");
    const pack = STICKER_PACKS.find((p) => p.id === packId);
    if (!pack) return notFound(c);
    return c.json(pack);
  });
}
