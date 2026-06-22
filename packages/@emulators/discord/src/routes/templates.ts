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
  requirePermission,
} from "../helpers.js";
import { PermissionFlags } from "../permissions.js";
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
      // permissions is a stringified bitset in the serialized snapshot, matching the Role object.
      permissions: String(r.permissions),
      color: r.color,
      colors: r.colors ?? { primary_color: r.color, secondary_color: null, tertiary_color: null },
      hoist: r.hoist,
      icon: r.icon ?? null,
      unicode_emoji: r.unicode_emoji ?? null,
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
    // Forum/thread defaults are part of the serialized channel snapshot (all nullable but required).
    default_auto_archive_duration: c.default_auto_archive_duration ?? null,
    available_tags: c.available_tags ?? null,
    template: "",
    default_reaction_emoji: c.default_reaction_emoji ?? null,
    default_thread_rate_limit_per_user: c.default_thread_rate_limit_per_user ?? null,
    default_sort_order: c.default_sort_order ?? null,
    default_forum_layout: c.default_forum_layout ?? null,
    default_tag_setting: null,
    theme_color: null,
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
  // T2: Use the stored synced_at (set only on Sync) as updated_at, so auto-bumped
  // updated_at from Collection.update() doesn't leak through on Modify.
  const updatedAt = (t as unknown as Record<string, unknown>).synced_at as string | undefined ?? t.updated_at;
  // T1: Compute is_dirty by comparing the source guild's updated_at against the last sync time.
  const sourceGuild = ds.guilds.findOneBy("snowflake", t.source_guild_snowflake);
  let isDirty: boolean | null = null;
  if (sourceGuild && updatedAt) {
    isDirty = new Date(sourceGuild.updated_at) > new Date(updatedAt) ? true : null;
  }
  return {
    code: t.code,
    name: t.name,
    description: t.description,
    usage_count: t.usage_count,
    creator_id: t.creator_snowflake,
    creator: creator ? toAPIUser(creator) : null,
    created_at: t.created_at,
    updated_at: updatedAt,
    source_guild_id: t.source_guild_snowflake,
    serialized_source_guild: serializeSourceGuild(ds, t.source_guild_snowflake),
    is_dirty: isDirty,
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
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // T6: Require MANAGE_GUILD permission.
    const permErr = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuild, { guildId });
    if (permErr) return permErr;
    return c.json(
      ds.guildTemplates.findBy("source_guild_snowflake", guildId).map((t) => toAPITemplate(t, ds)),
    );
  });

  app.post("/api/v:version/guilds/:guildId/templates", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    // T6: Require MANAGE_GUILD permission.
    const permErr = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuild, { guildId });
    if (permErr) return permErr;
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };

    // name is required and must be 1-100; description (if present) must be 0-120.
    if (typeof body.name !== "string" || validateName(body.name)) {
      return invalidFormBody(c, { name: "Must be between 1 and 100 in length." });
    }
    const descErr = validateDescription(body.description);
    if (descErr) return invalidFormBody(c, { description: descErr });

    // T2: Store synced_at at creation time (equal to created_at / now). This is the field
    // toAPITemplate uses as updated_at so Modify PATCH cannot bump it.
    const now = new Date().toISOString();
    const template = ds.guildTemplates.insert({
      code: randomBytes(6).toString("base64url").slice(0, 10),
      source_guild_snowflake: guildId,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      usage_count: 0,
      creator_snowflake: auth.user?.snowflake ?? null,
      synced_at: now,
    } as unknown as DiscordGuildTemplate);
    return c.json(toAPITemplate(template, ds), 201);
  });

  app.put("/api/v:version/guilds/:guildId/templates/:code", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // T6: Require MANAGE_GUILD permission.
    const permErr = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuild, { guildId });
    if (permErr) return permErr;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== guildId) return notFound(c);
    // T2: Sync bumps synced_at (used as updated_at in the API response).
    const syncedAt = new Date().toISOString();
    ds.guildTemplates.update(template.id, { synced_at: syncedAt } as unknown as Partial<DiscordGuildTemplate>);
    return c.json(toAPITemplate(ds.guildTemplates.findOneBy("code", template.code)!, ds));
  });

  app.patch("/api/v:version/guilds/:guildId/templates/:code", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // T6: Require MANAGE_GUILD permission.
    const permErr = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuild, { guildId });
    if (permErr) return permErr;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== guildId) return notFound(c);
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
    // T2: Preserve the existing synced_at so Collection.update()'s auto-bump of updated_at
    // does not leak through as the API's updated_at. We restore synced_at unchanged.
    const existingTemplate = ds.guildTemplates.findOneBy("code", template.code)!;
    const existingSyncedAt = (existingTemplate as unknown as Record<string, unknown>).synced_at as string | undefined;
    if (existingSyncedAt !== undefined) {
      (patch as unknown as Record<string, unknown>).synced_at = existingSyncedAt;
    }
    ds.guildTemplates.update(template.id, patch);
    return c.json(toAPITemplate(ds.guildTemplates.findOneBy("code", template.code)!, ds));
  });

  app.delete("/api/v:version/guilds/:guildId/templates/:code", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    // T6: Require MANAGE_GUILD permission.
    const permErr = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageGuild, { guildId });
    if (permErr) return permErr;
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== guildId) return notFound(c);
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

    // T3: Materialize the template's serialized_source_guild snapshot into a real guild.
    const guildName = typeof body.name === "string" && body.name.length > 0 ? body.name : template.name;
    const guild = createGuild(ds, {
      name: guildName,
      ownerSnowflake: auth.user!.snowflake,
    });

    // Apply guild-level settings from the snapshot.
    const snapshot = serializeSourceGuild(ds, template.source_guild_snowflake);
    if (snapshot) {
      const guildPatch: Record<string, unknown> = {};
      if (typeof snapshot.verification_level === "number") guildPatch.verification_level = snapshot.verification_level;
      if (typeof snapshot.default_message_notifications === "number") guildPatch.default_message_notifications = snapshot.default_message_notifications;
      if (typeof snapshot.explicit_content_filter === "number") guildPatch.explicit_content_filter = snapshot.explicit_content_filter;
      if (typeof snapshot.preferred_locale === "string") guildPatch.preferred_locale = snapshot.preferred_locale;
      if (typeof snapshot.afk_timeout === "number") guildPatch.afk_timeout = snapshot.afk_timeout;
      if (typeof snapshot.system_channel_flags === "number") guildPatch.system_channel_flags = snapshot.system_channel_flags;
      if (Object.keys(guildPatch).length > 0) {
        ds.guilds.update(guild.id, guildPatch as Parameters<typeof ds.guilds.update>[1]);
      }

      // Materialize roles (skip @everyone which was already created by createGuild).
      // Build a map from snapshot placeholder id -> real snowflake for role remapping.
      const roleIdMap = new Map<number, string>();
      const snapshotRoles = snapshot.roles as Array<Record<string, unknown>>;
      for (const snapRole of snapshotRoles) {
        const placeholderId = snapRole.id as number;
        if (placeholderId === 0) {
          // @everyone — already created, map to the guild's @everyone role (snowflake == guild id).
          roleIdMap.set(0, guild.snowflake);
        } else {
          // Create the role and record the mapping.
          const role = createRole(ds, guild.snowflake, {
            name: typeof snapRole.name === "string" ? snapRole.name : "role",
            color: typeof snapRole.color === "number" ? snapRole.color : 0,
            hoist: snapRole.hoist === true,
            mentionable: snapRole.mentionable === true,
            permissions: typeof snapRole.permissions === "number" ? String(snapRole.permissions) : "0",
          });
          roleIdMap.set(placeholderId, role.snowflake);
        }
      }

      // Materialize channels. Two passes: categories first, then children (so parent_id resolves).
      const snapshotChannels = snapshot.channels as Array<Record<string, unknown>>;
      const channelIdMap = new Map<number, string>();

      // Pass 1: categories (type 4).
      for (const snapCh of snapshotChannels) {
        if (snapCh.type !== 4) continue;
        const ch = createChannel(ds, {
          name: typeof snapCh.name === "string" ? snapCh.name : "channel",
          type: 4,
          guildSnowflake: guild.snowflake,
          position: typeof snapCh.position === "number" ? snapCh.position : 0,
          nsfw: snapCh.nsfw === true,
        });
        channelIdMap.set(snapCh.id as number, ch.snowflake);
      }

      // Pass 2: non-category channels.
      for (const snapCh of snapshotChannels) {
        if (snapCh.type === 4) continue;
        const parentSnowflake = snapCh.parent_id != null
          ? (channelIdMap.get(snapCh.parent_id as number) ?? null)
          : null;
        const ch = createChannel(ds, {
          name: typeof snapCh.name === "string" ? snapCh.name : "channel",
          type: typeof snapCh.type === "number" ? snapCh.type : 0,
          guildSnowflake: guild.snowflake,
          position: typeof snapCh.position === "number" ? snapCh.position : 0,
          topic: typeof snapCh.topic === "string" ? snapCh.topic : null,
          nsfw: snapCh.nsfw === true,
          rateLimitPerUser: typeof snapCh.rate_limit_per_user === "number" ? snapCh.rate_limit_per_user : 0,
          bitrate: typeof snapCh.bitrate === "number" ? snapCh.bitrate : undefined,
          userLimit: typeof snapCh.user_limit === "number" ? snapCh.user_limit : undefined,
          parentSnowflake,
        });
        channelIdMap.set(snapCh.id as number, ch.snowflake);
      }

      // Map placeholder system_channel_id to real snowflake.
      if (snapshot.system_channel_id != null) {
        const realSystemChannel = channelIdMap.get(snapshot.system_channel_id as number);
        if (realSystemChannel) {
          ds.guilds.update(guild.id, { system_channel_snowflake: realSystemChannel } as Parameters<typeof ds.guilds.update>[1]);
        }
      }

      // Map placeholder afk_channel_id to real snowflake.
      if (snapshot.afk_channel_id != null) {
        const realAfkChannel = channelIdMap.get(snapshot.afk_channel_id as number);
        if (realAfkChannel) {
          ds.guilds.update(guild.id, { afk_channel_snowflake: realAfkChannel } as Parameters<typeof ds.guilds.update>[1]);
        }
      }
    } else {
      // Fallback: no snapshot, seed a minimal guild.
      createRole(ds, guild.snowflake, { name: "Member" });
      const category = createChannel(ds, { name: "Text Channels", type: 4, guildSnowflake: guild.snowflake });
      createChannel(ds, { name: "general", type: 0, guildSnowflake: guild.snowflake, parentSnowflake: category.snowflake });
    }

    ds.guildTemplates.update(template.id, { usage_count: template.usage_count + 1 });
    return c.json(toAPIGuild(ds.guilds.findOneBy("snowflake", guild.snowflake)!, ds, { full: true }), 201);
  });
}
