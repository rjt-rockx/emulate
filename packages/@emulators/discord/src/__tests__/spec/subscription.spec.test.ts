/**
 * Spec suite for `developers/resources/subscription.mdx`.
 *
 * Encodes the page's documented expectations directly: the Subscription object structure
 * (every field including `renewal_sku_ids` and the nullable `canceled_at`), the Subscription
 * Statuses enum, the List SKU Subscriptions endpoint (before/after/limit 1-100 default 50/
 * user_id filters), and Get SKU Subscription. Written from the doc first; the implementation
 * is built/fixed until this is green.
 *
 * NOTE ON STATUS VALUES: the doc's "Subscription Statuses" table defines ACTIVE=0, INACTIVE=1,
 * ENDING=2. The doc is the source of truth, so this suite asserts those exact mappings.
 *
 * Nothing is seeded by default, so each test inserts subscriptions via the store.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

const SKU_ID = "1158857122189168803";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).app;
}

function seedSub(
  store: ReturnType<typeof createDiscordTestApp>["store"],
  over: Partial<Parameters<ReturnType<typeof getDiscordStore>["subscriptions"]["insert"]>[0]> & { snowflake: string },
): void {
  getDiscordStore(store).subscriptions.insert({
    user_snowflake: "1088605110638227537",
    sku_snowflakes: [SKU_ID],
    entitlement_snowflakes: [],
    current_period_start: "2024-08-27T19:48:44.406602+00:00",
    current_period_end: "2024-09-27T19:48:44.406602+00:00",
    status: 0,
    canceled_at: null,
    renewal_sku_snowflakes: null,
    ...over,
  });
}

describe("subscription.mdx — Subscription object", () => {
  it("serializes every documented field, including renewal_sku_ids (nullable) and canceled_at", async () => {
    const { app, store } = createDiscordTestApp();
    appId(store);
    seedSub(store, {
      snowflake: "1278078770116427839",
      entitlement_snowflakes: [],
      renewal_sku_snowflakes: null,
    });
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions/1278078770116427839`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const s = await json(res);
    expect(s.id).toBe("1278078770116427839");
    expect(s.user_id).toBe("1088605110638227537");
    expect(s.sku_ids).toEqual([SKU_ID]);
    expect(s.entitlement_ids).toEqual([]);
    // renewal_sku_ids is documented (?array) and must be present, null here.
    expect("renewal_sku_ids" in s).toBe(true);
    expect(s.renewal_sku_ids).toBeNull();
    expect(s.current_period_start).toBe("2024-08-27T19:48:44.406602+00:00");
    expect(s.current_period_end).toBe("2024-09-27T19:48:44.406602+00:00");
    expect(s.status).toBe(0);
    expect(s.canceled_at).toBeNull();
  });

  it("emits renewal_sku_ids as an array of snowflakes when set", async () => {
    const { app, store } = createDiscordTestApp();
    seedSub(store, {
      snowflake: "1278078770116427840",
      renewal_sku_snowflakes: ["9990000000000000001", "9990000000000000002"],
    });
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions/1278078770116427840`), {
      headers: botHeaders(),
    });
    const s = await json(res);
    expect(s.renewal_sku_ids).toEqual(["9990000000000000001", "9990000000000000002"]);
  });

  it("reflects a canceled subscription's canceled_at timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    seedSub(store, {
      snowflake: "1278078770116427841",
      status: 2, // ENDING
      canceled_at: "2024-09-01T00:00:00.000Z",
    });
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions/1278078770116427841`), {
      headers: botHeaders(),
    });
    const s = await json(res);
    expect(s.canceled_at).toBe("2024-09-01T00:00:00.000Z");
    expect(s.status).toBe(2);
  });
});

describe("subscription.mdx — Subscription Statuses", () => {
  it("documents ACTIVE=0, INACTIVE=1, ENDING=2 and round-trips each status integer", async () => {
    const { app, store } = createDiscordTestApp();
    const statuses = { ACTIVE: 0, INACTIVE: 1, ENDING: 2 } as const;
    let i = 1;
    for (const status of Object.values(statuses)) {
      seedSub(store, { snowflake: `1279000000000000000${i}`, status, user_snowflake: `user_${i}` });
      i++;
    }
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions`), { headers: botHeaders() });
    const body = await json<Array<Record<string, unknown>>>(res);
    const seen = new Set(body.map((s) => s.status));
    expect(seen.has(0)).toBe(true);
    expect(seen.has(1)).toBe(true);
    expect(seen.has(2)).toBe(true);
  });
});

describe("subscription.mdx — List SKU Subscriptions", () => {
  function seedMany(store: ReturnType<typeof createDiscordTestApp>["store"]): void {
    seedSub(store, { snowflake: "1280000000000000001", user_snowflake: "user_sub_1" });
    seedSub(store, {
      snowflake: "1280000000000000002",
      user_snowflake: "user_sub_2",
      sku_snowflakes: [SKU_ID, "other_sku"],
    });
    seedSub(store, { snowflake: "1280000000000000003", user_snowflake: "user_sub_1", sku_snowflakes: ["other_sku"] });
  }

  it("GET /skus/{sku.id}/subscriptions returns all subscriptions containing the SKU", async () => {
    const { app, store } = createDiscordTestApp();
    seedMany(store);
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<Array<Record<string, unknown>>>(res);
    const ids = body.map((s) => s.id);
    expect(ids).toContain("1280000000000000001");
    expect(ids).toContain("1280000000000000002");
    // …003 doesn't contain SKU_ID and must be omitted.
    expect(ids).not.toContain("1280000000000000003");
    for (const s of body) expect((s.sku_ids as string[]).includes(SKU_ID)).toBe(true);
  });

  it("filters by user_id", async () => {
    const { app, store } = createDiscordTestApp();
    seedMany(store);
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions?user_id=user_sub_2`), {
      headers: botHeaders(),
    });
    const body = await json<Array<Record<string, unknown>>>(res);
    expect(body.length).toBe(1);
    expect(body[0]!.user_id).toBe("user_sub_2");
  });

  it("paginates with before/after on the subscription ID", async () => {
    const { app, store } = createDiscordTestApp();
    seedMany(store);
    const before = await app.request(api(`/skus/${SKU_ID}/subscriptions?before=1280000000000000002`), {
      headers: botHeaders(),
    });
    const beforeIds = ((await before.json()) as Array<Record<string, unknown>>).map((s) => s.id);
    expect(beforeIds).toContain("1280000000000000001");
    expect(beforeIds).not.toContain("1280000000000000002");
    const after = await app.request(api(`/skus/${SKU_ID}/subscriptions?after=1280000000000000001`), {
      headers: botHeaders(),
    });
    const afterIds = ((await after.json()) as Array<Record<string, unknown>>).map((s) => s.id);
    expect(afterIds).toContain("1280000000000000002");
    expect(afterIds).not.toContain("1280000000000000001");
  });

  it("honors limit (1-100)", async () => {
    const { app, store } = createDiscordTestApp();
    seedMany(store);
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions?limit=1`), { headers: botHeaders() });
    const body = await json<unknown[]>(res);
    expect(body.length).toBe(1);
  });

  it("returns an empty array for a SKU with no subscriptions", async () => {
    const { app, store } = createDiscordTestApp();
    seedMany(store);
    const res = await app.request(api("/skus/999999999999999999/subscriptions"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("subscription.mdx — Get SKU Subscription", () => {
  it("returns a subscription by its ID", async () => {
    const { app, store } = createDiscordTestApp();
    seedSub(store, { snowflake: "1281000000000000001" });
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions/1281000000000000001`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe("1281000000000000001");
  });

  it("returns 404 when the subscription does not contain the requested SKU", async () => {
    const { app, store } = createDiscordTestApp();
    seedSub(store, { snowflake: "1281000000000000002", sku_snowflakes: ["other_sku"] });
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions/1281000000000000002`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown subscription id", async () => {
    const { app, store } = createDiscordTestApp();
    seedSub(store, { snowflake: "1281000000000000003" });
    const res = await app.request(api(`/skus/${SKU_ID}/subscriptions/999999999999999999`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
