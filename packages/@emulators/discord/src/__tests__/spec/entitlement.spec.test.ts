/**
 * Spec suite for `developers/resources/entitlement.mdx`.
 *
 * Encodes the page's documented expectations directly: the Entitlement object structure
 * (every field including `subscription_id`), the Entitlement Types enum (1..8), the List
 * Entitlements query filters (user_id, sku_ids, guild_id, before, after, limit 1-100/default
 * 100, exclude_ended default false, exclude_deleted default true), Get Entitlement, Consume
 * (204; consumable-only -> 40018), Create Test Entitlement (partial object WITHOUT
 * subscription_id/starts_at/ends_at; JSON params + validation), and Delete Test Entitlement.
 * Written from the doc first; the implementation is built/fixed until this is green.
 *
 * Nothing is seeded by default, so each test inserts SKUs/entitlements via the store.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).app;
}

/** Insert a CONSUMABLE (type 3) SKU and return its snowflake. */
function seedConsumableSku(store: ReturnType<typeof createDiscordTestApp>["store"], aid: string): string {
  const id = "300000000000000003";
  getDiscordStore(store).skus.insert({
    snowflake: id,
    application_snowflake: aid,
    type: 3, // CONSUMABLE
    name: "Consumable",
    slug: "consumable",
    flags: 0,
  });
  return id;
}

/** Insert a SUBSCRIPTION (type 5, non-consumable) SKU and return its snowflake. */
function seedSubscriptionSku(store: ReturnType<typeof createDiscordTestApp>["store"], aid: string): string {
  const id = "500000000000000005";
  getDiscordStore(store).skus.insert({
    snowflake: id,
    application_snowflake: aid,
    type: 5, // SUBSCRIPTION (not consumable)
    name: "Premium",
    slug: "premium",
    flags: 128,
  });
  return id;
}

describe("entitlement.mdx — Entitlement object & types", () => {
  it("serializes every documented field, including subscription_id when set", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    ds.entitlements.insert({
      snowflake: "1019653849998299136",
      sku_snowflake: "1019475255913222144",
      application_snowflake: aid,
      user_snowflake: "771129655544643584",
      guild_snowflake: "1015034326372454400",
      type: 8, // APPLICATION_SUBSCRIPTION
      deleted: false,
      starts_at: "2022-09-14T17:00:18.704163+00:00",
      ends_at: "2022-10-14T17:00:18.704163+00:00",
      consumed: false,
      subscription_snowflake: "1019653835926409216",
    });
    const res = await app.request(api(`/applications/${aid}/entitlements/1019653849998299136`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const e = await json(res);
    expect(e.id).toBe("1019653849998299136");
    expect(e.sku_id).toBe("1019475255913222144");
    expect(e.application_id).toBe(aid);
    expect(e.user_id).toBe("771129655544643584");
    expect(e.type).toBe(8);
    expect(e.deleted).toBe(false);
    expect(e.starts_at).toBe("2022-09-14T17:00:18.704163+00:00");
    expect(e.ends_at).toBe("2022-10-14T17:00:18.704163+00:00");
    expect(e.guild_id).toBe("1015034326372454400");
    expect(e.consumed).toBe(false);
    // The doc's example object carries subscription_id — it must be emitted.
    expect(e.subscription_id).toBe("1019653835926409216");
  });

  it("documents all eight Entitlement Types (1..8) and round-trips the type integer", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    const types = {
      PURCHASE: 1,
      PREMIUM_SUBSCRIPTION: 2,
      DEVELOPER_GIFT: 3,
      TEST_MODE_PURCHASE: 4,
      FREE_PURCHASE: 5,
      USER_GIFT: 6,
      PREMIUM_PURCHASE: 7,
      APPLICATION_SUBSCRIPTION: 8,
    } as const;
    let i = 1;
    for (const type of Object.values(types)) {
      ds.entitlements.insert({
        snowflake: `7000000000000000${i}`,
        sku_snowflake: "1019475255913222144",
        application_snowflake: aid,
        user_snowflake: "771129655544643584",
        guild_snowflake: null,
        type,
        deleted: false,
        starts_at: null,
        ends_at: null,
      });
      i++;
    }
    const res = await app.request(api(`/applications/${aid}/entitlements?exclude_ended=false`), {
      headers: botHeaders(),
    });
    const body = await json<Array<Record<string, unknown>>>(res);
    const seen = new Set(body.map((e) => e.type));
    for (const v of Object.values(types)) expect(seen.has(v)).toBe(true);
  });

  it("omits subscription_id/guild_id/user_id/consumed when they are not set", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    ds.entitlements.insert({
      snowflake: "7100000000000000001",
      sku_snowflake: "1019475255913222144",
      application_snowflake: aid,
      user_snowflake: null,
      guild_snowflake: null,
      type: 1,
      deleted: false,
      starts_at: null,
      ends_at: null,
    });
    const res = await app.request(api(`/applications/${aid}/entitlements/7100000000000000001`), {
      headers: botHeaders(),
    });
    const e = await json(res);
    // These fields are documented optional (`?`) and absent when unset.
    expect("subscription_id" in e).toBe(false);
    expect("user_id" in e).toBe(false);
    expect("guild_id" in e).toBe(false);
    // starts_at/ends_at are nullable-but-present per the structure table.
    expect(e.starts_at).toBeNull();
    expect(e.ends_at).toBeNull();
  });
});

describe("entitlement.mdx — List Entitlements", () => {
  function seedMany(store: ReturnType<typeof createDiscordTestApp>["store"], aid: string): void {
    const ds = getDiscordStore(store);
    ds.entitlements.insert({
      snowflake: "800000000000000001",
      sku_snowflake: "sku_a",
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 8,
      deleted: false,
      starts_at: null,
      ends_at: null,
    });
    ds.entitlements.insert({
      snowflake: "800000000000000002",
      sku_snowflake: "sku_b",
      application_snowflake: aid,
      user_snowflake: "user_b",
      guild_snowflake: "guild_x",
      type: 8,
      deleted: false,
      starts_at: null,
      ends_at: null,
    });
    // A deleted entitlement (excluded by default).
    ds.entitlements.insert({
      snowflake: "800000000000000003",
      sku_snowflake: "sku_a",
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 8,
      deleted: true,
      starts_at: null,
      ends_at: null,
    });
    // An ended entitlement (included by default).
    ds.entitlements.insert({
      snowflake: "800000000000000004",
      sku_snowflake: "sku_a",
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 8,
      deleted: false,
      starts_at: "2000-01-01T00:00:00.000Z",
      ends_at: "2000-02-01T00:00:00.000Z",
    });
  }

  it("returns all entitlements for the app (active and expired), defaulting exclude_deleted=true / exclude_ended=false", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<Array<Record<string, unknown>>>(res);
    const ids = body.map((e) => e.id);
    // Deleted (…003) excluded by default; ended (…004) included by default.
    expect(ids).toContain("800000000000000001");
    expect(ids).toContain("800000000000000002");
    expect(ids).not.toContain("800000000000000003");
    expect(ids).toContain("800000000000000004");
  });

  it("exclude_deleted=false includes deleted entitlements", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements?exclude_deleted=false`), {
      headers: botHeaders(),
    });
    const ids = (await json<Array<Record<string, unknown>>>(res)).map((e) => e.id);
    expect(ids).toContain("800000000000000003");
  });

  it("exclude_ended=true omits ended entitlements", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements?exclude_ended=true`), {
      headers: botHeaders(),
    });
    const ids = (await json<Array<Record<string, unknown>>>(res)).map((e) => e.id);
    expect(ids).not.toContain("800000000000000004");
    expect(ids).toContain("800000000000000001");
  });

  it("filters by user_id", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements?user_id=user_b`), {
      headers: botHeaders(),
    });
    const body = await json<Array<Record<string, unknown>>>(res);
    expect(body.length).toBe(1);
    expect(body[0]!.user_id).toBe("user_b");
  });

  it("filters by guild_id", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements?guild_id=guild_x`), {
      headers: botHeaders(),
    });
    const body = await json<Array<Record<string, unknown>>>(res);
    expect(body.length).toBe(1);
    expect(body[0]!.guild_id).toBe("guild_x");
  });

  it("filters by sku_ids as a comma-delimited set of snowflakes", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements?sku_ids=sku_b,sku_missing`), {
      headers: botHeaders(),
    });
    const body = await json<Array<Record<string, unknown>>>(res);
    expect(body.length).toBe(1);
    expect(body[0]!.sku_id).toBe("sku_b");
  });

  it("paginates with before/after on the entitlement ID", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const before = await app.request(api(`/applications/${aid}/entitlements?before=800000000000000002`), {
      headers: botHeaders(),
    });
    const beforeIds = ((await before.json()) as Array<Record<string, unknown>>).map((e) => e.id);
    expect(beforeIds).toContain("800000000000000001");
    expect(beforeIds).not.toContain("800000000000000002");
    const after = await app.request(api(`/applications/${aid}/entitlements?after=800000000000000002`), {
      headers: botHeaders(),
    });
    const afterIds = ((await after.json()) as Array<Record<string, unknown>>).map((e) => e.id);
    expect(afterIds).not.toContain("800000000000000001");
    expect(afterIds).not.toContain("800000000000000002");
    expect(afterIds).toContain("800000000000000004");
  });

  it("honors limit (1-100)", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    seedMany(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements?limit=1`), { headers: botHeaders() });
    const body = await json<unknown[]>(res);
    expect(body.length).toBe(1);
  });
});

describe("entitlement.mdx — Get Entitlement", () => {
  it("returns the entitlement object", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    ds.entitlements.insert({
      snowflake: "810000000000000001",
      sku_snowflake: "sku_a",
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 8,
      deleted: false,
      starts_at: null,
      ends_at: null,
    });
    const res = await app.request(api(`/applications/${aid}/entitlements/810000000000000001`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe("810000000000000001");
  });

  it("returns 404 Unknown Entitlement (10029) for an unknown id", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await app.request(api(`/applications/${aid}/entitlements/999999999999999999`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10029);
  });
});

describe("entitlement.mdx — Consume an Entitlement", () => {
  it("returns 204 and marks a CONSUMABLE entitlement consumed (consumed:true on next list)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    const skuId = seedConsumableSku(store, aid);
    ds.entitlements.insert({
      snowflake: "820000000000000001",
      sku_snowflake: skuId,
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 1,
      deleted: false,
      starts_at: null,
      ends_at: null,
      consumed: false,
    });
    const res = await app.request(api(`/applications/${aid}/entitlements/820000000000000001/consume`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    const list = await app.request(api(`/applications/${aid}/entitlements`), { headers: botHeaders() });
    const e = ((await list.json()) as Array<Record<string, unknown>>).find((x) => x.id === "820000000000000001")!;
    expect(e.consumed).toBe(true);
  });

  it("returns 400 (40018) 'Only consumable SKUs can be consumed' for a non-consumable SKU", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid); // type 5, not consumable
    ds.entitlements.insert({
      snowflake: "821000000000000001",
      sku_snowflake: skuId,
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 8,
      deleted: false,
      starts_at: null,
      ends_at: null,
      consumed: false,
    });
    const res = await app.request(api(`/applications/${aid}/entitlements/821000000000000001/consume`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(40018);
  });

  it("returns 404 Unknown Entitlement (10029) when consuming an unknown entitlement", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await app.request(api(`/applications/${aid}/entitlements/999999999999999999/consume`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10029);
  });
});

describe("entitlement.mdx — Create Test Entitlement", () => {
  it("creates a guild test entitlement (owner_type 1) and returns a PARTIAL object WITHOUT subscription_id/starts_at/ends_at", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sku_id: skuId, owner_id: "300000000000000001", owner_type: 1 }),
    });
    expect(res.status).toBe(200);
    const e = await json(res);
    expect(e.sku_id).toBe(skuId);
    expect(e.application_id).toBe(aid);
    expect(e.guild_id).toBe("300000000000000001");
    expect("user_id" in e).toBe(false);
    // "valid in perpetuity": the partial object must NOT carry these three fields.
    expect("subscription_id" in e).toBe(false);
    expect("starts_at" in e).toBe(false);
    expect("ends_at" in e).toBe(false);
  });

  it("creates a user test entitlement (owner_type 2) targeting the user", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sku_id: skuId, owner_id: "200000000000000001", owner_type: 2 }),
    });
    expect(res.status).toBe(200);
    const e = await json(res);
    expect(e.user_id).toBe("200000000000000001");
    expect("guild_id" in e).toBe(false);
  });

  it("returns 404 Unknown SKU (10027) when sku_id does not exist", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await app.request(api(`/applications/${aid}/entitlements`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sku_id: "999999999999999999", owner_id: "200000000000000001", owner_type: 2 }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10027);
  });

  it("returns 400 Invalid Form Body (50035) when owner_id is missing", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sku_id: skuId, owner_type: 2 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("returns 400 Invalid Form Body (50035) when owner_type is not 1 or 2", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid);
    const res = await app.request(api(`/applications/${aid}/entitlements`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sku_id: skuId, owner_id: "200000000000000001", owner_type: 3 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("persists the created test entitlement so it appears in List Entitlements", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid);
    const created = (await (
      await app.request(api(`/applications/${aid}/entitlements`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ sku_id: skuId, owner_id: "200000000000000001", owner_type: 2 }),
      })
    ).json()) as { id: string };
    const list = (await (
      await app.request(api(`/applications/${aid}/entitlements`), { headers: botHeaders() })
    ).json()) as Array<Record<string, unknown>>;
    expect(list.map((e) => e.id)).toContain(created.id);
  });
});

describe("entitlement.mdx — Delete Test Entitlement", () => {
  it("returns 204 and removes the entitlement", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    ds.entitlements.insert({
      snowflake: "830000000000000001",
      sku_snowflake: "sku_a",
      application_snowflake: aid,
      user_snowflake: "user_a",
      guild_snowflake: null,
      type: 8,
      deleted: false,
      starts_at: null,
      ends_at: null,
    });
    const res = await app.request(api(`/applications/${aid}/entitlements/830000000000000001`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    const get = await app.request(api(`/applications/${aid}/entitlements/830000000000000001`), {
      headers: botHeaders(),
    });
    expect(get.status).toBe(404);
  });

  it("returns 404 Unknown Entitlement (10029) when deleting an unknown entitlement", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await app.request(api(`/applications/${aid}/entitlements/999999999999999999`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10029);
  });
});

describe("entitlement.mdx — Gateway events", () => {
  it("emits ENTITLEMENT_CREATE on Create Test Entitlement and ENTITLEMENT_DELETE on delete", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const skuId = seedSubscriptionSku(store, aid);

    // Subscribe to the in-package bus to capture published gateway events.
    const { getDiscordRuntime } = await import("../../runtime.js");
    const bus = getDiscordRuntime(store).bus;
    const seen: string[] = [];
    const unsub = bus.subscribe((e) => seen.push(e.t));

    const created = (await (
      await app.request(api(`/applications/${aid}/entitlements`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ sku_id: skuId, owner_id: "200000000000000001", owner_type: 2 }),
      })
    ).json()) as { id: string };
    expect(seen).toContain("ENTITLEMENT_CREATE");

    await app.request(api(`/applications/${aid}/entitlements/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(seen).toContain("ENTITLEMENT_DELETE");
    unsub();
  });
});
