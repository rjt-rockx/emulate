import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, TEST_BASE_URL } from "./helpers.js";

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

describe("discord oauth2", () => {
  it("renders an authorize page with a user picker", async () => {
    const { app } = createDiscordTestApp(seed);
    const url = `${TEST_BASE_URL}/oauth2/authorize?client_id=cid&redirect_uri=${encodeURIComponent(
      "http://localhost:3000/cb",
    )}&response_type=code&scope=identify+email&state=xyz`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("authorize");
    expect(html).toContain("developer");
  });

  it("runs the full authorization_code flow and issues a usable bearer token", async () => {
    const { app, store } = createDiscordTestApp(seed);
    const dev = (await import("../store.js")).getDiscordStore(store).users.findOneBy("username", "developer")!;

    // callback issues a code
    const callbackBody = new URLSearchParams({
      user_id: dev.snowflake,
      client_id: "cid",
      redirect_uri: "http://localhost:3000/cb",
      scope: "identify email guilds",
      state: "xyz",
    });
    const cbRes = await app.request(`${TEST_BASE_URL}/oauth2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: callbackBody.toString(),
    });
    expect(cbRes.status).toBe(302);
    const location = cbRes.headers.get("location")!;
    const code = new URL(location).searchParams.get("code")!;
    expect(code).toBeTruthy();

    // exchange the code for a token
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "cid",
      client_secret: "secret",
      redirect_uri: "http://localhost:3000/cb",
    });
    const tokenRes = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token: string; token_type: string; scope: string };
    expect(token.token_type).toBe("Bearer");
    expect(token.access_token).toBeTruthy();

    // use the bearer token
    const meRes = await app.request(api("/oauth2/@me"), {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { scopes: string[]; user: { username: string } };
    expect(me.user.username).toBe("developer");
    expect(me.scopes).toContain("identify");
  });

  it("rejects a bad client_secret", async () => {
    const { app } = createDiscordTestApp(seed);
    const tokenRes = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "cid", client_secret: "wrong" }).toString(),
    });
    expect(tokenRes.status).toBe(401);
  });

  it("client_credentials issues no refresh token", async () => {
    const { app } = createDiscordTestApp(seed);
    const res = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "cid", client_secret: "secret", scope: "identify" }).toString(),
    });
    const token = (await res.json()) as { access_token: string; refresh_token?: string };
    expect(token.access_token).toBeTruthy();
    expect(token.refresh_token).toBeUndefined();
  });

  async function issueViaCode(app: ReturnType<typeof createDiscordTestApp>["app"], store: ReturnType<typeof createDiscordTestApp>["store"]) {
    const dev = (await import("../store.js")).getDiscordStore(store).users.findOneBy("username", "developer")!;
    const cb = await app.request(`${TEST_BASE_URL}/oauth2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_id: dev.snowflake, client_id: "cid", redirect_uri: "http://localhost:3000/cb", scope: "identify guilds" }).toString(),
    });
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    const res = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: "cid", client_secret: "secret", redirect_uri: "http://localhost:3000/cb" }).toString(),
    });
    return (await res.json()) as { access_token: string; refresh_token: string };
  }

  it("exchanges a refresh_token for a fresh access token (rotating it)", async () => {
    const { app, store } = createDiscordTestApp(seed);
    const first = await issueViaCode(app, store);
    expect(first.refresh_token).toBeTruthy();

    const refreshed = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "cid", client_secret: "secret", refresh_token: first.refresh_token }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(next.access_token).not.toBe(first.access_token);
    expect(next.scope).toContain("identify");

    // The old refresh token is now invalid (rotation).
    const reuse = await app.request(api("/oauth2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "cid", client_secret: "secret", refresh_token: first.refresh_token }).toString(),
    });
    expect(reuse.status).toBe(400);
  });

  it("revokes a token so it no longer authenticates", async () => {
    const { app, store } = createDiscordTestApp(seed);
    const tok = await issueViaCode(app, store);
    const before = await app.request(api("/oauth2/@me"), { headers: { Authorization: `Bearer ${tok.access_token}` } });
    expect(before.status).toBe(200);

    const revoke = await app.request(api("/oauth2/token/revoke"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tok.access_token, client_id: "cid", client_secret: "secret" }).toString(),
    });
    expect(revoke.status).toBe(200);

    const after = await app.request(api("/oauth2/@me"), { headers: { Authorization: `Bearer ${tok.access_token}` } });
    expect(after.status).toBe(401);
  });
});
