/**
 * Spec suite for the `discord.strict_scopes` enforcement feature.
 *
 * When `strict_scopes` is `true`, bearer tokens must hold the required OAuth2 scope for
 * each protected endpoint; missing the scope yields HTTP 403 with Discord error code 50026
 * ("Missing required OAuth2 scope"). Bot tokens bypass scope checks entirely. When
 * `strict_scopes` is `false` (the default), all bearer requests succeed regardless of the
 * scopes carried on the token.
 *
 * Endpoints covered here (scope gating already implemented in users.ts / roleConnections.ts):
 *   - GET  /users/@me                                   requires `identify`
 *   - GET  /users/@me/guilds                            requires `guilds`
 *   - GET  /users/@me/guilds/:id/member                 requires `guilds.members.read`
 *   - GET  /users/@me/applications/:id/role-connection  requires `role_connections.write`
 *   - PUT  /users/@me/applications/:id/role-connection  requires `role_connections.write`
 *
 * Endpoint covered by the oauth.ts change in this PR:
 *   - GET  /oauth2/@me -- `user` field omitted (not 403) when `identify` is missing and
 *     strict_scopes is on; field present when `identify` is included.
 *
 * DEFERRED: GET /users/@me/connections -- the `connections`-scope gating is not yet
 * implemented in integrations.ts and is left for a follow-up.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, bearerHeaders, json, seededIds } from "../helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed shared by every strict-mode test: one oauth app plus pre-seeded bearer tokens. */
const STRICT_SEED = {
  strict_scopes: true,
  oauth_apps: [
    {
      client_id: "cid",
      client_secret: "secret",
      redirect_uris: ["http://localhost:3000/cb"],
    },
  ],
  tokens: [
    // Scoped bearer tokens used directly in assertions.
    { token: "bt_identify", type: "bearer" as const, user: "developer", scopes: ["identify"] },
    { token: "bt_guilds", type: "bearer" as const, user: "developer", scopes: ["guilds"] },
    { token: "bt_gmr", type: "bearer" as const, user: "developer", scopes: ["guilds.members.read"] },
    { token: "bt_rcw", type: "bearer" as const, user: "developer", scopes: ["role_connections.write"] },
    // A token with no scopes at all -- useful for cross-cutting 403 checks.
    { token: "bt_empty", type: "bearer" as const, user: "developer", scopes: [] },
    // Multi-scope token used to assert success on multiple endpoints.
    {
      token: "bt_all",
      type: "bearer" as const,
      user: "developer",
      scopes: ["identify", "guilds", "guilds.members.read", "role_connections.write"],
    },
  ],
};

/** Seed used for leniency tests (strict_scopes off). */
const LENIENT_SEED = {
  strict_scopes: false,
  tokens: [{ token: "bt_no_scope", type: "bearer" as const, user: "developer", scopes: [] }],
};

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).app;
}

// ---------------------------------------------------------------------------
// GET /users/@me -- requires `identify`
// ---------------------------------------------------------------------------

describe("strict_scopes -- GET /users/@me (identify)", () => {
  it("returns 403/50026 when the bearer token lacks `identify`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_guilds") });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  it("returns 403/50026 for a bearer token with no scopes at all", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_empty") });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  it("returns 200 when the bearer token holds `identify`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_identify") });
    expect(res.status).toBe(200);
    const u = await json<{ username: string }>(res);
    expect(u.username).toBe("developer");
  });

  it("bot token always succeeds regardless of strict_scopes", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /users/@me/guilds -- requires `guilds`
// ---------------------------------------------------------------------------

describe("strict_scopes -- GET /users/@me/guilds (guilds)", () => {
  it("returns 403/50026 when the bearer token lacks `guilds`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me/guilds"), { headers: bearerHeaders("bt_identify") });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  it("returns 200 when the bearer token holds `guilds`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me/guilds"), { headers: bearerHeaders("bt_guilds") });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("bot token always succeeds regardless of strict_scopes", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/users/@me/guilds"), { headers: botHeaders() });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /users/@me/guilds/:id/member -- requires `guilds.members.read`
// ---------------------------------------------------------------------------

describe("strict_scopes -- GET /users/@me/guilds/:id/member (guilds.members.read)", () => {
  it("returns 403/50026 when the bearer token lacks `guilds.members.read`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const gid = guildId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/guilds/${gid}/member`), { headers: bearerHeaders("bt_identify") });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  it("returns 200 when the bearer token holds `guilds.members.read`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const gid = guildId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/guilds/${gid}/member`), { headers: bearerHeaders("bt_gmr") });
    expect(res.status).toBe(200);
    const m = await json(res);
    expect(Array.isArray(m.roles)).toBe(true);
  });

  it("bot token always succeeds regardless of strict_scopes", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const gid = guildId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/guilds/${gid}/member`), { headers: botHeaders() });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Role connection routes -- require `role_connections.write`
// ---------------------------------------------------------------------------

describe("strict_scopes -- GET /users/@me/applications/:id/role-connection (role_connections.write)", () => {
  it("returns 403/50026 when the bearer token lacks `role_connections.write`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      headers: bearerHeaders("bt_identify"),
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  it("returns 200 when the bearer token holds `role_connections.write`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      headers: bearerHeaders("bt_rcw"),
    });
    expect(res.status).toBe(200);
  });

  it("bot token always succeeds regardless of strict_scopes", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

describe("strict_scopes -- PUT /users/@me/applications/:id/role-connection (role_connections.write)", () => {
  it("returns 403/50026 when the bearer token lacks `role_connections.write`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      method: "PUT",
      headers: bearerHeaders("bt_guilds"),
      body: JSON.stringify({ platform_name: "Test" }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  it("returns 200 when the bearer token holds `role_connections.write`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      method: "PUT",
      headers: bearerHeaders("bt_rcw"),
      body: JSON.stringify({ platform_name: "TestPlatform" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ platform_name: string | null }>(res);
    expect(body.platform_name).toBe("TestPlatform");
  });

  it("bot token always succeeds regardless of strict_scopes", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ platform_name: "BotPlatform" }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /oauth2/@me -- user field gating on `identify`
// ---------------------------------------------------------------------------

describe("strict_scopes -- GET /oauth2/@me (user field requires identify)", () => {
  it("omits the user field when strict_scopes is on and bearer token lacks `identify`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders("bt_guilds") });
    expect(res.status).toBe(200);
    const info = await json(res);
    // No 403 -- the endpoint is accessible; the user field is simply absent.
    expect("user" in info).toBe(false);
  });

  it("includes the user field when strict_scopes is on and bearer token holds `identify`", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders("bt_identify") });
    expect(res.status).toBe(200);
    const info = await json<{ user?: { username: string } }>(res);
    expect(info.user).toBeDefined();
    expect(info.user!.username).toBe("developer");
  });

  it("omits the user field for a no-scope bearer token when strict_scopes is on", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders("bt_empty") });
    expect(res.status).toBe(200);
    const info = await json(res);
    expect("user" in info).toBe(false);
  });

  it("the user field is absent on /oauth2/@me with a bot token (bot tokens carry no `identify` scope)", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    // Bot tokens are accepted by /oauth2/@me (no special bearer-only enforcement in the
    // emulator), but they carry no scopes array, so `identify` is never present and the
    // user field is correctly omitted. This verifies the strict_scopes change does not
    // accidentally expose the user field for bot-token callers.
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const info = await json(res);
    expect("user" in info).toBe(false);
  });

  it("includes the application, scopes, and expires fields regardless of identify scope", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders("bt_guilds") });
    expect(res.status).toBe(200);
    const info = await json(res);
    expect(typeof info.application).toBe("object");
    expect(Array.isArray(info.scopes)).toBe(true);
    expect(typeof info.expires).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Leniency when strict_scopes is OFF (default)
// ---------------------------------------------------------------------------

describe("strict_scopes OFF -- all bearer endpoints are lenient", () => {
  it("GET /users/@me succeeds with a bearer token that has no scopes when strict_scopes is off", async () => {
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const res = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_no_scope") });
    expect(res.status).toBe(200);
  });

  it("GET /users/@me/guilds succeeds with a no-scope bearer token when strict_scopes is off", async () => {
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const res = await ctx.app.request(api("/users/@me/guilds"), { headers: bearerHeaders("bt_no_scope") });
    expect(res.status).toBe(200);
  });

  it("GET /users/@me/guilds/:id/member succeeds with a no-scope bearer token when strict_scopes is off", async () => {
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const gid = guildId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/guilds/${gid}/member`), { headers: bearerHeaders("bt_no_scope") });
    expect(res.status).toBe(200);
  });

  it("GET /users/@me/applications/:id/role-connection succeeds with a no-scope bearer when strict_scopes is off", async () => {
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      headers: bearerHeaders("bt_no_scope"),
    });
    expect(res.status).toBe(200);
  });

  it("PUT /users/@me/applications/:id/role-connection succeeds with a no-scope bearer when strict_scopes is off", async () => {
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const aid = appId(ctx.store);
    const res = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      method: "PUT",
      headers: bearerHeaders("bt_no_scope"),
      body: JSON.stringify({ platform_name: "Lenient" }),
    });
    expect(res.status).toBe(200);
  });

  it("GET /oauth2/@me omits user for a no-identify bearer even when strict_scopes is off (default behavior)", async () => {
    // The /oauth2/@me user field is ALWAYS gated on the identify scope per the Discord API
    // spec -- strict_scopes only makes this enforcement explicit; it is not the sole guard.
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders("bt_no_scope") });
    expect(res.status).toBe(200);
    const info = await json(res);
    expect("user" in info).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S4: GET /users/@me email field gating on the `email` scope (both modes)
// ---------------------------------------------------------------------------

describe("S4 -- GET /users/@me email field is gated on email scope for bearer tokens", () => {
  // S4: Bearer tokens without the `email` scope must NOT receive the email field even
  // when strict_scopes is off (lenient mode). Bot tokens are exempt and always see
  // the self-detail fields.
  it("S4: bearer without email scope omits the email field in non-strict mode", async () => {
    const ctx = createDiscordTestApp(LENIENT_SEED);
    const res = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_no_scope") });
    expect(res.status).toBe(200);
    const u = await json<Record<string, unknown>>(res);
    expect("email" in u).toBe(false);
  });

  it("S4: bearer with email scope receives the email field in non-strict mode", async () => {
    const ctx = createDiscordTestApp({
      strict_scopes: false,
      tokens: [{ token: "bt_email", type: "bearer" as const, user: "developer", scopes: ["email"] }],
    });
    const res = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_email") });
    expect(res.status).toBe(200);
    const u = await json<Record<string, unknown>>(res);
    expect("email" in u).toBe(true);
  });

  it("S4: bot token always sees the email field (bot tokens are exempt from scope checks)", async () => {
    const ctx = createDiscordTestApp();
    const res = await ctx.app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const u = await json<Record<string, unknown>>(res);
    // Bot tokens are type "bot", so the email gate does not apply.
    expect("email" in u).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-scope token succeeds on all strict endpoints
// ---------------------------------------------------------------------------

describe("strict_scopes -- multi-scope token passes all endpoint gates", () => {
  it("a token with all required scopes passes every guarded endpoint", async () => {
    const ctx = createDiscordTestApp(STRICT_SEED);
    const gid = guildId(ctx.store);
    const aid = appId(ctx.store);

    const meRes = await ctx.app.request(api("/users/@me"), { headers: bearerHeaders("bt_all") });
    expect(meRes.status).toBe(200);

    const guildsRes = await ctx.app.request(api("/users/@me/guilds"), { headers: bearerHeaders("bt_all") });
    expect(guildsRes.status).toBe(200);

    const memberRes = await ctx.app.request(api(`/users/@me/guilds/${gid}/member`), { headers: bearerHeaders("bt_all") });
    expect(memberRes.status).toBe(200);

    const rcGetRes = await ctx.app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      headers: bearerHeaders("bt_all"),
    });
    expect(rcGetRes.status).toBe(200);

    const oauthMeRes = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders("bt_all") });
    expect(oauthMeRes.status).toBe(200);
    const info = (await oauthMeRes.json()) as { user?: { username: string } };
    expect(info.user).toBeDefined();
    expect(info.user!.username).toBe("developer");
  });
});
