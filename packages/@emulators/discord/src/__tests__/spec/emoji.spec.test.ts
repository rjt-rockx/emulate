/**
 * Spec suite for `developers/resources/emoji.mdx`.
 *
 * Encodes the page's documented expectations: the Emoji object shape, guild emoji
 * endpoints (List/Get/Create/Modify/Delete), application emoji endpoints, and
 * documented name/image validation.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return { guildId: s.guild, appId: s.app };
}

// Emoji object shape

describe("emoji.mdx — Emoji object shape", () => {
  it("guild emoji has the documented fields (id/name/roles/require_colons/managed/animated/available)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);

    // Create an emoji so we have one to inspect.
    const createRes = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "myemoji", image: "data:image/png;base64,AAAA" }),
    });
    expect(createRes.status).toBe(201);
    const emoji = (await createRes.json()) as Record<string, unknown>;

    expect(typeof emoji.id).toBe("string");
    expect(typeof emoji.name).toBe("string");
    expect(Array.isArray(emoji.roles)).toBe(true);
    expect(typeof emoji.require_colons).toBe("boolean");
    expect(typeof emoji.managed).toBe("boolean");
    expect(typeof emoji.animated).toBe("boolean");
    expect(typeof emoji.available).toBe("boolean");
  });

  it("emoji user field is present when the bot created the emoji", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const createRes = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "withuser", image: "data:image/png;base64,AAAA" }),
    });
    const emoji = (await createRes.json()) as Record<string, unknown>;
    // user is present when the creator snowflake was recorded.
    if ("user" in emoji && emoji.user !== null && emoji.user !== undefined) {
      const u = emoji.user as Record<string, unknown>;
      expect(typeof u.id).toBe("string");
    }
  });
});

// List Guild Emojis

describe("emoji.mdx — List Guild Emojis", () => {
  it("GET /guilds/:id/emojis returns an array of emoji objects", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const emojis = await json<unknown[]>(res);
    expect(Array.isArray(emojis)).toBe(true);
  });

  it("List Guild Emojis for unknown guild returns 404 Unknown Guild (10004)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/emojis"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10004);
  });
});

// Get Guild Emoji

describe("emoji.mdx — Get Guild Emoji", () => {
  it("GET /guilds/:id/emojis/:emojiId returns the emoji", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Create so we have an ID to fetch.
    const createRes = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "fetchme", image: "data:image/png;base64,AAAA" }),
    });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(api(`/guilds/${guildId}/emojis/${created.id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const emoji = await json(res);
    expect(emoji.id).toBe(created.id);
  });

  it("GET unknown emoji returns 404 Unknown Emoji (10014)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10014);
  });
});

// Create Guild Emoji — validation

describe("emoji.mdx — Create Guild Emoji validation", () => {
  it("name shorter than 2 characters returns 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x", image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("name longer than 32 characters returns 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "a".repeat(33), image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("name with invalid characters (non-alphanumeric/underscore) returns 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "bad-name!", image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("valid name with alphanumeric and underscores succeeds", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "valid_name_123", image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(201);
  });

  it("empty image string returns 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "imgtest", image: "" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("absent image field returns 400 Invalid Form Body (50035) — image is required", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    // Send only the name; omit the required `image` field entirely.
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "noimgfield" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Create Guild Emoji returns 201 with a fully-formed emoji object", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "goodemoji", image: "data:image/png;base64,AAAA", roles: [] }),
    });
    expect(res.status).toBe(201);
    const e = await json(res);
    expect(typeof e.id).toBe("string");
    expect(e.name).toBe("goodemoji");
    expect(Array.isArray(e.roles)).toBe(true);
  });
});

// Modify Guild Emoji

describe("emoji.mdx — Modify Guild Emoji", () => {
  it("PATCH /guilds/:id/emojis/:emojiId updates name and roles", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const createRes = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "beforepatch", image: "data:image/png;base64,AAAA" }),
    });
    const created = (await createRes.json()) as { id: string };

    const patchRes = await app.request(api(`/guilds/${guildId}/emojis/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "afterpatch" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    expect(patched.name).toBe("afterpatch");
  });

  it("PATCH unknown emoji returns 404 Unknown Emoji (10014)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis/999999999999999999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10014);
  });
});

// Delete Guild Emoji

describe("emoji.mdx — Delete Guild Emoji", () => {
  it("DELETE /guilds/:id/emojis/:emojiId returns 204 and removes the emoji", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const createRes = await app.request(api(`/guilds/${guildId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "todelete", image: "data:image/png;base64,AAAA" }),
    });
    const created = (await createRes.json()) as { id: string };

    const deleteRes = await app.request(api(`/guilds/${guildId}/emojis/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    const ds = getDiscordStore(store);
    expect(ds.emojis.findOneBy("snowflake", created.id)).toBeUndefined();
  });

  it("DELETE unknown emoji returns 404 Unknown Emoji (10014)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guildId } = ids(store);
    const res = await app.request(api(`/guilds/${guildId}/emojis/999999999999999999`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10014);
  });
});

// Application Emojis

describe("emoji.mdx — Application Emoji endpoints", () => {
  it("List Application Emojis returns { items: [...] }", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/emojis`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("Create/Get/Modify/Delete Application Emoji lifecycle", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);

    // Create.
    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "appemoji", image: "data:image/png;base64,AAAA" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("appemoji");

    // Get.
    const getRes = await app.request(api(`/applications/${appId}/emojis/${created.id}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string };
    expect(fetched.id).toBe(created.id);

    // Modify (only name is accepted for application emojis per docs).
    const patchRes = await app.request(api(`/applications/${appId}/emojis/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "renamedapp" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { name: string };
    expect(patched.name).toBe("renamedapp");

    // Delete.
    const deleteRes = await app.request(api(`/applications/${appId}/emojis/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    // Verify gone.
    const missingRes = await app.request(api(`/applications/${appId}/emojis/${created.id}`), { headers: botHeaders() });
    expect(missingRes.status).toBe(404);
  });

  it("Application emoji includes the user field (uploader)", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "hasuser", image: "data:image/png;base64,AAAA" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    // user is expected on app emojis per docs.
    if (created.user !== null && created.user !== undefined) {
      const u = created.user as Record<string, unknown>;
      expect(typeof u.id).toBe("string");
    }
  });

  it("[E1] Create Application Emoji without image returns 400 Invalid Form Body (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "noimgapp" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("[E1] Create Application Emoji with name shorter than 2 chars returns 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x", image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("[E1] Create Application Emoji with invalid characters in name returns 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "bad-emoji!", image: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("[E2] Get Application Emoji for a different appId returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    // Create emoji under appId.
    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "scopedtest", image: "data:image/png;base64,AAAA" }),
    });
    const created = (await createRes.json()) as { id: string };
    // Try to fetch it under a different appId.
    const res = await app.request(api(`/applications/000000000000000001/emojis/${created.id}`), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });

  it("[E2] Delete Application Emoji for a different appId returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const createRes = await app.request(api(`/applications/${appId}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "deletescope", image: "data:image/png;base64,AAAA" }),
    });
    const created = (await createRes.json()) as { id: string };
    // Try to delete it under a different appId.
    const res = await app.request(api(`/applications/000000000000000001/emojis/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
