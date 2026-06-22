import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { createMessage } from "../factories.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return {
    guild: s.guild,
    channel: s.general,
    bot: s.bot,
  };
}

async function getAuditLog(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  guildId: string,
  actionType?: number,
): Promise<Array<{ action_type: number; target_id: string | null; user_id: string | null }>> {
  const qs = actionType != null ? `?action_type=${actionType}` : "";
  const res = await app.request(api(`/guilds/${guildId}/audit-logs${qs}`), { headers: botHeaders() });
  const body = await json<{ audit_log_entries: Array<{ action_type: number; target_id: string | null; user_id: string | null }> }>(res);
  return body.audit_log_entries;
}

describe("audit log coverage — emoji create", () => {
  it("records an EmojiCreate (60) entry after POST /guilds/:id/emojis", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);

    const res = await app.request(api(`/guilds/${guild}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "wave", animated: false, image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(201);
    const emoji = await json<{ id: string }>(res);

    const entries = await getAuditLog(app, guild, 60);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e) => e.target_id === emoji.id);
    expect(entry).toBeDefined();
    expect(entry!.action_type).toBe(60);
  });
});

describe("audit log coverage — invite create", () => {
  it("records an InviteCreate (40) entry after POST /channels/:id/invites", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, channel } = ids(store);

    const res = await app.request(api(`/channels/${channel}/invites`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ max_age: 3600 }),
    });
    expect(res.status).toBe(200);

    const entries = await getAuditLog(app, guild, 40);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].action_type).toBe(40);
  });
});

describe("audit log coverage — message delete", () => {
  it("records a MessageDelete (72) entry after DELETE /channels/:id/messages/:id", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, channel, bot } = ids(store);
    const ds = getDiscordStore(store);

    const msg = createMessage(ds, {
      channelSnowflake: channel,
      guildSnowflake: guild,
      authorSnowflake: bot,
      content: "delete me",
    });

    const del = await app.request(api(`/channels/${channel}/messages/${msg.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(del.status).toBe(204);

    const entries = await getAuditLog(app, guild, 72);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].action_type).toBe(72);
    // target_id is the message author
    expect(entries[0].target_id).toBe(bot);
  });
});

describe("audit log coverage — scheduled event create", () => {
  it("records a GuildScheduledEventCreate (100) entry after POST /guilds/:id/scheduled-events", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);

    const res = await app.request(api(`/guilds/${guild}/scheduled-events`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        name: "Launch Party",
        scheduled_start_time: "2030-01-01T00:00:00.000Z",
        scheduled_end_time: "2030-01-01T02:00:00.000Z",
        entity_type: 3,
        entity_metadata: { location: "The Internet" },
      }),
    });
    expect(res.status).toBe(201);
    const event = await json<{ id: string }>(res);

    const entries = await getAuditLog(app, guild, 100);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e) => e.target_id === event.id);
    expect(entry).toBeDefined();
    expect(entry!.action_type).toBe(100);
  });
});
