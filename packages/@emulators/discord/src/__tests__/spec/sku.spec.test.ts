/**
 * Spec suite for `developers/resources/sku.mdx`.
 *
 * Encodes the page's documented expectations directly: the SKU object structure and its
 * exact serialized fields, the SKU Types enum (DURABLE 2, CONSUMABLE 3, SUBSCRIPTION 5,
 * SUBSCRIPTION_GROUP 6), the SKU Flags bitfield (AVAILABLE 1<<2, GUILD_SUBSCRIPTION 1<<7,
 * USER_SUBSCRIPTION 1<<8), and the List SKUs endpoint contract. Written from the doc first;
 * the implementation is built/fixed until this is green.
 *
 * No SKUs are seeded by default, so every test inserts rows via the store before exercising
 * the endpoint.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).app;
}

describe("sku.mdx — SKU Types", () => {
  it("documents DURABLE=2, CONSUMABLE=3, SUBSCRIPTION=5, SUBSCRIPTION_GROUP=6 and round-trips each type", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    const types = { DURABLE: 2, CONSUMABLE: 3, SUBSCRIPTION: 5, SUBSCRIPTION_GROUP: 6 } as const;
    let i = 1;
    for (const [name, type] of Object.entries(types)) {
      ds.skus.insert({
        snowflake: `5000000000000000${i}`,
        application_snowflake: aid,
        type,
        name: `SKU ${name}`,
        slug: `sku-${name.toLowerCase()}`,
        flags: 0,
      });
      i++;
    }
    const res = await app.request(api(`/applications/${aid}/skus`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<Array<Record<string, unknown>>>(res);
    const byType = new Map(body.map((s) => [s.type, s]));
    expect(byType.has(2)).toBe(true);
    expect(byType.has(3)).toBe(true);
    expect(byType.has(5)).toBe(true);
    expect(byType.has(6)).toBe(true);
  });
});

describe("sku.mdx — SKU Flags", () => {
  it("AVAILABLE=1<<2, GUILD_SUBSCRIPTION=1<<7, USER_SUBSCRIPTION=1<<8 are preserved verbatim in the flags bitfield", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    const AVAILABLE = 1 << 2; // 4
    const GUILD_SUBSCRIPTION = 1 << 7; // 128
    const USER_SUBSCRIPTION = 1 << 8; // 256
    expect(AVAILABLE).toBe(4);
    expect(GUILD_SUBSCRIPTION).toBe(128);
    expect(USER_SUBSCRIPTION).toBe(256);
    const flags = AVAILABLE | USER_SUBSCRIPTION; // 260
    ds.skus.insert({
      snowflake: "510000000000000001",
      application_snowflake: aid,
      type: 5,
      name: "User Sub",
      slug: "user-sub",
      flags,
    });
    const res = await app.request(api(`/applications/${aid}/skus`), { headers: botHeaders() });
    const body = await json<Array<Record<string, unknown>>>(res);
    const sku = body[0]!;
    expect(sku.flags).toBe(260);
    // Bitwise differentiation per the doc must work against the serialized field.
    expect(((sku.flags as number) & USER_SUBSCRIPTION) !== 0).toBe(true);
    expect(((sku.flags as number) & GUILD_SUBSCRIPTION) !== 0).toBe(false);
  });
});

describe("sku.mdx — List SKUs", () => {
  it("GET /applications/{application.id}/skus returns the SKU object with exactly id/type/application_id/name/slug/flags", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    ds.skus.insert({
      snowflake: "1088510058284990888",
      application_snowflake: aid,
      type: 5,
      name: "Test Premium",
      slug: "test-premium",
      flags: 128,
    });
    const res = await app.request(api(`/applications/${aid}/skus`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<Array<Record<string, unknown>>>(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    const sku = body[0]!;
    // Documented SKU Structure fields, with exact values from the inserted row.
    expect(sku.id).toBe("1088510058284990888");
    expect(sku.type).toBe(5);
    expect(sku.application_id).toBe(aid);
    expect(sku.name).toBe("Test Premium");
    expect(sku.slug).toBe("test-premium");
    expect(sku.flags).toBe(128);
    expect(typeof sku.id).toBe("string");
    expect(typeof sku.application_id).toBe("string");
  });

  it("returns all SKUs for the given application and none from other applications", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const aid = appId(store);
    // Two SKUs for our app (a SUBSCRIPTION_GROUP type 6 and a SUBSCRIPTION type 5,
    // exactly as the doc's List SKUs example shows two entries).
    ds.skus.insert({
      snowflake: "1088510053843210999",
      application_snowflake: aid,
      type: 6,
      name: "Test Premium",
      slug: "test-premium",
      flags: 128,
    });
    ds.skus.insert({
      snowflake: "1088510058284990888",
      application_snowflake: aid,
      type: 5,
      name: "Test Premium",
      slug: "test-premium",
      flags: 128,
    });
    // A SKU belonging to a different application must not leak.
    ds.skus.insert({
      snowflake: "999000000000000001",
      application_snowflake: "111111111111111111",
      type: 5,
      name: "Other",
      slug: "other",
      flags: 0,
    });
    const res = await app.request(api(`/applications/${aid}/skus`), { headers: botHeaders() });
    const body = await json<Array<Record<string, unknown>>>(res);
    expect(body.length).toBe(2);
    const ids = body.map((s) => s.id);
    expect(ids).toContain("1088510053843210999");
    expect(ids).toContain("1088510058284990888");
    expect(ids).not.toContain("999000000000000001");
  });

  it("returns an empty array for an application with no SKUs", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await app.request(api(`/applications/${aid}/skus`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("requires authentication", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await app.request(api(`/applications/${aid}/skus`));
    expect(res.status).toBe(401);
  });
});
