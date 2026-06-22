import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  toAPIGuild,
  toAPIRole,
  toAPIMember,
  toAPIEmoji,
  toAPIUser,
} from "../helpers.js";
import {
  createGuild,
  createRole,
  addGuildMember,
  createEmoji,
} from "../factories.js";
import { Intents } from "../gateway/intents.js";

export function guildsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ---------------------------------------------------------------------------
  // Guild core
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const withCounts = c.req.query("with_counts") === "true";
    return c.json(toAPIGuild(guild, ds, { withCounts }));
  });

  app.post("/api/v:version/guilds", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is allowed; createGuild has defaults
    }
    const ownerSnowflake = auth.user?.snowflake ?? "";
    const guild = createGuild(ds, {
      name: (body.name as string | undefined) ?? "New Server",
      ownerSnowflake,
      icon: (body.icon as string | null | undefined) ?? null,
      description: (body.description as string | null | undefined) ?? null,
    });
    return c.json(toAPIGuild(guild, ds, { full: true }), 201);
  });

  app.patch("/api/v:version/guilds/:guildId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.verification_level !== undefined) patch.verification_level = body.verification_level;
    if (body.default_message_notifications !== undefined)
      patch.default_message_notifications = body.default_message_notifications;
    if (body.explicit_content_filter !== undefined) patch.explicit_content_filter = body.explicit_content_filter;
    if (body.afk_channel_id !== undefined) patch.afk_channel_snowflake = body.afk_channel_id;
    if (body.afk_timeout !== undefined) patch.afk_timeout = body.afk_timeout;
    if (body.system_channel_id !== undefined) patch.system_channel_snowflake = body.system_channel_id;
    if (body.preferred_locale !== undefined) patch.preferred_locale = body.preferred_locale;
    if (body.owner_id !== undefined) patch.owner_snowflake = body.owner_id;
    if (Object.keys(patch).length > 0) {
      ds.guilds.update(guild.id, patch);
    }
    const updated = ds.guilds.findOneBy("snowflake", guildId)!;
    const payload = toAPIGuild(updated, ds);
    bus.publish({
      t: "GUILD_UPDATE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: payload,
    });
    return c.json(payload);
  });

  app.delete("/api/v:version/guilds/:guildId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);

    // Cascade: messages in guild channels, then channels, then roles, members, emojis, guild.
    const channels = ds.channels.findBy("guild_snowflake", guildId);
    for (const ch of channels) {
      const msgs = ds.messages.findBy("channel_snowflake", ch.snowflake);
      for (const m of msgs) ds.messages.delete(m.id);
      ds.channels.delete(ch.id);
    }
    const roles = ds.roles.findBy("guild_snowflake", guildId);
    for (const r of roles) ds.roles.delete(r.id);
    const members = ds.members.findBy("guild_snowflake", guildId);
    for (const m of members) ds.members.delete(m.id);
    const emojis = ds.emojis.findBy("guild_snowflake", guildId);
    for (const e of emojis) ds.emojis.delete(e.id);
    ds.guilds.delete(guild.id);

    bus.publish({
      t: "GUILD_DELETE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: { id: guildId, unavailable: false },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId/roles", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const roles = ds.roles.findBy("guild_snowflake", guildId).map(toAPIRole);
    return c.json(roles);
  });

  app.post("/api/v:version/guilds/:guildId/roles", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const role = createRole(ds, guildId, {
      name: body.name as string | undefined,
      color: body.color as number | undefined,
      hoist: body.hoist as boolean | undefined,
      permissions: body.permissions as string | undefined,
      mentionable: body.mentionable as boolean | undefined,
      position: body.position as number | undefined,
      icon: body.icon as string | null | undefined,
    });
    const apiRole = toAPIRole(role);
    bus.publish({
      t: "GUILD_ROLE_CREATE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: { guild_id: guildId, role: apiRole },
    });
    return c.json(apiRole, 200);
  });

  app.patch("/api/v:version/guilds/:guildId/roles/:roleId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const roleId = c.req.param("roleId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const role = ds.roles.findOneBy("snowflake", roleId);
    if (!role || role.guild_snowflake !== guildId) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.color !== undefined) patch.color = body.color;
    if (body.hoist !== undefined) patch.hoist = body.hoist;
    if (body.permissions !== undefined) patch.permissions = body.permissions;
    if (body.mentionable !== undefined) patch.mentionable = body.mentionable;
    if (body.position !== undefined) patch.position = body.position;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (Object.keys(patch).length > 0) ds.roles.update(role.id, patch);
    const updated = ds.roles.findOneBy("snowflake", roleId)!;
    const apiRole = toAPIRole(updated);
    bus.publish({
      t: "GUILD_ROLE_UPDATE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: { guild_id: guildId, role: apiRole },
    });
    return c.json(apiRole);
  });

  app.delete("/api/v:version/guilds/:guildId/roles/:roleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const roleId = c.req.param("roleId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const role = ds.roles.findOneBy("snowflake", roleId);
    if (!role || role.guild_snowflake !== guildId) return notFound(c);
    ds.roles.delete(role.id);
    bus.publish({
      t: "GUILD_ROLE_DELETE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: { guild_id: guildId, role_id: roleId },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId/members", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const members = ds.members.findBy("guild_snowflake", guildId).map((m) => toAPIMember(m, ds));
    return c.json(members);
  });

  app.get("/api/v:version/guilds/:guildId/members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return notFound(c);
    return c.json(toAPIMember(member, ds));
  });

  app.put("/api/v:version/guilds/:guildId/members/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const user = ds.users.findOneBy("snowflake", userId);
    if (!user) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const member = addGuildMember(ds, guildId, userId, {
      nick: body.nick as string | null | undefined,
      roles: body.roles as string[] | undefined,
    });
    if (!member) {
      // Member already existed — return 204 (Discord semantics).
      return new Response(null, { status: 204 });
    }
    const apiMember = toAPIMember(member, ds);
    bus.publish({
      t: "GUILD_MEMBER_ADD",
      guildId,
      requiredIntents: Intents.GuildMembers,
      d: { ...apiMember, guild_id: guildId },
    });
    return c.json(apiMember, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/members/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const patch: Record<string, unknown> = {};
    if (body.nick !== undefined) patch.nick = body.nick;
    if (body.roles !== undefined) patch.role_snowflakes = body.roles;
    if (body.deaf !== undefined) patch.deaf = body.deaf;
    if (body.mute !== undefined) patch.mute = body.mute;
    if (Object.keys(patch).length > 0) ds.members.update(member.id, patch);
    const updated = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId)!;
    const apiMember = toAPIMember(updated, ds);
    bus.publish({
      t: "GUILD_MEMBER_UPDATE",
      guildId,
      requiredIntents: Intents.GuildMembers,
      d: { ...apiMember, guild_id: guildId },
    });
    return c.json(apiMember);
  });

  app.delete("/api/v:version/guilds/:guildId/members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return notFound(c);
    const user = ds.users.findOneBy("snowflake", userId);
    ds.members.delete(member.id);
    // Remove from guild.member_snowflakes.
    ds.guilds.update(guild.id, {
      member_snowflakes: guild.member_snowflakes.filter((s) => s !== userId),
    });
    bus.publish({
      t: "GUILD_MEMBER_REMOVE",
      guildId,
      requiredIntents: Intents.GuildMembers,
      d: { guild_id: guildId, user: user ? toAPIUser(user) : { id: userId } },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Emojis
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId/emojis", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const emojis = ds.emojis.findBy("guild_snowflake", guildId).map((e) => toAPIEmoji(e, ds));
    return c.json(emojis);
  });

  app.get("/api/v:version/guilds/:guildId/emojis/:emojiId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const emojiId = c.req.param("emojiId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const emoji = ds.emojis.findOneBy("snowflake", emojiId);
    if (!emoji || emoji.guild_snowflake !== guildId) return notFound(c);
    return c.json(toAPIEmoji(emoji, ds));
  });

  app.post("/api/v:version/guilds/:guildId/emojis", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const emoji = createEmoji(ds, guildId, {
      name: (body.name as string | undefined) ?? "emoji",
      animated: (body.animated as boolean | undefined) ?? false,
      creatorSnowflake: auth.user?.snowflake ?? null,
      roles: (body.roles as string[] | undefined) ?? [],
    });
    return c.json(toAPIEmoji(emoji, ds), 201);
  });

  app.patch("/api/v:version/guilds/:guildId/emojis/:emojiId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const emojiId = c.req.param("emojiId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const emoji = ds.emojis.findOneBy("snowflake", emojiId);
    if (!emoji || emoji.guild_snowflake !== guildId) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.roles !== undefined) patch.role_snowflakes = body.roles;
    if (Object.keys(patch).length > 0) ds.emojis.update(emoji.id, patch);
    const updated = ds.emojis.findOneBy("snowflake", emojiId)!;
    return c.json(toAPIEmoji(updated, ds));
  });

  app.delete("/api/v:version/guilds/:guildId/emojis/:emojiId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const emojiId = c.req.param("emojiId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const emoji = ds.emojis.findOneBy("snowflake", emojiId);
    if (!emoji || emoji.guild_snowflake !== guildId) return notFound(c);
    ds.emojis.delete(emoji.id);
    return new Response(null, { status: 204 });
  });
}
