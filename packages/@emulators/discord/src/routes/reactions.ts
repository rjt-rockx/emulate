import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import type { DiscordStore } from "../store.js";
import { requireBot, requireUser, unknownMessage, unknownEmoji, discordError, toAPIUser, toAPIMember } from "../helpers.js";
import { Intents } from "../gateway/intents.js";

interface ParsedEmoji {
  name: string;
  id: string | null;
  animated: boolean;
}

/**
 * Parse the URL-encoded `:emoji` path param: unicode emoji or custom `name:id`. For a custom
 * emoji, the `animated` flag is resolved from the stored emoji entity so the serialized reaction
 * reflects the real emoji.
 */
function parseEmoji(raw: string, ds: DiscordStore): ParsedEmoji {
  const decoded = decodeURIComponent(raw);
  if (decoded.includes(":")) {
    const [name, id] = decoded.split(":");
    const stored = id ? ds.emojis.findOneBy("snowflake", id) : undefined;
    return { name, id: id ?? null, animated: stored?.animated ?? false };
  }
  return { name: decoded, id: null, animated: false };
}

function emojiPayload(e: ParsedEmoji): Record<string, unknown> {
  return { id: e.id, name: e.name, animated: e.animated };
}

const MAX_DISTINCT_EMOJI = 20;

export function reactionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const resolveMessage = (channelId: string, messageId: string) => {
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", messageId);
    if (!message || message.channel_snowflake !== channelId) return null;
    return message;
  };

  const reactionKey = (name: string, id: string | null) => (id ? `${name}:${id}` : name);

  // Add the authed user's reaction.
  app.put("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji/@me", (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return unknownMessage(c);
    const emoji = parseEmoji(c.req.param("emoji"), ds);

    const existingReactions = ds.reactions.findBy("message_snowflake", messageId);
    const distinctEmoji = new Set(existingReactions.map((r) => reactionKey(r.emoji_name, r.emoji_snowflake)));
    const already = existingReactions.some(
      (r) => r.user_snowflake === auth.user!.snowflake && r.emoji_name === emoji.name && r.emoji_snowflake === emoji.id,
    );
    // For a custom emoji that is not already on the message, verify it exists in the emoji store.
    const emojiAlreadyOnMessage = distinctEmoji.has(reactionKey(emoji.name, emoji.id));
    if (emoji.id !== null && !emojiAlreadyOnMessage && !ds.emojis.findOneBy("snowflake", emoji.id)) return unknownEmoji(c);
    // A message may carry at most 20 distinct emoji. Adding a NEW distinct emoji past that cap is
    // rejected; reacting with an emoji already present on the message is always allowed.
    if (!already && !emojiAlreadyOnMessage && distinctEmoji.size >= MAX_DISTINCT_EMOJI) {
      return discordError(c, 400, "Maximum number of reactions reached (20)", 30010);
    }
    if (!already) {
      ds.reactions.insert({
        message_snowflake: messageId,
        channel_snowflake: channelId,
        guild_snowflake: message.guild_snowflake,
        user_snowflake: auth.user!.snowflake,
        emoji_name: emoji.name,
        emoji_snowflake: emoji.id,
        emoji_animated: emoji.animated,
        burst: false,
      });
    }
    const reactingMember = message.guild_snowflake
      ? ds.members.findBy("guild_snowflake", message.guild_snowflake).find((m) => m.user_snowflake === auth.user!.snowflake)
      : undefined;
    bus.publish({
      t: "MESSAGE_REACTION_ADD",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.GuildMessageReactions,
      d: {
        user_id: auth.user!.snowflake,
        channel_id: channelId,
        message_id: messageId,
        guild_id: message.guild_snowflake ?? undefined,
        member: reactingMember ? { ...toAPIMember(reactingMember, ds), user: toAPIUser(auth.user!) } : undefined,
        emoji: emojiPayload(emoji),
        message_author_id: message.author_snowflake,
        burst: false,
        type: 0,
      },
    });
    return new Response(null, { status: 204 });
  });

  const removeUserReaction = (c: Context<AppEnv>, userSnowflake: string): Response => {
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return unknownMessage(c);
    const emoji = parseEmoji(c.req.param("emoji"), ds);
    if (emoji.id !== null && !ds.emojis.findOneBy("snowflake", emoji.id)) return unknownEmoji(c);
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
        burst: false,
        type: 0,
      },
    });
    return new Response(null, { status: 204 });
  };

  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji/@me", (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth } = g;
    return removeUserReaction(c, auth.user!.snowflake);
  });

  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji/:userId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g;
    return removeUserReaction(c, c.req.param("userId"));
  });

  // List users who reacted with a given emoji. Honors `type` (0 NORMAL / 1 BURST), `after`, `limit`.
  app.get("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const messageId = c.req.param("messageId");
    if (!resolveMessage(c.req.param("channelId"), messageId)) return unknownMessage(c);
    const emoji = parseEmoji(c.req.param("emoji"), ds);
    if (emoji.id !== null && !ds.emojis.findOneBy("snowflake", emoji.id)) return unknownEmoji(c);
    const limit = Math.min(Number(c.req.query("limit") ?? 25) || 25, 100);
    const type = Number(c.req.query("type") ?? 0) || 0; // 0 NORMAL, 1 BURST
    const after = c.req.query("after");
    const users = ds.reactions
      .findBy("message_snowflake", messageId)
      .filter((r) => r.emoji_name === emoji.name && r.emoji_snowflake === emoji.id)
      .filter((r) => (type === 1 ? r.burst === true : r.burst !== true))
      .filter((r) => (after ? BigInt(r.user_snowflake) > BigInt(after) : true))
      .sort((a, b) => (BigInt(a.user_snowflake) < BigInt(b.user_snowflake) ? -1 : 1))
      .slice(0, limit)
      .map((r) => ds.users.findOneBy("snowflake", r.user_snowflake))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => toAPIUser(u));
    return c.json(users);
  });

  // Remove all reactions for a specific emoji.
  app.delete("/api/v:version/channels/:channelId/messages/:messageId/reactions/:emoji", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return unknownMessage(c);
    const emoji = parseEmoji(c.req.param("emoji"), ds);
    if (emoji.id !== null && !ds.emojis.findOneBy("snowflake", emoji.id)) return unknownEmoji(c);
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
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const message = resolveMessage(channelId, messageId);
    if (!message) return unknownMessage(c);
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
