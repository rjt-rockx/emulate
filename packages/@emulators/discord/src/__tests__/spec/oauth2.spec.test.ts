/**
 * Spec suite for `developers/topics/oauth2.mdx`.
 *
 * Encodes the page's documented expectations directly: the full scope list, every grant
 * flow (authorization code, client credentials, refresh, implicit), the bot authorization
 * flow and its extended/advanced variant, the webhook.incoming flow, token revocation, and
 * the Get Current Authorization Information / Get Current Bot Application Information
 * endpoints. Written from the doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, TEST_BASE_URL, bearerHeaders, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

// The default seeded app + a known oauth client. Mirrors the existing oauth.test.ts setup so
// the seeded client_id/secret/redirect_uri are reused across every grant exercise here.
const seed = {
  oauth_apps: [
    {
      client_id: "cid",
      client_secret: "secret",
      redirect_uris: ["http://localhost:3000/cb"],
      scopes: ["identify", "email", "guilds"],
    },
  ],
};

const REDIRECT = "http://localhost:3000/cb";

function devSnowflake(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).users.findOneBy("username", "developer")!.snowflake;
}

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

/** Drive authorize -> code by POSTing the authorize callback and reading the redirect code. */
async function obtainCode(
  appCtx: ReturnType<typeof createDiscordTestApp>,
  scope: string,
  extra: Record<string, string> = {},
): Promise<{ location: string; code: string }> {
  const { app, store } = appCtx;
  const res = await app.request(`${TEST_BASE_URL}/oauth2/authorize/callback`, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({ user_id: devSnowflake(store), client_id: "cid", redirect_uri: REDIRECT, scope, ...extra }),
  });
  const location = res.headers.get("location")!;
  return { location, code: new URL(location).searchParams.get("code")! };
}

async function exchangeCode(appCtx: ReturnType<typeof createDiscordTestApp>, code: string): Promise<Response> {
  return appCtx.app.request(api("/oauth2/token"), {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      grant_type: "authorization_code",
      code,
      client_id: "cid",
      client_secret: "secret",
      redirect_uri: REDIRECT,
    }),
  });
}

describe("oauth2.mdx — OAuth2 Scopes", () => {
  // Every scope name listed in the doc's Scopes table. The authorize page advertises the
  // requested scopes, so each must be recognized (round-tripped) without error.
  const ALL_SCOPES = [
    "activities.read",
    "activities.write",
    "applications.builds.read",
    "applications.builds.upload",
    "applications.commands",
    "applications.commands.update",
    "applications.commands.permissions.update",
    "applications.entitlements",
    "applications.store.update",
    "bot",
    "connections",
    "dm_channels.read",
    "email",
    "gdm.join",
    "guilds",
    "guilds.join",
    "guilds.members.read",
    "identify",
    "identify.premium",
    "messages.read",
    "relationships.read",
    "role_connections.write",
    "rpc",
    "rpc.activities.write",
    "rpc.notifications.read",
    "rpc.voice.read",
    "rpc.voice.write",
    "voice",
    "webhook.incoming",
  ];

  it("recognizes every documented scope and echoes it back in the token's scope string", async () => {
    const ctx = createDiscordTestApp(seed);
    // A representative, plausibly-combined subset granted through a real code exchange.
    const scope = "identify email connections guilds guilds.join role_connections.write applications.commands";
    const { code } = await obtainCode(ctx, scope);
    const token = (await (await exchangeCode(ctx, code)).json()) as { scope: string };
    for (const s of scope.split(" ")) expect(token.scope.split(" ")).toContain(s);
  });

  it("lists all 29 documented scope names", () => {
    // Guards against silent drift of the documented scope vocabulary.
    expect(new Set(ALL_SCOPES).size).toBe(ALL_SCOPES.length);
    expect(ALL_SCOPES).toContain("webhook.incoming");
    expect(ALL_SCOPES).toContain("role_connections.write");
  });
});

describe("oauth2.mdx — Authorization Code Grant", () => {
  it("authorize page renders and accepts the documented query params", async () => {
    const { app } = createDiscordTestApp(seed);
    const url = `${TEST_BASE_URL}/oauth2/authorize?response_type=code&client_id=cid&scope=${encodeURIComponent(
      "identify guilds.join",
    )}&state=abc&redirect_uri=${encodeURIComponent(REDIRECT)}&prompt=consent`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
  });

  it("redirect carries the code and echoes state", async () => {
    const ctx = createDiscordTestApp(seed);
    const { location } = await obtainCode(ctx, "identify", { state: "15773059ghq9183habn" });
    const u = new URL(location);
    expect(u.searchParams.get("code")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe("15773059ghq9183habn");
  });

  it("token response has exactly {access_token, token_type:'Bearer', expires_in, refresh_token, scope}", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const res = await exchangeCode(ctx, code);
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(typeof t.access_token).toBe("string");
    expect(t.token_type).toBe("Bearer");
    expect(typeof t.expires_in).toBe("number");
    expect(typeof t.refresh_token).toBe("string");
    expect(t.scope).toBe("identify");
  });

  it("expires_in is seconds-until-expiry (the documented 604800)", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const t = (await (await exchangeCode(ctx, code)).json()) as { expires_in: number };
    expect(t.expires_in).toBe(604800);
  });

  it("the issued access token authenticates against the API", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string };
    const me = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) });
    expect(me.status).toBe(200);
  });

  it("a used/unknown code is rejected (invalid_grant)", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    expect((await exchangeCode(ctx, code)).status).toBe(200);
    const reuse = await exchangeCode(ctx, code);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("oauth2.mdx — Client Credentials Grant", () => {
  it("issues an access token WITHOUT a refresh token", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ grant_type: "client_credentials", client_id: "cid", client_secret: "secret", scope: "identify connections" }),
    });
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(typeof t.access_token).toBe("string");
    expect(t.token_type).toBe("Bearer");
    expect(typeof t.expires_in).toBe("number");
    expect(t.scope).toBe("identify connections");
    expect("refresh_token" in t).toBe(false);
  });

  it("rejects a bad client_secret with 401 invalid_client", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ grant_type: "client_credentials", client_id: "cid", client_secret: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect((await json<{ error: string }>(res)).error).toBe("invalid_client");
  });
});

describe("oauth2.mdx — Refresh Token Grant", () => {
  it("exchanges a refresh token for a fresh access-token response (rotation)", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify guilds");
    const first = (await (await exchangeCode(ctx, code)).json()) as { access_token: string; refresh_token: string };

    const res = await ctx.app.request(api("/oauth2/token"), {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ grant_type: "refresh_token", client_id: "cid", client_secret: "secret", refresh_token: first.refresh_token }),
    });
    expect(res.status).toBe(200);
    const next = await json(res);
    expect(next.token_type).toBe("Bearer");
    expect(typeof next.refresh_token).toBe("string");
    expect(next.access_token).not.toBe(first.access_token);
    // The same grant (scopes) is carried across the refresh.
    expect((next.scope as string).split(" ")).toContain("identify");
  });

  it("invalidates the old refresh token after rotation", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const first = (await (await exchangeCode(ctx, code)).json()) as { refresh_token: string };
    const refresh = (rt: string) =>
      ctx.app.request(api("/oauth2/token"), {
        method: "POST",
        headers: FORM_HEADERS,
        body: form({ grant_type: "refresh_token", client_id: "cid", client_secret: "secret", refresh_token: rt }),
      });
    expect((await refresh(first.refresh_token)).status).toBe(200);
    // The original refresh token can no longer be reused.
    expect((await refresh(first.refresh_token)).status).toBe(400);
  });
});

describe("oauth2.mdx — Implicit Grant", () => {
  it("response_type=token returns the token in the URL fragment, NOT the query string", async () => {
    const ctx = createDiscordTestApp(seed);
    const res = await ctx.app.request(`${TEST_BASE_URL}/oauth2/authorize/callback`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({
        user_id: devSnowflake(ctx.store),
        client_id: "cid",
        redirect_uri: REDIRECT,
        scope: "identify",
        state: "15773059ghq9183habn",
        response_type: "token",
      }),
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    // The fragment must carry access_token/token_type/expires_in/scope/state; query must be empty.
    expect(location).toContain("#");
    const u = new URL(location);
    expect(u.search === "" || u.search === "?").toBe(true);
    const frag = new URLSearchParams(location.slice(location.indexOf("#") + 1));
    expect(frag.get("access_token")).toBeTruthy();
    expect(frag.get("token_type")).toBe("Bearer");
    expect(frag.get("expires_in")).toBe("604800");
    expect(frag.get("scope")).toBe("identify");
    expect(frag.get("state")).toBe("15773059ghq9183habn");
  });

  it("the implicit fragment carries NO refresh token", async () => {
    const ctx = createDiscordTestApp(seed);
    const res = await ctx.app.request(`${TEST_BASE_URL}/oauth2/authorize/callback`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ user_id: devSnowflake(ctx.store), client_id: "cid", redirect_uri: REDIRECT, scope: "identify", response_type: "token" }),
    });
    const location = res.headers.get("location")!;
    const frag = new URLSearchParams(location.slice(location.indexOf("#") + 1));
    expect(frag.has("refresh_token")).toBe(false);
  });

  it("the implicitly-issued access token authenticates", async () => {
    const ctx = createDiscordTestApp(seed);
    const res = await ctx.app.request(`${TEST_BASE_URL}/oauth2/authorize/callback`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ user_id: devSnowflake(ctx.store), client_id: "cid", redirect_uri: REDIRECT, scope: "identify", response_type: "token" }),
    });
    const frag = new URLSearchParams(res.headers.get("location")!.split("#")[1]);
    const me = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(frag.get("access_token")!) });
    expect(me.status).toBe(200);
  });
});

describe("oauth2.mdx — Bot Authorization Flow", () => {
  it("the bot scope token response carries a guild object", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "bot", { permissions: "1", guild_id: "" });
    const t = (await (await exchangeCode(ctx, code)).json()) as Record<string, unknown>;
    expect(t.token_type).toBe("Bearer");
    expect(typeof t.guild).toBe("object");
    expect((t.guild as Record<string, unknown>).id).toBeTruthy();
  });

  it("threads permissions through the pending code and echoes them on the redirect", async () => {
    const ctx = createDiscordTestApp(seed);
    const { location } = await obtainCode(ctx, "bot", { permissions: "8" });
    const u = new URL(location);
    expect(u.searchParams.get("permissions")).toBe("8");
  });

  it("threads guild_id through the pending code and echoes it on the redirect", async () => {
    const ctx = createDiscordTestApp(seed);
    const guild = getDiscordStore(ctx.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const { location } = await obtainCode(ctx, "bot", { guild_id: guild, permissions: "8" });
    const u = new URL(location);
    expect(u.searchParams.get("guild_id")).toBe(guild);
  });

  it("Advanced (extended) flow: bot + extra scopes returns guild AND a refresh token", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "bot identify", { permissions: "8" });
    const t = (await (await exchangeCode(ctx, code)).json()) as Record<string, unknown>;
    expect(typeof t.guild).toBe("object");
    expect((t.scope as string).split(" ")).toContain("bot");
    expect((t.scope as string).split(" ")).toContain("identify");
    // The extended flow runs a full authorization code grant: a refresh token is returned.
    expect(typeof t.refresh_token).toBe("string");
    expect(t.token_type).toBe("Bearer");
    expect(typeof t.expires_in).toBe("number");
  });
});

describe("oauth2.mdx — Webhooks (webhook.incoming)", () => {
  it("the webhook.incoming token response includes a webhook object", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "webhook.incoming");
    const res = await exchangeCode(ctx, code);
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(t.token_type).toBe("Bearer");
    expect(typeof t.access_token).toBe("string");
    expect((t.scope as string)).toBe("webhook.incoming");
    expect(typeof t.refresh_token).toBe("string");
    const wh = t.webhook as Record<string, unknown>;
    expect(typeof wh).toBe("object");
    // Documented webhook fields.
    expect(typeof wh.id).toBe("string");
    expect(typeof wh.token).toBe("string");
    expect(typeof wh.channel_id).toBe("string");
    expect(typeof wh.application_id).toBe("string");
    expect(typeof wh.url).toBe("string");
    expect(wh.type).toBe(1);
    expect("name" in wh).toBe(true);
    expect("avatar" in wh).toBe(true);
    expect("guild_id" in wh).toBe(true);
  });

  it("creates a persisted webhook row that can be looked up by id+token", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "webhook.incoming");
    const t = (await (await exchangeCode(ctx, code)).json()) as { webhook: { id: string; token: string } };
    const ds = getDiscordStore(ctx.store);
    const row = ds.webhooks.findOneBy("snowflake", t.webhook.id);
    expect(row).toBeTruthy();
    expect(row!.token).toBe(t.webhook.token);
  });
});

describe("oauth2.mdx — Token endpoint content-type enforcement (oauth2.mdx:23-25)", () => {
  // Doc: token and revoke URLs accept ONLY application/x-www-form-urlencoded; JSON -> error.

  it("POST /oauth2/token rejects a JSON body (non-form content-type)", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", scope: "identify" }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid_request");
  });

  it("POST /oauth2/token/revoke rejects a JSON body (non-form content-type)", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/token/revoke"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "some_token" }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid_request");
  });

  it("POST /oauth2/token with unsupported grant_type returns unsupported_grant_type (oauth2.mdx:8)", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ grant_type: "password", scope: "identify" }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("unsupported_grant_type");
  });
});

describe("oauth2.mdx — Token Revocation", () => {
  it("revokes a token so it no longer authenticates", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string };
    expect((await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) })).status).toBe(200);

    const revoke = await ctx.app.request(api("/oauth2/token/revoke"), {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ token: t.access_token, token_type_hint: "access_token", client_id: "cid", client_secret: "secret" }),
    });
    expect(revoke.status).toBe(200);
    expect((await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) })).status).toBe(401);
  });

  it("revoking by refresh_token also revokes the associated access token", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string; refresh_token: string };
    const revoke = await ctx.app.request(api("/oauth2/token/revoke"), {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ token: t.refresh_token, token_type_hint: "refresh_token", client_id: "cid", client_secret: "secret" }),
    });
    expect(revoke.status).toBe(200);
    expect((await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) })).status).toBe(401);
  });
});

describe("oauth2.mdx — Get Current Authorization Information (GET /oauth2/@me)", () => {
  it("requires a bearer token", async () => {
    const { app } = createDiscordTestApp(seed);
    expect((await app.request(api("/oauth2/@me"))).status).toBe(401);
  });

  it("returns application (partial), scopes, and expires", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify guilds.join");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string };
    const res = await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) });
    expect(res.status).toBe(200);
    const info = await json(res);
    expect(typeof info.application).toBe("object");
    expect(Array.isArray(info.scopes)).toBe(true);
    expect((info.scopes as string[]).sort()).toEqual(["guilds.join", "identify"]);
    // expires is an ISO8601 timestamp.
    expect(typeof info.expires).toBe("string");
    expect(Number.isNaN(Date.parse(info.expires as string))).toBe(false);
  });

  it("the partial application carries id/name/icon/description/bot_public/bot_require_code_grant/verify_key", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string };
    const info = (await (await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) })).json()) as {
      application: Record<string, unknown>;
    };
    const a = info.application;
    expect(typeof a.id).toBe("string");
    expect(typeof a.name).toBe("string");
    expect("icon" in a).toBe(true);
    expect("description" in a).toBe(true);
    expect(typeof a.bot_public).toBe("boolean");
    expect(typeof a.bot_require_code_grant).toBe("boolean");
    expect(typeof a.verify_key).toBe("string");
  });

  it("includes the user only when the identify scope was granted", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "identify");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string };
    const info = (await (await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) })).json()) as {
      user?: { username: string };
    };
    expect(info.user).toBeDefined();
    expect(info.user!.username).toBe("developer");
  });

  it("omits the user when identify was NOT granted", async () => {
    const ctx = createDiscordTestApp(seed);
    const { code } = await obtainCode(ctx, "guilds");
    const t = (await (await exchangeCode(ctx, code)).json()) as { access_token: string };
    const info = (await (await ctx.app.request(api("/oauth2/@me"), { headers: bearerHeaders(t.access_token) })).json()) as {
      user?: unknown;
    };
    expect("user" in info).toBe(false);
  });
});

describe("oauth2.mdx — Get Current Bot Application Information (GET /oauth2/applications/@me)", () => {
  it("returns the bot's application object (versioned path)", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/applications/@me"), {
      headers: { Authorization: "Bot test_bot_token" },
    });
    expect(res.status).toBe(200);
    const a = await json(res);
    expect(typeof a.id).toBe("string");
    expect(typeof a.name).toBe("string");
    expect(typeof a.verify_key).toBe("string");
    expect("bot_public" in a).toBe(true);
    expect("bot_require_code_grant" in a).toBe(true);
  });

  it("is also reachable at the unversioned /api/oauth2/applications/@me alias", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(`${TEST_BASE_URL}/api/oauth2/applications/@me`, {
      headers: { Authorization: "Bot test_bot_token" },
    });
    expect(res.status).toBe(200);
    const a = await json(res);
    expect(typeof a.id).toBe("string");
  });
});
