import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, discordError, snowflake, toAPIApplicationCommand } from "../helpers.js";
import type { DiscordApplicationCommand } from "../entities.js";
import type { DiscordStore } from "../store.js";

const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;

/**
 * Validate a command create body, returning a Discord `errors` tree (50035) or null. CHAT_INPUT
 * (type 1) names must be 1-32 chars, match the name regex, and be lowercase; their description
 * must be 1-100 chars. USER/MESSAGE (2/3) commands must have an empty description.
 */
function validateCommand(body: CommandInput): Record<string, unknown> | null {
  const errors: Record<string, { _errors: Array<{ code: string; message: string }> }> = {};
  const type = body.type ?? 1;
  const name = body.name ?? "";
  if (type === 1) {
    // CHAT_INPUT: strict — regex (no spaces) and lowercase.
    if (!NAME_RE.test(name)) {
      errors.name = { _errors: [{ code: "STRING_TYPE_REGEX", message: "Must match ^[-_\\p{L}\\p{N}]{1,32}$" }] };
    } else if (name !== name.toLowerCase()) {
      errors.name = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NAME", message: "Command name must be lowercase" }] };
    }
  } else if (name.length < 1 || name.length > 32) {
    // USER/MESSAGE context menu: 1-32 chars, spaces and mixed case allowed.
    errors.name = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 32 in length." }] };
  }
  const description = body.description ?? "";
  if (type === 1) {
    if (description.length < 1 || description.length > 100) {
      errors.description = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." }] };
    }
  } else if (description.length > 0) {
    errors.description = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be empty for this command type." }] };
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

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
    const errors = validateCommand(body);
    if (errors) return discordError(c, 400, "Invalid Form Body", 50035, { errors });
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
    const errors = validateCommand(body);
    if (errors) return discordError(c, 400, "Invalid Form Body", 50035, { errors });
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
