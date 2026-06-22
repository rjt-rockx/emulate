import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake } from "../helpers.js";
import type { DiscordEntitlement, DiscordSubscription } from "../entities.js";

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function toAPISKU(sku: {
  snowflake: string;
  application_snowflake: string;
  type: number;
  name: string;
  slug: string;
  flags: number;
}): Record<string, unknown> {
  return {
    id: sku.snowflake,
    type: sku.type,
    application_id: sku.application_snowflake,
    name: sku.name,
    slug: sku.slug,
    flags: sku.flags,
  };
}

function toAPIEntitlement(e: DiscordEntitlement): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: e.snowflake,
    sku_id: e.sku_snowflake,
    application_id: e.application_snowflake,
    type: e.type,
    deleted: e.deleted,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
  };
  if (e.user_snowflake != null) obj.user_id = e.user_snowflake;
  if (e.guild_snowflake != null) obj.guild_id = e.guild_snowflake;
  if (e.consumed != null) obj.consumed = e.consumed;
  return obj;
}

function toAPISubscription(s: DiscordSubscription): Record<string, unknown> {
  return {
    id: s.snowflake,
    user_id: s.user_snowflake,
    sku_ids: s.sku_snowflakes,
    entitlement_ids: s.entitlement_snowflakes,
    current_period_start: s.current_period_start,
    current_period_end: s.current_period_end,
    status: s.status,
    canceled_at: s.canceled_at,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value === "true" || value === "1";
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function monetizationRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // 1. GET /applications/:appId/skus
  app.get("/api/v:version/applications/:appId/skus", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const skus = ds.skus.findBy("application_snowflake", appId).map(toAPISKU);
    return c.json(skus);
  });

  // 2. GET /applications/:appId/entitlements
  app.get("/api/v:version/applications/:appId/entitlements", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");

    const userId = c.req.query("user_id");
    const skuIdsParam = c.req.query("sku_ids");
    const guildId = c.req.query("guild_id");
    const before = c.req.query("before");
    const after = c.req.query("after");
    const limitParam = c.req.query("limit");
    const excludeEnded = parseBool(c.req.query("exclude_ended"), false);
    // By default, deleted entitlements are excluded (exclude_deleted defaults to true)
    const excludeDeleted = parseBool(c.req.query("exclude_deleted"), true);

    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 100) : 100;

    const skuIdSet = skuIdsParam
      ? new Set(skuIdsParam.split(",").map((s) => s.trim()).filter(Boolean))
      : null;

    const now = new Date().toISOString();

    let results = ds.entitlements.findBy("application_snowflake", appId);

    if (userId) results = results.filter((e) => e.user_snowflake === userId);
    if (skuIdSet) results = results.filter((e) => skuIdSet.has(e.sku_snowflake));
    if (guildId) results = results.filter((e) => e.guild_snowflake === guildId);
    if (excludeDeleted) results = results.filter((e) => !e.deleted);
    if (excludeEnded) results = results.filter((e) => !e.ends_at || e.ends_at > now);
    if (before) results = results.filter((e) => e.snowflake < before);
    if (after) results = results.filter((e) => e.snowflake > after);

    results = results.slice(0, limit);

    return c.json(results.map(toAPIEntitlement));
  });

  // 3. GET /applications/:appId/entitlements/:entitlementId
  app.get("/api/v:version/applications/:appId/entitlements/:entitlementId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const entitlementId = c.req.param("entitlementId");
    const appId = c.req.param("appId");
    const entitlement = ds.entitlements.findOneBy("snowflake", entitlementId);
    if (!entitlement || entitlement.application_snowflake !== appId) return notFound(c);
    return c.json(toAPIEntitlement(entitlement));
  });

  // 4. POST /applications/:appId/entitlements (create test entitlement)
  app.post("/api/v:version/applications/:appId/entitlements", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const skuId = String(body.sku_id ?? "");
    const ownerId = String(body.owner_id ?? "");
    const ownerType = Number(body.owner_type ?? 0);

    const now = new Date().toISOString();

    const inserted = ds.entitlements.insert({
      snowflake: snowflake(),
      sku_snowflake: skuId,
      application_snowflake: appId,
      user_snowflake: ownerType === 2 ? ownerId : null,
      guild_snowflake: ownerType === 1 ? ownerId : null,
      type: 8, // APPLICATION_SUBSCRIPTION
      deleted: false,
      starts_at: now,
      ends_at: null,
      consumed: false,
    });

    return c.json(toAPIEntitlement(inserted));
  });

  // 5. DELETE /applications/:appId/entitlements/:entitlementId
  app.delete("/api/v:version/applications/:appId/entitlements/:entitlementId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const entitlementId = c.req.param("entitlementId");
    const appId = c.req.param("appId");
    const entitlement = ds.entitlements.findOneBy("snowflake", entitlementId);
    if (!entitlement || entitlement.application_snowflake !== appId) return notFound(c);
    ds.entitlements.delete(entitlement.id);
    return new Response(null, { status: 204 });
  });

  // 6. POST /applications/:appId/entitlements/:entitlementId/consume
  app.post("/api/v:version/applications/:appId/entitlements/:entitlementId/consume", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const entitlementId = c.req.param("entitlementId");
    const appId = c.req.param("appId");
    const entitlement = ds.entitlements.findOneBy("snowflake", entitlementId);
    if (!entitlement || entitlement.application_snowflake !== appId) return notFound(c);
    ds.entitlements.update(entitlement.id, { consumed: true });
    return new Response(null, { status: 204 });
  });

  // 7. GET /skus/:skuId/subscriptions
  app.get("/api/v:version/skus/:skuId/subscriptions", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const skuId = c.req.param("skuId");

    const userId = c.req.query("user_id");
    const before = c.req.query("before");
    const after = c.req.query("after");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100) : 50;

    let results = ds.subscriptions.all().filter((s) => s.sku_snowflakes.includes(skuId));

    if (userId) results = results.filter((s) => s.user_snowflake === userId);
    if (before) results = results.filter((s) => s.snowflake < before);
    if (after) results = results.filter((s) => s.snowflake > after);

    results = results.slice(0, limit);

    return c.json(results.map(toAPISubscription));
  });

  // 8. GET /skus/:skuId/subscriptions/:subscriptionId
  app.get("/api/v:version/skus/:skuId/subscriptions/:subscriptionId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const skuId = c.req.param("skuId");
    const subscriptionId = c.req.param("subscriptionId");
    const subscription = ds.subscriptions.findOneBy("snowflake", subscriptionId);
    if (!subscription || !subscription.sku_snowflakes.includes(skuId)) return notFound(c);
    return c.json(toAPISubscription(subscription));
  });
}
