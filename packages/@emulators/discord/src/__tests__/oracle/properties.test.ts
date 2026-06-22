import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, seededIds, json } from "../helpers.js";

/**
 * Invariant / property tests: instead of asserting one endpoint's shape, these assert rules that
 * must hold ACROSS endpoints, so a whole class of regressions fails at once.
 */

const UNKNOWN = "999999999999999999";

describe("invariant: every error response is a well-formed Discord error envelope", () => {
  // Each row should fail; we assert the envelope `{ message: string, code: number }` regardless of
  // which resource produced it. (Generic transport 404s legitimately use code 0; typed resource
  // errors must use their documented non-zero code, asserted per-row below.)
  const cases: Array<{ method: string; path: string; body?: unknown; status: number; code: number; headers?: Record<string, string> }> = [
    { method: "GET", path: `/guilds/${UNKNOWN}`, status: 404, code: 10004 },
    { method: "GET", path: `/channels/${UNKNOWN}`, status: 404, code: 10003 },
    { method: "GET", path: `/users/${UNKNOWN}`, status: 404, code: 10013 },
    { method: "GET", path: `/applications/${UNKNOWN}`, status: 404, code: 10002 },
  ];

  it("typed resource 404s carry the documented non-zero code and a message", async () => {
    const { app } = createDiscordTestApp();
    for (const t of cases) {
      const res = await app.request(api(t.path), { method: t.method, headers: t.headers ?? botHeaders(), body: t.body ? JSON.stringify(t.body) : undefined });
      expect(res.status, `${t.method} ${t.path}`).toBe(t.status);
      const body = await json<{ message?: unknown; code?: unknown }>(res);
      expect(typeof body.message, `${t.path} message`).toBe("string");
      expect(typeof body.code, `${t.path} code`).toBe("number");
      expect(body.code, `${t.path} code value`).toBe(t.code);
    }
  });

  it("missing/invalid auth yields a 401 envelope", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api(`/users/@me`));
    expect(res.status).toBe(401);
    const body = await json<{ message?: unknown; code?: unknown }>(res);
    expect(typeof body.message).toBe("string");
    expect(typeof body.code).toBe("number");
  });

  it("an invalid form body yields a 400 with code 50035 and an errors tree", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    // A username that is too long triggers Invalid Form Body.
    const res = await app.request(api(`/guilds/${ids.guild}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ afk_timeout: 7 }), // not one of the allowed values
    });
    expect(res.status).toBe(400);
    const body = await json<{ code?: unknown; errors?: unknown }>(res);
    expect(body.code).toBe(50035);
    expect(body.errors).toBeTypeOf("object");
  });
});

describe("invariant: create -> read-back returns an identical object", () => {
  it("a created role/channel/message/webhook is byte-identical on read-back", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);

    // Role: create, then find it in the roles list.
    const roleRes = await app.request(api(`/guilds/${ids.guild}/roles`), { method: "POST", headers: botHeaders(), body: JSON.stringify({ name: "rt-role" }) });
    const role = await json<{ id: string }>(roleRes);
    const roles = await json<Array<{ id: string }>>(await app.request(api(`/guilds/${ids.guild}/roles`), { headers: botHeaders() }));
    expect(roles.find((r) => r.id === role.id)).toEqual(role);

    // Channel: create, then GET it directly.
    const chRes = await app.request(api(`/guilds/${ids.guild}/channels`), { method: "POST", headers: botHeaders(), body: JSON.stringify({ name: "rt-chan", type: 0 }) });
    const ch = await json<{ id: string }>(chRes);
    const chGet = await json<{ id: string }>(await app.request(api(`/channels/${ch.id}`), { headers: botHeaders() }));
    expect(chGet).toEqual(ch);

    // Message: create, then GET it directly.
    const msgRes = await app.request(api(`/channels/${ids.general}/messages`), { method: "POST", headers: botHeaders(), body: JSON.stringify({ content: "round-trip" }) });
    const msg = await json<{ id: string }>(msgRes);
    const msgGet = await json<{ id: string }>(await app.request(api(`/channels/${ids.general}/messages/${msg.id}`), { headers: botHeaders() }));
    expect(msgGet).toEqual(msg);

    // Webhook: create, then GET it directly (the token GET omits `user`, so use the bot GET).
    const whRes = await app.request(api(`/channels/${ids.general}/webhooks`), { method: "POST", headers: botHeaders(), body: JSON.stringify({ name: "rt-hook" }) });
    const wh = await json<{ id: string }>(whRes);
    const whGet = await json<{ id: string }>(await app.request(api(`/webhooks/${wh.id}`), { headers: botHeaders() }));
    expect(whGet).toEqual(wh);
  });
});
