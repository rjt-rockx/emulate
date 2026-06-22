import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { discordPlugin } from "../index.js";
import { getDiscordRuntime } from "../runtime.js";
import { getDiscordStore } from "../store.js";
import { commandPermissionsRoutes } from "../routes/commandPermissions.js";
import { api, botHeaders, TEST_BASE_URL } from "./helpers.js";

function build() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  discordPlugin.register(app, store, webhooks, TEST_BASE_URL);
  const runtime = getDiscordRuntime(store, TEST_BASE_URL);
  commandPermissionsRoutes({ app, store, webhooks, baseUrl: TEST_BASE_URL, bus: runtime.bus });
  discordPlugin.seed?.(store, TEST_BASE_URL);
  return { app, store };
}

describe("discord application command permissions", () => {
  it("returns 404 with code 10066 when no permissions set for a command", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const commandId = "555";

    const res = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(10066);
    expect(body.message).toBe("Unknown application command permissions");
  });

  it("PUT sets permissions and returns 200 with the stored object", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const commandId = "555";
    const permissions = [{ id: "111", type: 1, permission: true }];

    const res = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ permissions }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      application_id: string;
      guild_id: string;
      permissions: Array<{ id: string; type: number; permission: boolean }>;
    };
    expect(body.id).toBe(commandId);
    expect(body.application_id).toBe(appId);
    expect(body.guild_id).toBe(guildId);
    expect(body.permissions).toEqual(permissions);
  });

  it("GET single returns the permissions after PUT", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const commandId = "555";
    const permissions = [{ id: "222", type: 2, permission: false }];

    await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ permissions }),
      },
    );

    const res = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      permissions: Array<{ id: string; type: number; permission: boolean }>;
    };
    expect(body.id).toBe(commandId);
    expect(body.permissions).toEqual(permissions);
  });

  it("GET guild-wide list includes all set command permissions", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const commandId = "555";
    const permissions = [{ id: "333", type: 3, permission: true }];

    await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ permissions }),
      },
    );

    const res = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; permissions: unknown[] }>;
    expect(Array.isArray(list)).toBe(true);
    const entry = list.find((x) => x.id === commandId);
    expect(entry).toBeDefined();
    expect(entry!.permissions).toEqual(permissions);
  });

  it("PUT again updates permissions without duplicating (list length stays 1)", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const commandId = "555";

    const firstPerms = [{ id: "111", type: 1, permission: true }];
    const secondPerms = [
      { id: "111", type: 1, permission: false },
      { id: "222", type: 2, permission: true },
    ];

    await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ permissions: firstPerms }),
      },
    );

    await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ permissions: secondPerms }),
      },
    );

    // Guild-wide list should have exactly one row for this commandId
    const listRes = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/permissions`),
      { headers: botHeaders() },
    );
    const list = (await listRes.json()) as Array<{ id: string; permissions: unknown[] }>;
    const entries = list.filter((x) => x.id === commandId);
    expect(entries).toHaveLength(1);

    // The stored permissions should be the second PUT's data
    const singleRes = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/${commandId}/permissions`),
      { headers: botHeaders() },
    );
    const single = (await singleRes.json()) as {
      permissions: Array<{ id: string; type: number; permission: boolean }>;
    };
    expect(single.permissions).toEqual(secondPerms);
  });

  it("GET guild-wide list requires a bot token", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;

    const res = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/permissions`),
    );
    expect(res.status).toBe(401);
  });

  it("GET single requires a bot token", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;

    const res = await app.request(
      api(`/applications/${appId}/guilds/${guildId}/commands/555/permissions`),
    );
    expect(res.status).toBe(401);
  });

  it("batch PUT upserts permissions for multiple commands", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;

    const res = await app.request(api(`/applications/${appId}/guilds/${guildId}/commands/permissions`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify([
        { id: "111", permissions: [{ id: guildId, type: 1, permission: true }] },
        { id: "222", permissions: [{ id: guildId, type: 1, permission: false }] },
      ]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id).sort()).toEqual(["111", "222"]);

    const list = (await (await app.request(api(`/applications/${appId}/guilds/${guildId}/commands/permissions`), { headers: botHeaders() })).json()) as Array<{ id: string }>;
    expect(list.length).toBe(2);
  });
});
