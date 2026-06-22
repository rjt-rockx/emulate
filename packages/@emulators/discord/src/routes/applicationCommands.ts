import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake, toAPIApplicationCommand } from "../helpers.js";
import type { DiscordApplicationCommand } from "../entities.js";
import type { DiscordStore } from "../store.js";

interface CommandInput {
  name?: string;
  description?: string;
  type?: number;
  options?: unknown[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
}

function upsertCommand(
  ds: DiscordStore,
  appId: string,
  guildId: string | null,
  body: CommandInput,
): DiscordApplicationCommand {
  // Discord upserts global/guild commands by (application, guild, name).
  const existing = ds.commands
    .findBy("application_snowflake", appId)
    .find((cmd) => cmd.guild_snowflake === guildId && cmd.name === body.name);
  if (existing) {
    ds.commands.update(existing.id, {
      description: body.description ?? existing.description,
      type: body.type ?? existing.type,
      options: body.options ?? existing.options,
      default_member_permissions:
        body.default_member_permissions !== undefined ? body.default_member_permissions : existing.default_member_permissions,
      dm_permission: body.dm_permission ?? existing.dm_permission,
      nsfw: body.nsfw ?? existing.nsfw,
      version: snowflake(),
    });
    return ds.commands.findOneBy("snowflake", existing.snowflake)!;
  }
  return ds.commands.insert({
    snowflake: snowflake(),
    application_snowflake: appId,
    guild_snowflake: guildId,
    type: body.type ?? 1,
    name: body.name ?? "command",
    description: body.description ?? "",
    options: body.options ?? [],
    default_member_permissions: body.default_member_permissions ?? null,
    dm_permission: body.dm_permission ?? true,
    nsfw: body.nsfw ?? false,
    version: snowflake(),
  });
}

export function applicationCommandsRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  const requireBot = (c: Context<AppEnv>) => {
    const auth = getAuth(c, store);
    return auth && auth.type === "bot" ? auth : null;
  };

  // Register both global and guild variants. Guild routes are registered before the
  // global ones so the more specific path wins where it matters.

  // ----- Guild commands -----
  app.get("/api/v:version/applications/:appId/guilds/:guildId/commands", (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const guildId = c.req.param("guildId");
    const cmds = ds.commands
      .findBy("application_snowflake", appId)
      .filter((cmd) => cmd.guild_snowflake === guildId)
      .map(toAPIApplicationCommand);
    return c.json(cmds);
  });

  app.post("/api/v:version/applications/:appId/guilds/:guildId/commands", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as CommandInput;
    const cmd = upsertCommand(ds, c.req.param("appId"), c.req.param("guildId"), body);
    return c.json(toAPIApplicationCommand(cmd), 201);
  });

  app.put("/api/v:version/applications/:appId/guilds/:guildId/commands", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const guildId = c.req.param("guildId");
    const body = (await c.req.json().catch(() => [])) as CommandInput[];
    for (const cmd of ds.commands.findBy("application_snowflake", appId).filter((x) => x.guild_snowflake === guildId)) {
      ds.commands.delete(cmd.id);
    }
    const created = (Array.isArray(body) ? body : []).map((b) => toAPIApplicationCommand(upsertCommand(ds, appId, guildId, b)));
    return c.json(created);
  });

  app.get("/api/v:version/applications/:appId/guilds/:guildId/commands/:commandId", (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const cmd = ds.commands.findOneBy("snowflake", c.req.param("commandId"));
    if (!cmd || cmd.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    return c.json(toAPIApplicationCommand(cmd));
  });

  app.patch("/api/v:version/applications/:appId/guilds/:guildId/commands/:commandId", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const cmd = ds.commands.findOneBy("snowflake", c.req.param("commandId"));
    if (!cmd || cmd.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as CommandInput;
    ds.commands.update(cmd.id, {
      name: body.name ?? cmd.name,
      description: body.description ?? cmd.description,
      options: body.options ?? cmd.options,
      version: snowflake(),
    });
    return c.json(toAPIApplicationCommand(ds.commands.findOneBy("snowflake", cmd.snowflake)!));
  });

  app.delete("/api/v:version/applications/:appId/guilds/:guildId/commands/:commandId", (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const cmd = ds.commands.findOneBy("snowflake", c.req.param("commandId"));
    if (!cmd || cmd.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    ds.commands.delete(cmd.id);
    return new Response(null, { status: 204 });
  });

  // ----- Global commands -----
  app.get("/api/v:version/applications/:appId/commands", (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const cmds = ds.commands
      .findBy("application_snowflake", appId)
      .filter((cmd) => cmd.guild_snowflake === null)
      .map(toAPIApplicationCommand);
    return c.json(cmds);
  });

  app.post("/api/v:version/applications/:appId/commands", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as CommandInput;
    const cmd = upsertCommand(ds, c.req.param("appId"), null, body);
    return c.json(toAPIApplicationCommand(cmd), 201);
  });

  app.put("/api/v:version/applications/:appId/commands", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const body = (await c.req.json().catch(() => [])) as CommandInput[];
    for (const cmd of ds.commands.findBy("application_snowflake", appId).filter((x) => x.guild_snowflake === null)) {
      ds.commands.delete(cmd.id);
    }
    const created = (Array.isArray(body) ? body : []).map((b) => toAPIApplicationCommand(upsertCommand(ds, appId, null, b)));
    return c.json(created);
  });

  app.get("/api/v:version/applications/:appId/commands/:commandId", (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const cmd = ds.commands.findOneBy("snowflake", c.req.param("commandId"));
    if (!cmd || cmd.guild_snowflake !== null) return notFound(c);
    return c.json(toAPIApplicationCommand(cmd));
  });

  app.patch("/api/v:version/applications/:appId/commands/:commandId", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const cmd = ds.commands.findOneBy("snowflake", c.req.param("commandId"));
    if (!cmd || cmd.guild_snowflake !== null) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as CommandInput;
    ds.commands.update(cmd.id, {
      name: body.name ?? cmd.name,
      description: body.description ?? cmd.description,
      options: body.options ?? cmd.options,
      version: snowflake(),
    });
    return c.json(toAPIApplicationCommand(ds.commands.findOneBy("snowflake", cmd.snowflake)!));
  });

  app.delete("/api/v:version/applications/:appId/commands/:commandId", (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const cmd = ds.commands.findOneBy("snowflake", c.req.param("commandId"));
    if (!cmd || cmd.guild_snowflake !== null) return notFound(c);
    ds.commands.delete(cmd.id);
    return new Response(null, { status: 204 });
  });
}
