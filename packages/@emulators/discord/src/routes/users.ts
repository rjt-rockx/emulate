import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  requireUser,
  unauthorized,
  unknownUser,
  unknownGuild,
  unknownMember,
  discordError,
  invalidFormBody,
  toAPIUser,
  toAPIChannel,
  toAPIMember,
  getGuildMember,
} from "../helpers.js";
import { createChannel } from "../factories.js";
import { computeGuildPermissions } from "../permissions.js";
import { Intents } from "../gateway/intents.js";
import { ChannelType } from "../constants.js";
import type { Context, AppEnv, Store } from "@emulators/core";
import type { DiscordAuth } from "../helpers.js";

/** Returns a 403 "Missing required OAuth2 scope" (50026) response. */
function missingScopeError(c: Context<AppEnv>): Response {
  return discordError(c, 403, "Missing required OAuth2 scope", 50026);
}

/**
 * When `discord.strict_scopes` is enabled, verify the bearer auth holds the
 * required scope. Bot tokens bypass scope checks entirely. Returns a 403
 * response when the check fails, or null when the caller may proceed.
 */
function requireScope(c: Context<AppEnv>, store: Store, auth: DiscordAuth, scope: string): Response | null {
  if (store.getData<boolean>("discord.strict_scopes") !== true) return null;
  if (auth.type === "bot") return null;
  if (auth.scopes.includes(scope)) return null;
  return missingScopeError(c);
}

export function usersRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // Register @me literal routes before the :userId param route so "@me" is not
  // captured as a user id.
  app.get("/api/v:version/users/@me", (c) => {
    const g = requireUser(c, store);
    if (g instanceof Response) return g;
    const { auth } = g;
    const scopeErr = requireScope(c, store, auth, "identify");
    if (scopeErr) return scopeErr;
    const userObj = toAPIUser(auth.user!, true);
    // S4: For bearer tokens, gate the email field on the email scope regardless of strict mode.
    // Bot tokens are exempt and always see self fields.
    if (auth.type !== "bot" && !auth.scopes.includes("email")) {
      delete userObj.email;
    }
    return c.json(userObj);
  });

  app.patch("/api/v:version/users/@me", async (c) => {
    const g = requireUser(c, store);
    if (g instanceof Response) return g;
    const { auth, ds } = g;
    const user = auth.user!;
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body allowed
    }
    // Validate username when provided: 2-32 chars, no banned substrings, not a reserved word.
    // Banned substrings per docs: @, #, :, ` (backtick), "discord".
    // Reserved words: "everyone", "here".
    if (typeof body.username === "string") {
      const username = body.username;
      const usernameErrors: Record<string, string> = {};
      if (username.length < 2 || username.length > 32) {
        usernameErrors.username = "Must be between 2 and 32 in length.";
      } else if (/[@#:`]/.test(username) || username.toLowerCase().includes("discord")) {
        usernameErrors.username = "Username contains an invalid substring.";
      } else if (/\s/.test(username)) {
        // U4: Leading, trailing, or internal whitespace is not allowed.
        usernameErrors.username = "Username contains disallowed whitespace characters.";
      } else if (username.toLowerCase() === "everyone" || username.toLowerCase() === "here") {
        // U4: Reserved-word check must be case-insensitive.
        usernameErrors.username = "Username is a reserved word.";
      }
      if (Object.keys(usernameErrors).length > 0) return invalidFormBody(c, usernameErrors);
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.username === "string") patch.username = body.username;
    if (body.global_name !== undefined) patch.global_name = body.global_name;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.banner !== undefined) patch.banner = body.banner;
    if (Object.keys(patch).length > 0) ds.users.update(user.id, patch);
    const updated = ds.users.findOneBy("snowflake", user.snowflake) ?? user;
    bus.publish({ t: "USER_UPDATE", guildId: null, requiredIntents: 0, d: toAPIUser(updated, true) });
    return c.json(toAPIUser(updated, true));
  });

  app.get("/api/v:version/users/@me/guilds", (c) => {
    const g = requireUser(c, store);
    if (g instanceof Response) return g;
    const { auth, ds } = g;
    const user = auth.user!;
    const scopeErr = requireScope(c, store, auth, "guilds");
    if (scopeErr) return scopeErr;
    const withCounts = c.req.query("with_counts") === "true";
    const before = c.req.query("before");
    const after = c.req.query("after");
    const limitRaw = c.req.query("limit");
    // U5: limit must be >= 1; reject limit=0 as invalid (doc range: 1-200, default 200).
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return invalidFormBody(c, { limit: "int value should be between 1 and 200." });
      }
    }
    const limit = limitRaw !== undefined ? Math.min(Number(limitRaw), 200) : 200;
    const memberships = ds.members.findBy("user_snowflake", user.snowflake);
    let resolved = memberships
      .map((m) => ds.guilds.findOneBy("snowflake", m.guild_snowflake))
      .filter((guild): guild is NonNullable<typeof guild> => !!guild)
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? -1 : 1));
    // before/after are snowflake cursors over the guild id.
    if (after) resolved = resolved.filter((guild) => BigInt(guild.snowflake) > BigInt(after));
    if (before) resolved = resolved.filter((guild) => BigInt(guild.snowflake) < BigInt(before));
    resolved = resolved.slice(0, limit);
    const guilds = resolved.map((guild) => {
      const partial: Record<string, unknown> = {
        id: guild.snowflake,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner ?? null,
        owner: guild.owner_snowflake === user.snowflake,
        permissions: computeGuildPermissions(ds, user.snowflake, guild.snowflake).toString(),
        features: guild.features,
      };
      if (withCounts) {
        partial.approximate_member_count = guild.member_snowflakes.length;
        partial.approximate_presence_count = guild.member_snowflakes.length;
      }
      return partial;
    });
    return c.json(guilds);
  });

  // Current user's member object within a specific guild (oauth `guilds.members.read`).
  app.get("/api/v:version/users/@me/guilds/:guildId/member", (c) => {
    const g = requireUser(c, store);
    if (g instanceof Response) return g;
    const { auth, ds } = g;
    const user = auth.user!;
    const scopeErr = requireScope(c, store, auth, "guilds.members.read");
    if (scopeErr) return scopeErr;
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return unknownGuild(c);
    const member = getGuildMember(ds, guildId, user.snowflake);
    if (!member) return unknownMember(c);
    return c.json(toAPIMember(member, ds));
  });

  // Leave a guild.
  app.delete("/api/v:version/users/@me/guilds/:guildId", (c) => {
    const g = requireUser(c, store);
    if (g instanceof Response) return g;
    const { auth, ds } = g;
    const user = auth.user!;
    const guildId = c.req.param("guildId");
    const guild = ds.guilds.findOneBy("snowflake", guildId);
    if (!guild) return unknownGuild(c);
    const member = getGuildMember(ds, guildId, user.snowflake);
    if (member) {
      ds.members.delete(member.id);
      ds.guilds.update(guild.id, { member_snowflakes: guild.member_snowflakes.filter((s) => s !== user.snowflake) });
      bus.publish({
        t: "GUILD_MEMBER_REMOVE",
        guildId,
        requiredIntents: Intents.GuildMembers,
        d: { guild_id: guildId, user: toAPIUser(user) },
      });
      // The leaving user/bot sees the guild become unavailable (targeted: only it leaves).
      bus.publish({ t: "GUILD_DELETE", guildId, requiredIntents: 0, targetUserId: user.snowflake, d: { id: guildId, unavailable: false } });
    }
    return new Response(null, { status: 204 });
  });

  app.post("/api/v:version/users/@me/channels", async (c) => {
    const g = requireUser(c, store);
    if (g instanceof Response) return g;
    const { auth, ds } = g;
    const caller = auth.user!;
    let body: Record<string, unknown> = {};
    let rawBody = "";
    try {
      rawBody = await c.req.text();
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      // no-op
    }

    // Group DM path: body contains access_tokens (array) and optional nicks (dict).
    // access_tokens identifies recipients by access-token; in the emulator we treat
    // each token as a user snowflake for simplicity (test-harness controlled).
    if (Array.isArray(body.access_tokens)) {
      const tokens = body.access_tokens as string[];
      const nicks = (body.nicks ?? {}) as Record<string, string>;
      // Collect unique recipient snowflakes from tokens (emulator: token == snowflake).
      const recipientSnowflakes: string[] = [];
      for (const token of tokens) {
        const tokenUser = ds.users.findOneBy("snowflake", token);
        if (tokenUser && !recipientSnowflakes.includes(tokenUser.snowflake)) {
          recipientSnowflakes.push(tokenUser.snowflake);
        }
      }
      // Include the caller as an owner/member.
      const allMembers = [caller.snowflake, ...recipientSnowflakes.filter((s) => s !== caller.snowflake)];

      // Cap at 10 recipients (the API enforces a 10-GDM limit; owner counts toward the total).
      if (allMembers.length > 10) {
        return discordError(c, 400, "Maximum number of group DM users reached (10)", 50007);
      }

      // Reuse an existing group DM with the same member set if present.
      const memberSet = new Set(allMembers);
      const existing = ds.channels.all().find(
        (ch) =>
          ch.type === ChannelType.GroupDM &&
          ch.recipient_snowflakes.length === allMembers.length &&
          ch.recipient_snowflakes.every((s) => memberSet.has(s)),
      );
      if (existing) return c.json(toAPIChannel(existing, ds));

      const gdmName = Object.keys(nicks).length > 0 ? (Object.values(nicks)[0] ?? "") : "";
      const gdmRaw = createChannel(ds, { name: gdmName, type: ChannelType.GroupDM, guildSnowflake: null });
      // findOneBy returns the typed record; use its numeric id to update recipient list.
      const gdmRecord = ds.channels.findOneBy("snowflake", gdmRaw.snowflake)!;
      ds.channels.update(gdmRecord.id, {
        recipient_snowflakes: allMembers,
        owner_snowflake: caller.snowflake,
      });
      const created = ds.channels.findOneBy("snowflake", gdmRaw.snowflake)!;
      // U1: Publish CHANNEL_CREATE event for a new group DM.
      bus.publish({ t: "CHANNEL_CREATE", guildId: null, requiredIntents: Intents.DirectMessages, d: toAPIChannel(created, ds) });
      return c.json(toAPIChannel(created, ds));
    }

    // Single-recipient DM path. discord.py sends recipient_id as a bare JSON number (User.id is an
    // int); re-extract it from the raw text so a 64-bit snowflake isn't mangled by JS number
    // precision. Quoted or unquoted, both yield the digit string.
    const recipientId = rawBody.match(/"recipient_id"\s*:\s*"?(\d+)"?/)?.[1] ?? "";
    // You cannot open a DM with yourself.
    if (recipientId === caller.snowflake) {
      return discordError(c, 400, "Cannot send messages to this user", 50007);
    }
    const recipient = ds.users.findOneBy("snowflake", recipientId);
    if (!recipient) return unknownUser(c);

    // Reuse an existing DM with the same recipient pair if present.
    const existing = ds.channels
      .all()
      .find(
        (ch) =>
          ch.type === ChannelType.DM &&
          ch.recipient_snowflakes.includes(caller.snowflake) &&
          ch.recipient_snowflakes.includes(recipient.snowflake),
      );
    if (existing) return c.json(toAPIChannel(existing, ds));

    const dm = createChannel(ds, { name: "", type: ChannelType.DM, guildSnowflake: null });
    ds.channels.update(dm.id, { recipient_snowflakes: [caller.snowflake, recipient.snowflake] });
    const created = ds.channels.findOneBy("snowflake", dm.snowflake)!;
    return c.json(toAPIChannel(created, ds));
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
