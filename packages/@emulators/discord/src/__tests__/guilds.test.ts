import { describe, it, expect, beforeEach } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import type { DiscordTestApp } from "./helpers.js";

describe("guilds routes", () => {
  let testApp: DiscordTestApp;

  beforeEach(() => {
    testApp = createDiscordTestApp();
  });

  function guildId(): string {
    const ds = getDiscordStore(testApp.store);
    const guild = ds.guilds.findOneBy("name", "Emulate Server");
    if (!guild) throw new Error("Seeded guild not found");
    return guild.snowflake;
  }

  function developerUserId(): string {
    const ds = getDiscordStore(testApp.store);
    const user = ds.users.findOneBy("username", "developer");
    if (!user) throw new Error("Seeded developer user not found");
    return user.snowflake;
  }

  // -------------------------------------------------------------------------
  // GET guild
  // -------------------------------------------------------------------------

  it("GET /guilds/:guildId returns the guild with roles including @everyone", async () => {
    const id = guildId();
    const res = await testApp.app.request(api(`/guilds/${id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.name).toBe("Emulate Server");
    const roles = body.roles as Array<Record<string, unknown>>;
    expect(Array.isArray(roles)).toBe(true);
    const everyone = roles.find((r) => r.name === "@everyone");
    expect(everyone).toBeDefined();
    expect(typeof everyone!.id).toBe("string");
  });

  it("GET /guilds/:guildId returns 404 for unknown guild", async () => {
    const res = await testApp.app.request(api("/guilds/000000000000000000"), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });

  it("GET /guilds/:guildId?with_counts=true includes member counts", async () => {
    const id = guildId();
    const res = await testApp.app.request(api(`/guilds/${id}?with_counts=true`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.approximate_member_count).toBe("number");
  });

  // -------------------------------------------------------------------------
  // POST guild
  // -------------------------------------------------------------------------

  it("POST /guilds creates a new guild owned by the bot user", async () => {
    const res = await testApp.app.request(api("/guilds"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "My New Guild" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("My New Guild");
    expect(typeof body.id).toBe("string");
    // full serialization includes channels and members
    expect(Array.isArray(body.channels)).toBe(true);
    expect(Array.isArray(body.members)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PATCH guild
  // -------------------------------------------------------------------------

  it("PATCH /guilds/:guildId updates the guild name and returns updated guild", async () => {
    const id = guildId();
    const res = await testApp.app.request(api(`/guilds/${id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Renamed Server" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("Renamed Server");
    expect(body.id).toBe(id);

    // Confirm persistence.
    const ds = getDiscordStore(testApp.store);
    const guild = ds.guilds.findOneBy("snowflake", id);
    expect(guild?.name).toBe("Renamed Server");
  });

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  it("POST /guilds/:guildId/roles creates a role and GET /roles lists it", async () => {
    const id = guildId();

    // Create the role.
    const createRes = await testApp.app.request(api(`/guilds/${id}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Moderators", color: 0x3498db, permissions: "8" }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.name).toBe("Moderators");
    expect(typeof created.id).toBe("string");

    // List roles — should include @everyone and the new one.
    const listRes = await testApp.app.request(api(`/guilds/${id}/roles`), { headers: botHeaders() });
    expect(listRes.status).toBe(200);
    const roles = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(roles.some((r) => r.name === "Moderators")).toBe(true);
    expect(roles.some((r) => r.name === "@everyone")).toBe(true);
  });

  it("DELETE /guilds/:guildId/roles/:roleId returns 204 and removes the role", async () => {
    const id = guildId();

    // First create a role to delete.
    const createRes = await testApp.app.request(api(`/guilds/${id}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "TempRole" }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as Record<string, unknown>;
    const roleId = created.id as string;

    // Delete it.
    const delRes = await testApp.app.request(api(`/guilds/${id}/roles/${roleId}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(delRes.status).toBe(204);

    // Confirm it is gone.
    const ds = getDiscordStore(testApp.store);
    const role = ds.roles.findOneBy("snowflake", roleId);
    expect(role).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  it("PUT /guilds/:guildId/members/:userId adds the developer user as a member", async () => {
    const devId = developerUserId();

    // Developer is already seeded into the guild — addGuildMember returns null for existing.
    // Create a fresh guild to add the developer to cleanly.
    const newGuildRes = await testApp.app.request(api("/guilds"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Fresh Guild" }),
    });
    expect(newGuildRes.status).toBe(201);
    const newGuild = (await newGuildRes.json()) as Record<string, unknown>;
    const newGuildId = newGuild.id as string;

    const res = await testApp.app.request(api(`/guilds/${newGuildId}/members/${devId}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    // 201 when freshly added, 204 if already a member
    expect([201, 204]).toContain(res.status);

    // Verify the member now exists in the store.
    const ds = getDiscordStore(testApp.store);
    const member = ds.members.findBy("guild_snowflake", newGuildId).find((m) => m.user_snowflake === devId);
    expect(member).toBeDefined();
  });

  it("GET /guilds/:guildId/members lists members with user objects", async () => {
    const id = guildId();
    const res = await testApp.app.request(api(`/guilds/${id}/members`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<Record<string, unknown>>;
    expect(members.length).toBeGreaterThan(0);
    const first = members[0];
    expect(first).toHaveProperty("roles");
    expect(first).toHaveProperty("joined_at");
    // Serializer includes user by default.
    expect(first.user).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Emojis
  // -------------------------------------------------------------------------

  it("POST /guilds/:guildId/emojis creates an emoji and GET /emojis lists it", async () => {
    const id = guildId();

    const createRes = await testApp.app.request(api(`/guilds/${id}/emojis`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "thumbsup", animated: false, image: "data:image/png;base64,AAAA" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.name).toBe("thumbsup");
    expect(typeof created.id).toBe("string");

    const listRes = await testApp.app.request(api(`/guilds/${id}/emojis`), { headers: botHeaders() });
    expect(listRes.status).toBe(200);
    const emojis = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(emojis.some((e) => e.name === "thumbsup")).toBe(true);
  });
});
