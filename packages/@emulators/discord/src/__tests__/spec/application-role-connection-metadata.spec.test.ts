/**
 * Spec suite for `developers/resources/application-role-connection-metadata.mdx`.
 *
 * Encodes the page's documented expectations directly: the Application Role Connection
 * Metadata object shape, the full metadata-type enum (1-8), and the Get/Update records
 * endpoints with their validation rules (type enum, key regex+length, name/description
 * length, max 5 records) producing 50035. Written from the doc first; the implementation is
 * built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).applications.all()[0]!.snowflake;
}

const record = (over: Record<string, unknown> = {}) => ({
  type: 2,
  key: "level",
  name: "Level",
  description: "Account level",
  ...over,
});

async function put(
  ctx: ReturnType<typeof createDiscordTestApp>,
  body: unknown,
  aid = appId(ctx.store),
): Promise<Response> {
  return ctx.app.request(api(`/applications/${aid}/role-connections/metadata`), {
    method: "PUT",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
}

async function get(ctx: ReturnType<typeof createDiscordTestApp>, aid = appId(ctx.store)): Promise<Response> {
  return ctx.app.request(api(`/applications/${aid}/role-connections/metadata`), { headers: botHeaders() });
}

describe("application-role-connection-metadata.mdx — Metadata Type enum", () => {
  // The full documented value mapping. Each must be accepted on PUT and rejected outside 1-8.
  const TYPES: Record<string, number> = {
    INTEGER_LESS_THAN_OR_EQUAL: 1,
    INTEGER_GREATER_THAN_OR_EQUAL: 2,
    INTEGER_EQUAL: 3,
    INTEGER_NOT_EQUAL: 4,
    DATETIME_LESS_THAN_OR_EQUAL: 5,
    DATETIME_GREATER_THAN_OR_EQUAL: 6,
    BOOLEAN_EQUAL: 7,
    BOOLEAN_NOT_EQUAL: 8,
  };

  it("documents the full 1..8 value mapping with BOOLEAN_NOT_EQUAL last", () => {
    expect(TYPES.INTEGER_LESS_THAN_OR_EQUAL).toBe(1);
    expect(TYPES.BOOLEAN_EQUAL).toBe(7);
    expect(TYPES.BOOLEAN_NOT_EQUAL).toBe(8);
    expect(Object.values(TYPES)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("accepts every documented type value (1-8)", async () => {
    for (const value of Object.values(TYPES)) {
      const ctx = createDiscordTestApp();
      const res = await put(ctx, [record({ type: value, key: `k${value}` })]);
      expect(res.status).toBe(200);
      const got = (await res.json()) as Array<{ type: number }>;
      expect(got[0].type).toBe(value);
    }
  });

  it("rejects a type below 1 with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ type: 0 })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a type above 8 with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ type: 9 })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });
});

describe("application-role-connection-metadata.mdx — Get records", () => {
  it("returns a list (array) of metadata objects", async () => {
    const ctx = createDiscordTestApp();
    expect((await put(ctx, [record()])).status).toBe(200);
    const res = await get(ctx);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list[0].key).toBe("level");
    // Documented object fields.
    expect(typeof list[0].type).toBe("number");
    expect(typeof list[0].name).toBe("string");
    expect(typeof list[0].description).toBe("string");
  });

  it("is empty for a fresh application", async () => {
    const ctx = createDiscordTestApp();
    const list = (await (await get(ctx)).json()) as unknown[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });
});

describe("application-role-connection-metadata.mdx — Update records", () => {
  it("updates and returns the list", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ key: "wins", name: "Wins", description: "Total wins" })]);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ key: string }>;
    expect(list.map((m) => m.key)).toContain("wins");
    // The update is persisted and visible on a subsequent GET.
    const after = (await (await get(ctx)).json()) as Array<{ key: string }>;
    expect(after.map((m) => m.key)).toContain("wins");
  });

  it("accepts up to 5 metadata records", async () => {
    const ctx = createDiscordTestApp();
    const five = [1, 2, 3, 4, 5].map((n) => record({ key: `k${n}`, type: n }));
    const res = await put(ctx, five);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(5);
  });

  it("rejects more than 5 records with 50035", async () => {
    const ctx = createDiscordTestApp();
    const six = [1, 2, 3, 4, 5, 6].map((n) => record({ key: `k${n}`, type: ((n - 1) % 8) + 1 }));
    const res = await put(ctx, six);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });
});

describe("application-role-connection-metadata.mdx — key validation", () => {
  it("accepts a key of a-z, 0-9 and _ characters", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ key: "score_2024" })]);
    expect(res.status).toBe(200);
  });

  it("rejects an uppercase / illegal-character key with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ key: "Level!" })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects an empty key with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ key: "" })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a key longer than 50 characters with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ key: "a".repeat(51) })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("accepts a 50-character key", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ key: "a".repeat(50) })]);
    expect(res.status).toBe(200);
  });
});

describe("application-role-connection-metadata.mdx — name validation", () => {
  it("rejects an empty name with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ name: "" })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a name longer than 100 characters with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ name: "n".repeat(101) })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("accepts a 100-character name", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ name: "n".repeat(100) })]);
    expect(res.status).toBe(200);
  });
});

describe("application-role-connection-metadata.mdx — description validation", () => {
  it("rejects an empty description with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ description: "" })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a description longer than 200 characters with 50035", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ description: "d".repeat(201) })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("accepts a 200-character description", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [record({ description: "d".repeat(200) })]);
    expect(res.status).toBe(200);
  });
});

describe("application-role-connection-metadata.mdx — optional localizations", () => {
  it("round-trips name_localizations and description_localizations", async () => {
    const ctx = createDiscordTestApp();
    const res = await put(ctx, [
      record({ name_localizations: { "en-US": "Level" }, description_localizations: { "en-US": "Account level" } }),
    ]);
    expect(res.status).toBe(200);
    const got = (await res.json()) as Array<Record<string, unknown>>;
    expect((got[0].name_localizations as Record<string, string>)["en-US"]).toBe("Level");
    expect((got[0].description_localizations as Record<string, string>)["en-US"]).toBe("Account level");
  });
});
