import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("roles — full surface and parity", () => {
  it("round-trips every documented create field (name/color/hoist/mentionable/permissions/unicode_emoji)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        name: "Moderator",
        color: 0x5865f2,
        hoist: true,
        mentionable: true,
        permissions: "8",
        unicode_emoji: "🛡️",
      }),
    });
    expect(res.status).toBe(200);
    const role = (await res.json()) as Record<string, unknown>;
    expect(role.name).toBe("Moderator");
    expect(role.color).toBe(0x5865f2);
    expect(role.hoist).toBe(true);
    expect(role.mentionable).toBe(true);
    expect(role.permissions).toBe("8");
    expect(role.unicode_emoji).toBe("🛡️");
    // Always-present documented fields.
    expect(role.flags).toBe(0);
    expect(role.managed).toBe(false);
    expect(typeof role.position).toBe("number");
    expect(typeof role.id).toBe("string");
  });

  it("permissions is always serialized as a decimal string, never a number", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x", permissions: 274877906944 }),
    });
    const role = (await res.json()) as Record<string, unknown>;
    expect(typeof role.permissions).toBe("string");
    expect(role.permissions).toBe("274877906944");
  });

  it("rejects a role name longer than 100 chars with 50035 and a .name field error", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "a".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: number; errors?: { name?: unknown } };
    expect(body.code).toBe(50035);
    expect(body.errors?.name).toBeDefined();
  });

  it("rejects an out-of-range color with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x", color: 0x1000000 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("enforces the 250-role cap with code 30005", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const gid = guildId(store);
    // The guild already has @everyone; pad to the cap directly via the store, then POST one more.
    while (ds.roles.findBy("guild_snowflake", gid).length < 250) {
      ds.roles.insert({
        snowflake: `${Math.random()}`,
        guild_snowflake: gid,
        name: "filler",
        color: 0,
        hoist: false,
        position: 1,
        permissions: "0",
        managed: false,
        mentionable: false,
        icon: null,
      });
    }
    const res = await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "one too many" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(30005);
  });

  it("PATCH round-trips the colors object (primary/secondary/tertiary colors)", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const created = await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Gradient" }),
    });
    const role = (await created.json()) as { id: string };
    const colorsPayload = { primary_color: 0xff0000, secondary_color: 0x00ff00, tertiary_color: null };
    const res = await app.request(api(`/guilds/${gid}/roles/${role.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ colors: colorsPayload }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    // The serializer emits `colors` on the role object.
    expect(updated.colors).toBeDefined();
    const colors = updated.colors as { primary_color: number; secondary_color: number | null; tertiary_color: number | null };
    expect(colors.primary_color).toBe(0xff0000);
    expect(colors.secondary_color).toBe(0x00ff00);
    expect(colors.tertiary_color).toBeNull();
    // Verify persistence via a follow-up GET.
    const getRes = await app.request(api(`/guilds/${gid}/roles/${role.id}`), { headers: botHeaders() });
    const fetched = (await getRes.json()) as Record<string, unknown>;
    const fetchedColors = fetched.colors as { primary_color: number; secondary_color: number | null };
    expect(fetchedColors.primary_color).toBe(0xff0000);
    expect(fetchedColors.secondary_color).toBe(0x00ff00);
  });

  it("PATCH updates unicode_emoji and flags (previously dropped)", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const created = await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Booster" }),
    });
    const role = (await created.json()) as { id: string };
    const res = await app.request(api(`/guilds/${gid}/roles/${role.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ unicode_emoji: "⭐", flags: 1 }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated.unicode_emoji).toBe("⭐");
    expect(updated.flags).toBe(1);
  });

  it("cannot delete the @everyone role (50028)", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const res = await app.request(api(`/guilds/${gid}/roles/${gid}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50028);
  });

  it("deleting a role strips it from every member that held it", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const gid = guildId(store);
    const created = await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Temp" }),
    });
    const role = (await created.json()) as { id: string };
    const member = ds.members.findBy("guild_snowflake", gid)[0];
    ds.members.update(member.id, { role_snowflakes: [role.id] });

    await app.request(api(`/guilds/${gid}/roles/${role.id}`), { method: "DELETE", headers: botHeaders() });
    const after = ds.members.findBy("guild_snowflake", gid).find((m) => m.user_snowflake === member.user_snowflake)!;
    expect(after.role_snowflakes).not.toContain(role.id);
  });

  it("404s for an unknown role with code 10011", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/roles/99999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ghost" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10011);
  });

  it("records a Role Create audit entry carrying the X-Audit-Log-Reason", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    await app.request(api(`/guilds/${gid}/roles`), {
      method: "POST",
      headers: { ...botHeaders(), "X-Audit-Log-Reason": "promoted staff" },
      body: JSON.stringify({ name: "Staff", permissions: "8" }),
    });
    const ds = getDiscordStore(store);
    const entry = ds.auditLog.findBy("guild_snowflake", gid).find((e) => e.action_type === 30);
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("promoted staff");
    // The create change set carries more than just the name.
    const keys = (entry!.changes as Array<{ key: string }>).map((ch) => ch.key);
    expect(keys).toContain("permissions");
  });
});

describe("roles — hierarchy enforcement (opt-in)", () => {
  it("blocks assigning a role at/above the bot's highest role with 50013 when enforcement is on", async () => {
    const { app, store } = createDiscordTestApp({ enforce_permissions: true });
    const ds = getDiscordStore(store);
    const gid = guildId(store);
    const botUser = ds.applications.all()[0]!.bot_user_snowflake;
    // Give the bot a low role, and create a higher role it should not be able to grant.
    const botRole = ds.roles.insert({
      snowflake: `${Math.random()}`,
      guild_snowflake: gid,
      name: "bot-role",
      color: 0,
      hoist: false,
      position: 1,
      permissions: "268435456", // MANAGE_ROLES
      managed: false,
      mentionable: false,
      icon: null,
    });
    const high = ds.roles.insert({
      snowflake: `${Math.random()}`,
      guild_snowflake: gid,
      name: "high-role",
      color: 0,
      hoist: false,
      position: 5,
      permissions: "0",
      managed: false,
      mentionable: false,
      icon: null,
    });
    const botMember = ds.members.findBy("guild_snowflake", gid).find((m) => m.user_snowflake === botUser)!;
    ds.members.update(botMember.id, { role_snowflakes: [botRole.snowflake] });
    // A target member to receive the high role.
    const target = ds.members.findBy("guild_snowflake", gid).find((m) => m.user_snowflake !== botUser)!;

    const res = await app.request(
      api(`/guilds/${gid}/members/${target.user_snowflake}/roles/${high.snowflake}`),
      { method: "PUT", headers: botHeaders() },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: number }).code).toBe(50013);
  });
});
