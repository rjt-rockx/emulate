import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json } from "./helpers.js";
import { getDiscordStore } from "../store.js";

describe("discord users routes", () => {
  it("GET /users/@me returns the bot user", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ id: string; bot: boolean; username: string }>(res);
    expect(typeof body.id).toBe("string");
    expect(body.bot).toBe(true);
    expect(body.username).toBe("emulate-bot");
  });

  it("GET /users/@me without auth is 401", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"));
    expect(res.status).toBe(401);
  });

  it("GET /users/:id returns a public user", async () => {
    const { app, store } = createDiscordTestApp();
    const dev = getDiscordStore(store).users.findOneBy("username", "developer")!;
    const res = await app.request(api(`/users/${dev.snowflake}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ id: string; username: string; email?: string }>(res);
    expect(body.id).toBe(dev.snowflake);
    expect(body.username).toBe("developer");
    expect(body.email).toBeUndefined(); // public serialization omits email
  });

  it("PATCH /users/@me updates global_name and persists", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ global_name: "Renamed Bot" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ global_name: string }>(res)).global_name).toBe("Renamed Bot");
    const bot = getDiscordStore(store).users.findOneBy("username", "emulate-bot")!;
    expect(bot.global_name).toBe("Renamed Bot");
  });

  it("GET /users/@me/guilds lists the seeded guild", async () => {
    const { app, store } = createDiscordTestApp();
    void store;
    const res = await app.request(api("/users/@me/guilds"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const guilds = await json<Array<{ id: string; name: string }>>(res);
    expect(guilds.some((g) => g.name === "Emulate Server")).toBe(true);
  });
});
