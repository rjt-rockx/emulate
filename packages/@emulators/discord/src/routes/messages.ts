import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  unknownChannel,
  unknownMessage,
  discordError,
  invalidFormBody,
  toAPIMessage,
  toAPIMember,
  redactMessageContent,
  isEphemeral,
  parseMessageBody,
  requirePermission,
  recordAudit,
  AuditLogEvent,
  auditReason,
  MessageFlags,
  CREATE_MESSAGE_SETTABLE_FLAGS,
  EDIT_MESSAGE_SETTABLE_FLAGS,
} from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import { PermissionFlags } from "../permissions.js";
import type { DiscordMessage } from "../entities.js";
import type { DiscordStore } from "../store.js";

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
 * Validate the `allowed_mentions` object against the documented rules:
 *  - `parse` is mutually exclusive with the matching explicit field ("users"/"roles"). Passing a
 *    falsy/empty explicit value alongside `parse` does NOT trigger an error.
 *  - `users` and `roles` are each capped at 100 ids.
 * Returns an `invalidFormBody` (50035) response when invalid, else null.
 */
function validateAllowedMentions(
  c: Parameters<typeof invalidFormBody>[0],
  allowed: AllowedMentions | undefined,
): Response | null {
  if (!allowed) return null;
  const parse = allowed.parse;
  if (parse?.includes("users") && Array.isArray(allowed.users) && allowed.users.length > 0) {
    return invalidFormBody(c, { "allowed_mentions.users": "parse and users are mutually exclusive." });
  }
  if (parse?.includes("roles") && Array.isArray(allowed.roles) && allowed.roles.length > 0) {
    return invalidFormBody(c, { "allowed_mentions.roles": "parse and roles are mutually exclusive." });
  }
  if (Array.isArray(allowed.users) && allowed.users.length > 100) {
    return invalidFormBody(c, { "allowed_mentions.users": "Must be 100 or fewer in length." });
  }
  if (Array.isArray(allowed.roles) && allowed.roles.length > 100) {
    return invalidFormBody(c, { "allowed_mentions.roles": "Must be 100 or fewer in length." });
  }
  return null;
}

/**
 * Apply an `allowed_mentions` allow-list to the mentions parsed from content. When omitted,
 * every mention in the content pings (REST default). When present, only the categories in
 * `parse` ping, plus any ids explicitly whitelisted in `users`/`roles` that actually appear.
 * `repliedAuthor` is the author of the replied-to message; it is added to the user mentions
 * when `replied_user` is true (independent of whether they appear in the content).
 */
function applyAllowedMentions(
  parsed: { users: string[]; roles: string[]; everyone: boolean },
  allowed: AllowedMentions | undefined,
  repliedAuthor?: string | null,
): { users: string[]; roles: string[]; everyone: boolean } {
  let result: { users: string[]; roles: string[]; everyone: boolean };
  if (!allowed) {
    result = { users: [...parsed.users], roles: [...parsed.roles], everyone: parsed.everyone };
  } else {
    const parse = allowed.parse;
    const users = (parse?.includes("users") ? parsed.users : (allowed.users ?? [])).filter((id) => parsed.users.includes(id));
    const roles = (parse?.includes("roles") ? parsed.roles : (allowed.roles ?? [])).filter((id) => parsed.roles.includes(id));
    const everyone = (parse?.includes("everyone") ?? false) && parsed.everyone;
    result = { users, roles, everyone };
  }
  // replied_user defaults to false; only when explicitly true do we mention the replied author.
  if (repliedAuthor && allowed?.replied_user === true && !result.users.includes(repliedAuthor)) {
    result.users.push(repliedAuthor);
  }
  return result;
}

/** A poll create request, with text-length and answer-count validation (50035). */
function validatePollRequest(
  c: Parameters<typeof invalidFormBody>[0],
  poll: { question?: { text?: string }; answers?: unknown[] },
): Response | null {
  const answers = poll.answers ?? [];
  if (!Array.isArray(answers) || answers.length > 10) {
    return invalidFormBody(c, { "poll.answers": "Must be 10 or fewer in length." });
  }
  const questionText = poll.question?.text ?? "";
  if (questionText.length > 300) {
    return invalidFormBody(c, { "poll.question.text": "Must be 300 or fewer in length." });
  }
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i] as { poll_media?: { text?: string } };
    const text = a.poll_media?.text ?? "";
    if (text.length > 55) {
      return invalidFormBody(c, { [`poll.answers.${i}.poll_media.text`]: "Must be 55 or fewer in length." });
    }
  }
  return null;
}

/**
 * Build the minimal message-snapshot subset for a forwarded message. The doc limits the subset to:
 * type, content, embeds, attachments, timestamp, edited_timestamp, flags, mentions, mention_roles,
 * stickers, sticker_items, and components — explicitly EXCLUDING author.
 */
function buildSnapshot(source: DiscordMessage, ds: DiscordStore): { message: Record<string, unknown> } {
  const full = toAPIMessage(source, ds);
  const message: Record<string, unknown> = {
    type: full.type,
    content: full.content,
    embeds: full.embeds,
    attachments: full.attachments,
    timestamp: full.timestamp,
    edited_timestamp: full.edited_timestamp,
    flags: full.flags ?? 0,
    mentions: full.mentions,
    mention_roles: full.mention_roles,
    sticker_items: full.sticker_items,
    components: full.components,
  };
  return { message };
}

export function messagesRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus, baseUrl } = ctx;

  const messageIntents = (guildSnowflake: string | null) =>
    guildSnowflake ? Intents.GuildMessages : Intents.DirectMessages;

  /**
   * MESSAGE_CREATE / MESSAGE_UPDATE gateway payloads carry extra fields beyond the REST shape:
   * the author's guild `member` and the `channel_type`. We augment locally rather than changing
   * toAPIMessage (which models the REST response).
   */
  const gatewayMessagePayload = (m: DiscordMessage, ds: DiscordStore, rest: Record<string, unknown>): Record<string, unknown> => {
    const channel = ds.channels.findOneBy("snowflake", m.channel_snowflake);
    const payload: Record<string, unknown> = { ...rest, channel_type: channel?.type };
    if (m.guild_snowflake) {
      const member = ds.members.findBy("guild_snowflake", m.guild_snowflake).find((mm) => mm.user_snowflake === m.author_snowflake);
      if (member) payload.member = toAPIMember(member, ds);
    }
    return payload;
  };

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

    // Resolve and mask the create-settable flags (only SUPPRESS_EMBEDS, SUPPRESS_NOTIFICATIONS,
    // IS_VOICE_MESSAGE, IS_COMPONENTS_V2 may be set by a client).
    const requestedFlags = typeof body.flags === "number" ? body.flags : 0;
    const flags = requestedFlags & CREATE_MESSAGE_SETTABLE_FLAGS;
    const isComponentsV2 = (flags & MessageFlags.IsComponentsV2) !== 0;

    // A message_reference may make this a reply (DEFAULT/type 0) or a forward (FORWARD/type 1).
    const ref = body.message_reference as { message_id?: string; type?: number; channel_id?: string } | undefined;
    const refType = ref?.type ?? 0;
    const isForward = !!ref && refType === 1;
    const isReply = !!ref?.message_id && refType === 0;

    // IS_COMPONENTS_V2 forbids content/embeds/poll/sticker_ids.
    if (isComponentsV2) {
      const offending: Record<string, string> = {};
      if (typeof body.content === "string" && body.content.length > 0) offending.content = "Cannot be used with IS_COMPONENTS_V2.";
      if (Array.isArray(body.embeds) && body.embeds.length > 0) offending.embeds = "Cannot be used with IS_COMPONENTS_V2.";
      if (body.poll) offending.poll = "Cannot be used with IS_COMPONENTS_V2.";
      if (Array.isArray(body.sticker_ids) && body.sticker_ids.length > 0) offending.sticker_ids = "Cannot be used with IS_COMPONENTS_V2.";
      if (Object.keys(offending).length > 0) return invalidFormBody(c, offending);
    }

    // Validate allowed_mentions (parse/explicit mutual exclusivity + 100-id caps).
    const allowed = body.allowed_mentions as AllowedMentions | undefined;
    const amError = validateAllowedMentions(c, allowed);
    if (amError) return amError;

    // Validate + normalize a poll create request (<=10 answers, lengths) and default its duration.
    let poll = body.poll as DiscordMessage["poll"] | undefined;
    if (poll) {
      const pollError = validatePollRequest(c, body.poll as never);
      if (pollError) return pollError;
      const durationHours = typeof (body.poll as { duration?: number }).duration === "number"
        ? (body.poll as { duration: number }).duration
        : 24; // Poll Create Request defaults duration to 24h.
      poll = { ...poll, expiry: new Date(Date.now() + durationHours * 3600_000).toISOString() };
    }

    // enforce_nonce: if a recent message by this author with the same nonce already exists in the
    // channel, return it instead of creating a new one.
    const nonce = typeof body.nonce === "string" ? body.nonce : typeof body.nonce === "number" ? String(body.nonce) : null;
    if (body.enforce_nonce === true && nonce) {
      const existing = ds.messages
        .findBy("channel_snowflake", channelId)
        .find((mm) => mm.author_snowflake === auth.user!.snowflake && mm.nonce === nonce);
      if (existing) return c.json(toAPIMessage(existing, ds, auth.user.snowflake), 200);
    }

    const content = typeof body.content === "string" ? body.content : "";

    // Resolve the replied-to author (for replied_user) before computing mentions.
    let repliedAuthor: string | null = null;
    if (isReply) {
      const target = ds.messages.findOneBy("snowflake", ref!.message_id!);
      repliedAuthor = target?.author_snowflake ?? null;
    }
    const mentions = applyAllowedMentions(parseMentions(content), allowed, repliedAuthor);

    // Forwarding: snapshot the source message and flag HAS_SNAPSHOT.
    let messageSnapshots: unknown[] | undefined;
    let snapshotFlags = flags;
    if (isForward && ref?.message_id) {
      const source = ds.messages.findOneBy("snowflake", ref.message_id);
      if (source) {
        messageSnapshots = [buildSnapshot(source, ds)];
        snapshotFlags |= MessageFlags.HasSnapshot;
      }
    }

    const stickerIds = Array.isArray(body.sticker_ids)
      ? (body.sticker_ids as unknown[]).map((s) => String(s))
      : [];

    // A message must carry at least one of content/embeds/attachments/components/poll/sticker_ids,
    // OR be a forward (only message_reference required) -> otherwise 50006 Cannot send an empty message.
    const isEmpty =
      content.length === 0 &&
      !(Array.isArray(body.embeds) && body.embeds.length > 0) &&
      uploaded.length === 0 &&
      !(Array.isArray(body.components) && body.components.length > 0) &&
      !poll &&
      stickerIds.length === 0 &&
      !messageSnapshots;
    if (isEmpty) return discordError(c, 400, "Cannot send an empty message", 50006);

    // The reply reference echoed back must include type:0, channel_id, guild_id.
    let messageReference: DiscordMessage["message_reference"] = null;
    if (isReply) {
      messageReference = {
        type: 0,
        message_id: ref!.message_id!,
        channel_id: ref!.channel_id ?? channelId,
        guild_id: channel.guild_snowflake ?? undefined,
      };
    } else if (isForward && ref) {
      messageReference = {
        type: 1,
        message_id: ref.message_id,
        channel_id: ref.channel_id ?? channelId,
        guild_id: channel.guild_snowflake ?? undefined,
      };
    } else if (ref) {
      messageReference = ref as never;
    }

    const message = createMessage(ds, {
      channelSnowflake: channelId,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: auth.user.snowflake,
      content,
      tts: body.tts === true,
      type: isReply ? 19 : 0,
      flags: snapshotFlags,
      embeds: (body.embeds as unknown[] | undefined) ?? [],
      components: (body.components as unknown[] | undefined) ?? [],
      attachments: uploaded.length > 0 ? uploaded : ((body.attachments as unknown[] | undefined) ?? []),
      nonce,
      messageReference,
      referencedMessageSnowflake: isReply ? ref!.message_id! : null,
      stickerSnowflakes: stickerIds,
      messageSnapshots,
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
      d: gatewayMessagePayload(message, ds, payload),
      redactedData: redactMessageContent(gatewayMessagePayload(message, ds, payload)),
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

    const allowed = body.allowed_mentions as AllowedMentions | undefined;
    const amError = validateAllowedMentions(c, allowed);
    if (amError) return amError;

    const patch: Record<string, unknown> = { edited_timestamp: new Date().toISOString() };
    if (typeof body.content === "string") {
      patch.content = body.content;
      // On a content edit the mentions/mention_roles/mention_everyone are rebuilt from scratch,
      // honoring the edit request's allowed_mentions (default allowances when absent).
      const mentions = applyAllowedMentions(parseMentions(body.content), allowed);
      patch.mention_snowflakes = mentions.users;
      patch.mention_role_snowflakes = mentions.roles;
      patch.mention_everyone = mentions.everyone;
    }
    if (body.embeds !== undefined) patch.embeds = body.embeds;
    if (body.components !== undefined) patch.components = body.components;
    if (body.flags !== undefined && typeof body.flags === "number") {
      // Only the edit-settable bits may be changed; all other bits are preserved from the message.
      const settable = body.flags & EDIT_MESSAGE_SETTABLE_FLAGS;
      patch.flags = (message.flags & ~EDIT_MESSAGE_SETTABLE_FLAGS) | settable;
    }
    ds.messages.update(message.id, patch);
    const updated = ds.messages.findOneBy("snowflake", message.snowflake)!;
    const payload = toAPIMessage(updated, ds);
    bus.publish({
      t: "MESSAGE_UPDATE",
      guildId: updated.guild_snowflake,
      requiredIntents: messageIntents(updated.guild_snowflake),
      d: gatewayMessagePayload(updated, ds, payload),
      redactedData: redactMessageContent(gatewayMessagePayload(updated, ds, payload)),
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
    if (message.guild_snowflake) {
      recordAudit(ds, bus, {
        guildSnowflake: message.guild_snowflake,
        actionType: AuditLogEvent.MessageDelete,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: message.author_snowflake,
        reason: auditReason(c),
      });
    }
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
    const channel = ds.channels.findOneBy("snowflake", channelId);
    const guildSnowflake = channel?.guild_snowflake ?? null;
    bus.publish({
      t: "MESSAGE_DELETE_BULK",
      guildId: guildSnowflake,
      requiredIntents: Intents.GuildMessages,
      d: { ids: body.messages ?? [], channel_id: channelId },
    });
    if (guildSnowflake) {
      recordAudit(ds, bus, {
        guildSnowflake,
        actionType: AuditLogEvent.MessageBulkDelete,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: channelId,
        reason: auditReason(c),
      });
    }
    return new Response(null, { status: 204 });
  });
}
