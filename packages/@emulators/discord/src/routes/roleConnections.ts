import type { DiscordRouteContext } from "../context.js";
import { invalidFormBody, discordError, requireBot, requireUser } from "../helpers.js";
import type { Context, AppEnv, Store } from "@emulators/core";
import type { DiscordAuth } from "../helpers.js";

/** Returns a 403 "Missing required OAuth2 scope" (50026) response. */
function missingScopeError(c: Context<AppEnv>): Response {
  return discordError(c, 403, "Missing required OAuth2 scope", 50026);
}

/**
 * When `discord.strict_scopes` is enabled, verify the bearer auth holds the
 * required scope. Bot tokens bypass scope checks. Returns a 403 response when
 * the check fails, or null when the caller may proceed.
 */
function requireScope(c: Context<AppEnv>, store: Store, auth: DiscordAuth, scope: string): Response | null {
  if (store.getData<boolean>("discord.strict_scopes") !== true) return null;
  if (auth.type === "bot") return null;
  if (auth.scopes.includes(scope)) return null;
  return missingScopeError(c);
}

// Documented Application Role Connection Metadata Type enum (1-8 inclusive).
const MIN_METADATA_TYPE = 1;
const MAX_METADATA_TYPE = 8;
const MAX_METADATA_RECORDS = 5;
const METADATA_KEY_RE = /^[a-z0-9_]{1,50}$/;

/**
 * Validate a metadata record array against the documented constraints. Returns a field-error map
 * (suitable for `invalidFormBody`) when something is wrong, or null when the records are valid.
 */
function validateMetadataRecords(records: unknown[]): Record<string, string> | null {
  if (records.length > MAX_METADATA_RECORDS) {
    return { "": `An application can have a maximum of ${MAX_METADATA_RECORDS} metadata records.` };
  }
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object") {
      return { [`${i}`]: "This field is required." };
    }
    const type = rec.type;
    if (typeof type !== "number" || !Number.isInteger(type) || type < MIN_METADATA_TYPE || type > MAX_METADATA_TYPE) {
      return { [`${i}.type`]: `Value must be one of ${MIN_METADATA_TYPE} to ${MAX_METADATA_TYPE}.` };
    }
    const key = rec.key;
    if (typeof key !== "string" || !METADATA_KEY_RE.test(key)) {
      return { [`${i}.key`]: "Must match the regex ^[a-z0-9_]{1,50}$." };
    }
    const name = rec.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 100) {
      return { [`${i}.name`]: "Must be between 1 and 100 in length." };
    }
    const description = rec.description;
    if (typeof description !== "string" || description.length < 1 || description.length > 200) {
      return { [`${i}.description`]: "Must be between 1 and 200 in length." };
    }
  }
  return null;
}

export function roleConnectionsRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // Application role-connection metadata records.
  app.get("/api/v:version/applications/:appId/role-connections/metadata", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    // A1: Must resolve strictly by appId — do NOT fall back to all()[0].
    const application = ds.applications.findOneBy("snowflake", c.req.param("appId"));
    if (!application) return discordError(c, 404, "Unknown Application", 10002);
    return c.json(application.role_connection_metadata ?? []);
  });

  app.put("/api/v:version/applications/:appId/role-connections/metadata", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    // A1: Must resolve strictly by appId — do NOT fall back to all()[0].
    const application = ds.applications.findOneBy("snowflake", c.req.param("appId"));
    if (!application) return discordError(c, 404, "Unknown Application", 10002);
    // A3: A non-array body must return 50035, not silently coerce to [].
    let body: unknown;
    try { body = await c.req.json(); } catch { body = undefined; }
    if (!Array.isArray(body)) return invalidFormBody(c, { "": "This field must be an array." });
    const records = body as unknown[];
    const errors = validateMetadataRecords(records);
    if (errors) return invalidFormBody(c, errors);
    ds.applications.update(application.id, { role_connection_metadata: records });
    return c.json(records);
  });

  // The authed user's application role connection.
  app.get("/api/v:version/users/@me/applications/:appId/role-connection", (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const scopeErr = requireScope(c, store, auth, "role_connections.write");
    if (scopeErr) return scopeErr;
    const appId = c.req.param("appId");
    const existing = ds.roleConnections
      .findBy("application_snowflake", appId)
      .find((r) => r.user_snowflake === auth.user!.snowflake);
    return c.json({
      platform_name: existing?.platform_name ?? null,
      platform_username: existing?.platform_username ?? null,
      metadata: existing?.metadata ?? {},
    });
  });

  app.put("/api/v:version/users/@me/applications/:appId/role-connection", async (c) => {
    const g = requireUser(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const scopeErr = requireScope(c, store, auth, "role_connections.write");
    if (scopeErr) return scopeErr;
    const appId = c.req.param("appId");
    const body = (await c.req.json().catch(() => ({}))) as {
      platform_name?: string;
      platform_username?: string;
      metadata?: Record<string, string>;
    };
    const existing = ds.roleConnections
      .findBy("application_snowflake", appId)
      .find((r) => r.user_snowflake === auth.user!.snowflake);
    if (existing) {
      ds.roleConnections.update(existing.id, {
        platform_name: body.platform_name ?? existing.platform_name,
        platform_username: body.platform_username ?? existing.platform_username,
        metadata: body.metadata ?? existing.metadata,
      });
    } else {
      ds.roleConnections.insert({
        application_snowflake: appId,
        user_snowflake: auth.user!.snowflake,
        platform_name: body.platform_name ?? null,
        platform_username: body.platform_username ?? null,
        metadata: body.metadata ?? {},
      });
    }
    return c.json({
      platform_name: body.platform_name ?? existing?.platform_name ?? null,
      platform_username: body.platform_username ?? existing?.platform_username ?? null,
      metadata: body.metadata ?? existing?.metadata ?? {},
    });
  });
}
