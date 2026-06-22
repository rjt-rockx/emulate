import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  unknownGuild,
  unknownChannel,
  unknownMember,
  unknownRole,
  unknownUser,
  unknownEmoji,
  toAPIGuild,
  toAPIRole,
  toAPIMember,
  toAPIEmoji,
  toAPIUser,
  recordAudit,
  AuditLogEvent,
  auditReason,
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

  // Broadcast the guild's full emoji list (GUILD_EMOJIS_UPDATE) after any emoji change.
  const emitEmojisUpdate = (guildId: string): void => {
    const ds = getDiscordStore(store);
    bus.publish({
      t: "GUILD_EMOJIS_UPDATE",
      guildId,
      requiredIntents: Intents.GuildExpressions,
      d: { guild_id: guildId, emojis: ds.emojis.findBy("guild_snowflake", guildId).map((e) => toAPIEmoji(e, ds)) },
    });
  };

  // ---------------------------------------------------------------------------
  // Literal routes that must be registered before their `:param` siblings, since
  // the router matches in registration order (e.g. /members/search vs /members/:userId).
  // ---------------------------------------------------------------------------

  // Modify the current member (nick, etc.).
  app.patch("/api/v:version/guilds/:guildId/members/@me", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === auth.user!.snowflake);
    if (!member) return unknownMember(c);
    const body = (await c.req.json().catch(() => ({}))) as { nick?: string | null };
    if (body.nick !== undefined) ds.members.update(member.id, { nick: body.nick });
    const updated = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === auth.user!.snowflake)!;
    const apiMember = toAPIMember(updated, ds);
    bus.publish({ t: "GUILD_MEMBER_UPDATE", guildId, requiredIntents: Intents.GuildMembers, d: { ...apiMember, guild_id: guildId } });
    return c.json(apiMember);
  });

  // Deprecated set-own-nick alias (returns just the nick).
  app.patch("/api/v:version/guilds/:guildId/members/@me/nick", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === auth.user!.snowflake);
    if (!member) return unknownMember(c);
    const body = (await c.req.json().catch(() => ({}))) as { nick?: string | null };
    if (body.nick !== undefined) ds.members.update(member.id, { nick: body.nick });
    return c.json({ nick: body.nick ?? null });
  });

  // Search guild members by username/nick prefix.
  app.get("/api/v:version/guilds/:guildId/members/search", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return unknownGuild(c);
    const query = (c.req.query("query") ?? "").toLowerCase();
    const limit = Math.min(Number(c.req.query("limit") ?? 1) || 1, 1000);
    const matches = ds.members
      .findBy("guild_snowflake", guildId)
      .filter((m) => {
        if (!query) return true;
        const user = ds.users.findOneBy("snowflake", m.user_snowflake);
        const uname = user?.username.toLowerCase() ?? "";
        const nick = (m.nick ?? "").toLowerCase();
        return uname.startsWith(query) || nick.startsWith(query);
      })
      .slice(0, limit)
      .map((m) => toAPIMember(m, ds));
    return c.json(matches);
  });

  // Per-role member counts (literal — must precede /roles/:roleId).
  app.get("/api/v:version/guilds/:guildId/roles/member-counts", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return unknownGuild(c);
    const counts: Record<string, number> = {};
    for (const role of ds.roles.findBy("guild_snowflake", guildId)) {
      counts[role.snowflake] = ds.members
        .findBy("guild_snowflake", guildId)
        .filter((m) => m.role_snowflakes.includes(role.snowflake)).length;
    }
    return c.json(counts);
  });

  // ---------------------------------------------------------------------------
  // Guild core
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/guilds/:guildId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const withCounts = c.req.query("with_counts") === "true";
    return c.json(toAPIGuild(guild, ds, { withCounts }));
  });

  // Guild preview (public-facing subset; available to bots in the guild here).
  app.get("/api/v:version/guilds/:guildId/preview", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const memberCount = ds.members.findBy("guild_snowflake", guildId).length;
    return c.json({
      id: guild.snowflake,
      name: guild.name,
      icon: guild.icon,
      splash: guild.splash,
      discovery_splash: null,
      emojis: ds.emojis.findBy("guild_snowflake", guildId).map((e) => toAPIEmoji(e, ds)),
      features: guild.features,
      approximate_member_count: memberCount,
      approximate_presence_count: memberCount,
      description: guild.description,
      stickers: ds.stickers.findBy("guild_snowflake", guildId).map((s) => ({ id: s.snowflake, name: s.name })),
    });
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
    const fullGuild = toAPIGuild(guild, ds, { full: true });
    // The creating bot is now in the guild: deliver GUILD_CREATE to its live session.
    if (auth.user) {
      bus.publish({ t: "GUILD_CREATE", guildId: guild.snowflake, requiredIntents: 0, targetUserId: auth.user.snowflake, d: fullGuild });
    }
    return c.json(fullGuild, 201);
  });

  app.patch("/api/v:version/guilds/:guildId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
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
    if (!guild) return unknownGuild(c);

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
    if (!guild) return unknownGuild(c);
    const roles = ds.roles.findBy("guild_snowflake", guildId).map(toAPIRole);
    return c.json(roles);
  });

  // Get a single role.
  app.get("/api/v:version/guilds/:guildId/roles/:roleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const role = ds.roles.findOneBy("snowflake", c.req.param("roleId"));
    if (!role || role.guild_snowflake !== guildId) return unknownRole(c);
    return c.json(toAPIRole(role));
  });

  // Reorder roles (batch position update). Returns all guild roles.
  app.patch("/api/v:version/guilds/:guildId/roles", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return unknownGuild(c);
    const body = (await c.req.json().catch(() => [])) as Array<{ id: string; position?: number }>;
    for (const entry of Array.isArray(body) ? body : []) {
      const role = ds.roles.findOneBy("snowflake", entry.id);
      if (role && role.guild_snowflake === guildId && entry.position !== undefined) {
        ds.roles.update(role.id, { position: entry.position });
      }
    }
    const roles = ds.roles.findBy("guild_snowflake", guildId).map(toAPIRole);
    bus.publish({ t: "GUILD_ROLE_UPDATE", guildId, requiredIntents: Intents.Guilds, d: { guild_id: guildId, roles } });
    return c.json(roles);
  });

  app.post("/api/v:version/guilds/:guildId/roles", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
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
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.RoleCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: role.snowflake,
      changes: [{ key: "name", new_value: role.name }],
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
    if (!guild) return unknownGuild(c);
    const role = ds.roles.findOneBy("snowflake", roleId);
    if (!role || role.guild_snowflake !== guildId) return unknownRole(c);
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
    const roleChanges = Object.keys(patch).map((key) => ({
      key,
      old_value: (role as unknown as Record<string, unknown>)[key],
      new_value: patch[key],
    }));
    if (Object.keys(patch).length > 0) ds.roles.update(role.id, patch);
    const updated = ds.roles.findOneBy("snowflake", roleId)!;
    const apiRole = toAPIRole(updated);
    bus.publish({
      t: "GUILD_ROLE_UPDATE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: { guild_id: guildId, role: apiRole },
    });
    if (roleChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: guildId,
        actionType: AuditLogEvent.RoleUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: roleId,
        changes: roleChanges,
      });
    }
    return c.json(apiRole);
  });

  app.delete("/api/v:version/guilds/:guildId/roles/:roleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const roleId = c.req.param("roleId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const role = ds.roles.findOneBy("snowflake", roleId);
    if (!role || role.guild_snowflake !== guildId) return unknownRole(c);
    ds.roles.delete(role.id);
    bus.publish({
      t: "GUILD_ROLE_DELETE",
      guildId,
      requiredIntents: Intents.Guilds,
      d: { guild_id: guildId, role_id: roleId },
    });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.RoleDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: roleId,
      changes: [{ key: "name", old_value: role.name }],
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
    if (!guild) return unknownGuild(c);
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
    if (!guild) return unknownGuild(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return unknownMember(c);
    return c.json(toAPIMember(member, ds));
  });

  app.put("/api/v:version/guilds/:guildId/members/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const user = ds.users.findOneBy("snowflake", userId);
    if (!user) return unknownUser(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const alreadyMember = ds.members.findBy("guild_snowflake", guildId).some((m) => m.user_snowflake === userId);
    const member = addGuildMember(ds, guildId, userId, {
      nick: body.nick as string | null | undefined,
      roles: body.roles as string[] | undefined,
    });
    if (!member || alreadyMember) {
      // Member already existed — Discord returns 204 with no body.
      return new Response(null, { status: 204 });
    }
    const apiMember = toAPIMember(member, ds);
    bus.publish({
      t: "GUILD_MEMBER_ADD",
      guildId,
      requiredIntents: Intents.GuildMembers,
      d: { ...apiMember, guild_id: guildId },
    });
    // If the added member is a bot, its own session learns it joined via GUILD_CREATE.
    if (user.bot) {
      bus.publish({
        t: "GUILD_CREATE",
        guildId,
        requiredIntents: 0,
        targetUserId: user.snowflake,
        d: toAPIGuild(guild, ds, { full: true }),
      });
    }
    return c.json(apiMember, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/members/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return unknownMember(c);
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
    if (body.communication_disabled_until !== undefined) patch.communication_disabled_until = body.communication_disabled_until;
    const previousRoles = member.role_snowflakes;
    if (Object.keys(patch).length > 0) ds.members.update(member.id, patch);
    const updated = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId)!;
    const apiMember = toAPIMember(updated, ds);
    bus.publish({
      t: "GUILD_MEMBER_UPDATE",
      guildId,
      requiredIntents: Intents.GuildMembers,
      d: { ...apiMember, guild_id: guildId },
    });
    if (body.roles !== undefined) {
      const nextRoles = updated.role_snowflakes;
      const added = nextRoles.filter((r) => !previousRoles.includes(r));
      const removed = previousRoles.filter((r) => !nextRoles.includes(r));
      const roleChanges: unknown[] = [];
      if (added.length > 0) roleChanges.push({ key: "$add", new_value: added.map((id) => ({ id })) });
      if (removed.length > 0) roleChanges.push({ key: "$remove", new_value: removed.map((id) => ({ id })) });
      if (roleChanges.length > 0) {
        recordAudit(ds, bus, {
          guildSnowflake: guildId,
          actionType: AuditLogEvent.MemberRoleUpdate,
          actorSnowflake: auth.user?.snowflake ?? null,
          targetSnowflake: userId,
          changes: roleChanges,
        });
      }
    }
    return c.json(apiMember);
  });

  app.delete("/api/v:version/guilds/:guildId/members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return unknownMember(c);
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
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.MemberKick,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: userId,
      reason: auditReason(c),
    });
    return new Response(null, { status: 204 });
  });

  // Add a single role to a member.
  app.put("/api/v:version/guilds/:guildId/members/:userId/roles/:roleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const roleId = c.req.param("roleId");
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    const role = ds.roles.findOneBy("snowflake", roleId);
    if (!member || !role || role.guild_snowflake !== guildId) return notFound(c);
    if (!member.role_snowflakes.includes(roleId)) {
      ds.members.update(member.id, { role_snowflakes: [...member.role_snowflakes, roleId] });
      const updated = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId)!;
      bus.publish({
        t: "GUILD_MEMBER_UPDATE",
        guildId,
        requiredIntents: Intents.GuildMembers,
        d: { ...toAPIMember(updated, ds), guild_id: guildId },
      });
      recordAudit(ds, bus, {
        guildSnowflake: guildId,
        actionType: AuditLogEvent.MemberRoleUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: userId,
        changes: [{ key: "$add", new_value: [{ id: roleId, name: role.name }] }],
      });
    }
    return new Response(null, { status: 204 });
  });

  // Remove a single role from a member.
  app.delete("/api/v:version/guilds/:guildId/members/:userId/roles/:roleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const roleId = c.req.param("roleId");
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (!member) return unknownMember(c);
    if (member.role_snowflakes.includes(roleId)) {
      ds.members.update(member.id, { role_snowflakes: member.role_snowflakes.filter((r) => r !== roleId) });
      const updated = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId)!;
      bus.publish({
        t: "GUILD_MEMBER_UPDATE",
        guildId,
        requiredIntents: Intents.GuildMembers,
        d: { ...toAPIMember(updated, ds), guild_id: guildId },
      });
      const role = ds.roles.findOneBy("snowflake", roleId);
      recordAudit(ds, bus, {
        guildSnowflake: guildId,
        actionType: AuditLogEvent.MemberRoleUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: userId,
        changes: [{ key: "$remove", new_value: [{ id: roleId, name: role?.name }] }],
      });
    }
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
    if (!guild) return unknownGuild(c);
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
    if (!guild) return unknownGuild(c);
    const emoji = ds.emojis.findOneBy("snowflake", emojiId);
    if (!emoji || emoji.guild_snowflake !== guildId) return unknownEmoji(c);
    return c.json(toAPIEmoji(emoji, ds));
  });

  app.post("/api/v:version/guilds/:guildId/emojis", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
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
    emitEmojisUpdate(guildId);
    return c.json(toAPIEmoji(emoji, ds), 201);
  });

  app.patch("/api/v:version/guilds/:guildId/emojis/:emojiId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const emojiId = c.req.param("emojiId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const emoji = ds.emojis.findOneBy("snowflake", emojiId);
    if (!emoji || emoji.guild_snowflake !== guildId) return unknownEmoji(c);
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
    emitEmojisUpdate(guildId);
    return c.json(toAPIEmoji(updated, ds));
  });

  app.delete("/api/v:version/guilds/:guildId/emojis/:emojiId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const emojiId = c.req.param("emojiId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const emoji = ds.emojis.findOneBy("snowflake", emojiId);
    if (!emoji || emoji.guild_snowflake !== guildId) return unknownEmoji(c);
    ds.emojis.delete(emoji.id);
    emitEmojisUpdate(guildId);
    return new Response(null, { status: 204 });
  });
}
