import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  unknownUser,
  unknownGuild,
  unknownMember,
  toAPIUser,
  toAPIChannel,
  toAPIMember,
} from "../helpers.js";
import { createChannel } from "../factories.js";
import { computeGuildPermissions } from "../permissions.js";
import { Intents } from "../gateway/intents.js";

export function usersRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // Register @me literal routes before the :userId param route so "@me" is not
  // captured as a user id.
  app.get("/api/v:version/users/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    return c.json(toAPIUser(auth.user, true));
  });

  app.patch("/api/v:version/users/@me", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body allowed
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.username === "string") patch.username = body.username;
    if (body.global_name !== undefined) patch.global_name = body.global_name;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.banner !== undefined) patch.banner = body.banner;
    if (Object.keys(patch).length > 0) ds.users.update(auth.user.id, patch);
    const updated = ds.users.findOneBy("snowflake", auth.user.snowflake) ?? auth.user;
    bus.publish({ t: "USER_UPDATE", guildId: null, requiredIntents: 0, d: toAPIUser(updated, true) });
    return c.json(toAPIUser(updated, true));
  });

  app.get("/api/v:version/users/@me/guilds", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const withCounts = c.req.query("with_counts") === "true";
    const before = c.req.query("before");
    const after = c.req.query("after");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined ? Math.max(0, Math.min(200, Number(limitRaw) || 0)) : 200;
    const memberships = ds.members.findBy("user_snowflake", auth.user.snowflake);
    let resolved = memberships
      .map((m) => ds.guilds.findOneBy("snowflake", m.guild_snowflake))
      .filter((g): g is NonNullable<typeof g> => !!g)
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? -1 : 1));
    // before/after are snowflake cursors over the guild id.
    if (after) resolved = resolved.filter((g) => BigInt(g.snowflake) > BigInt(after));
    if (before) resolved = resolved.filter((g) => BigInt(g.snowflake) < BigInt(before));
    resolved = resolved.slice(0, limit);
    const guilds = resolved.map((g) => {
      const partial: Record<string, unknown> = {
        id: g.snowflake,
        name: g.name,
        icon: g.icon,
        banner: g.banner ?? null,
        owner: g.owner_snowflake === auth.user!.snowflake,
        permissions: computeGuildPermissions(ds, auth.user!.snowflake, g.snowflake).toString(),
        features: g.features,
      };
      if (withCounts) {
        partial.approximate_member_count = g.member_snowflakes.length;
        partial.approximate_presence_count = g.member_snowflakes.length;
      }
      return partial;
    });
    return c.json(guilds);
  });

  // Current user's member object within a specific guild (oauth `guilds.members.read`).
  app.get("/api/v:version/users/@me/guilds/:guildId/member", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return unknownGuild(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === auth.user!.snowflake);
    if (!member) return unknownMember(c);
    return c.json(toAPIMember(member, ds));
  });

  // Leave a guild.
  app.delete("/api/v:version/users/@me/guilds/:guildId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const member = ds.members.findBy("guild_snowflake", guildId).find((m) => m.user_snowflake === auth.user!.snowflake);
    if (member) {
      ds.members.delete(member.id);
      ds.guilds.update(guild.id, { member_snowflakes: guild.member_snowflakes.filter((s) => s !== auth.user!.snowflake) });
      bus.publish({
        t: "GUILD_MEMBER_REMOVE",
        guildId,
        requiredIntents: Intents.GuildMembers,
        d: { guild_id: guildId, user: toAPIUser(auth.user) },
      });
      // The leaving user/bot sees the guild become unavailable (targeted: only it leaves).
      bus.publish({ t: "GUILD_DELETE", guildId, requiredIntents: 0, targetUserId: auth.user.snowflake, d: { id: guildId, unavailable: false } });
    }
    return new Response(null, { status: 204 });
  });

  app.post("/api/v:version/users/@me/channels", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const recipientId = typeof body.recipient_id === "string" ? body.recipient_id : "";
    const recipient = ds.users.findOneBy("snowflake", recipientId);
    if (!recipient) return unknownUser(c);

    // Reuse an existing DM with the same recipient pair if present.
    const existing = ds.channels
      .all()
      .find(
        (ch) =>
          ch.type === 1 &&
          ch.recipient_snowflakes.includes(auth.user!.snowflake) &&
          ch.recipient_snowflakes.includes(recipient.snowflake),
      );
    if (existing) return c.json(toAPIChannel(existing));

    const dm = createChannel(ds, { name: "", type: 1, guildSnowflake: null });
    ds.channels.update(dm.id, { recipient_snowflakes: [auth.user.snowflake, recipient.snowflake] });
    const created = ds.channels.findOneBy("snowflake", dm.snowflake)!;
    return c.json(toAPIChannel(created));
  });

  app.get("/api/v:version/users/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const user = ds.users.findOneBy("snowflake", c.req.param("userId"));
    if (!user) return unknownUser(c);
    return c.json(toAPIUser(user));
  });
}
