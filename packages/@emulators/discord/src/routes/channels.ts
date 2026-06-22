import type { Context, AppEnv } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import type { DiscordChannel } from "../entities.js";
import { getDiscordStore } from "../store.js";
import {
  requireBot,
  requireUser,
  requireGuild,
  requireChannel,
  requireMessage,
  readBody,
  getAuth,
  unauthorized,
  notFound,
  unknownChannel,
  invalidFormBody,
  toAPIChannel,
  toAPIMember,
  toAPIMessage,
  redactMessageContent,
  recordAudit,
  auditReason,
  AuditLogEvent,
  snowflake,
  requirePermission,
} from "../helpers.js";
import { createChannel } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import { PermissionFlags } from "../permissions.js";

/** Message flag bit for a crossposted (published) announcement message (CROSSPOSTED, 1 << 0). */
const MESSAGE_FLAG_CROSSPOSTED = 1 << 0;

export function channelsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  app.get("/api/v:version/guilds/:guildId/channels", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const guildId = c.req.param("guildId");
    const _guild = requireGuild(c, ds, guildId); if (_guild instanceof Response) return _guild;
    const channels = ds.channels
      .findBy("guild_snowflake", guildId)
      .sort((a, b) => a.position - b.position)
      .map((ch) => toAPIChannel(ch));
    return c.json(channels);
  });

  app.post("/api/v:version/guilds/:guildId/channels", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    const _guild = requireGuild(c, ds, guildId); if (_guild instanceof Response) return _guild;
    const denied = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageChannels, { guildId });
    if (denied) return denied;
    const body = await readBody<Record<string, unknown>>(c);
    // Validate Create Channel params
    if (typeof body.name === "string" && (body.name.length < 1 || body.name.length > 100)) {
      return invalidFormBody(c, { name: "Must be between 1 and 100 in length." });
    }
    if (typeof body.topic === "string") {
      const t = body.type as number | undefined;
      const maxTopic = (t === 15 || t === 16) ? 4096 : 1024;
      if (body.topic.length > maxTopic) {
        return invalidFormBody(c, { topic: `Must be ${maxTopic} or fewer in length.` });
      }
    }
    if (typeof body.rate_limit_per_user === "number" && (body.rate_limit_per_user < 0 || body.rate_limit_per_user > 21600)) {
      return invalidFormBody(c, { rate_limit_per_user: "Must be between 0 and 21600." });
    }
    if (typeof body.user_limit === "number" && (body.user_limit < 0 || body.user_limit > 10000)) {
      return invalidFormBody(c, { user_limit: "Must be between 0 and 10000." });
    }
    if (typeof body.bitrate === "number" && body.bitrate < 8000) {
      return invalidFormBody(c, { bitrate: "Must be 8000 or greater." });
    }
    const VALID_AUTO_ARCHIVE_CREATE = new Set([60, 1440, 4320, 10080]);
    if (body.default_auto_archive_duration !== undefined && body.default_auto_archive_duration !== null &&
        !VALID_AUTO_ARCHIVE_CREATE.has(body.default_auto_archive_duration as number)) {
      return invalidFormBody(c, { default_auto_archive_duration: "Must be one of 60, 1440, 4320, 10080." });
    }
    if (Array.isArray(body.available_tags) && body.available_tags.length > 20) {
      return invalidFormBody(c, { available_tags: "Must be 20 or fewer in length." });
    }
    const channel = createChannel(ds, {
      name: (body.name as string | undefined) ?? "new-channel",
      type: (body.type as number | undefined) ?? 0,
      guildSnowflake: guildId,
      topic: (body.topic as string | null | undefined) ?? null,
      parentSnowflake: (body.parent_id as string | null | undefined) ?? null,
      nsfw: (body.nsfw as boolean | undefined) ?? false,
      position: body.position as number | undefined,
      bitrate: body.bitrate as number | undefined,
      userLimit: body.user_limit as number | undefined,
      rateLimitPerUser: body.rate_limit_per_user as number | undefined,
      permissionOverwrites: body.permission_overwrites as DiscordChannel["permission_overwrites"] | undefined,
      rtcRegion: body.rtc_region as string | null | undefined,
      videoQualityMode: body.video_quality_mode as number | undefined,
      defaultAutoArchiveDuration: body.default_auto_archive_duration as number | undefined,
      availableTags: body.available_tags as unknown[] | undefined,
      defaultReactionEmoji: body.default_reaction_emoji,
      defaultSortOrder: body.default_sort_order as number | null | undefined,
      defaultForumLayout: body.default_forum_layout as number | undefined,
      defaultThreadRateLimitPerUser: body.default_thread_rate_limit_per_user as number | undefined,
    });
    if (typeof body.flags === "number") ds.channels.update(channel.id, { flags: body.flags });
    const payload = toAPIChannel(ds.channels.findOneBy("snowflake", channel.snowflake)!);
    bus.publish({ t: "CHANNEL_CREATE", guildId, requiredIntents: Intents.Guilds, d: payload });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.ChannelCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: channel.snowflake,
      changes: [{ key: "name", new_value: channel.name }],
    });
    return c.json(payload, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/channels", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const body = (await c.req.json().catch(() => [])) as Array<{ id: string; position?: number; parent_id?: string | null }>;
    for (const entry of Array.isArray(body) ? body : []) {
      const channel = ds.channels.findOneBy("snowflake", entry.id);
      if (!channel) continue;
      const patch: Record<string, unknown> = {};
      if (entry.position !== undefined) patch.position = entry.position;
      if (entry.parent_id !== undefined) patch.parent_snowflake = entry.parent_id;
      if (Object.keys(patch).length > 0) ds.channels.update(channel.id, patch);
    }
    return new Response(null, { status: 204 });
  });

  app.get("/api/v:version/channels/:channelId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    const payload = toAPIChannel(channel);
    // For a thread, include the current user's thread-member object if they have joined.
    const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    if (isThread && auth.user) {
      const tm = ds.threadMembers
        .findBy("thread_snowflake", channel.snowflake)
        .find((m) => m.user_snowflake === auth.user!.snowflake);
      if (tm)
        (payload as { member?: unknown }).member = {
          id: channel.snowflake,
          user_id: tm.user_snowflake,
          join_timestamp: tm.joined_at,
          flags: 0,
        };
    }
    return c.json(payload);
  });

  app.patch("/api/v:version/channels/:channelId", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    // P-1: PATCH /channels/:id -> MANAGE_CHANNELS (or MANAGE_THREADS for threads).
    const channelId = c.req.param("channelId");
    const isThreadForPerm = channel.type === 10 || channel.type === 11 || channel.type === 12;
    const patchPermFlag = isThreadForPerm ? PermissionFlags.ManageThreads : PermissionFlags.ManageChannels;
    const deniedPatch = requirePermission(c, store, auth.user?.snowflake, patchPermFlag, { channelId });
    if (deniedPatch) return deniedPatch;
    const body = await readBody<Record<string, unknown>>(c);
    // --- Validation: field ranges per the Discord docs ---

    if (typeof body.name === "string" && (body.name.length < 1 || body.name.length > 100)) {
      return invalidFormBody(c, { name: "Must be between 1 and 100 in length." });
    }

    // Topic length: text/announcement channels allow up to 1024 chars; forum/media up to 4096
    if (typeof body.topic === "string") {
      const maxTopic = (channel.type === 15 || channel.type === 16) ? 4096 : 1024;
      if (body.topic.length > maxTopic) {
        return invalidFormBody(c, { topic: `Must be ${maxTopic} or fewer in length.` });
      }
    }

    if (typeof body.rate_limit_per_user === "number" && (body.rate_limit_per_user < 0 || body.rate_limit_per_user > 21600)) {
      return invalidFormBody(c, { rate_limit_per_user: "Must be between 0 and 21600." });
    }

    if (typeof body.user_limit === "number") {
      // voice: 0-99, stage: 0-10000; treat both as 0-10000
      if (body.user_limit < 0 || body.user_limit > 10000) {
        return invalidFormBody(c, { user_limit: "Must be between 0 and 10000." });
      }
    }

    if (typeof body.bitrate === "number" && body.bitrate < 8000) {
      return invalidFormBody(c, { bitrate: "Must be 8000 or greater." });
    }

    const VALID_AUTO_ARCHIVE = new Set([60, 1440, 4320, 10080]);
    if (body.default_auto_archive_duration !== undefined && body.default_auto_archive_duration !== null &&
        !VALID_AUTO_ARCHIVE.has(body.default_auto_archive_duration as number)) {
      return invalidFormBody(c, { default_auto_archive_duration: "Must be one of 60, 1440, 4320, 10080." });
    }

    if (Array.isArray(body.available_tags) && body.available_tags.length > 20) {
      return invalidFormBody(c, { available_tags: "Must be 20 or fewer in length." });
    }

    if (Array.isArray(body.applied_tags) && body.applied_tags.length > 5) {
      return invalidFormBody(c, { applied_tags: "Must be 5 or fewer in length." });
    }

    const patch: Record<string, unknown> = {};

    // Type conversion: only Text (0) <-> Announcement (5) is allowed.
    if (body.type !== undefined) {
      const fromType = channel.type;
      const toType = body.type as number;
      const allowedConversion =
        (fromType === 0 && toType === 5) || (fromType === 5 && toType === 0);
      if (!allowedConversion) {
        if (fromType !== toType) {
          return invalidFormBody(c, { type: "Cannot convert channel to this type." });
        }
        // same type: ignore silently
      } else {
        patch.type = toType;
      }
    }

    if (body.name !== undefined) patch.name = body.name;
    if (body.topic !== undefined) patch.topic = body.topic;
    if (body.position !== undefined) patch.position = body.position;
    if (body.nsfw !== undefined) patch.nsfw = body.nsfw;
    if (body.parent_id !== undefined) patch.parent_snowflake = body.parent_id;
    if (body.rate_limit_per_user !== undefined) patch.rate_limit_per_user = body.rate_limit_per_user;
    if (body.bitrate !== undefined) patch.bitrate = body.bitrate;
    if (body.user_limit !== undefined) patch.user_limit = body.user_limit;
    if (body.permission_overwrites !== undefined) patch.permission_overwrites = body.permission_overwrites;
    if (body.rtc_region !== undefined) patch.rtc_region = body.rtc_region;
    if (body.video_quality_mode !== undefined) patch.video_quality_mode = body.video_quality_mode;
    if (body.default_auto_archive_duration !== undefined)
      patch.default_auto_archive_duration = body.default_auto_archive_duration;
    if (body.flags !== undefined) patch.flags = body.flags;
    if (body.available_tags !== undefined) patch.available_tags = body.available_tags;
    if (body.default_reaction_emoji !== undefined) patch.default_reaction_emoji = body.default_reaction_emoji;
    if (body.default_sort_order !== undefined) patch.default_sort_order = body.default_sort_order;
    if (body.default_forum_layout !== undefined) patch.default_forum_layout = body.default_forum_layout;
    if (body.default_thread_rate_limit_per_user !== undefined)
      patch.default_thread_rate_limit_per_user = body.default_thread_rate_limit_per_user;
    if (body.applied_tags !== undefined) patch.applied_tags = body.applied_tags;
    const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    // T-3: auto_archive_duration (thread metadata field) must be one of {60,1440,4320,10080}.
    if (isThread && body.auto_archive_duration !== undefined && body.auto_archive_duration !== null &&
        !VALID_AUTO_ARCHIVE.has(body.auto_archive_duration as number)) {
      return invalidFormBody(c, { auto_archive_duration: "Must be one of 60, 1440, 4320, 10080." });
    }
    if (
      isThread &&
      (body.archived !== undefined ||
        body.locked !== undefined ||
        body.auto_archive_duration !== undefined ||
        body.invitable !== undefined)
    ) {
      const existingMeta = channel.thread_metadata ?? { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false };
      const newArchived = body.archived !== undefined ? !!body.archived : existingMeta.archived;
      const archiveChanged = body.archived !== undefined || body.auto_archive_duration !== undefined;
      patch.thread_metadata = {
        ...existingMeta,
        ...(body.archived !== undefined ? { archived: newArchived } : {}),
        ...(body.locked !== undefined ? { locked: !!body.locked } : {}),
        ...(body.auto_archive_duration !== undefined ? { auto_archive_duration: body.auto_archive_duration } : {}),
        ...(body.invitable !== undefined ? { invitable: !!body.invitable } : {}),
        ...(archiveChanged ? { archive_timestamp: new Date().toISOString() } : {}),
      };
    }
    const channelChanges = Object.keys(patch)
      .filter((key) => key !== "thread_metadata")
      .map((key) => ({
        key,
        old_value: (channel as unknown as Record<string, unknown>)[key],
        new_value: patch[key],
      }));
    if (Object.keys(patch).length > 0) ds.channels.update(channel.id, patch);
    const updated = ds.channels.findOneBy("snowflake", channel.snowflake)!;
    const payload = toAPIChannel(updated);
    bus.publish({
      t: isThread ? "THREAD_UPDATE" : "CHANNEL_UPDATE",
      guildId: updated.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: payload,
    });
    if (!isThread && channelChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: updated.guild_snowflake,
        actionType: AuditLogEvent.ChannelUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: updated.snowflake,
        changes: channelChanges,
      });
    }
    return c.json(payload);
  });

  app.delete("/api/v:version/channels/:channelId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    // P-1: DELETE /channels/:id -> MANAGE_CHANNELS (or MANAGE_THREADS if channel is a thread).
    const isThreadForPerm = channel.type === 10 || channel.type === 11 || channel.type === 12;
    const deletePermFlag = isThreadForPerm ? PermissionFlags.ManageThreads : PermissionFlags.ManageChannels;
    const deniedDelete = requirePermission(c, store, auth.user?.snowflake, deletePermFlag, { channelId: channel.snowflake });
    if (deniedDelete) return deniedDelete;
    const payload = toAPIChannel(channel);
    const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    for (const m of ds.messages.findBy("channel_snowflake", channel.snowflake)) ds.messages.delete(m.id);
    ds.channels.delete(channel.id);
    bus.publish({
      t: isThread ? "THREAD_DELETE" : "CHANNEL_DELETE",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: payload,
    });
    if (!isThread) {
      recordAudit(ds, bus, {
        guildSnowflake: channel.guild_snowflake,
        actionType: AuditLogEvent.ChannelDelete,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: channel.snowflake,
        changes: [{ key: "name", old_value: channel.name }],
      });
    }
    return c.json(payload);
  });

  app.post("/api/v:version/channels/:channelId/typing", (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    // In a guild channel, TYPING_START carries the typing user's guild member object.
    const member = channel.guild_snowflake
      ? ds.members.findBy("guild_snowflake", channel.guild_snowflake).find((m) => m.user_snowflake === auth.user!.snowflake)
      : undefined;
    bus.publish({
      t: "TYPING_START",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.GuildMessageTyping,
      d: {
        channel_id: channel.snowflake,
        guild_id: channel.guild_snowflake ?? undefined,
        user_id: auth.user!.snowflake,
        timestamp: Math.floor(Date.now() / 1000),
        ...(member ? { member: toAPIMember(member, ds) } : {}),
      },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Permission overwrites
  // ---------------------------------------------------------------------------

  app.put("/api/v:version/channels/:channelId/permissions/:overwriteId", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    // P-1: PUT /channels/:id/permissions/:overwriteId -> MANAGE_ROLES.
    const deniedPut = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageRoles, { channelId: channel.snowflake });
    if (deniedPut) return deniedPut;
    const overwriteId = c.req.param("overwriteId");
    const body = (await c.req.json().catch(() => ({}))) as { type?: number; allow?: string; deny?: string };
    // C-3: type (0=role, 1=member) is required; reject with 50035 when absent.
    if (body.type === undefined || body.type === null) {
      return invalidFormBody(c, { type: "This field is required." });
    }
    const overwrite = {
      id: overwriteId,
      type: body.type,
      allow: body.allow ?? "0",
      deny: body.deny ?? "0",
    };
    const existing = channel.permission_overwrites.find((o) => o.id === overwriteId);
    const overwrites = channel.permission_overwrites.filter((o) => o.id !== overwriteId);
    overwrites.push(overwrite);
    ds.channels.update(channel.id, { permission_overwrites: overwrites });
    const updated = ds.channels.findOneBy("snowflake", channel.snowflake)!;
    bus.publish({ t: "CHANNEL_UPDATE", guildId: updated.guild_snowflake, requiredIntents: Intents.Guilds, d: toAPIChannel(updated) });
    if (updated.guild_snowflake) {
      recordAudit(ds, bus, {
        guildSnowflake: updated.guild_snowflake,
        actionType: existing ? AuditLogEvent.ChannelOverwriteUpdate : AuditLogEvent.ChannelOverwriteCreate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: updated.snowflake,
        changes: [
          { key: "id", new_value: overwrite.id },
          { key: "type", new_value: overwrite.type },
          { key: "allow", new_value: overwrite.allow },
          { key: "deny", new_value: overwrite.deny },
        ],
        reason: auditReason(c),
        options: { id: overwrite.id, type: String(overwrite.type) },
      });
    }
    return new Response(null, { status: 204 });
  });

  app.delete("/api/v:version/channels/:channelId/permissions/:overwriteId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    // P-1: DELETE /channels/:id/permissions/:overwriteId -> MANAGE_ROLES.
    const deniedDel = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.ManageRoles, { channelId: channel.snowflake });
    if (deniedDel) return deniedDel;
    const overwriteId = c.req.param("overwriteId");
    const removed = channel.permission_overwrites.find((o) => o.id === overwriteId);
    ds.channels.update(channel.id, {
      permission_overwrites: channel.permission_overwrites.filter((o) => o.id !== overwriteId),
    });
    const updated = ds.channels.findOneBy("snowflake", channel.snowflake)!;
    bus.publish({ t: "CHANNEL_UPDATE", guildId: updated.guild_snowflake, requiredIntents: Intents.Guilds, d: toAPIChannel(updated) });
    if (updated.guild_snowflake && removed) {
      recordAudit(ds, bus, {
        guildSnowflake: updated.guild_snowflake,
        actionType: AuditLogEvent.ChannelOverwriteDelete,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: updated.snowflake,
        changes: [
          { key: "id", old_value: removed.id },
          { key: "type", old_value: removed.type },
          { key: "allow", old_value: removed.allow },
          { key: "deny", old_value: removed.deny },
        ],
        reason: auditReason(c),
        options: { id: removed.id, type: String(removed.type) },
      });
    }
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Announcement channels: crosspost + follow
  // ---------------------------------------------------------------------------

  app.post("/api/v:version/channels/:channelId/messages/:messageId/crosspost", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const channelId = c.req.param("channelId");
    const message = requireMessage(c, ds, channelId, c.req.param("messageId")); if (message instanceof Response) return message;
    ds.messages.update(message.id, { flags: message.flags | MESSAGE_FLAG_CROSSPOSTED });
    const updated = ds.messages.findOneBy("snowflake", message.snowflake)!;
    const payload = toAPIMessage(updated, ds);
    bus.publish({
      t: "MESSAGE_UPDATE",
      guildId: updated.guild_snowflake,
      requiredIntents: updated.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
      d: payload,
      redactedData: redactMessageContent(payload),
      messageAuthorId: updated.author_snowflake,
    });
    return c.json(payload);
  });

  // Follow an announcement channel: creates a channel-follower webhook in the target channel.
  app.post("/api/v:version/channels/:channelId/followers", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const source = requireChannel(c, ds, c.req.param("channelId")); if (source instanceof Response) return source;
    const body = (await c.req.json().catch(() => ({}))) as { webhook_channel_id?: string };
    const targetId = body.webhook_channel_id ?? "";
    const target = ds.channels.findOneBy("snowflake", targetId);
    if (!target) return unknownChannel(c);
    const webhook = ds.webhooks.insert({
      snowflake: snowflake(),
      type: 2, // Channel Follower
      guild_snowflake: target.guild_snowflake,
      channel_snowflake: target.snowflake,
      user_snowflake: auth.user?.snowflake ?? null,
      name: source.name,
      avatar: null,
      token: `whk_${snowflake()}`,
      application_snowflake: auth.application?.snowflake ?? null,
      // Persist the followed source so the channel-follower webhook can surface source_guild/source_channel.
      // (The toAPIWebhook serializer is owned by another agent; we only store the snowflakes here.)
      source_guild_snowflake: source.guild_snowflake,
      source_channel_snowflake: source.snowflake,
    });
    // Fires a Webhooks Update Gateway event for the target channel.
    bus.publish({
      t: "WEBHOOKS_UPDATE",
      guildId: target.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { guild_id: target.guild_snowflake ?? undefined, channel_id: target.snowflake },
    });
    return c.json({ channel_id: source.snowflake, webhook_id: webhook.snowflake });
  });

  // ---------------------------------------------------------------------------
  // Pins (current API under /messages/pins)
  // ---------------------------------------------------------------------------

  app.get("/api/v:version/channels/:channelId/messages/pins", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const channelId = c.req.param("channelId");
    const _ch = requireChannel(c, ds, channelId); if (_ch instanceof Response) return _ch;
    const items = ds.messages
      .findBy("channel_snowflake", channelId)
      .filter((m) => m.pinned)
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1))
      .map((m) => ({ pinned_at: m.updated_at ?? m.timestamp, message: toAPIMessage(m, ds) }));
    return c.json({ items, has_more: false });
  });

  const setPinnedNew = (channelIdParam: string, messageIdParam: string, pinned: boolean, c: Context<AppEnv>) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const message = requireMessage(c, ds, channelIdParam, messageIdParam); if (message instanceof Response) return message;
    ds.messages.update(message.id, { pinned });
    bus.publish({
      t: "CHANNEL_PINS_UPDATE",
      guildId: message.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { guild_id: message.guild_snowflake ?? undefined, channel_id: channelIdParam, last_pin_timestamp: new Date().toISOString() },
    });
    return new Response(null, { status: 204 });
  };

  app.put("/api/v:version/channels/:channelId/messages/pins/:messageId", (c) =>
    setPinnedNew(c.req.param("channelId"), c.req.param("messageId"), true, c),
  );
  app.delete("/api/v:version/channels/:channelId/messages/pins/:messageId", (c) =>
    setPinnedNew(c.req.param("channelId"), c.req.param("messageId"), false, c),
  );

  // ---------------------------------------------------------------------------
  // Group DM recipients + voice channel status
  // ---------------------------------------------------------------------------

  app.put("/api/v:version/channels/:channelId/recipients/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    const user = ds.users.findOneBy("snowflake", c.req.param("userId"));
    if (!channel || !user) return notFound(c);
    if (!channel.recipient_snowflakes.includes(user.snowflake)) {
      ds.channels.update(channel.id, { recipient_snowflakes: [...channel.recipient_snowflakes, user.snowflake] });
    }
    return new Response(null, { status: 204 });
  });

  app.delete("/api/v:version/channels/:channelId/recipients/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("snowflake", c.req.param("channelId"));
    if (!channel) return unknownChannel(c);
    const userId = c.req.param("userId");
    ds.channels.update(channel.id, { recipient_snowflakes: channel.recipient_snowflakes.filter((s) => s !== userId) });
    return new Response(null, { status: 204 });
  });

  // Set a voice channel's status string.
  app.put("/api/v:version/channels/:channelId/voice-status", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const channel = requireChannel(c, ds, c.req.param("channelId")); if (channel instanceof Response) return channel;
    // C-8: requires SET_VOICE_CHANNEL_STATUS.
    const deniedStatus = requirePermission(c, store, auth.user?.snowflake, PermissionFlags.SetVoiceChannelStatus, { channelId: channel.snowflake });
    if (deniedStatus) return deniedStatus;
    const body = (await c.req.json().catch(() => ({}))) as { status?: string | null };
    if (typeof body.status === "string" && body.status.length > 500) {
      return invalidFormBody(c, { status: "Must be 500 or fewer in length." });
    }
    store.setData(`discord.voice_status.${channel.snowflake}`, body.status ?? null);
    bus.publish({
      t: "VOICE_CHANNEL_STATUS_UPDATE",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.Guilds,
      d: { id: channel.snowflake, guild_id: channel.guild_snowflake ?? undefined, status: body.status ?? null },
    });
    return new Response(null, { status: 204 });
  });
}
