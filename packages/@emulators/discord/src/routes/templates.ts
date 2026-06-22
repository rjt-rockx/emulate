import { randomBytes } from "node:crypto";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import {
  notFound,
  invalidFormBody,
  toAPIUser,
  toAPIGuild,
  requireBot,
  requireUser,
} from "../helpers.js";
import { createGuild, createChannel, createRole } from "../factories.js";
import type { APITemplate } from "discord-api-types/v10";
import type { DiscordGuildTemplate } from "../entities.js";

// ---------------------------------------------------------------------------
// Serialized source-guild snapshot
// ---------------------------------------------------------------------------

/**
 * Build the `serialized_source_guild` snapshot for a template's source guild. This is a
 * partial guild object whose `roles` and `channels` carry placeholder *integer* ids (the
 * @everyone role is id 0), with child channels referencing their category's placeholder id.
 */
function serializeSourceGuild(ds: DiscordStore, sourceGuildSnowflake: string): Record<string, unknown> | null {
  const guild = ds.guilds.findOneBy("snowflake", sourceGuildSnowflake);
  if (!guild) return null;

  const roles = ds.roles
    .findBy("guild_snowflake", sourceGuildSnowflake)
    .slice()
    .sort((a, b) => a.position - b.position);
  // @everyone (whose snowflake equals the guild id) is the placeholder id 0; other roles get 1..n.
  let nextRoleId = 1;
  const serializedRoles = roles.map((r) => {
    const isEveryone = r.snowflake === sourceGuildSnowflake;
    return {
      id: isEveryone ? 0 : nextRoleId++,
      name: r.name,
      permissions: Number(r.permissions),
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
    };
  });

  // Channels get sequential placeholder ids; build a map from snowflake -> placeholder id so
  // children can reference their parent category's placeholder id.
  const channels = ds.channels
    .findBy("guild_snowflake", sourceGuildSnowflake)
    .filter((c) => c.type !== 10 && c.type !== 11 && c.type !== 12) // exclude threads
    .slice()
    .sort((a, b) => a.position - b.position);
  const channelIdMap = new Map<string, number>();
  channels.forEach((c, i) => channelIdMap.set(c.snowflake, i + 1));
  const serializedChannels = channels.map((c) => ({
    name: c.name,
    position: c.position,
    topic: c.topic,
    bitrate: c.bitrate ?? 64000,
    user_limit: c.user_limit ?? 0,
    nsfw: c.nsfw,
    rate_limit_per_user: c.rate_limit_per_user,
    parent_id: c.parent_snowflake != null ? (channelIdMap.get(c.parent_snowflake) ?? null) : null,
    permission_overwrites: [],
    id: channelIdMap.get(c.snowflake)!,
    type: c.type,
  }));

  return {
    name: guild.name,
    description: guild.description,
    region: null,
    verification_level: guild.verification_level,
    default_message_notifications: guild.default_message_notifications,
    explicit_content_filter: guild.explicit_content_filter,
    preferred_locale: guild.preferred_locale,
    afk_timeout: guild.afk_timeout,
    roles: serializedRoles,
    channels: serializedChannels,
    afk_channel_id: guild.afk_channel_snowflake != null ? (channelIdMap.get(guild.afk_channel_snowflake) ?? null) : null,
    system_channel_id:
      guild.system_channel_snowflake != null ? (channelIdMap.get(guild.system_channel_snowflake) ?? null) : null,
    system_channel_flags: guild.system_channel_flags ?? 0,
    icon_hash: null,
  };
}

function toAPITemplate(t: DiscordGuildTemplate, ds: DiscordStore): APITemplate {
  const creator = t.creator_snowflake ? ds.users.findOneBy("snowflake", t.creator_snowflake) : null;
  return {
    code: t.code,
    name: t.name,
    description: t.description,
    usage_count: t.usage_count,
    creator_id: t.creator_snowflake,
    creator: creator ? toAPIUser(creator) : null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    source_guild_id: t.source_guild_snowflake,
    serialized_source_guild: serializeSourceGuild(ds, t.source_guild_snowflake),
    is_dirty: null,
  } as unknown as APITemplate;
}

// ---------------------------------------------------------------------------
// Validation (name 1-100, description 0-120)
// ---------------------------------------------------------------------------

function validateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  if (name.length < 1 || name.length > 100) return "Must be between 1 and 100 in length.";
  return null;
}

function validateDescription(description: unknown): string | null {
  if (description == null) return null;
  if (typeof description !== "string") return null;
  if (description.length > 120) return "Must be 120 or fewer in length.";
  return null;
}

export function templatesRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  app.get("/api/v:version/guilds/templates/:code", (c) => {
    const ds = getDiscordStore(store);
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template) return notFound(c);
    return c.json(toAPITemplate(template, ds));
  });

  app.get("/api/v:version/guilds/:guildId/templates", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    return c.json(
      ds.guildTemplates.findBy("source_guild_snowflake", c.req.param("guildId")).map((t) => toAPITemplate(t, ds)),
    );
  });

  app.post("/api/v:version/guilds/:guildId/templates", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };

    // name is required and must be 1-100; description (if present) must be 0-120.
    if (typeof body.name !== "string" || validateName(body.name)) {
      return invalidFormBody(c, { name: "Must be between 1 and 100 in length." });
    }
    const descErr = validateDescription(body.description);
    if (descErr) return invalidFormBody(c, { description: descErr });

    const template = ds.guildTemplates.insert({
      code: randomBytes(6).toString("base64url").slice(0, 10),
      source_guild_snowflake: guildId,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      usage_count: 0,
      creator_snowflake: auth.user?.snowflake ?? null,
    });
    return c.json(toAPITemplate(template, ds), 201);
  });

  app.put("/api/v:version/guilds/:guildId/templates/:code", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== c.req.param("guildId")) return notFound(c);
    // Sync re-snapshots the source guild and records the sync time on updated_at.
    ds.guildTemplates.update(template.id, { updated_at: new Date().toISOString() });
    return c.json(toAPITemplate(ds.guildTemplates.findOneBy("code", template.code)!, ds));
  });

  app.patch("/api/v:version/guilds/:guildId/templates/:code", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string | null };

    if (body.name !== undefined) {
      const nameErr = validateName(body.name);
      if (typeof body.name !== "string" || nameErr) {
        return invalidFormBody(c, { name: "Must be between 1 and 100 in length." });
      }
    }
    if (body.description !== undefined) {
      const descErr = validateDescription(body.description);
      if (descErr) return invalidFormBody(c, { description: descErr });
    }

    const patch: Partial<DiscordGuildTemplate> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description ?? null;
    ds.guildTemplates.update(template.id, patch);
    return c.json(toAPITemplate(ds.guildTemplates.findOneBy("code", template.code)!, ds));
  });

  app.delete("/api/v:version/guilds/:guildId/templates/:code", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const payload = toAPITemplate(template, ds);
    ds.guildTemplates.delete(template.id);
    return c.json(payload);
  });

  // Create a new guild from a template.
  app.post("/api/v:version/guilds/templates/:code", async (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const guild = createGuild(ds, {
      name: typeof body.name === "string" ? body.name : template.name,
      ownerSnowflake: auth.user!.snowflake,
    });
    // Seed a couple of default structures so the new guild is usable.
    createRole(ds, guild.snowflake, { name: "Member" });
    const category = createChannel(ds, { name: "Text Channels", type: 4, guildSnowflake: guild.snowflake });
    createChannel(ds, {
      name: "general",
      type: 0,
      guildSnowflake: guild.snowflake,
      parentSnowflake: category.snowflake,
    });
    ds.guildTemplates.update(template.id, { usage_count: template.usage_count + 1 });
    return c.json(toAPIGuild(guild, ds, { full: true }), 201);
  });
}
