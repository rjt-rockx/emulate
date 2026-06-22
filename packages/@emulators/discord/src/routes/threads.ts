import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  unknownChannel,
  unknownMessage,
  invalidFormBody,
  snowflake,
  toAPIChannel,
  toAPIMember,
  toAPIMessage,
  recordAudit,
  AuditLogEvent,
} from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordChannel } from "../entities.js";

/** Parent channel types that can spawn threads: text (0), announcement (5), forum (15), media (16). */
const THREADABLE_PARENT_TYPES = new Set([0, 5, 15, 16]);
const isForumParent = (type: number): boolean => type === 15 || type === 16;

/** Build the current user's thread-member object as attached to a freshly created thread. */
function selfThreadMember(threadSnowflake: string, userSnowflake: string, joinedAt: string): Record<string, unknown> {
  return { id: threadSnowflake, user_id: userSnowflake, join_timestamp: joinedAt, flags: 0 };
}

/** Serialize a thread member, optionally nesting the guild member object when with_member is set. */
function threadMemberPayload(
  ds: DiscordStore,
  thread: DiscordChannel,
  userSnowflake: string,
  joinedAt: string,
  withMember: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: thread.snowflake,
    user_id: userSnowflake,
    join_timestamp: joinedAt,
    flags: 0,
  };
  if (withMember && thread.guild_snowflake) {
    const gm = ds.members
      .findBy("guild_snowflake", thread.guild_snowflake)
      .find((m) => m.user_snowflake === userSnowflake);
    if (gm) payload.member = toAPIMember(gm, ds);
  }
  return payload;
}

function addThreadMember(ds: DiscordStore, threadSnowflake: string, userSnowflake: string): void {
  const exists = ds.threadMembers
    .findBy("thread_snowflake", threadSnowflake)
    .some((m) => m.user_snowflake === userSnowflake);
  if (exists) return;
  ds.threadMembers.insert({ thread_snowflake: threadSnowflake, user_snowflake: userSnowflake, joined_at: new Date().toISOString() });
  const thread = ds.channels.findOneBy("snowflake", threadSnowflake);
  if (thread) ds.channels.update(thread.id, { member_count: (thread.member_count ?? 0) + 1 });
}

function createThread(
  ds: DiscordStore,
  parent: DiscordChannel,
  ownerSnowflake: string,
  body: Record<string, unknown>,
  opts: { type: number; snowflake?: string } & { messageCount?: number },
): DiscordChannel {
  const now = new Date().toISOString();
  // Threads in thread-only channels copy the parent's default_thread_rate_limit_per_user when no explicit rate is sent.
  const rateLimit =
    typeof body.rate_limit_per_user === "number"
      ? body.rate_limit_per_user
      : isForumParent(parent.type)
        ? (parent.default_thread_rate_limit_per_user ?? 0)
        : 0;
  return ds.channels.insert({
    snowflake: opts.snowflake ?? snowflake(),
    guild_snowflake: parent.guild_snowflake,
    type: opts.type,
    name: typeof body.name === "string" ? body.name : "thread",
    position: 0,
    topic: null,
    nsfw: false,
    last_message_snowflake: null,
    parent_snowflake: parent.snowflake,
    rate_limit_per_user: rateLimit,
    bitrate: null,
    user_limit: null,
    permission_overwrites: [],
    recipient_snowflakes: [],
    owner_snowflake: ownerSnowflake,
    thread_metadata: {
      archived: false,
      auto_archive_duration:
        typeof body.auto_archive_duration === "number"
          ? body.auto_archive_duration
          : (parent.default_auto_archive_duration ?? 1440),
      archive_timestamp: now,
      locked: false,
      create_timestamp: now,
      ...(opts.type === 12 && typeof body.invitable === "boolean" ? { invitable: body.invitable } : {}),
    },
    message_count: opts.messageCount ?? 0,
    member_count: 0,
    applied_tags: Array.isArray(body.applied_tags) ? (body.applied_tags as string[]) : [],
  });
}

export function threadsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const emitThreadMembers = (threadId: string, change: { added?: string[]; removed?: string[] }): void => {
    const ds = getDiscordStore(store);
    const thread = ds.channels.findOneBy("snowflake", threadId);
    if (!thread) return;
    const d: Record<string, unknown> = {
      id: threadId,
      guild_id: thread.guild_snowflake ?? undefined,
      member_count: thread.member_count ?? 0,
    };
    if (change.added?.length) {
      d.added_members = change.added.map((userId) => {
        const m = ds.threadMembers.findBy("thread_snowflake", threadId).find((tm) => tm.user_snowflake === userId);
        return { id: threadId, user_id: userId, join_timestamp: m?.joined_at ?? new Date().toISOString(), flags: 0 };
      });
    }
    if (change.removed?.length) d.removed_member_ids = change.removed;
    bus.publish({ t: "THREAD_MEMBERS_UPDATE", guildId: thread.guild_snowflake, requiredIntents: Intents.Guilds, d });
  };

  // Finalize a freshly created thread: auto-join the creator, attach the current-user thread
  // member to the payload, fire THREAD_CREATE + audit, and return 201.
  const finishThread = (
    c: Parameters<Parameters<typeof app.post>[1]>[0],
    ds: DiscordStore,
    thread: DiscordChannel,
    creatorSnowflake: string,
    extra?: Record<string, unknown>,
  ) => {
    addThreadMember(ds, thread.snowflake, creatorSnowflake);
    const joined = ds.threadMembers
      .findBy("thread_snowflake", thread.snowflake)
      .find((m) => m.user_snowflake === creatorSnowflake);
    const payload = toAPIChannel(ds.channels.findOneBy("snowflake", thread.snowflake)!);
    // The create endpoints return the current user's thread-member object on the channel.
    (payload as { member?: unknown }).member = selfThreadMember(
      thread.snowflake,
      creatorSnowflake,
      joined?.joined_at ?? new Date().toISOString(),
    );
    if (extra) Object.assign(payload, extra);
    bus.publish({ t: "THREAD_CREATE", guildId: thread.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    if (thread.guild_snowflake) {
      recordAudit(ds, bus, {
        guildSnowflake: thread.guild_snowflake,
        actionType: AuditLogEvent.ThreadCreate,
        actorSnowflake: creatorSnowflake,
        targetSnowflake: thread.snowflake,
        changes: [{ key: "name", new_value: thread.name }],
      });
    }
    return c.json(payload, 201);
  };

  // Start Thread from Message: text (0) -> PUBLIC_THREAD (11); announcement (5) -> ANNOUNCEMENT_THREAD (10).
  // The created thread shares the id of the source message. Forum/media parents are rejected.
  const startThreadFromMessage = async (
    c: Parameters<Parameters<typeof app.post>[1]>[0],
    parentChannelId: string,
    messageId: string,
  ) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const parent = ds.channels.findOneBy("snowflake", parentChannelId);
    if (!parent) return unknownChannel(c);
    const message = ds.messages.findOneBy("snowflake", messageId);
    if (!message || message.channel_snowflake !== parentChannelId) return unknownMessage(c);
    // Only text and announcement parents may spawn a thread from a message.
    if (parent.type !== 0 && parent.type !== 5) {
      return invalidFormBody(c, { channel_id: "Cannot execute action on this channel type" });
    }
    if (ds.channels.findOneBy("snowflake", messageId)) {
      // A message can only have a single thread created from it.
      return invalidFormBody(c, { message_id: "A thread has already been created for this message" });
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const threadType = parent.type === 5 ? 10 : 11;
    const thread = createThread(ds, parent, auth.user.snowflake, body, { type: threadType, snowflake: messageId });
    return finishThread(c, ds, thread, auth.user.snowflake);
  };

  // Start Thread without Message (text 0 / announcement 5) and Start Thread in Forum/Media (15/16).
  const startThreadWithoutMessage = async (
    c: Parameters<Parameters<typeof app.post>[1]>[0],
    parentChannelId: string,
  ) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const parent = ds.channels.findOneBy("snowflake", parentChannelId);
    if (!parent) return unknownChannel(c);
    // Voice (2), category (4), DM (1/3), and other non-threadable parents are rejected.
    if (!THREADABLE_PARENT_TYPES.has(parent.type)) {
      return invalidFormBody(c, { channel_id: "Cannot execute action on this channel type" });
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    if (isForumParent(parent.type)) {
      // Forum/media: a message is created with the same id as the thread; the type is PUBLIC_THREAD.
      const msgParams = (body.message as Record<string, unknown> | undefined) ?? {};
      const hasContent =
        typeof msgParams.content === "string" ||
        Array.isArray(msgParams.embeds) ||
        Array.isArray(msgParams.sticker_ids) ||
        Array.isArray(msgParams.components);
      if (!body.message || !hasContent) {
        return invalidFormBody(c, {
          message: "You must provide at least one of content, embeds, sticker_ids, components, or files[n]",
        });
      }
      const thread = createThread(ds, parent, auth.user.snowflake, body, { type: 11, messageCount: 1 });
      const message = createMessage(ds, {
        channelSnowflake: thread.snowflake,
        guildSnowflake: thread.guild_snowflake,
        authorSnowflake: auth.user.snowflake,
        content: typeof msgParams.content === "string" ? msgParams.content : "",
        embeds: Array.isArray(msgParams.embeds) ? (msgParams.embeds as unknown[]) : [],
        components: Array.isArray(msgParams.components) ? (msgParams.components as unknown[]) : [],
        stickerSnowflakes: Array.isArray(msgParams.sticker_ids) ? (msgParams.sticker_ids as string[]) : [],
      });
      bus.publish({
        t: "MESSAGE_CREATE",
        guildId: thread.guild_snowflake,
        requiredIntents: thread.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
        d: toAPIMessage(message, ds),
        messageAuthorId: message.author_snowflake,
      });
      return finishThread(c, ds, thread, auth.user.snowflake, { message: toAPIMessage(message, ds) });
    }

    // Text/announcement: type defaults to PRIVATE_THREAD (12) to match legacy behavior.
    const threadType = typeof body.type === "number" ? body.type : 12;
    const thread = createThread(ds, parent, auth.user.snowflake, body, { type: threadType });
    return finishThread(c, ds, thread, auth.user.snowflake);
  };

  app.post("/api/v:version/channels/:channelId/messages/:messageId/threads", (c) =>
    startThreadFromMessage(c, c.req.param("channelId"), c.req.param("messageId")),
  );
  app.post("/api/v:version/channels/:channelId/threads", (c) => startThreadWithoutMessage(c, c.req.param("channelId")));

  // Active threads in a guild.
  app.get("/api/v:version/guilds/:guildId/threads/active", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    const threads = ds.channels
      .findBy("guild_snowflake", guildId)
      .filter((ch) => (ch.type === 10 || ch.type === 11 || ch.type === 12) && !ch.thread_metadata?.archived);
    const members = threads.flatMap((t) =>
      ds.threadMembers.findBy("thread_snowflake", t.snowflake).map((m) => ({
        id: t.snowflake,
        user_id: m.user_snowflake,
        join_timestamp: m.joined_at,
        flags: 0,
      })),
    );
    return c.json({ threads: threads.map(toAPIChannel), members, has_more: false });
  });

  // Thread members.
  app.put("/api/v:version/channels/:threadId/thread-members/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    if (!ds.channels.findOneBy("snowflake", c.req.param("threadId"))) return notFound(c);
    addThreadMember(ds, c.req.param("threadId"), auth.user.snowflake);
    emitThreadMembers(c.req.param("threadId"), { added: [auth.user.snowflake] });
    return new Response(null, { status: 204 });
  });

  app.put("/api/v:version/channels/:threadId/thread-members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    if (!ds.channels.findOneBy("snowflake", c.req.param("threadId"))) return notFound(c);
    addThreadMember(ds, c.req.param("threadId"), c.req.param("userId"));
    emitThreadMembers(c.req.param("threadId"), { added: [c.req.param("userId")] });
    return new Response(null, { status: 204 });
  });

  const removeMember = (c: Parameters<Parameters<typeof app.delete>[1]>[0], userId: string) => {
    const ds = getDiscordStore(store);
    const threadId = c.req.param("threadId");
    const member = ds.threadMembers.findBy("thread_snowflake", threadId).find((m) => m.user_snowflake === userId);
    if (member) {
      ds.threadMembers.delete(member.id);
      const thread = ds.channels.findOneBy("snowflake", threadId);
      if (thread) ds.channels.update(thread.id, { member_count: Math.max(0, (thread.member_count ?? 1) - 1) });
      emitThreadMembers(threadId, { removed: [userId] });
    }
    return new Response(null, { status: 204 });
  };

  app.delete("/api/v:version/channels/:threadId/thread-members/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    return removeMember(c, auth.user.snowflake);
  });
  app.delete("/api/v:version/channels/:threadId/thread-members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return removeMember(c, c.req.param("userId"));
  });

  app.get("/api/v:version/channels/:threadId/thread-members", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const threadId = c.req.param("threadId");
    const thread = ds.channels.findOneBy("snowflake", threadId);
    if (!thread) return unknownChannel(c);
    const withMember = c.req.query("with_member") === "true";
    const after = c.req.query("after");
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
    let rows = ds.threadMembers.findBy("thread_snowflake", threadId);
    // with_member paginates the results (by user id) per the docs.
    if (withMember) {
      rows = [...rows].sort((a, b) => (BigInt(a.user_snowflake) < BigInt(b.user_snowflake) ? -1 : 1));
      if (after) rows = rows.filter((m) => BigInt(m.user_snowflake) > BigInt(after));
      rows = rows.slice(0, limit);
    }
    const members = rows.map((m) => threadMemberPayload(ds, thread, m.user_snowflake, m.joined_at, withMember));
    return c.json(members);
  });

  // Single thread member.
  app.get("/api/v:version/channels/:threadId/thread-members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const threadId = c.req.param("threadId");
    const userId = c.req.param("userId");
    const thread = ds.channels.findOneBy("snowflake", threadId);
    if (!thread) return unknownChannel(c);
    const member = ds.threadMembers.findBy("thread_snowflake", threadId).find((m) => m.user_snowflake === userId);
    if (!member) return notFound(c);
    const withMember = c.req.query("with_member") === "true";
    return c.json(threadMemberPayload(ds, thread, member.user_snowflake, member.joined_at, withMember));
  });

  // Archived threads (public/private) under a channel, newest-archived first.
  const archivedList = (channelId: string, type: number, joinedOnlyUser?: string) => {
    const ds = getDiscordStore(store);
    let threads = ds.channels
      .findBy("parent_snowflake", channelId)
      .filter((ch) => ch.type === type && ch.thread_metadata?.archived);
    if (joinedOnlyUser) {
      threads = threads.filter((t) => ds.threadMembers.findBy("thread_snowflake", t.snowflake).some((m) => m.user_snowflake === joinedOnlyUser));
    }
    threads.sort((a, b) => (a.thread_metadata!.archive_timestamp < b.thread_metadata!.archive_timestamp ? 1 : -1));
    const members = threads.flatMap((t) =>
      ds.threadMembers.findBy("thread_snowflake", t.snowflake).map((m) => ({ id: t.snowflake, user_id: m.user_snowflake, join_timestamp: m.joined_at, flags: 0 })),
    );
    return { threads: threads.map(toAPIChannel), members, has_more: false };
  };

  app.get("/api/v:version/channels/:channelId/threads/archived/public", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    if (!getDiscordStore(store).channels.findOneBy("snowflake", c.req.param("channelId"))) return notFound(c);
    return c.json(archivedList(c.req.param("channelId"), 11));
  });

  app.get("/api/v:version/channels/:channelId/threads/archived/private", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    if (!getDiscordStore(store).channels.findOneBy("snowflake", c.req.param("channelId"))) return notFound(c);
    return c.json(archivedList(c.req.param("channelId"), 12));
  });

  app.get("/api/v:version/channels/:channelId/users/@me/threads/archived/private", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    if (!getDiscordStore(store).channels.findOneBy("snowflake", c.req.param("channelId"))) return notFound(c);
    return c.json(archivedList(c.req.param("channelId"), 12, auth.user.snowflake));
  });
}
