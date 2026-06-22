import { randomBytes } from "node:crypto";
import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser, toAPIMessage, recordAudit, AuditLogEvent } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordBan, DiscordInvite } from "../entities.js";

function toAPIBan(b: DiscordBan, ds: DiscordStore): Record<string, unknown> {
  const user = ds.users.findOneBy("snowflake", b.user_snowflake);
  return { reason: b.reason, user: user ? toAPIUser(user) : null };
}

function toAPIInvite(inv: DiscordInvite, ds: DiscordStore): Record<string, unknown> {
  const guild = inv.guild_snowflake ? ds.guilds.findOneBy("snowflake", inv.guild_snowflake) : null;
  const channel = ds.channels.findOneBy("snowflake", inv.channel_snowflake);
  const inviter = inv.inviter_snowflake ? ds.users.findOneBy("snowflake", inv.inviter_snowflake) : null;
  return {
    code: inv.code,
    type: 0,
    guild: guild ? { id: guild.snowflake, name: guild.name, icon: guild.icon, features: guild.features } : null,
    channel: channel ? { id: channel.snowflake, name: channel.name, type: channel.type } : null,
    inviter: inviter ? toAPIUser(inviter) : undefined,
    uses: inv.uses,
    max_uses: inv.max_uses,
    max_age: inv.max_age,
    temporary: inv.temporary,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
  };
}

export function extrasRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ----- Pins -----
  app.get("/api/v:version/channels/:channelId/pins", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const pinned = ds.messages
      .findBy("channel_snowflake", c.req.param("channelId"))
      .filter((m) => m.pinned)
      .map((m) => toAPIMessage(m, ds));
    return c.json(pinned);
  });

  const setPinned = (c: Context<AppEnv>, pinned: boolean) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message || message.channel_snowflake !== channelId) return notFound(c);
    ds.messages.update(message.id, { pinned });
    bus.publish({
      t: "CHANNEL_PINS_UPDATE",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { guild_id: message.guild_snowflake ?? undefined, channel_id: channelId, last_pin_timestamp: new Date().toISOString() },
    });
    return new Response(null, { status: 204 });
  };

  app.put("/api/v:version/channels/:channelId/pins/:messageId", (c) => setPinned(c, true));
  app.delete("/api/v:version/channels/:channelId/pins/:messageId", (c) => setPinned(c, false));

  // ----- Bans -----
  app.get("/api/v:version/guilds/:guildId/bans", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const bans = ds.bans.findBy("guild_snowflake", c.req.param("guildId")).map((b) => toAPIBan(b, ds));
    return c.json(bans);
  });

  app.get("/api/v:version/guilds/:guildId/bans/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const ban = ds.bans
      .findBy("guild_snowflake", c.req.param("guildId"))
      .find((b) => b.user_snowflake === c.req.param("userId"));
    if (!ban) return notFound(c);
    return c.json(toAPIBan(ban, ds));
  });

  app.put("/api/v:version/guilds/:guildId/bans/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    const user = ds.users.findOneBy("snowflake", userId);
    if (!guild || !user) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    if (!ds.bans.findBy("guild_snowflake", guildId).some((b) => b.user_snowflake === userId)) {
      ds.bans.insert({ guild_snowflake: guildId, user_snowflake: userId, reason: body.reason ?? null });
    }
    // Remove the member if present.
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
    if (member) {
      ds.members.delete(member.id);
      ds.guilds.update(guild.id, { member_snowflakes: guild.member_snowflakes.filter((s) => s !== userId) });
      bus.publish({
        t: "GUILD_MEMBER_REMOVE",
        guildId,
        requiredIntents: Intents.GuildMembers,
        d: { guild_id: guildId, user: toAPIUser(user) },
      });
    }
    bus.publish({
      t: "GUILD_BAN_ADD",
      guildId,
      requiredIntents: Intents.GuildModeration,
      d: { guild_id: guildId, user: toAPIUser(user) },
    });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.MemberBanAdd,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: userId,
      reason: body.reason ?? null,
    });
    return new Response(null, { status: 204 });
  });

  app.delete("/api/v:version/guilds/:guildId/bans/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const userId = c.req.param("userId");
    const ban = ds.bans.findBy("guild_snowflake", guildId).find((b) => b.user_snowflake === userId);
    if (!ban) return notFound(c);
    ds.bans.delete(ban.id);
    const user = ds.users.findOneBy("snowflake", userId);
    bus.publish({
      t: "GUILD_BAN_REMOVE",
      guildId,
      requiredIntents: Intents.GuildModeration,
      d: { guild_id: guildId, user: user ? toAPIUser(user) : { id: userId } },
    });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.MemberBanRemove,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: userId,
    });
    return new Response(null, { status: 204 });
  });

  // Bulk ban up to 200 users at once.
  app.post("/api/v:version/guilds/:guildId/bulk-ban", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { user_ids?: string[]; reason?: string };
    const userIds = Array.isArray(body.user_ids) ? body.user_ids.slice(0, 200) : [];
    const banned: string[] = [];
    const failed: string[] = [];
    for (const userId of userIds) {
      const user = ds.users.findOneBy("snowflake", userId);
      const already = ds.bans.findBy("guild_snowflake", guildId).some((b) => b.user_snowflake === userId);
      if (!user || already) {
        failed.push(userId);
        continue;
      }
      ds.bans.insert({ guild_snowflake: guildId, user_snowflake: userId, reason: body.reason ?? null });
      const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === userId);
      if (member) {
        ds.members.delete(member.id);
        ds.guilds.update(guild.id, { member_snowflakes: guild.member_snowflakes.filter((s) => s !== userId) });
        bus.publish({ t: "GUILD_MEMBER_REMOVE", guildId, requiredIntents: Intents.GuildMembers, d: { guild_id: guildId, user: toAPIUser(user) } });
      }
      bus.publish({ t: "GUILD_BAN_ADD", guildId, requiredIntents: Intents.GuildModeration, d: { guild_id: guildId, user: toAPIUser(user) } });
      recordAudit(ds, bus, {
        guildSnowflake: guildId,
        actionType: AuditLogEvent.MemberBanAdd,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: userId,
        reason: body.reason ?? null,
      });
      banned.push(userId);
    }
    // Discord returns 400 if no users could be banned.
    if (banned.length === 0) return c.json({ banned_users: [], failed_users: failed }, 400);
    return c.json({ banned_users: banned, failed_users: failed });
  });

  // ----- Invites -----
  app.post("/api/v:version/channels/:channelId/invites", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      max_age?: number;
      max_uses?: number;
      temporary?: boolean;
    };
    const maxAge = body.max_age ?? 86400;
    const invite = ds.invites.insert({
      code: randomBytes(5).toString("base64url").slice(0, 8),
      guild_snowflake: channel.guild_snowflake,
      channel_snowflake: channel.snowflake,
      inviter_snowflake: auth.user?.snowflake ?? null,
      uses: 0,
      max_uses: body.max_uses ?? 0,
      max_age: maxAge,
      temporary: body.temporary ?? false,
      expires_at: maxAge > 0 ? new Date(Date.now() + maxAge * 1000).toISOString() : null,
    });
    bus.publish({
      t: "INVITE_CREATE",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.GuildInvites,
      d: {
        channel_id: channel.snowflake,
        code: invite.code,
        created_at: invite.created_at,
        guild_id: channel.guild_snowflake ?? undefined,
        inviter: auth.user ? toAPIUser(auth.user) : undefined,
        max_age: invite.max_age,
        max_uses: invite.max_uses,
        temporary: invite.temporary,
        uses: 0,
      },
    });
    return c.json(toAPIInvite(invite, ds), 200);
  });

  app.get("/api/v:version/channels/:channelId/invites", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json(ds.invites.findBy("channel_snowflake", c.req.param("channelId")).map((i) => toAPIInvite(i, ds)));
  });

  app.get("/api/v:version/guilds/:guildId/invites", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json(ds.invites.findBy("guild_snowflake", c.req.param("guildId")).map((i) => toAPIInvite(i, ds)));
  });

  app.get("/api/v:version/invites/:code", (c) => {
    const ds = getDiscordStore(store);
    const invite = ds.invites.findOneBy("code", c.req.param("code"));
    if (!invite) return notFound(c);
    return c.json(toAPIInvite(invite, ds));
  });

  app.delete("/api/v:version/invites/:code", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const invite = ds.invites.findOneBy("code", c.req.param("code"));
    if (!invite) return notFound(c);
    const payload = toAPIInvite(invite, ds);
    ds.invites.delete(invite.id);
    bus.publish({
      t: "INVITE_DELETE",
      guildId: invite.guild_snowflake,
      requiredIntents: Intents.GuildInvites,
      d: { channel_id: invite.channel_snowflake, guild_id: invite.guild_snowflake ?? undefined, code: invite.code },
    });
    return c.json(payload);
  });
}
