import { randomBytes } from "node:crypto";
import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, unknownGuild, unknownChannel, unknownMessage, unknownBan, unknownInvite, invalidFormBody, toAPIUser, toAPIMessage, toAPIScheduledEvent, recordAudit, AuditLogEvent, auditReason } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordBan, DiscordInvite } from "../entities.js";

function toAPIBan(b: DiscordBan, ds: DiscordStore): Record<string, unknown> {
  const user = ds.users.findOneBy("snowflake", b.user_snowflake);
  return { reason: b.reason, user: user ? toAPIUser(user) : null };
}

/**
 * On a ban, Discord deletes the user's recent messages in the guild. `delete_message_seconds`
 * (0-604800) takes precedence; the deprecated `delete_message_days` (0-7) is converted to seconds.
 */
function deleteRecentMessages(
  ds: DiscordStore,
  guildSnowflake: string,
  userSnowflake: string,
  deleteMessageSeconds?: number,
  deleteMessageDays?: number,
): void {
  let seconds = 0;
  if (typeof deleteMessageSeconds === "number") seconds = deleteMessageSeconds;
  else if (typeof deleteMessageDays === "number") seconds = deleteMessageDays * 86400;
  if (seconds <= 0) return;
  const cutoff = Date.now() - Math.min(seconds, 604800) * 1000;
  for (const m of ds.messages.findBy("guild_snowflake", guildSnowflake)) {
    if (m.author_snowflake !== userSnowflake) continue;
    if (new Date(m.timestamp).getTime() >= cutoff) ds.messages.delete(m.id);
  }
}

interface InviteSerializeOptions {
  withCounts?: boolean;
  guildScheduledEventId?: string | null;
}

function toAPIInvite(inv: DiscordInvite, ds: DiscordStore, opts: InviteSerializeOptions = {}): Record<string, unknown> {
  const guild = inv.guild_snowflake ? ds.guilds.findOneBy("snowflake", inv.guild_snowflake) : null;
  const channel = ds.channels.findOneBy("snowflake", inv.channel_snowflake);
  const inviter = inv.inviter_snowflake ? ds.users.findOneBy("snowflake", inv.inviter_snowflake) : null;
  const payload: Record<string, unknown> = {
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
  // Voice channel target fields, only present when the invite targets a stream/embedded app.
  if (inv.target_type != null) {
    payload.target_type = inv.target_type;
    if (inv.target_user_snowflake) {
      const targetUser = ds.users.findOneBy("snowflake", inv.target_user_snowflake);
      if (targetUser) payload.target_user = toAPIUser(targetUser);
    }
    if (inv.target_application_snowflake) {
      const targetApp = ds.applications.findOneBy("snowflake", inv.target_application_snowflake);
      if (targetApp) {
        payload.target_application = {
          id: targetApp.snowflake,
          name: targetApp.name,
          description: targetApp.description,
          icon: targetApp.icon,
          bot: targetApp.bot_user_snowflake ? toAPIUser(ds.users.findOneBy("snowflake", targetApp.bot_user_snowflake)!) : undefined,
        };
      }
    }
  }
  if (inv.flags != null) payload.flags = inv.flags;
  // Counts are only returned on GET /invites/{code} when with_counts is true.
  if (opts.withCounts && guild) {
    payload.approximate_member_count = guild.member_snowflakes.length;
    payload.approximate_presence_count = guild.member_snowflakes.length;
  }
  // Only included when a valid guild_scheduled_event_id is supplied to GET /invites/{code}.
  if (opts.guildScheduledEventId) {
    const event = ds.scheduledEvents.findOneBy("snowflake", opts.guildScheduledEventId);
    if (event && event.guild_snowflake === inv.guild_snowflake) {
      payload.guild_scheduled_event = toAPIScheduledEvent(event, ds);
    }
  }
  return payload;
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
    const messageId = c.req.param("messageId");
    const message = ds.messages.findOneBy("snowflake", messageId);
    if (!message || message.channel_snowflake !== channelId) return unknownMessage(c);
    ds.messages.update(message.id, { pinned });
    bus.publish({
      t: "CHANNEL_PINS_UPDATE",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { guild_id: message.guild_snowflake ?? undefined, channel_id: channelId, last_pin_timestamp: new Date().toISOString() },
    });
    if (message.guild_snowflake) {
      recordAudit(ds, bus, {
        guildSnowflake: message.guild_snowflake,
        actionType: pinned ? AuditLogEvent.MessagePin : AuditLogEvent.MessageUnpin,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: message.author_snowflake,
        reason: auditReason(c),
      });
    }
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
    if (!ban) return unknownBan(c);
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
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; delete_message_seconds?: number; delete_message_days?: number };
    const reason = auditReason(c) ?? body.reason ?? null;
    if (!ds.bans.findBy("guild_snowflake", guildId).some((b) => b.user_snowflake === userId)) {
      ds.bans.insert({ guild_snowflake: guildId, user_snowflake: userId, reason });
    }
    deleteRecentMessages(ds, guildId, userId, body.delete_message_seconds, body.delete_message_days);
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
      reason,
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
    if (!ban) return unknownBan(c);
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
      reason: auditReason(c),
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
    if (!guild) return unknownGuild(c);
    const body = (await c.req.json().catch(() => ({}))) as { user_ids?: string[]; reason?: string; delete_message_seconds?: number };
    const reason = auditReason(c) ?? body.reason ?? null;
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
      ds.bans.insert({ guild_snowflake: guildId, user_snowflake: userId, reason });
      deleteRecentMessages(ds, guildId, userId, body.delete_message_seconds);
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
        reason,
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
    if (!channel) return unknownChannel(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      max_age?: number;
      max_uses?: number;
      temporary?: boolean;
      unique?: boolean;
      target_type?: number;
      target_user_id?: string;
      target_application_id?: string;
    };

    // Validate ranges: max_age 0-604800 (7 days), max_uses 0-100 — out-of-range is a 50035.
    const errors: Record<string, string> = {};
    if (body.max_age != null && (typeof body.max_age !== "number" || body.max_age < 0 || body.max_age > 604800)) {
      errors.max_age = "int value should be between 0 and 604800.";
    }
    if (body.max_uses != null && (typeof body.max_uses !== "number" || body.max_uses < 0 || body.max_uses > 100)) {
      errors.max_uses = "int value should be between 0 and 100.";
    }
    if (body.target_type != null && body.target_type !== 1 && body.target_type !== 2) {
      errors.target_type = "Value must be one of (1, 2).";
    }
    if (Object.keys(errors).length > 0) return invalidFormBody(c, errors);

    const maxAge = body.max_age ?? 86400;
    const maxUses = body.max_uses ?? 0;
    const targetType = body.target_type ?? null;

    // Unless `unique` is set, reuse an existing equivalent invite on this channel (Discord behavior).
    if (!body.unique) {
      const existing = ds.invites.findBy("channel_snowflake", channel.snowflake).find(
        (i) =>
          i.max_age === maxAge &&
          i.max_uses === maxUses &&
          i.temporary === (body.temporary ?? false) &&
          (i.target_type ?? null) === targetType &&
          (i.target_user_snowflake ?? null) === (body.target_user_id ?? null) &&
          (i.target_application_snowflake ?? null) === (body.target_application_id ?? null),
      );
      if (existing) return c.json(toAPIInvite(existing, ds), 200);
    }

    const invite = ds.invites.insert({
      code: randomBytes(5).toString("base64url").slice(0, 8),
      guild_snowflake: channel.guild_snowflake,
      channel_snowflake: channel.snowflake,
      inviter_snowflake: auth.user?.snowflake ?? null,
      uses: 0,
      max_uses: maxUses,
      max_age: maxAge,
      temporary: body.temporary ?? false,
      expires_at: maxAge > 0 ? new Date(Date.now() + maxAge * 1000).toISOString() : null,
      target_type: targetType,
      target_user_snowflake: body.target_user_id ?? null,
      target_application_snowflake: body.target_application_id ?? null,
      flags: 0,
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
    if (channel.guild_snowflake) {
      recordAudit(ds, bus, {
        guildSnowflake: channel.guild_snowflake,
        actionType: AuditLogEvent.InviteCreate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: null,
        changes: [{ key: "code", new_value: invite.code }],
        reason: auditReason(c),
      });
    }
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
    if (!invite) return unknownInvite(c);
    const withCounts = c.req.query("with_counts") === "true";
    const guildScheduledEventId = c.req.query("guild_scheduled_event_id") ?? null;
    return c.json(toAPIInvite(invite, ds, { withCounts, guildScheduledEventId }));
  });

  app.delete("/api/v:version/invites/:code", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const invite = ds.invites.findOneBy("code", c.req.param("code"));
    if (!invite) return unknownInvite(c);
    const payload = toAPIInvite(invite, ds);
    ds.invites.delete(invite.id);
    bus.publish({
      t: "INVITE_DELETE",
      guildId: invite.guild_snowflake,
      requiredIntents: Intents.GuildInvites,
      d: { channel_id: invite.channel_snowflake, guild_id: invite.guild_snowflake ?? undefined, code: invite.code },
    });
    if (invite.guild_snowflake) {
      recordAudit(ds, bus, {
        guildSnowflake: invite.guild_snowflake,
        actionType: AuditLogEvent.InviteDelete,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: null,
        changes: [{ key: "code", old_value: invite.code }],
        reason: auditReason(c),
      });
    }
    return c.json(payload);
  });
}
