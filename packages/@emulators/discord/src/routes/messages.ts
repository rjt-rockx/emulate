import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, unknownChannel, unknownMessage, discordError, toAPIMessage, redactMessageContent, isEphemeral, parseMessageBody, requirePermission } from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import { PermissionFlags } from "../permissions.js";
import type { DiscordMessage } from "../entities.js";

const MENTION_RE = /<@!?(\d+)>/g;
const ROLE_MENTION_RE = /<@&(\d+)>/g;

function parseMentions(content: string): { users: string[]; roles: string[]; everyone: boolean } {
  const users = new Set<string>();
  const roles = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(content)) !== null) users.add(m[1]);
  while ((m = ROLE_MENTION_RE.exec(content)) !== null) roles.add(m[1]);
  return { users: [...users], roles: [...roles], everyone: /@everyone\b|@here\b/.test(content) };
}

interface AllowedMentions {
  parse?: string[];
  users?: string[];
  roles?: string[];
  replied_user?: boolean;
}

/**
 * Apply an `allowed_mentions` allow-list to the mentions parsed from content. When omitted,
 * every mention in the content pings (REST default). When present, only the categories in
 * `parse` ping, plus any ids explicitly whitelisted in `users`/`roles` that actually appear.
 */
function applyAllowedMentions(
  parsed: { users: string[]; roles: string[]; everyone: boolean },
  allowed: AllowedMentions | undefined,
): { users: string[]; roles: string[]; everyone: boolean } {
  if (!allowed) return parsed;
  const parse = allowed.parse;
  const users = (parse?.includes("users") ? parsed.users : (allowed.users ?? [])).filter((id) => parsed.users.includes(id));
  const roles = (parse?.includes("roles") ? parsed.roles : (allowed.roles ?? [])).filter((id) => parsed.roles.includes(id));
  const everyone = (parse?.includes("everyone") ?? false) && parsed.everyone;
  return { users, roles, everyone };
}

export function messagesRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus, baseUrl } = ctx;

  const messageIntents = (guildSnowflake: string | null) =>
    guildSnowflake ? Intents.GuildMessages : Intents.DirectMessages;

  app.get("/api/v:version/channels/:channelId/messages", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    if (!ds.channels.findOneBy("snowflake", channelId)) return unknownChannel(c);
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);
    const before = c.req.query("before");
    const after = c.req.query("after");
    let messages = ds.messages
      .findBy("channel_snowflake", channelId)
      // Ephemeral interaction replies are not part of channel history.
      .filter((mm) => !isEphemeral(mm.flags))
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1));
    if (before) messages = messages.filter((mm) => BigInt(mm.snowflake) < BigInt(before));
    if (after) messages = messages.filter((mm) => BigInt(mm.snowflake) > BigInt(after));
    return c.json(messages.slice(0, limit).map((mm) => toAPIMessage(mm, ds, auth.user?.snowflake)));
  });

  app.get("/api/v:version/channels/:channelId/messages/:messageId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message || message.channel_snowflake !== c.req.param("channelId")) return unknownMessage(c);
    return c.json(toAPIMessage(message, ds, auth.user?.snowflake));
  });

  app.post("/api/v:version/channels/:channelId/messages", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const channel = ds.channels.findOneBy("snowflake", channelId);
    if (!channel) return unknownChannel(c);
    const denied = requirePermission(c, store, auth.user.snowflake, PermissionFlags.SendMessages, { channelId });
    if (denied) return denied;
    // Accept JSON or multipart/form-data (file uploads -> synthesized attachment objects).
    const { body, attachments: uploaded } = await parseMessageBody(c, baseUrl, channelId);
    const content = typeof body.content === "string" ? body.content : "";
    const mentions = applyAllowedMentions(parseMentions(content), body.allowed_mentions as AllowedMentions | undefined);
    // A message_reference with a message_id makes this a reply (type 19) that hydrates
    // referenced_message from the target.
    const ref = body.message_reference as { message_id?: string; type?: number } | undefined;
    const isReply = !!ref?.message_id && (ref.type ?? 0) === 0;
    // Polls specify a duration in hours; convert it to a concrete expiry timestamp.
    let poll = body.poll as DiscordMessage["poll"] | undefined;
    if (poll && typeof (body.poll as { duration?: number }).duration === "number") {
      const hours = (body.poll as { duration: number }).duration;
      poll = { ...poll, expiry: new Date(Date.now() + hours * 3600_000).toISOString() };
    }
    // A message must carry at least one of: content, embeds, attachments, components, poll,
    // sticker_ids -> otherwise 50006 Cannot send an empty message.
    const isEmpty =
      content.length === 0 &&
      !(Array.isArray(body.embeds) && body.embeds.length > 0) &&
      uploaded.length === 0 &&
      !(Array.isArray(body.components) && body.components.length > 0) &&
      !poll &&
      !(Array.isArray(body.sticker_ids) && body.sticker_ids.length > 0);
    if (isEmpty) return discordError(c, 400, "Cannot send an empty message", 50006);
    const message = createMessage(ds, {
      channelSnowflake: channelId,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: auth.user.snowflake,
      content,
      tts: body.tts === true,
      type: isReply ? 19 : 0,
      embeds: (body.embeds as unknown[] | undefined) ?? [],
      components: (body.components as unknown[] | undefined) ?? [],
      attachments: uploaded.length > 0 ? uploaded : ((body.attachments as unknown[] | undefined) ?? []),
      nonce: typeof body.nonce === "string" ? body.nonce : typeof body.nonce === "number" ? String(body.nonce) : null,
      messageReference: (body.message_reference as never) ?? null,
      referencedMessageSnowflake: isReply ? ref!.message_id! : null,
      poll: poll ?? null,
      mentionSnowflakes: mentions.users,
      mentionRoleSnowflakes: mentions.roles,
      mentionEveryone: mentions.everyone,
    });
    const payload = toAPIMessage(message, ds);
    bus.publish({
      t: "MESSAGE_CREATE",
      guildId: channel.guild_snowflake,
      requiredIntents: messageIntents(channel.guild_snowflake),
      d: payload,
      redactedData: redactMessageContent(payload),
      messageAuthorId: message.author_snowflake,
      messageMentionIds: message.mention_snowflakes,
    });
    return c.json(payload, 200);
  });

  app.patch("/api/v:version/channels/:channelId/messages/:messageId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message || message.channel_snowflake !== c.req.param("channelId")) return unknownMessage(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const patch: Record<string, unknown> = { edited_timestamp: new Date().toISOString() };
    if (typeof body.content === "string") {
      patch.content = body.content;
      const mentions = parseMentions(body.content);
      patch.mention_snowflakes = mentions.users;
      patch.mention_everyone = mentions.everyone;
    }
    if (body.embeds !== undefined) patch.embeds = body.embeds;
    if (body.components !== undefined) patch.components = body.components;
    if (body.flags !== undefined) patch.flags = body.flags;
    ds.messages.update(message.id, patch);
    const updated = ds.messages.findOneBy("snowflake", message.snowflake)!;
    const payload = toAPIMessage(updated, ds);
    bus.publish({
      t: "MESSAGE_UPDATE",
      guildId: updated.guild_snowflake,
      requiredIntents: messageIntents(updated.guild_snowflake),
      d: payload,
      redactedData: redactMessageContent(payload),
      messageAuthorId: updated.author_snowflake,
      messageMentionIds: updated.mention_snowflakes,
    });
    return c.json(payload);
  });

  app.delete("/api/v:version/channels/:channelId/messages/:messageId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message || message.channel_snowflake !== channelId) return unknownMessage(c);
    for (const r of ds.reactions.findBy("message_snowflake", message.snowflake)) ds.reactions.delete(r.id);
    ds.messages.delete(message.id);
    bus.publish({
      t: "MESSAGE_DELETE",
      guildId: message.guild_snowflake,
      requiredIntents: messageIntents(message.guild_snowflake),
      d: { id: message.snowflake, channel_id: channelId, guild_id: message.guild_snowflake ?? undefined },
    });
    return new Response(null, { status: 204 });
  });

  app.post("/api/v:version/channels/:channelId/messages/bulk-delete", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    let body: { messages?: string[] } = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    for (const id of body.messages ?? []) {
      const message = ds.messages.findOneBy("snowflake", id);
      if (message && message.channel_snowflake === channelId) ds.messages.delete(message.id);
    }
    bus.publish({
      t: "MESSAGE_DELETE_BULK",
      guildId: ds.channels.findOneBy("snowflake", channelId)?.guild_snowflake ?? null,
      requiredIntents: Intents.GuildMessages,
      d: { ids: body.messages ?? [], channel_id: channelId },
    });
    return new Response(null, { status: 204 });
  });
}
