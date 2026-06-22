import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound } from "../helpers.js";

export function roleConnectionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // Application role-connection metadata records.
  app.get("/api/v:version/applications/:appId/role-connections/metadata", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const application = ds.applications.findOneBy("snowflake", c.req.param("appId")) ?? ds.applications.all()[0];
    if (!application) return notFound(c);
    return c.json(application.role_connection_metadata ?? []);
  });

  app.put("/api/v:version/applications/:appId/role-connections/metadata", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const application = ds.applications.findOneBy("snowflake", c.req.param("appId")) ?? ds.applications.all()[0];
    if (!application) return notFound(c);
    const body = (await c.req.json().catch(() => [])) as unknown[];
    const records = Array.isArray(body) ? body : [];
    ds.applications.update(application.id, { role_connection_metadata: records });
    return c.json(records);
  });

  // The authed user's application role connection.
  app.get("/api/v:version/users/@me/applications/:appId/role-connection", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const existing = ds.roleConnections
      .findBy("application_snowflake", appId)
      .find((r) => r.user_snowflake === auth.user!.snowflake);
    return c.json({
      platform_name: existing?.platform_name ?? null,
      platform_username: existing?.platform_username ?? null,
      metadata: existing?.metadata ?? {},
    });
  });

  app.put("/api/v:version/users/@me/applications/:appId/role-connection", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const body = (await c.req.json().catch(() => ({}))) as {
      platform_name?: string;
      platform_username?: string;
      metadata?: Record<string, string>;
    };
    const existing = ds.roleConnections
      .findBy("application_snowflake", appId)
      .find((r) => r.user_snowflake === auth.user!.snowflake);
    if (existing) {
      ds.roleConnections.update(existing.id, {
        platform_name: body.platform_name ?? existing.platform_name,
        platform_username: body.platform_username ?? existing.platform_username,
        metadata: body.metadata ?? existing.metadata,
      });
    } else {
      ds.roleConnections.insert({
        application_snowflake: appId,
        user_snowflake: auth.user.snowflake,
        platform_name: body.platform_name ?? null,
        platform_username: body.platform_username ?? null,
        metadata: body.metadata ?? {},
      });
    }
    return c.json({
      platform_name: body.platform_name ?? existing?.platform_name ?? null,
      platform_username: body.platform_username ?? existing?.platform_username ?? null,
      metadata: body.metadata ?? existing?.metadata ?? {},
    });
  });
}
