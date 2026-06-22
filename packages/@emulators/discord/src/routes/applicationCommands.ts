import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, discordError, snowflake, toAPIApplicationCommand } from "../helpers.js";
import type { DiscordApplicationCommand } from "../entities.js";
import type { DiscordStore } from "../store.js";

// CHAT_INPUT and PRIMARY_ENTRY_POINT (1, 4): lowercase-only name, no spaces.
const CHAT_INPUT_NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;

// Application command option types
const OptionType = {
  SubCommand: 1,
  SubCommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Mentionable: 9,
  Number: 10,
  Attachment: 11,
} as const;

interface OptionInput {
  type?: number;
  name?: string;
  description?: string;
  required?: boolean;
  choices?: unknown[];
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  channel_types?: unknown[];
  options?: OptionInput[];
}

/**
 * Validate options array recursively. Returns an error tree or null.
 * `depth` tracks nesting level: 0 = top-level, 1 = inside a SubCommandGroup.
 */
function validateOptions(
  options: OptionInput[],
  depth = 0,
): Record<string, unknown> | null {
  const errors: Record<string, { _errors: Array<{ code: string; message: string }> }> = {};

  if (options.length > 25) {
    errors.options = { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 25 or fewer in length." }] };
    return errors;
  }

  // Required options must precede optional ones (only applies to leaf options, not subcommands).
  let seenOptional = false;
  for (const opt of options) {
    const type = opt.type ?? 3;
    if (type === OptionType.SubCommand || type === OptionType.SubCommandGroup) continue;
    if (opt.required) {
      if (seenOptional) {
        errors.options = { _errors: [{ code: "APPLICATION_COMMAND_OPTIONS_INVALID_ORDER", message: "Required options must precede optional ones." }] };
        return errors;
      }
    } else {
      seenOptional = true;
    }
  }

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const type = opt.type ?? 3;
    const prefix = `options.${i}`;
    const optErrors: Record<string, { _errors: Array<{ code: string; message: string }> }> = {};

    // Validate option name: must match the same regex as CHAT_INPUT command names.
    const name = opt.name ?? "";
    if (!CHAT_INPUT_NAME_RE.test(name)) {
      optErrors[`${prefix}.name`] = { _errors: [{ code: "STRING_TYPE_REGEX", message: "Must match ^[-_\\p{L}\\p{N}]{1,32}$" }] };
    } else if (name !== name.toLowerCase()) {
      optErrors[`${prefix}.name`] = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NAME", message: "Option name must be lowercase" }] };
    }

    // Option description: 1-100 chars.
    const desc = opt.description ?? "";
    if (desc.length < 1 || desc.length > 100) {
      optErrors[`${prefix}.description`] = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." }] };
    }

    // Choices: max 25, XOR autocomplete.
    if (opt.choices !== undefined) {
      if (opt.choices.length > 25) {
        optErrors[`${prefix}.choices`] = { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 25 or fewer in length." }] };
      }
      if (opt.autocomplete) {
        optErrors[`${prefix}.autocomplete`] = { _errors: [{ code: "APPLICATION_COMMAND_CHOICES_AND_AUTOCOMPLETE_MUTUALLY_EXCLUSIVE", message: "choices and autocomplete are mutually exclusive." }] };
      }
    }

    // min_value / max_value: only INTEGER (4) or NUMBER (10).
    if ((opt.min_value !== undefined || opt.max_value !== undefined) && type !== OptionType.Integer && type !== OptionType.Number) {
      optErrors[`${prefix}.min_value`] = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_OPTION_TYPE", message: "min_value/max_value only valid on INTEGER or NUMBER options." }] };
    }

    // min_length / max_length: only STRING (3).
    if ((opt.min_length !== undefined || opt.max_length !== undefined) && type !== OptionType.String) {
      optErrors[`${prefix}.min_length`] = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_OPTION_TYPE", message: "min_length/max_length only valid on STRING options." }] };
    }

    // channel_types: only CHANNEL (7).
    if (opt.channel_types !== undefined && type !== OptionType.Channel) {
      optErrors[`${prefix}.channel_types`] = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_OPTION_TYPE", message: "channel_types only valid on CHANNEL options." }] };
    }

    // Subcommand nesting: SubCommandGroups (2) may only contain SubCommands (1), not more groups.
    if (type === OptionType.SubCommandGroup) {
      if (depth > 0) {
        optErrors[`${prefix}.type`] = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NESTING", message: "SubCommandGroups cannot be nested more than one level." }] };
      } else if (opt.options) {
        const nestedErrors = validateOptions(opt.options as OptionInput[], depth + 1);
        if (nestedErrors) Object.assign(optErrors, nestedErrors);

        // Within a SubCommandGroup, only SubCommands are allowed — no further groups.
        for (const nested of opt.options as OptionInput[]) {
          if ((nested.type ?? 1) === OptionType.SubCommandGroup) {
            optErrors[`${prefix}.options`] = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NESTING", message: "SubCommandGroups cannot be nested inside another SubCommandGroup." }] };
            break;
          }
        }
      }
    }

    Object.assign(errors, optErrors);
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Validate a command create/update body, returning a Discord `errors` tree (50035) or null.
 * CHAT_INPUT (type 1) and PRIMARY_ENTRY_POINT (type 4) names must be 1-32 chars, match the name
 * regex, and be lowercase; their description must be 1-100 chars.
 * USER/MESSAGE (2/3) commands must have an empty description.
 */
function validateCommand(body: CommandInput): Record<string, unknown> | null {
  const errors: Record<string, { _errors: Array<{ code: string; message: string }> }> = {};
  const type = body.type ?? 1;
  const name = body.name ?? "";

  if (type === 1 || type === 4) {
    // CHAT_INPUT / PRIMARY_ENTRY_POINT: strict — regex (no spaces) and lowercase.
    if (!CHAT_INPUT_NAME_RE.test(name)) {
      errors.name = { _errors: [{ code: "STRING_TYPE_REGEX", message: "Must match ^[-_\\p{L}\\p{N}]{1,32}$" }] };
    } else if (name !== name.toLowerCase()) {
      errors.name = { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NAME", message: "Command name must be lowercase" }] };
    }
  } else if (name.length < 1 || name.length > 32) {
    // USER/MESSAGE context menu: 1-32 chars, spaces and mixed case allowed.
    errors.name = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 32 in length." }] };
  }

  const description = body.description ?? "";
  if (type === 1 || type === 4) {
    if (description.length < 1 || description.length > 100) {
      errors.description = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." }] };
    }
  } else if (description.length > 0) {
    errors.description = { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be empty for this command type." }] };
  }

  // Validate options if present.
  if (body.options && body.options.length > 0) {
    const optionErrors = validateOptions(body.options as OptionInput[]);
    if (optionErrors) Object.assign(errors, optionErrors);
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
  integration_types?: number[] | null;
  contexts?: number[] | null;
  name_localizations?: Record<string, string> | null;
  description_localizations?: Record<string, string> | null;
  default_permission?: boolean | null;
  handler?: number | null;
}

function upsertCommand(
  ds: DiscordStore,
  appId: string,
  guildId: string | null,
  body: CommandInput,
): { cmd: DiscordApplicationCommand; isNew: boolean } {
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
      integration_types: body.integration_types !== undefined ? body.integration_types : existing.integration_types,
      contexts: body.contexts !== undefined ? body.contexts : existing.contexts,
      name_localizations: body.name_localizations !== undefined ? body.name_localizations : existing.name_localizations,
      description_localizations: body.description_localizations !== undefined ? body.description_localizations : existing.description_localizations,
      default_permission: body.default_permission !== undefined ? body.default_permission : existing.default_permission,
      handler: body.handler !== undefined ? body.handler : existing.handler,
      version: snowflake(),
    });
    return { cmd: ds.commands.findOneBy("snowflake", existing.snowflake)!, isNew: false };
  }
  const cmd = ds.commands.insert({
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
    integration_types: body.integration_types ?? [0],
    contexts: body.contexts ?? null,
    name_localizations: body.name_localizations ?? null,
    description_localizations: body.description_localizations ?? null,
    default_permission: body.default_permission ?? true,
    handler: body.handler ?? null,
    version: snowflake(),
  });
  return { cmd, isNew: true };
}

/** Per-type global command caps: CHAT_INPUT = 100, USER = 5, MESSAGE = 5. */
const GLOBAL_CMD_CAPS: Record<number, number> = { 1: 100, 4: 100, 2: 5, 3: 5 };

function checkCommandCap(
  c: Context<AppEnv>,
  ds: DiscordStore,
  appId: string,
  guildId: string | null,
  body: CommandInput,
): Response | null {
  const type = body.type ?? 1;
  const cap = GLOBAL_CMD_CAPS[type];
  if (!cap) return null;

  // Count existing commands of the same type (global scope only for now).
  const existing = ds.commands
    .findBy("application_snowflake", appId)
    .filter((cmd) => cmd.guild_snowflake === guildId && cmd.type === type);

  // If a command with the same name already exists, this is an upsert — no cap concern.
  const nameExists = existing.some((cmd) => cmd.name === body.name);
  if (nameExists) return null;

  if (existing.length >= cap) {
    return discordError(c, 400, "Maximum number of application commands reached (100)", 30032);
  }
  return null;
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
    const capErr = checkCommandCap(c, ds, c.req.param("appId"), c.req.param("guildId"), body);
    if (capErr) return capErr;
    const { cmd, isNew } = upsertCommand(ds, c.req.param("appId"), c.req.param("guildId"), body);
    return c.json(toAPIApplicationCommand(cmd), isNew ? 201 : 200);
  });

  app.put("/api/v:version/applications/:appId/guilds/:guildId/commands", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const guildId = c.req.param("guildId");
    const body = (await c.req.json().catch(() => [])) as CommandInput[];
    // Validate all entries first.
    for (const entry of Array.isArray(body) ? body : []) {
      const errors = validateCommand(entry);
      if (errors) return discordError(c, 400, "Invalid Form Body", 50035, { errors });
    }
    for (const cmd of ds.commands.findBy("application_snowflake", appId).filter((x) => x.guild_snowflake === guildId)) {
      ds.commands.delete(cmd.id);
    }
    const created = (Array.isArray(body) ? body : []).map((b) => toAPIApplicationCommand(upsertCommand(ds, appId, guildId, b).cmd));
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
    // Validate options if provided.
    if (body.options !== undefined) {
      const optErrors = validateOptions(body.options as OptionInput[]);
      if (optErrors) return discordError(c, 400, "Invalid Form Body", 50035, { errors: optErrors });
    }
    const patch: Record<string, unknown> = { version: snowflake() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.options !== undefined) patch.options = body.options;
    if (body.default_member_permissions !== undefined) patch.default_member_permissions = body.default_member_permissions;
    if (body.dm_permission !== undefined) patch.dm_permission = body.dm_permission;
    if (body.nsfw !== undefined) patch.nsfw = body.nsfw;
    if (body.integration_types !== undefined) patch.integration_types = body.integration_types;
    if (body.contexts !== undefined) patch.contexts = body.contexts;
    if (body.name_localizations !== undefined) patch.name_localizations = body.name_localizations;
    if (body.description_localizations !== undefined) patch.description_localizations = body.description_localizations;
    if (body.default_permission !== undefined) patch.default_permission = body.default_permission;
    if (body.handler !== undefined) patch.handler = body.handler;
    ds.commands.update(cmd.id, patch);
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
    const capErr = checkCommandCap(c, ds, c.req.param("appId"), null, body);
    if (capErr) return capErr;
    const { cmd, isNew } = upsertCommand(ds, c.req.param("appId"), null, body);
    return c.json(toAPIApplicationCommand(cmd), isNew ? 201 : 200);
  });

  app.put("/api/v:version/applications/:appId/commands", async (c) => {
    if (!requireBot(c)) return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const body = (await c.req.json().catch(() => [])) as CommandInput[];
    // Validate all entries first.
    for (const entry of Array.isArray(body) ? body : []) {
      const errors = validateCommand(entry);
      if (errors) return discordError(c, 400, "Invalid Form Body", 50035, { errors });
    }
    for (const cmd of ds.commands.findBy("application_snowflake", appId).filter((x) => x.guild_snowflake === null)) {
      ds.commands.delete(cmd.id);
    }
    const created = (Array.isArray(body) ? body : []).map((b) => toAPIApplicationCommand(upsertCommand(ds, appId, null, b).cmd));
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
    // Validate options if provided.
    if (body.options !== undefined) {
      const optErrors = validateOptions(body.options as OptionInput[]);
      if (optErrors) return discordError(c, 400, "Invalid Form Body", 50035, { errors: optErrors });
    }
    const patch: Record<string, unknown> = { version: snowflake() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.options !== undefined) patch.options = body.options;
    if (body.default_member_permissions !== undefined) patch.default_member_permissions = body.default_member_permissions;
    if (body.dm_permission !== undefined) patch.dm_permission = body.dm_permission;
    if (body.nsfw !== undefined) patch.nsfw = body.nsfw;
    if (body.integration_types !== undefined) patch.integration_types = body.integration_types;
    if (body.contexts !== undefined) patch.contexts = body.contexts;
    if (body.name_localizations !== undefined) patch.name_localizations = body.name_localizations;
    if (body.description_localizations !== undefined) patch.description_localizations = body.description_localizations;
    if (body.default_permission !== undefined) patch.default_permission = body.default_permission;
    if (body.handler !== undefined) patch.handler = body.handler;
    ds.commands.update(cmd.id, patch);
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
