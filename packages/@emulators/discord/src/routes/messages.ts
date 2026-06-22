import type { DiscordRouteContext } from "../context.js";
import {
  requireBot,
  requireUser,
  requireChannel,
  requireMessage,
  readBody,
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
  snowflakeTimestamp,
} from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import { PermissionFlags } from "../permissions.js";
import type { DiscordMessage } from "../entities.js";
import type { DiscordStore } from "../store.js";
import type { APIMessage, APIGuildMember } from "discord-api-types/v10";

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
  poll: { question?: { text?: string }; answers?: unknown[]; duration?: number },
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
  // Duration must be <= 768 hours (32 days).
  if (typeof poll.duration === "number" && poll.duration > 768) {
    return invalidFormBody(c, { "poll.duration": "Must be 768 or fewer in length." });
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

/**
 * Validate embed fields against Discord's documented limits.
 * Returns an invalidFormBody (50035) response if any limit is exceeded, else null.
 */
function validateEmbeds(
  c: Parameters<typeof invalidFormBody>[0],
  embeds: unknown[],
): Response | null {
  if (embeds.length > 10) {
    return invalidFormBody(c, { embeds: "Must be 10 or fewer in length." });
  }
  // Compute total character count across all embeds.
  let totalChars = 0;
  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i] as Record<string, unknown>;
    const title = typeof embed.title === "string" ? embed.title : "";
    const description = typeof embed.description === "string" ? embed.description : "";
    const footerText = typeof (embed.footer as Record<string, unknown> | undefined)?.text === "string"
      ? (embed.footer as Record<string, unknown>).text as string
      : "";
    const authorName = typeof (embed.author as Record<string, unknown> | undefined)?.name === "string"
      ? (embed.author as Record<string, unknown>).name as string
      : "";
    if (title.length > 256) {
      return invalidFormBody(c, { [`embeds.${i}.title`]: "Must be 256 or fewer in length." });
    }
    if (description.length > 4096) {
      return invalidFormBody(c, { [`embeds.${i}.description`]: "Must be 4096 or fewer in length." });
    }
    if (footerText.length > 2048) {
      return invalidFormBody(c, { [`embeds.${i}.footer.text`]: "Must be 2048 or fewer in length." });
    }
    if (authorName.length > 256) {
      return invalidFormBody(c, { [`embeds.${i}.author.name`]: "Must be 256 or fewer in length." });
    }
    const fields = Array.isArray(embed.fields) ? (embed.fields as unknown[]) : [];
    if (fields.length > 25) {
      return invalidFormBody(c, { [`embeds.${i}.fields`]: "Must be 25 or fewer in length." });
    }
    for (let j = 0; j < fields.length; j++) {
      const field = fields[j] as Record<string, unknown>;
      const name = typeof field.name === "string" ? field.name : "";
      const value = typeof field.value === "string" ? field.value : "";
      if (name.length > 256) {
        return invalidFormBody(c, { [`embeds.${i}.fields.${j}.name`]: "Must be 256 or fewer in length." });
      }
      if (value.length > 1024) {
        return invalidFormBody(c, { [`embeds.${i}.fields.${j}.value`]: "Must be 1024 or fewer in length." });
      }
      totalChars += name.length + value.length;
    }
    totalChars += title.length + description.length + footerText.length + authorName.length;
  }
  if (totalChars > 6000) {
    return invalidFormBody(c, { embeds: "Must be 6000 or fewer in length in total." });
  }
  return null;
}

/**
 * Recursively replace component id===0 with undefined (API-assigned).
 */
function sanitizeComponentIds(components: unknown[]): unknown[] {
  return components.map((raw) => {
    const comp = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...comp };
    if (out.id === 0) delete out.id;
    if (Array.isArray(out.components)) {
      out.components = sanitizeComponentIds(out.components as unknown[]);
    }
    return out;
  });
}

/**
 * Validate component fields against Discord's documented limits.
 * Returns an invalidFormBody (50035) response if any limit is exceeded, else null.
 * Walks nested components recursively.
 */
function validateComponents(
  c: Parameters<typeof invalidFormBody>[0],
  components: unknown[],
  isV2: boolean,
  pathPrefix = "components",
): Response | null {
  // Count total components for IS_COMPONENTS_V2 messages (max 40).
  let totalCount = 0;
  const walk = (comps: unknown[], prefix: string): Response | null => {
    for (let i = 0; i < comps.length; i++) {
      const comp = comps[i] as Record<string, unknown>;
      totalCount++;
      if (isV2 && totalCount > 40) {
        return invalidFormBody(c, { [prefix]: "Must be 40 or fewer in length." });
      }
      const path = `${prefix}.${i}`;
      const type = typeof comp.type === "number" ? comp.type : 0;
      // custom_id check: must be 1-100 chars if present.
      if (typeof comp.custom_id === "string") {
        if (comp.custom_id.length === 0 || comp.custom_id.length > 100) {
          return invalidFormBody(c, { [`${path}.custom_id`]: "Must be between 1 and 100 in length." });
        }
      }
      // type 2 = Button
      if (type === 2) {
        const label = typeof comp.label === "string" ? comp.label : "";
        if (label.length > 80) {
          return invalidFormBody(c, { [`${path}.label`]: "Must be 80 or fewer in length." });
        }
        const url = typeof comp.url === "string" ? comp.url : "";
        if (url.length > 512) {
          return invalidFormBody(c, { [`${path}.url`]: "Must be 512 or fewer in length." });
        }
        const style = typeof comp.style === "number" ? comp.style : 0;
        if (style === 5) {
          // Link button: must have url
          if (!comp.url) {
            return invalidFormBody(c, { [`${path}.url`]: "This field is required." });
          }
        } else {
          // Non-link button: must have custom_id
          if (!comp.custom_id) {
            return invalidFormBody(c, { [`${path}.custom_id`]: "This field is required." });
          }
        }
      }
      // type 3,5,6,7,8 = Select menus
      if (type === 3 || type === 5 || type === 6 || type === 7 || type === 8) {
        const options = Array.isArray(comp.options) ? comp.options : [];
        if (options.length > 25) {
          return invalidFormBody(c, { [`${path}.options`]: "Must be 25 or fewer in length." });
        }
        if (typeof comp.min_values === "number") {
          if (comp.min_values < 0 || comp.min_values > 25) {
            return invalidFormBody(c, { [`${path}.min_values`]: "Must be between 0 and 25." });
          }
        }
        if (typeof comp.max_values === "number") {
          if (comp.max_values < 0 || comp.max_values > 25) {
            return invalidFormBody(c, { [`${path}.max_values`]: "Must be between 0 and 25." });
          }
        }
        const minV = typeof comp.min_values === "number" ? comp.min_values : 0;
        const maxV = typeof comp.max_values === "number" ? comp.max_values : 1;
        if (minV > maxV) {
          return invalidFormBody(c, { [`${path}.min_values`]: "min_values must be less than or equal to max_values." });
        }
      }
      // type 4 = Text Input
      if (type === 4) {
        if (typeof comp.min_length === "number") {
          if (comp.min_length < 0 || comp.min_length > 4000) {
            return invalidFormBody(c, { [`${path}.min_length`]: "Must be between 0 and 4000." });
          }
        }
        if (typeof comp.max_length === "number") {
          if (comp.max_length < 1 || comp.max_length > 4000) {
            return invalidFormBody(c, { [`${path}.max_length`]: "Must be between 1 and 4000." });
          }
        }
      }
      // Recurse into nested components.
      if (Array.isArray(comp.components)) {
        const nested = walk(comp.components as unknown[], `${path}.components`);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(components, pathPrefix);
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
  const gatewayMessagePayload = (
    m: DiscordMessage,
    ds: DiscordStore,
    rest: APIMessage,
  ): APIMessage & { channel_type?: number; member?: APIGuildMember } => {
    const channel = ds.channels.findOneBy("snowflake", m.channel_snowflake);
    const payload: APIMessage & { channel_type?: number; member?: APIGuildMember } = {
      ...rest,
      channel_type: channel?.type,
    };
    if (m.guild_snowflake) {
      const member = ds.members.findBy("guild_snowflake", m.guild_snowflake).find((mm) => mm.user_snowflake === m.author_snowflake);
      if (member) payload.member = toAPIMember(member, ds);
    }
    return payload;
  };

  app.get("/api/v:version/channels/:channelId/messages", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channelId = c.req.param("channelId");
    const _ch = requireChannel(c, ds, channelId); if (_ch instanceof Response) return _ch;
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);
    const before = c.req.query("before");
    const after = c.req.query("after");
    const around = c.req.query("around");
    // before/after/around are mutually exclusive.
    const exclusiveCount = [before, after, around].filter(Boolean).length;
    if (exclusiveCount > 1) {
      return invalidFormBody(c, { around: "before, after, and around are mutually exclusive" });
    }
    let messages = ds.messages
      .findBy("channel_snowflake", channelId)
      // Ephemeral interaction replies are not part of channel history.
      .filter((mm) => !isEphemeral(mm.flags))
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1));
    if (before) messages = messages.filter((mm) => BigInt(mm.snowflake) < BigInt(before));
    if (after) messages = messages.filter((mm) => BigInt(mm.snowflake) > BigInt(after));
    if (around) {
      const aroundId = BigInt(around);
      // Take half limit before, half after, then sort ascending and cap to limit.
      const half = Math.floor(limit / 2);
      const beforeAround = messages
        .filter((mm) => BigInt(mm.snowflake) < aroundId)
        .slice(0, half);
      const afterAround = messages
        .filter((mm) => BigInt(mm.snowflake) >= aroundId)
        .reverse()
        .slice(0, limit - half);
      messages = [...beforeAround, ...afterAround].sort((a, b) =>
        BigInt(a.snowflake) < BigInt(b.snowflake) ? -1 : 1,
      ).slice(0, limit);
      return c.json(messages.map((mm) => toAPIMessage(mm, ds, auth.user?.snowflake)));
    }
    return c.json(messages.slice(0, limit).map((mm) => toAPIMessage(mm, ds, auth.user?.snowflake)));
  });

  app.get("/api/v:version/channels/:channelId/messages/:messageId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const message = requireMessage(c, ds, c.req.param("channelId"), c.req.param("messageId")); if (message instanceof Response) return message;
    return c.json(toAPIMessage(message, ds, auth.user?.snowflake));
  });

  app.post("/api/v:version/channels/:channelId/messages", async (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channelId = c.req.param("channelId");
    const channel = requireChannel(c, ds, channelId); if (channel instanceof Response) return channel;
    const denied = requirePermission(c, store, auth.user!.snowflake, PermissionFlags.SendMessages, { channelId });
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

    // Validate components.
    if (Array.isArray(body.components) && body.components.length > 0) {
      const compError = validateComponents(c, body.components as unknown[], isComponentsV2);
      if (compError) return compError;
    }

    // Validate embeds.
    if (Array.isArray(body.embeds) && body.embeds.length > 0) {
      const embedError = validateEmbeds(c, body.embeds as unknown[]);
      if (embedError) return embedError;
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
    // Validate nonce length (string nonce only, max 25 chars).
    if (typeof body.nonce === "string" && body.nonce.length > 25) {
      return invalidFormBody(c, { nonce: "Must be 25 or fewer in length." });
    }
    if (body.enforce_nonce === true && nonce) {
      const existing = ds.messages
        .findBy("channel_snowflake", channelId)
        .find((mm) => mm.author_snowflake === auth.user!.snowflake && mm.nonce === nonce);
      if (existing) return c.json(toAPIMessage(existing, ds, auth.user!.snowflake), 200);
    }

    const content = typeof body.content === "string" ? body.content : "";
    // Validate content length (<= 2000 chars).
    if (content.length > 2000) {
      return invalidFormBody(c, { content: "Must be 2000 or fewer in length." });
    }

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
    // Validate sticker_ids count (max 3).
    if (stickerIds.length > 3) {
      return invalidFormBody(c, { sticker_ids: "Must be 3 or fewer in length." });
    }

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
      authorSnowflake: auth.user!.snowflake,
      content,
      tts: body.tts === true,
      type: isReply ? 19 : 0,
      flags: snapshotFlags,
      embeds: (body.embeds as unknown[] | undefined) ?? [],
      components: sanitizeComponentIds((body.components as unknown[] | undefined) ?? []),
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
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const message = requireMessage(c, ds, c.req.param("channelId"), c.req.param("messageId")); if (message instanceof Response) return message;
    const body = await readBody<Record<string, unknown>>(c);

    const allowed = body.allowed_mentions as AllowedMentions | undefined;
    const amError = validateAllowedMentions(c, allowed);
    if (amError) return amError;

    // Validate embeds on edit.
    if (Array.isArray(body.embeds) && body.embeds.length > 0) {
      const embedError = validateEmbeds(c, body.embeds as unknown[]);
      if (embedError) return embedError;
    }

    // Validate components on edit.
    if (Array.isArray(body.components) && body.components.length > 0) {
      const editIsV2 = (message.flags & MessageFlags.IsComponentsV2) !== 0;
      const compError = validateComponents(c, body.components as unknown[], editIsV2);
      if (compError) return compError;
    }

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
    if (body.components !== undefined) patch.components = sanitizeComponentIds(Array.isArray(body.components) ? body.components as unknown[] : []);
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
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channelId = c.req.param("channelId");
    const message = requireMessage(c, ds, channelId, c.req.param("messageId")); if (message instanceof Response) return message;
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
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channelId = c.req.param("channelId");
    const body = await readBody<{ messages?: string[] }>(c);
    const messageIds = body.messages ?? [];
    // Bulk delete: must have 2-100 messages.
    if (messageIds.length < 2 || messageIds.length > 100) {
      return discordError(c, 400, "Provided too few or too many messages to delete. Must provide at least 2 and fewer than 100 messages to delete.", 50034);
    }
    // Reject duplicate IDs.
    const uniqueIds = new Set(messageIds);
    if (uniqueIds.size !== messageIds.length) {
      return discordError(c, 400, "Provided too few or too many messages to delete. Must provide at least 2 and fewer than 100 messages to delete.", 50034);
    }
    // Reject messages older than 2 weeks.
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const id of messageIds) {
      if (snowflakeTimestamp(id) < twoWeeksAgo) {
        return discordError(c, 400, "Provided too few or too many messages to delete. Must provide at least 2 and fewer than 100 messages to delete.", 50034);
      }
    }
    for (const id of messageIds) {
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
