import type { DiscordRouteContext } from "../context.js";
import { requireBot, notFound, toAPIUser, toAPIMessage, redactMessageContent } from "../helpers.js";
import { Intents } from "../gateway/intents.js";

export function pollsRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // List the users who voted for a given poll answer. Honors `after` and `limit` (1-100, default 25).
  app.get("/api/v:version/channels/:channelId/polls/:messageId/answers/:answerId", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const messageId = c.req.param("messageId");
    if (!ds.messages.findOneBy("snowflake", messageId)) return notFound(c);
    const answerId = Number(c.req.param("answerId"));
    const limit = Math.min(Number(c.req.query("limit") ?? 25) || 25, 100);
    const after = c.req.query("after");
    const users = ds.pollVotes
      .findBy("message_snowflake", messageId)
      .filter((v) => v.answer_id === answerId)
      .filter((v) => (after ? BigInt(v.user_snowflake) > BigInt(after) : true))
      .sort((a, b) => (BigInt(a.user_snowflake) < BigInt(b.user_snowflake) ? -1 : 1))
      .slice(0, limit)
      .map((v) => ds.users.findOneBy("snowflake", v.user_snowflake))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => toAPIUser(u));
    return c.json({ users });
  });

  // Expire (finalize) a poll.
  app.post("/api/v:version/channels/:channelId/polls/:messageId/expire", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const message = ds.messages.findOneBy("snowflake", c.req.param("messageId"));
    if (!message || !message.poll) return notFound(c);
    ds.messages.update(message.id, { poll_finalized: true });
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

  // Emulator control plane: cast or remove a poll vote (no real client to click), dispatching
  // MESSAGE_POLL_VOTE_ADD / MESSAGE_POLL_VOTE_REMOVE.
  app.post("/__emulate/poll-vote", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const body = (await c.req.json().catch(() => ({}))) as {
      message_id?: string;
      answer_id?: number;
      user?: string;
      remove?: boolean;
    };
    const message = body.message_id ? ds.messages.findOneBy("snowflake", body.message_id) : null;
    if (!message || !message.poll) return notFound(c);
    const user = body.user
      ? (ds.users.findOneBy("snowflake", body.user) ?? ds.users.findOneBy("username", body.user))
      : ds.users.all().find((u) => !u.bot);
    if (!user) return notFound(c);
    const answerId = Number(body.answer_id ?? 0);

    const userVotes = ds.pollVotes
      .findBy("message_snowflake", message.snowflake)
      .filter((v) => v.user_snowflake === user.snowflake);
    const existing = userVotes.find((v) => v.answer_id === answerId);
    if (body.remove) {
      if (existing) ds.pollVotes.delete(existing.id);
    } else if (!existing) {
      // A single-select poll (allow_multiselect:false) only permits one vote per user: casting a
      // new vote clears the voter's other-answer votes first.
      if (!message.poll.allow_multiselect) {
        for (const v of userVotes) ds.pollVotes.delete(v.id);
      }
      ds.pollVotes.insert({
        message_snowflake: message.snowflake,
        channel_snowflake: message.channel_snowflake,
        guild_snowflake: message.guild_snowflake,
        answer_id: answerId,
        user_snowflake: user.snowflake,
      });
    }
    bus.publish({
      t: body.remove ? "MESSAGE_POLL_VOTE_REMOVE" : "MESSAGE_POLL_VOTE_ADD",
      guildId: message.guild_snowflake,
      requiredIntents: message.guild_snowflake ? Intents.GuildMessagePolls : Intents.DirectMessagePolls,
      d: {
        user_id: user.snowflake,
        channel_id: message.channel_snowflake,
        message_id: message.snowflake,
        guild_id: message.guild_snowflake ?? undefined,
        answer_id: answerId,
      },
    });
    return c.json(toAPIMessage(ds.messages.findOneBy("snowflake", message.snowflake)!, ds, user.snowflake));
  });
}
