import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser } from "../helpers.js";
import { Intents } from "../gateway/intents.js";

interface ParsedEmoji {
  name: string;
  id: string | null;
  animated: boolean;
}

/** Parse the URL-encoded `:emoji` path param: unicode emoji or custom `name:id`. */
function parseEmoji(raw: string): ParsedEmoji {
  const decoded = decodeURIComponent(raw);
  if (decoded.includes(":")) {
    const [name, id] = decoded.split(":");
    return { name, id: id ?? null, animated: false };
  }
  return { name: decoded, id: null, animated: false };
}

function emojiPayload(e: ParsedEmoji): Record<string, unknown> {
  return { id: e.id, name: e.name, animated: e.animated };
}

export function reactionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const resolveMessage = (channelId: string, messageId: string) => {
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", messageId);
    if (!message || message.channel_snowflake !== channelId) return null;
    return message;
  };

  // Add the authed user's reaction.
  app.put("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return notFound(c);
    const emoji = parseEmoji(c.req.param("emoji"));

    const already = ds.reactions
      .findBy("message_snowflake", messageId)
      .some((r) => r.user_snowflake === auth.user!.snowflake && r.emoji_name === emoji.name && r.emoji_snowflake === emoji.id);
    if (!already) {
      ds.reactions.insert({
        message_snowflake: messageId,
        channel_snowflake: channelId,
        guild_snowflake: message.guild_snowflake,
        user_snowflake: auth.user.snowflake,
        emoji_name: emoji.name,
        emoji_snowflake: emoji.id,
        emoji_animated: emoji.animated,
      });
    }
    bus.publish({
      t: "MESSAGE_REACTION_ADD",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.GuildMessageReactions,
      d: {
        user_id: auth.user.snowflake,
        channel_id: channelId,
        message_id: messageId,
        guild_id: message.guild_snowflake ?? undefined,
        emoji: emojiPayload(emoji),
      },
    });
    return new Response(null, { status: 204 });
  });

  const removeUserReaction = (c: Context<AppEnv>, userSnowflake: string): Response => {
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return notFound(c);
    const emoji = parseEmoji(c.req.param("emoji"));
    const row = ds.reactions
      .findBy("message_snowflake", messageId)
      .find((r) => r.user_snowflake === userSnowflake && r.emoji_name === emoji.name && r.emoji_snowflake === emoji.id);
    if (row) ds.reactions.delete(row.id);
    bus.publish({
      t: "MESSAGE_REACTION_REMOVE",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.GuildMessageReactions,
      d: {
        user_id: userSnowflake,
        channel_id: channelId,
        message_id: messageId,
        guild_id: message.guild_snowflake ?? undefined,
        emoji: emojiPayload(emoji),
      },
    });
    return new Response(null, { status: 204 });
  };

  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    return removeUserReaction(c, auth.user.snowflake);
  });

  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return removeUserReaction(c, c.req.param("userId"));
  });

  // List users who reacted with a given emoji.
  app.get("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const messageId = c.req.param("messageId");
    if (!resolveMessage(c.req.param("channelId"), messageId)) return notFound(c);
    const emoji = parseEmoji(c.req.param("emoji"));
    const limit = Math.min(Number(c.req.query("limit") ?? 25) || 25, 100);
    const users = ds.reactions
      .findBy("message_snowflake", messageId)
      .filter((r) => r.emoji_name === emoji.name && r.emoji_snowflake === emoji.id)
      .slice(0, limit)
      .map((r) => ds.users.findOneBy("snowflake", r.user_snowflake))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => toAPIUser(u));
    return c.json(users);
  });

  // Remove all reactions for a specific emoji.
  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return notFound(c);
    const emoji = parseEmoji(c.req.param("emoji"));
    for (const r of ds.reactions
      .findBy("message_snowflake", messageId)
      .filter((row) => row.emoji_name === emoji.name && row.emoji_snowflake === emoji.id)) {
      ds.reactions.delete(r.id);
    }
    bus.publish({
      t: "MESSAGE_REACTION_REMOVE_EMOJI",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.GuildMessageReactions,
      d: {
        channel_id: channelId,
        message_id: messageId,
        guild_id: message.guild_snowflake ?? undefined,
        emoji: emojiPayload(emoji),
      },
    });
    return new Response(null, { status: 204 });
  });

  // Remove all reactions on the message.
  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return notFound(c);
    for (const r of ds.reactions.findBy("message_snowflake", messageId)) ds.reactions.delete(r.id);
    bus.publish({
      t: "MESSAGE_REACTION_REMOVE_ALL",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.GuildMessageReactions,
      d: { channel_id: channelId, message_id: messageId, guild_id: message.guild_snowflake ?? undefined },
    });
    return new Response(null, { status: 204 });
  });
}
