import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("permission enforcement (opt-in)", () => {
  it("is lenient by default — the bot can manage roles without permission", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Staff" }),
    });
    expect(res.status).toBe(200);
  });

  it("when enabled, denies an action the bot lacks (ManageRoles) with 50013", async () => {
    const { app, store } = createDiscordTestApp({ enforce_permissions: true });
    const res = await app.request(api(`/guilds/${guildId(store)}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Staff" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: number }).code).toBe(50013);
  });

  it("when enabled, still allows an action the @everyone role grants (SendMessages)", async () => {
    const { app, store } = createDiscordTestApp({ enforce_permissions: true });
    const channel = getDiscordStore(store).channels.findOneBy("name", "general")!.snowflake;
    const res = await app.request(api(`/channels/${channel}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
  });

  it("when enabled, a guild owner (the bot) bypasses checks", async () => {
    const { app, store } = createDiscordTestApp({ enforce_permissions: true });
    // The bot creates a guild -> it is the owner -> Administrator short-circuit.
    const created = await app.request(api("/guilds"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Bot's Server" }),
    });
    const guild = (await created.json()) as { id: string };
    const role = await app.request(api(`/guilds/${guild.id}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Owner Role" }),
    });
    expect(role.status).toBe(200);
  });
});
