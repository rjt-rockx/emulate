/**
 * Spec suite for `developers/resources/sticker.mdx`.
 *
 * Encodes the page's documented expectations directly: the Sticker object and Sticker Item
 * shapes, the Sticker Types / Format Types enumerations, the Sticker Pack object, and every
 * endpoint (Get Sticker, List/Get Sticker Pack, List/Get/Create/Modify/Delete Guild Sticker)
 * with its response shape, status codes, error codes, and the Create Guild Sticker validation
 * rules (name 2-30, description empty-or-2-100, file -> format_type inference). Written from the
 * doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

/** POST a guild sticker as multipart/form-data with a synthesized file part. */
async function createSticker(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  guild: string,
  fields: { name?: string; description?: string; tags?: string; filename?: string; fileType?: string; fileBody?: string },
) {
  const form = new FormData();
  if (fields.name !== undefined) form.set("name", fields.name);
  if (fields.description !== undefined) form.set("description", fields.description);
  form.set("tags", fields.tags ?? "tag");
  const file = new File([fields.fileBody ?? "binary-bytes"], fields.filename ?? "sticker.png", {
    type: fields.fileType ?? "image/png",
  });
  form.set("file", file);
  const res = await app.request(api(`/guilds/${guild}/stickers`), {
    method: "POST",
    headers: { Authorization: "Bot test_bot_token" },
    body: form,
  });
  return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("sticker.mdx — Sticker object & types", () => {
  it("Create Guild Sticker returns a GUILD (type 2) sticker with all documented fields", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json: s } = await createSticker(app, guild, { name: "blob", description: "a blob", tags: "blobs" });
    expect(res.status).toBe(201);
    expect(typeof s.id).toBe("string");
    expect(s.name).toBe("blob");
    expect(s.description).toBe("a blob");
    expect(s.tags).toBe("blobs");
    expect(s.type).toBe(2); // GUILD
    expect(s.guild_id).toBe(guild);
    expect(s.available).toBe(true);
    // user is the uploader.
    expect((s.user as Record<string, unknown>).id).toBeDefined();
  });

  it("Sticker Types: GUILD = 2 for uploaded guild stickers", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: s } = await createSticker(app, guild, { name: "guildone" });
    expect(s.type).toBe(2);
  });

  it("Format Types are inferred from the uploaded file: PNG=1, APNG=2, GIF=4 (non-Lottie)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const png = await createSticker(app, guild, { name: "png-one", filename: "a.png", fileType: "image/png" });
    expect(png.json.format_type).toBe(1);
    const apng = await createSticker(app, guild, { name: "apng-one", filename: "a.apng", fileType: "image/apng" });
    expect(apng.json.format_type).toBe(2);
    const gif = await createSticker(app, guild, { name: "gif-one", filename: "a.gif", fileType: "image/gif" });
    expect(gif.json.format_type).toBe(4);
  });

  it("Lottie (format_type=3) requires VERIFIED or PARTNERED guild feature (50035 otherwise)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const guild = guildId(store);
    // Regular guild (no features) — should reject Lottie.
    const reject = await createSticker(app, guild, { name: "lottie-fail", filename: "a.json", fileType: "application/json" });
    expect(reject.res.status).toBe(400);
    expect(reject.json.code).toBe(50035);
    // VERIFIED guild — should accept Lottie.
    const guildRow = ds.guilds.findOneBy("snowflake", guild)!;
    ds.guilds.update(guildRow.id, { features: ["VERIFIED"] } as Parameters<typeof ds.guilds.update>[1]);
    const accept = await createSticker(app, guild, { name: "lottie-ok", filename: "a.json", fileType: "application/json" });
    expect(accept.res.status).toBe(201);
    expect(accept.json.format_type).toBe(3);
  });
});

describe("sticker.mdx — Create Guild Sticker validation", () => {
  it("rejects a name shorter than 2 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "a" });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("rejects a name longer than 30 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "x".repeat(31) });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("accepts an empty description", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "emptydesc", description: "" });
    expect(res.status).toBe(201);
    expect(json.description).toBe("");
  });

  it("rejects a non-empty description shorter than 2 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "shortdesc", description: "x" });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("rejects a description longer than 100 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "longdesc", description: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("rejects a file that is not PNG/APNG/GIF/Lottie (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "badfile", filename: "a.txt", fileType: "text/plain" });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("rejects a file larger than 512 KiB (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const big = "x".repeat(512 * 1024 + 1);
    const { res, json } = await createSticker(app, guild, { name: "bigfile", fileBody: big });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("rejects tags longer than 200 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { res, json } = await createSticker(app, guild, { name: "longtags", tags: "x".repeat(201) });
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("requires a file field (50035 when absent)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    // Send JSON body (no file field) to test the requirement.
    const res = await app.request(api(`/guilds/${guild}/stickers`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "nofile", tags: "tag" }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(json.code).toBe(50035);
  });
});

describe("sticker.mdx — List/Get/Modify/Delete Guild Sticker", () => {
  it("List Guild Stickers returns the guild's stickers", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "listed" });
    const res = await app.request(api(`/guilds/${guild}/stickers`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = await json<Array<{ id: string }>>(res);
    expect(list.some((x) => x.id === created.id)).toBe(true);
  });

  it("Get Guild Sticker returns the sticker; 404 for an unknown id", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "getme" });
    const ok = await app.request(api(`/guilds/${guild}/stickers/${created.id}`), { headers: botHeaders() });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe(created.id);
    const missing = await app.request(api(`/guilds/${guild}/stickers/999999999999999999`), { headers: botHeaders() });
    expect(missing.status).toBe(404);
  });

  it("Modify Guild Sticker updates name/description/tags", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "before" });
    const res = await app.request(api(`/guilds/${guild}/stickers/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "after", description: "now described", tags: "newtags" }),
    });
    expect(res.status).toBe(200);
    const s = await json(res);
    expect(s.name).toBe("after");
    expect(s.description).toBe("now described");
    expect(s.tags).toBe("newtags");
  });

  it("Modify rejects an out-of-range name (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "valid" });
    const res = await app.request(api(`/guilds/${guild}/stickers/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "a" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Delete Guild Sticker returns 204 No Content and removes the sticker", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "deleteme" });
    const res = await app.request(api(`/guilds/${guild}/stickers/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).stickers.findOneBy("snowflake", created.id as string)).toBeUndefined();
  });
});

describe("sticker.mdx — Sticker Packs", () => {
  it("List Sticker Packs returns { sticker_packs: [...] } with the documented pack shape", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/sticker-packs"));
    expect(res.status).toBe(200);
    const body = await json<{ sticker_packs: Array<Record<string, unknown>> }>(res);
    expect(Array.isArray(body.sticker_packs)).toBe(true);
    expect(body.sticker_packs.length).toBeGreaterThan(0);
    const pack = body.sticker_packs[0];
    expect(typeof pack.id).toBe("string");
    expect(typeof pack.name).toBe("string");
    expect(typeof pack.sku_id).toBe("string");
    expect(typeof pack.description).toBe("string");
    // Packs include their stickers (array of sticker objects).
    expect(Array.isArray(pack.stickers)).toBe(true);
    expect((pack.stickers as unknown[]).length).toBeGreaterThan(0);
  });

  it("packed stickers are STANDARD (type 1) and carry pack_id + sort_value", async () => {
    const { app } = createDiscordTestApp();
    const body = (await (await app.request(api("/sticker-packs"))).json()) as {
      sticker_packs: Array<{ id: string; stickers: Array<Record<string, unknown>> }>;
    };
    const pack = body.sticker_packs[0];
    const sticker = pack.stickers[0];
    expect(sticker.type).toBe(1); // STANDARD
    expect(sticker.pack_id).toBe(pack.id);
    expect(typeof sticker.sort_value).toBe("number");
    // Format type is one of the documented values.
    expect([1, 2, 3, 4]).toContain(sticker.format_type);
  });

  it("Get Sticker Pack returns a single pack by id; 404 for unknown", async () => {
    const { app } = createDiscordTestApp();
    const list = (await (await app.request(api("/sticker-packs"))).json()) as { sticker_packs: Array<{ id: string }> };
    const id = list.sticker_packs[0].id;
    const res = await app.request(api(`/sticker-packs/${id}`));
    expect(res.status).toBe(200);
    expect((await json<{ id: string }>(res)).id).toBe(id);
    const missing = await app.request(api("/sticker-packs/999999999999999999"));
    expect(missing.status).toBe(404);
  });

  it("cover_sticker_id, when present, references a sticker in the pack", async () => {
    const { app } = createDiscordTestApp();
    const list = (await (await app.request(api("/sticker-packs"))).json()) as {
      sticker_packs: Array<{ stickers: Array<{ id: string }>; cover_sticker_id?: string }>;
    };
    const pack = list.sticker_packs.find((p) => p.cover_sticker_id);
    if (pack) {
      expect(pack.stickers.some((s) => s.id === pack.cover_sticker_id)).toBe(true);
    }
  });
});

describe("sticker.mdx — Get Sticker", () => {
  it("resolves a guild sticker by id", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "globalget" });
    const res = await app.request(api(`/stickers/${created.id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect((await json<{ id: string }>(res)).id).toBe(created.id);
  });

  it("resolves a standard pack sticker by id (packs include their cover stickers)", async () => {
    const { app } = createDiscordTestApp();
    const list = (await (await app.request(api("/sticker-packs"))).json()) as {
      sticker_packs: Array<{ stickers: Array<{ id: string; type: number }> }>;
    };
    const standard = list.sticker_packs[0].stickers[0];
    const res = await app.request(api(`/stickers/${standard.id}`));
    expect(res.status).toBe(200);
    const s = await json<{ id: string; type: number }>(res);
    expect(s.id).toBe(standard.id);
    expect(s.type).toBe(1);
  });

  it("Get Sticker for an unknown id returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/stickers/999999999999999999"));
    expect(res.status).toBe(404);
  });
});

describe("sticker.mdx — Sticker Item shape via messages", () => {
  it("a message sticker item carries only id, name and format_type", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "itemized", filename: "a.gif", fileType: "image/gif" });
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!.snowflake;
    const msg = await app.request(api(`/channels/${channel}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sticker_ids: [created.id] }),
    });
    const m = (await msg.json()) as { sticker_items: Array<Record<string, unknown>> };
    const item = m.sticker_items[0];
    expect(item.id).toBe(created.id);
    expect(item.name).toBe("itemized");
    expect(item.format_type).toBe(4);
    expect(Object.keys(item).sort()).toEqual(["format_type", "id", "name"]);
  });
});

describe("sticker.mdx — auth", () => {
  it("Create Guild Sticker requires a bot token", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const form = new FormData();
    form.set("name", "noauth");
    form.set("file", new File(["x"], "a.png", { type: "image/png" }));
    const res = await app.request(api(`/guilds/${guild}/stickers`), { method: "POST", body: form });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// S1: Permission-gated user field
// ---------------------------------------------------------------------------
describe("sticker.mdx — S1: user field is gated on expression permissions", () => {
  it("omits user field when enforcement is on and caller lacks expression permissions", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const guild = guildId(store);
    // Create a sticker to test with (before stripping permissions).
    const { json: created } = await createSticker(app, guild, { name: "perm-test" });
    // Strip CreateGuildExpressions from the @everyone role so the bot has no expression perms.
    // @everyone role has snowflake == guild snowflake.
    const everyoneRole = ds.roles.findOneBy("snowflake", guild)!;
    const perm = BigInt(everyoneRole.permissions ?? "0");
    const CREATE_GUILD_EXPRESSIONS = 1n << 43n;
    const MANAGE_GUILD_EXPRESSIONS = 1n << 30n;
    const stripped = perm & ~CREATE_GUILD_EXPRESSIONS & ~MANAGE_GUILD_EXPRESSIONS;
    ds.roles.update(everyoneRole.id, { permissions: String(stripped) });
    // Enable permission enforcement.
    store.setData("discord.enforce_permissions", true);
    const res = await app.request(api(`/guilds/${guild}/stickers/${created.id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const s = await res.json() as Record<string, unknown>;
    // Without the permission, user field should be absent.
    expect("user" in s).toBe(false);
    // Cleanup.
    store.setData("discord.enforce_permissions", false);
  });

  it("includes user field when enforcement is off (lenient default)", async () => {
    const { app, store } = createDiscordTestApp();
    const guild = guildId(store);
    const { json: created } = await createSticker(app, guild, { name: "user-present" });
    const res = await app.request(api(`/guilds/${guild}/stickers/${created.id}`), { headers: botHeaders() });
    const s = await res.json() as Record<string, unknown>;
    expect((s.user as Record<string, unknown>).id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// S3: Per-guild sticker slot cap
// ---------------------------------------------------------------------------
describe("sticker.mdx — S3: per-guild sticker slot cap", () => {
  it("returns 30039 when guild sticker slots are exhausted", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const guild = guildId(store);
    // Tier 0 guilds have 5 free slots. Fill them.
    for (let i = 0; i < 5; i++) {
      const { res } = await createSticker(app, guild, { name: `slot-${i}` });
      expect(res.status).toBe(201);
    }
    // 6th sticker should exceed the cap.
    const { res, json: body } = await createSticker(app, guild, { name: "overflow" });
    expect(res.status).toBe(400);
    expect(body.code).toBe(30039);
    void ds;
  });
});
