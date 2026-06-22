import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { discordPlugin } from "../index.js";
import { getDiscordRuntime } from "../runtime.js";
import { getDiscordStore } from "../store.js";
import { monetizationRoutes } from "../routes/monetization.js";
import { api, botHeaders, TEST_BASE_URL } from "./helpers.js";

function build() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  discordPlugin.register(app, store, webhooks, TEST_BASE_URL);
  const runtime = getDiscordRuntime(store, TEST_BASE_URL);
  monetizationRoutes({ app, store, webhooks, baseUrl: TEST_BASE_URL, bus: runtime.bus });
  discordPlugin.seed?.(store, TEST_BASE_URL);
  return { app, store };
}

describe("monetization routes", () => {
  let app: Hono<AppEnv>;
  let store: Store;
  let appId: string;

  beforeEach(() => {
    ({ app, store } = build());
    appId = getDiscordStore(store).applications.all()[0].snowflake;

    // Seed a SKU
    getDiscordStore(store).skus.insert({
      snowflake: "100000000000000001",
      application_snowflake: appId,
      type: 5,
      name: "Premium",
      slug: "premium",
      flags: 128,
    });
  });

  // ---------------------------------------------------------------------------
  // SKUs
  // ---------------------------------------------------------------------------

  describe("GET /applications/:appId/skus", () => {
    it("returns seeded SKUs", async () => {
      const res = await app.request(api(`/applications/${appId}/skus`), { headers: botHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe("100000000000000001");
      expect(body[0].application_id).toBe(appId);
      expect(body[0].name).toBe("Premium");
      expect(body[0].slug).toBe("premium");
      expect(body[0].type).toBe(5);
      expect(body[0].flags).toBe(128);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(api(`/applications/${appId}/skus`));
      expect(res.status).toBe(401);
    });

    it("returns empty array when app has no SKUs", async () => {
      const res = await app.request(api("/applications/999999999999999999/skus"), { headers: botHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Entitlements CRUD lifecycle
  // ---------------------------------------------------------------------------

  describe("entitlement lifecycle", () => {
    it("create, list, get, consume, delete", async () => {
      // A consumable SKU (type 3) — only consumable SKUs can be consumed
      // (developers/resources/entitlement.mdx "Consume an Entitlement").
      getDiscordStore(store).skus.insert({
        snowflake: "100000000000000002",
        application_snowflake: appId,
        type: 3,
        name: "Consumable",
        slug: "consumable",
        flags: 0,
      });
      // CREATE
      const createRes = await app.request(api(`/applications/${appId}/entitlements`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({
          sku_id: "100000000000000002",
          owner_id: "200000000000000001",
          owner_type: 2, // user
        }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as Record<string, unknown>;
      expect(typeof created.id).toBe("string");
      expect(created.sku_id).toBe("100000000000000002");
      expect(created.application_id).toBe(appId);
      expect(created.user_id).toBe("200000000000000001");
      expect(created.guild_id).toBeUndefined();
      expect(created.type).toBe(8);
      expect(created.deleted).toBe(false);
      expect(created.consumed).toBe(false);

      const entitlementId = created.id as string;

      // LIST
      const listRes = await app.request(api(`/applications/${appId}/entitlements`), { headers: botHeaders() });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<Record<string, unknown>>;
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(entitlementId);

      // GET single
      const getRes = await app.request(api(`/applications/${appId}/entitlements/${entitlementId}`), {
        headers: botHeaders(),
      });
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as Record<string, unknown>;
      expect(got.id).toBe(entitlementId);
      expect(got.user_id).toBe("200000000000000001");

      // CONSUME
      const consumeRes = await app.request(api(`/applications/${appId}/entitlements/${entitlementId}/consume`), {
        method: "POST",
        headers: botHeaders(),
      });
      expect(consumeRes.status).toBe(204);

      // Verify consumed via GET
      const afterConsumeRes = await app.request(api(`/applications/${appId}/entitlements/${entitlementId}`), {
        headers: botHeaders(),
      });
      expect(afterConsumeRes.status).toBe(200);
      const afterConsumed = (await afterConsumeRes.json()) as Record<string, unknown>;
      expect(afterConsumed.consumed).toBe(true);

      // DELETE
      const deleteRes = await app.request(api(`/applications/${appId}/entitlements/${entitlementId}`), {
        method: "DELETE",
        headers: botHeaders(),
      });
      expect(deleteRes.status).toBe(204);

      // Verify gone via GET
      const afterDeleteRes = await app.request(api(`/applications/${appId}/entitlements/${entitlementId}`), {
        headers: botHeaders(),
      });
      expect(afterDeleteRes.status).toBe(404);

      // Verify empty list
      const afterDeleteListRes = await app.request(api(`/applications/${appId}/entitlements`), {
        headers: botHeaders(),
      });
      const afterDeleteList = (await afterDeleteListRes.json()) as unknown[];
      expect(afterDeleteList.length).toBe(0);
    });

    it("creates guild entitlement with owner_type=1", async () => {
      const createRes = await app.request(api(`/applications/${appId}/entitlements`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({
          sku_id: "100000000000000001",
          owner_id: "300000000000000001",
          owner_type: 1, // guild
        }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as Record<string, unknown>;
      expect(created.guild_id).toBe("300000000000000001");
      expect(created.user_id).toBeUndefined();
    });

    it("GET unknown entitlement returns 404", async () => {
      const res = await app.request(api(`/applications/${appId}/entitlements/000000000000000001`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE unknown entitlement returns 404", async () => {
      const res = await app.request(api(`/applications/${appId}/entitlements/000000000000000001`), {
        method: "DELETE",
        headers: botHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Entitlement filtering
  // ---------------------------------------------------------------------------

  describe("entitlement filters", () => {
    beforeEach(async () => {
      // Insert two entitlements: one for user A, one for user B
      await app.request(api(`/applications/${appId}/entitlements`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ sku_id: "100000000000000001", owner_id: "user_a", owner_type: 2 }),
      });
      await app.request(api(`/applications/${appId}/entitlements`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ sku_id: "100000000000000001", owner_id: "user_b", owner_type: 2 }),
      });
    });

    it("filters by user_id", async () => {
      const res = await app.request(api(`/applications/${appId}/entitlements?user_id=user_a`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body.length).toBe(1);
      expect(body[0].user_id).toBe("user_a");
    });

    it("filters by sku_ids", async () => {
      const res = await app.request(api(`/applications/${appId}/entitlements?sku_ids=100000000000000001`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body.length).toBe(2);
    });

    it("filters by nonexistent sku_ids returns empty", async () => {
      const res = await app.request(api(`/applications/${appId}/entitlements?sku_ids=999`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body.length).toBe(0);
    });

    it("respects limit", async () => {
      const res = await app.request(api(`/applications/${appId}/entitlements?limit=1`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  describe("subscriptions", () => {
    const skuId = "100000000000000001";

    beforeEach(() => {
      const ds = getDiscordStore(store);
      ds.subscriptions.insert({
        snowflake: "400000000000000001",
        user_snowflake: "user_sub_1",
        sku_snowflakes: [skuId],
        entitlement_snowflakes: [],
        current_period_start: "2024-01-01T00:00:00.000Z",
        current_period_end: "2024-02-01T00:00:00.000Z",
        status: 0,
        canceled_at: null,
      });
      ds.subscriptions.insert({
        snowflake: "400000000000000002",
        user_snowflake: "user_sub_2",
        sku_snowflakes: [skuId, "other_sku"],
        entitlement_snowflakes: [],
        current_period_start: "2024-01-01T00:00:00.000Z",
        current_period_end: "2024-02-01T00:00:00.000Z",
        status: 1,
        canceled_at: null,
      });
    });

    it("GET /skus/:skuId/subscriptions returns all subscriptions for the SKU", async () => {
      const res = await app.request(api(`/skus/${skuId}/subscriptions`), { headers: botHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body.length).toBe(2);
      expect(body[0].id).toBeDefined();
      expect(Array.isArray(body[0].sku_ids)).toBe(true);
      expect((body[0].sku_ids as string[]).includes(skuId)).toBe(true);
    });

    it("filters by user_id", async () => {
      const res = await app.request(api(`/skus/${skuId}/subscriptions?user_id=user_sub_1`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body.length).toBe(1);
      expect(body[0].user_id).toBe("user_sub_1");
    });

    it("returns empty for unrelated SKU", async () => {
      const res = await app.request(api("/skus/999999/subscriptions"), { headers: botHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body.length).toBe(0);
    });

    it("GET /skus/:skuId/subscriptions/:subscriptionId returns one subscription", async () => {
      const res = await app.request(api(`/skus/${skuId}/subscriptions/400000000000000001`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe("400000000000000001");
      expect(body.user_id).toBe("user_sub_1");
      expect(Array.isArray(body.sku_ids)).toBe(true);
      expect(Array.isArray(body.entitlement_ids)).toBe(true);
      expect(typeof body.current_period_start).toBe("string");
      expect(typeof body.current_period_end).toBe("string");
      expect(body.status).toBe(0);
      expect(body.canceled_at).toBeNull();
    });

    it("GET /skus/:skuId/subscriptions/:subscriptionId returns 404 for wrong SKU", async () => {
      const res = await app.request(api("/skus/wrong_sku/subscriptions/400000000000000001"), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("GET /skus/:skuId/subscriptions/:subscriptionId returns 404 for unknown subscription", async () => {
      const res = await app.request(api(`/skus/${skuId}/subscriptions/000000000000000001`), {
        headers: botHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("respects limit", async () => {
      const res = await app.request(api(`/skus/${skuId}/subscriptions?limit=1`), { headers: botHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body.length).toBe(1);
    });
  });
});
