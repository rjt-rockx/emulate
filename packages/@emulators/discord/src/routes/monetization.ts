import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  snowflake,
  unknownSku,
  unknownEntitlement,
  invalidFormBody,
  discordError,
} from "../helpers.js";
import type { DiscordEntitlement, DiscordSubscription } from "../entities.js";

/** SKU types per developers/resources/sku.mdx (SKU Types table). */
const SKU_TYPE_CONSUMABLE = 3;

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

/**
 * Serialize an entitlement to the documented Entitlement object.
 *
 * `partial` mode (Create Test Entitlement) returns the partial object that, per the doc,
 * "will not contain subscription_id, starts_at, or ends_at, as it's valid in perpetuity".
 */
function toAPIEntitlement(e: DiscordEntitlement, partial = false): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: e.snowflake,
    sku_id: e.sku_snowflake,
    application_id: e.application_snowflake,
    type: e.type,
    deleted: e.deleted,
  };
  if (!partial) {
    obj.starts_at = e.starts_at;
    obj.ends_at = e.ends_at;
    if (e.subscription_snowflake != null) obj.subscription_id = e.subscription_snowflake;
  }
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
    // renewal_sku_ids is documented as a nullable array, always present (null in the example).
    renewal_sku_ids: s.renewal_sku_snowflakes ?? null,
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
  const { app, store, bus } = ctx;

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

    return c.json(results.map((e) => toAPIEntitlement(e)));
  });

  // 3. GET /applications/:appId/entitlements/:entitlementId
  app.get("/api/v:version/applications/:appId/entitlements/:entitlementId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const entitlementId = c.req.param("entitlementId");
    const appId = c.req.param("appId");
    const entitlement = ds.entitlements.findOneBy("snowflake", entitlementId);
    if (!entitlement || entitlement.application_snowflake !== appId) return unknownEntitlement(c);
    return c.json(toAPIEntitlement(entitlement));
  });

  // 4. POST /applications/:appId/entitlements (create test entitlement)
  app.post("/api/v:version/applications/:appId/entitlements", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const skuId = body.sku_id == null ? "" : String(body.sku_id);
    const hasOwnerId = body.owner_id != null && String(body.owner_id) !== "";
    const ownerId = hasOwnerId ? String(body.owner_id) : "";
    const ownerType = Number(body.owner_type);

    // Validate the JSON params (Invalid Form Body, 50035).
    const errors: Record<string, string> = {};
    if (!hasOwnerId) errors.owner_id = "This field is required";
    // owner_type must be 1 (guild subscription) or 2 (user subscription).
    if (ownerType !== 1 && ownerType !== 2) errors.owner_type = "This field is required";
    if (Object.keys(errors).length > 0) return invalidFormBody(c, errors);

    // The SKU to grant the entitlement to must exist.
    const sku = ds.skus.findOneBy("snowflake", skuId);
    if (!sku || sku.application_snowflake !== appId) return unknownSku(c);

    const inserted = ds.entitlements.insert({
      snowflake: snowflake(),
      sku_snowflake: skuId,
      application_snowflake: appId,
      user_snowflake: ownerType === 2 ? ownerId : null,
      guild_snowflake: ownerType === 1 ? ownerId : null,
      type: 8, // APPLICATION_SUBSCRIPTION
      deleted: false,
      // Test entitlements are "valid in perpetuity": no start/end window.
      starts_at: null,
      ends_at: null,
      consumed: false,
    });

    // Partial object (no subscription_id/starts_at/ends_at) per the doc.
    const partial = toAPIEntitlement(inserted, true);
    bus.publish({ t: "ENTITLEMENT_CREATE", guildId: null, requiredIntents: 0, applicationId: appId, d: partial });
    return c.json(partial);
  });

  // 5. DELETE /applications/:appId/entitlements/:entitlementId
  app.delete("/api/v:version/applications/:appId/entitlements/:entitlementId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const entitlementId = c.req.param("entitlementId");
    const appId = c.req.param("appId");
    const entitlement = ds.entitlements.findOneBy("snowflake", entitlementId);
    if (!entitlement || entitlement.application_snowflake !== appId) return unknownEntitlement(c);
    ds.entitlements.delete(entitlement.id);
    bus.publish({ t: "ENTITLEMENT_DELETE", guildId: null, requiredIntents: 0, applicationId: appId, d: toAPIEntitlement(entitlement) });
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
    if (!entitlement || entitlement.application_snowflake !== appId) return unknownEntitlement(c);
    // Only consumable (type 3) SKUs can be consumed.
    const sku = ds.skus.findOneBy("snowflake", entitlement.sku_snowflake);
    if (!sku || sku.type !== SKU_TYPE_CONSUMABLE) {
      return discordError(c, 400, "Only consumable SKUs can be consumed.", 40018);
    }
    ds.entitlements.update(entitlement.id, { consumed: true });
    const updated = ds.entitlements.findOneBy("snowflake", entitlementId);
    if (updated) {
      bus.publish({
        t: "ENTITLEMENT_UPDATE",
        guildId: null,
        requiredIntents: 0,
        applicationId: appId,
        d: toAPIEntitlement(updated),
      });
    }
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
