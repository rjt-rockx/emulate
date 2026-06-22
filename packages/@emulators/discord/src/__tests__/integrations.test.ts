import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { discordPlugin } from "../index.js";
import { getDiscordRuntime } from "../runtime.js";
import { getDiscordStore } from "../store.js";
import { integrationsRoutes } from "../routes/integrations.js";
import { api, botHeaders, TEST_BASE_URL } from "./helpers.js";
import { snowflake } from "../helpers.js";

function build() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  discordPlugin.register(app, store, webhooks, TEST_BASE_URL);
  const runtime = getDiscordRuntime(store, TEST_BASE_URL);
  integrationsRoutes({ app, store, webhooks, baseUrl: TEST_BASE_URL, bus: runtime.bus });
  discordPlugin.seed?.(store, TEST_BASE_URL);
  return { app, store };
}

describe("integrations routes", () => {
  // -------------------------------------------------------------------------
  // GET /guilds/:guildId/integrations
  // -------------------------------------------------------------------------

  it("lists integrations for a guild after inserting one", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("name", "Emulate Server")!;
    expect(guild).toBeDefined();

    const integSnowflake = snowflake();
    ds.integrations.insert({
      snowflake: integSnowflake,
      guild_snowflake: guild.snowflake,
      name: "Test Integration",
      type: "twitch",
      enabled: true,
      account: { id: "twitch-123", name: "streamer" },
    });

    const res = await app.request(api(`/guilds/${guild.snowflake}/integrations`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const found = body.find((i) => i.id === integSnowflake);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Test Integration");
    expect(found!.type).toBe("twitch");
    expect(found!.enabled).toBe(true);
    expect((found!.account as Record<string, unknown>).id).toBe("twitch-123");
  });

  it("returns 401 without bot auth for integrations list", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("name", "Emulate Server")!;
    const res = await app.request(api(`/guilds/${guild.snowflake}/integrations`));
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown guild integrations", async () => {
    const { app } = build();
    const res = await app.request(api("/guilds/000000000000000000/integrations"), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // DELETE /guilds/:guildId/integrations/:integrationId
  // -------------------------------------------------------------------------

  it("deletes an integration and returns 204", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("name", "Emulate Server")!;

    const integSnowflake = snowflake();
    ds.integrations.insert({
      snowflake: integSnowflake,
      guild_snowflake: guild.snowflake,
      name: "Delete Me",
      type: "youtube",
      enabled: true,
      account: { id: "yt-999", name: "channel" },
    });

    const res = await app.request(
      api(`/guilds/${guild.snowflake}/integrations/${integSnowflake}`),
      { method: "DELETE", headers: botHeaders() },
    );
    expect(res.status).toBe(204);

    // Verify it is gone from the store.
    const gone = ds.integrations.findOneBy("snowflake", integSnowflake);
    expect(gone).toBeUndefined();
  });

  it("returns 404 when deleting a non-existent integration", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("name", "Emulate Server")!;

    const res = await app.request(
      api(`/guilds/${guild.snowflake}/integrations/000000000000000099`),
      { method: "DELETE", headers: botHeaders() },
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET /users/@me/connections
  // -------------------------------------------------------------------------

  it("lists connections for the current user after inserting one", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Use the seeded bot user (emulate-bot) which has a token already.
    const botUser = ds.users.findOneBy("username", "emulate-bot");
    expect(botUser).toBeDefined();

    ds.connections.insert({
      user_snowflake: botUser!.snowflake,
      connection_id: "gh-user-42",
      name: "octocat",
      type: "github",
      verified: true,
      friend_sync: false,
      show_activity: true,
      two_way_link: false,
      visibility: 1,
    });

    const res = await app.request(api("/users/@me/connections"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((c) => c.id === "gh-user-42");
    expect(found).toBeDefined();
    expect(found!.name).toBe("octocat");
    expect(found!.type).toBe("github");
    expect(found!.verified).toBe(true);
    expect(found!.visibility).toBe(1);
    expect(Array.isArray(found!.integrations)).toBe(true);
  });

  it("returns 401 without auth for connections", async () => {
    const { app } = build();
    const res = await app.request(api("/users/@me/connections"));
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /sticker-packs
  // -------------------------------------------------------------------------

  it("returns at least one sticker pack", async () => {
    const { app } = build();
    const res = await app.request(api("/sticker-packs"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sticker_packs: Array<Record<string, unknown>> };
    expect(Array.isArray(body.sticker_packs)).toBe(true);
    expect(body.sticker_packs.length).toBeGreaterThanOrEqual(1);
    const pack = body.sticker_packs[0];
    expect(typeof pack.id).toBe("string");
    expect(typeof pack.name).toBe("string");
    expect(typeof pack.description).toBe("string");
    expect(Array.isArray(pack.stickers)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GET /sticker-packs/:packId
  // -------------------------------------------------------------------------

  it("returns a specific sticker pack by id", async () => {
    const { app } = build();
    // First retrieve the list to get a real id.
    const listRes = await app.request(api("/sticker-packs"), { headers: botHeaders() });
    const listBody = (await listRes.json()) as { sticker_packs: Array<Record<string, unknown>> };
    const firstId = listBody.sticker_packs[0].id as string;

    const res = await app.request(api(`/sticker-packs/${firstId}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const pack = (await res.json()) as Record<string, unknown>;
    expect(pack.id).toBe(firstId);
    expect(typeof pack.name).toBe("string");
  });

  it("returns 404 for an unknown sticker pack id", async () => {
    const { app } = build();
    const res = await app.request(api("/sticker-packs/000000000000000000"), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });
});
