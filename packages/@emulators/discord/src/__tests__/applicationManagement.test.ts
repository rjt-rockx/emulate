import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { discordPlugin } from "../index.js";
import { getDiscordRuntime } from "../runtime.js";
import { getDiscordStore } from "../store.js";
import { applicationManagementRoutes } from "../routes/applicationManagement.js";
import { api, botHeaders, TEST_BASE_URL } from "./helpers.js";

function build() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  discordPlugin.register(app, store, webhooks, TEST_BASE_URL);
  const runtime = getDiscordRuntime(store, TEST_BASE_URL);
  applicationManagementRoutes({ app, store, webhooks, baseUrl: TEST_BASE_URL, bus: runtime.bus });
  discordPlugin.seed?.(store, TEST_BASE_URL);
  return { app, store };
}

describe("GET /applications/@me", () => {
  it("returns the current application with id and name", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const res = await app.request(api("/applications/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(appId);
    expect(typeof body.name).toBe("string");
    expect(body.verify_key).toBeDefined();
    expect(body.flags).toBeDefined();
  });

  it("returns 401 without auth", async () => {
    const { app } = build();
    const res = await app.request(api("/applications/@me"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /applications/@me", () => {
  it("updates description and re-GET reflects the change", async () => {
    const { app } = build();

    const patchRes = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "updated description" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    expect(patched.description).toBe("updated description");

    // Re-GET should reflect the change (stateful)
    const getRes = await app.request(api("/applications/@me"), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as Record<string, unknown>;
    expect(got.description).toBe("updated description");
  });

  it("updates interactions_endpoint_url", async () => {
    const { app } = build();

    const patchRes = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: "https://example.com/interactions" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    // The field is not directly returned in the application object but the update should succeed
    expect(patched.id).toBeDefined();
  });
});

describe("Application Emojis CRUD", () => {
  it("list is empty initially wrapped in { items: [] }", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const res = await app.request(api(`/applications/${appId}/emojis`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });

  it("creates an emoji and it appears in the items list", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "test_emoji", image: "data:image/png;base64,abc" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.id).toBeDefined();
    expect(created.name).toBe("test_emoji");

    // List should now contain it
    const listRes = await app.request(api(`/applications/${appId}/emojis`), { headers: botHeaders() });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<Record<string, unknown>> };
    expect(list.items.length).toBe(1);
    expect(list.items[0].id).toBe(created.id);
    expect(list.items[0].name).toBe("test_emoji");
  });

  it("GET by emojiId returns the emoji", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "find_me", image: "data:image/png;base64,abc" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const emojiId = created.id as string;

    const getRes = await app.request(api(`/applications/${appId}/emojis/${emojiId}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as Record<string, unknown>;
    expect(got.id).toBe(emojiId);
    expect(got.name).toBe("find_me");
  });

  it("GET by emojiId returns 404 if not found", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const res = await app.request(api(`/applications/${appId}/emojis/000000000000000000`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH renames the emoji", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "original_name" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const emojiId = created.id as string;

    const patchRes = await app.request(api(`/applications/${appId}/emojis/${emojiId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "renamed_emoji" }),
    });
    expect(patchRes.status).toBe(200);
    const renamed = (await patchRes.json()) as Record<string, unknown>;
    expect(renamed.name).toBe("renamed_emoji");
    expect(renamed.id).toBe(emojiId);
  });

  it("DELETE removes the emoji and it is gone (204 + 404 on re-fetch)", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "to_delete" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const emojiId = created.id as string;

    const deleteRes = await app.request(api(`/applications/${appId}/emojis/${emojiId}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    // Should be gone from list
    const listRes = await app.request(api(`/applications/${appId}/emojis`), { headers: botHeaders() });
    const list = (await listRes.json()) as { items: Array<Record<string, unknown>> };
    expect(list.items.some((e) => e.id === emojiId)).toBe(false);

    // Should 404 on direct GET
    const getRes = await app.request(api(`/applications/${appId}/emojis/${emojiId}`), { headers: botHeaders() });
    expect(getRes.status).toBe(404);
  });

  it("list response is wrapped in { items: [...] } object", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);
    const appId = ds.applications.all()[0].snowflake;

    // Create two emojis
    await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "emoji_one" }),
    });
    await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "emoji_two" }),
    });

    const listRes = await app.request(api(`/applications/${appId}/emojis`), { headers: botHeaders() });
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as Record<string, unknown>;

    // Must be wrapped in { items: [...] }, not a bare array
    expect(Array.isArray(body)).toBe(false);
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as unknown[]).length).toBe(2);
  });
});
