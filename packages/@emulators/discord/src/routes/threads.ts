import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake, toAPIChannel } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordChannel } from "../entities.js";

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
): DiscordChannel {
  const type = typeof body.type === "number" ? body.type : 11; // public thread
  return ds.channels.insert({
    snowflake: snowflake(),
    guild_snowflake: parent.guild_snowflake,
    type,
    name: typeof body.name === "string" ? body.name : "thread",
    position: 0,
    topic: null,
    nsfw: false,
    last_message_snowflake: null,
    parent_snowflake: parent.snowflake,
    rate_limit_per_user: typeof body.rate_limit_per_user === "number" ? body.rate_limit_per_user : 0,
    bitrate: null,
    user_limit: null,
    permission_overwrites: [],
    recipient_snowflakes: [],
    owner_snowflake: ownerSnowflake,
    thread_metadata: {
      archived: false,
      auto_archive_duration: typeof body.auto_archive_duration === "number" ? body.auto_archive_duration : 1440,
      archive_timestamp: new Date().toISOString(),
      locked: false,
      create_timestamp: new Date().toISOString(),
    },
    message_count: 0,
    member_count: 0,
  });
}

export function threadsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const startThread = async (
    c: Parameters<Parameters<typeof app.post>[1]>[0],
    parentChannelId: string,
    messageId?: string,
  ) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const parent = ds.channels.findOneBy("snowflake", parentChannelId);
    if (!parent) return notFound(c);
    if (messageId && !ds.messages.findOneBy("snowflake", messageId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const thread = createThread(ds, parent, auth.user.snowflake, messageId ? { ...body, type: 11 } : body);
    addThreadMember(ds, thread.snowflake, auth.user.snowflake);
    const payload = toAPIChannel(ds.channels.findOneBy("snowflake", thread.snowflake)!);
    bus.publish({ t: "THREAD_CREATE", guildId: thread.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    return c.json(payload, 201);
  };

  app.post("/api/v:version/channels/:channelId/messages/:messageId/threads", (c) =>
    startThread(c, c.req.param("channelId"), c.req.param("messageId")),
  );
  app.post("/api/v:version/channels/:channelId/threads", (c) => startThread(c, c.req.param("channelId")));

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
    return new Response(null, { status: 204 });
  });

  app.put("/api/v:version/channels/:threadId/thread-members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    if (!ds.channels.findOneBy("snowflake", c.req.param("threadId"))) return notFound(c);
    addThreadMember(ds, c.req.param("threadId"), c.req.param("userId"));
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
    const members = ds.threadMembers.findBy("thread_snowflake", threadId).map((m) => ({
      id: threadId,
      user_id: m.user_snowflake,
      join_timestamp: m.joined_at,
      flags: 0,
    }));
    return c.json(members);
  });
}
