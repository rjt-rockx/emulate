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
});
