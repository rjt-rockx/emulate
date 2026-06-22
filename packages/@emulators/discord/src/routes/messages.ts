import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIMessage, redactMessageContent, isEphemeral } from "../helpers.js";
import { createMessage } from "../factories.js";
import { Intents } from "../gateway/intents.js";

const MENTION_RE = /<@!?(\d+)>/g;

function parseMentions(content: string): { users: string[]; everyone: boolean } {
  const users = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(content)) !== null) users.add(m[1]);
  return { users: [...users], everyone: /@everyone\b/.test(content) };
}

export function messagesRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  const messageIntents = (guildSnowflake: string | null) =>
    guildSnowflake ? Intents.GuildMessages : Intents.DirectMessages;

  app.get("/api/v:version/channels/:channelId/messages", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    if (!ds.channels.findOneBy("snowflake", channelId)) return notFound(c);
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
    if (!message || message.channel_snowflake !== c.req.param("channelId")) return notFound(c);
    return c.json(toAPIMessage(message, ds, auth.user?.snowflake));
  });

  app.post("/api/v:version/channels/:channelId/messages", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const channelId = c.req.param("channelId");
    const channel = ds.channels.findOneBy("snowflake", channelId);
    if (!channel) return notFound(c);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const content = typeof body.content === "string" ? body.content : "";
    const mentions = parseMentions(content);
    const message = createMessage(ds, {
      channelSnowflake: channelId,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: auth.user.snowflake,
      content,
      tts: body.tts === true,
      embeds: (body.embeds as unknown[] | undefined) ?? [],
      components: (body.components as unknown[] | undefined) ?? [],
      nonce: typeof body.nonce === "string" ? body.nonce : null,
      messageReference: (body.message_reference as never) ?? null,
      poll: (body.poll as never) ?? null,
      mentionSnowflakes: mentions.users,
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
    if (!message || message.channel_snowflake !== c.req.param("channelId")) return notFound(c);
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
    if (!message || message.channel_snowflake !== channelId) return notFound(c);
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
