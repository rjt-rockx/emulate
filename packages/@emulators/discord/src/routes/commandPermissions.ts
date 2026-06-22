import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, requireBot, unauthorized, discordError } from "../helpers.js";

/** Discord API error code for unknown application command permissions. */
const UNKNOWN_COMMAND_PERMISSIONS_CODE = 10066;

/**
 * Pattern for the guild-wide list endpoint:
 *   GET /api/v<ver>/applications/<appId>/guilds/<guildId>/commands/permissions
 *
 * This path conflicts with the existing applicationCommands route
 *   GET /api/v:version/applications/:appId/guilds/:guildId/commands/:commandId
 * which is registered first in the plugin and would intercept it.
 *
 * We use `app.use()` (middleware) here because middleware runs BEFORE the matched
 * route handler in the custom Hono dispatch chain. A middleware that returns a
 * Response short-circuits dispatch, preventing the applicationCommands handler from
 * running.
 */
const GUILD_PERMISSIONS_RE =
  /^\/api\/v[^/]+\/applications\/([^/]+)\/guilds\/([^/]+)\/commands\/permissions$/;

export function commandPermissionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const emitPermsUpdate = (appId: string, guildId: string, commandId: string, permissions: unknown): void => {
    bus.publish({
      t: "APPLICATION_COMMAND_PERMISSIONS_UPDATE",
      guildId,
      requiredIntents: 0,
      applicationId: appId,
      d: { id: commandId, application_id: appId, guild_id: guildId, permissions },
    });
  };

  // GET /api/v:version/applications/:appId/guilds/:guildId/commands/permissions
  // Returns ALL command-permission objects in the guild for the application.
  // Registered as middleware to take precedence over the existing dynamic
  // applicationCommands route /:commandId that was registered before us.
  app.use(async (c, next) => {
    const m = GUILD_PERMISSIONS_RE.exec(c.req.path);
    if (!m) return next();
    const appId = m[1];
    const guildId = m[2];
    const ds = getDiscordStore(store);

    if (c.req.method === "GET") {
      const gb = requireBot(c, store);
      if (gb instanceof Response) return gb;
      const rows = ds.commandPermissions
        .findBy("application_snowflake", appId)
        .filter((row) => row.guild_snowflake === guildId);
      return c.json(
        rows.map((row) => ({ id: row.command_snowflake, application_id: appId, guild_id: guildId, permissions: row.permissions })),
      );
    }

    // PUT: deprecated batch edit of every command's permissions in the guild.
    if (c.req.method === "PUT") {
      const auth = getAuth(c, store);
      if (!auth) return unauthorized(c);
      const body = (await c.req.json().catch(() => [])) as Array<{
        id: string;
        permissions: Array<{ id: string; type: number; permission: boolean }>;
      }>;
      const result: Array<Record<string, unknown>> = [];
      for (const entry of Array.isArray(body) ? body : []) {
        const permissions = entry.permissions ?? [];
        const existing = ds.commandPermissions
          .findBy("application_snowflake", appId)
          .find((r) => r.guild_snowflake === guildId && r.command_snowflake === entry.id);
        if (existing) ds.commandPermissions.update(existing.id, { permissions });
        else ds.commandPermissions.insert({ application_snowflake: appId, guild_snowflake: guildId, command_snowflake: entry.id, permissions });
        result.push({ id: entry.id, application_id: appId, guild_id: guildId, permissions });
        emitPermsUpdate(appId, guildId, entry.id, permissions);
      }
      return c.json(result);
    }

    return next();
  });

  // GET /api/v:version/applications/:appId/guilds/:guildId/commands/:commandId/permissions
  // Returns the single command-permission object; 404 if none exists.
  app.get("/api/v:version/applications/:appId/guilds/:guildId/commands/:commandId/permissions", (c) => {
    const g = requireBot(c, store);
    if (g instanceof Response) return g;
    const { ds } = g;
    const appId = c.req.param("appId");
    const guildId = c.req.param("guildId");
    const commandId = c.req.param("commandId");
    const row = ds.commandPermissions
      .findBy("application_snowflake", appId)
      .find((r) => r.guild_snowflake === guildId && r.command_snowflake === commandId);
    if (!row) {
      return discordError(c, 404, "Unknown application command permissions", UNKNOWN_COMMAND_PERMISSIONS_CODE);
    }
    return c.json({
      id: row.command_snowflake,
      application_id: appId,
      guild_id: guildId,
      permissions: row.permissions,
    });
  });

  // PUT /api/v:version/applications/:appId/guilds/:guildId/commands/:commandId/permissions
  // Upserts and returns the stored command-permission object.
  // Requires a Bearer token per Discord docs (application-commands.mdx:311-313):
  //   "Authenticating with a bot token will result in an error."
  app.put("/api/v:version/applications/:appId/guilds/:guildId/commands/:commandId/permissions", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    if (auth.type !== "bearer") {
      return discordError(c, 403, "You are not authorized to perform this action on this resource", 50013);
    }
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const guildId = c.req.param("guildId");
    const commandId = c.req.param("commandId");
    const body = (await c.req.json().catch(() => ({}))) as {
      permissions?: Array<{ id: string; type: number; permission: boolean }>;
    };
    const permissions = body.permissions ?? [];
    const existing = ds.commandPermissions
      .findBy("application_snowflake", appId)
      .find((r) => r.guild_snowflake === guildId && r.command_snowflake === commandId);
    if (existing) {
      ds.commandPermissions.update(existing.id, { permissions });
    } else {
      ds.commandPermissions.insert({
        application_snowflake: appId,
        guild_snowflake: guildId,
        command_snowflake: commandId,
        permissions,
      });
    }
    emitPermsUpdate(appId, guildId, commandId, permissions);
    return c.json({
      id: commandId,
      application_id: appId,
      guild_id: guildId,
      permissions,
    });
  });
}
