import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("discord guild misc", () => {
  it("lists voice regions", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/voice/regions"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const regions = (await res.json()) as Array<{ id: string }>;
    expect(regions.some((r) => r.id === "us-east")).toBe(true);
  });

  it("reports prune count and vanity url", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const prune = await app.request(api(`/guilds/${gid}/prune`), { headers: botHeaders() });
    expect(((await prune.json()) as { pruned: number }).pruned).toBe(0);
    const vanity = await app.request(api(`/guilds/${gid}/vanity-url`), { headers: botHeaders() });
    expect(((await vanity.json()) as { code: string | null }).code).toBeNull();
  });

  it("returns an audit log with referenced users", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const res = await app.request(api(`/guilds/${gid}/audit-logs`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const log = (await res.json()) as { audit_log_entries: unknown[]; users: Array<{ username: string }> };
    expect(Array.isArray(log.audit_log_entries)).toBe(true);
    expect(log.users.some((u) => u.username === "emulate-bot")).toBe(true);
  });

  it("records audit log entries retroactively for mutations", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);

    // Create a role -> RoleCreate (30).
    const roleRes = await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Moderators", color: 0xff0000 }),
    });
    const role = (await roleRes.json()) as { id: string };

    // Create a channel -> ChannelCreate (10).
    const channelRes = await app.request(api(`/guilds/${gid}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "mod-log", type: 0 }),
    });
    const channel = (await channelRes.json()) as { id: string };

    const res = await app.request(api(`/guilds/${gid}/audit-logs`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const log = (await res.json()) as {
      audit_log_entries: Array<{ id: string; target_id: string; action_type: number; user_id: string }>;
    };
    // Newest first: channel create should precede role create.
    expect(log.audit_log_entries[0]?.action_type).toBe(10);
    expect(log.audit_log_entries[0]?.target_id).toBe(channel.id);
    const roleEntry = log.audit_log_entries.find((e) => e.action_type === 30);
    expect(roleEntry?.target_id).toBe(role.id);
    // The actor (the bot) is hydrated into users.
    expect(log.audit_log_entries.every((e) => typeof e.user_id === "string")).toBe(true);
  });

  it("filters audit log entries by action_type", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);

    await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "RoleA" }),
    });
    await app.request(api(`/guilds/${gid}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "chan-a", type: 0 }),
    });

    const res = await app.request(api(`/guilds/${gid}/audit-logs?action_type=30`), { headers: botHeaders() });
    const log = (await res.json()) as { audit_log_entries: Array<{ action_type: number }> };
    expect(log.audit_log_entries.length).toBe(1);
    expect(log.audit_log_entries.every((e) => e.action_type === 30)).toBe(true);
  });
});
