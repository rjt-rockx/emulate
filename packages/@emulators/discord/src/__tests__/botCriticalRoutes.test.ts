import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    bot: ds.users.findOneBy("username", "emulate-bot")!.snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    general: ds.channels.findOneBy("name", "general")!.snowflake,
    random: ds.channels.findOneBy("name", "random")!.snowflake,
  };
}

async function createRole(app: ReturnType<typeof createDiscordTestApp>["app"], guild: string, name: string): Promise<string> {
  const res = await app.request(api(`/guilds/${guild}/roles`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe("member + role management", () => {
  it("adds and removes a single role on a member", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const roleId = await createRole(app, guild, "VIP");

    const add = await app.request(api(`/guilds/${guild}/members/${bot}/roles/${roleId}`), { method: "PUT", headers: botHeaders() });
    expect(add.status).toBe(204);
    let member = (await (await app.request(api(`/guilds/${guild}/members/${bot}`), { headers: botHeaders() })).json()) as { roles: string[] };
    expect(member.roles).toContain(roleId);

    const remove = await app.request(api(`/guilds/${guild}/members/${bot}/roles/${roleId}`), { method: "DELETE", headers: botHeaders() });
    expect(remove.status).toBe(204);
    member = (await (await app.request(api(`/guilds/${guild}/members/${bot}`), { headers: botHeaders() })).json()) as { roles: string[] };
    expect(member.roles).not.toContain(roleId);
  });

  it("edits the current member's nick", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/members/@me`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ nick: "Botster" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { nick: string }).nick).toBe("Botster");
    const member = (await (await app.request(api(`/guilds/${guild}/members/${bot}`), { headers: botHeaders() })).json()) as { nick: string };
    expect(member.nick).toBe("Botster");
  });

  it("searches members by username prefix", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/members/search?query=emul&limit=10`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ user: { username: string } }>;
    expect(members.some((m) => m.user.username === "emulate-bot")).toBe(true);
  });

  it("gets a single role, reorders, and counts members", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const roleId = await createRole(app, guild, "Staff");
    await app.request(api(`/guilds/${guild}/members/${bot}/roles/${roleId}`), { method: "PUT", headers: botHeaders() });

    const single = await app.request(api(`/guilds/${guild}/roles/${roleId}`), { headers: botHeaders() });
    expect(((await single.json()) as { id: string }).id).toBe(roleId);

    const reorder = await app.request(api(`/guilds/${guild}/roles`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify([{ id: roleId, position: 3 }]),
    });
    expect(reorder.status).toBe(200);
    expect(getDiscordStore(store).roles.findOneBy("snowflake", roleId)!.position).toBe(3);

    const counts = (await (await app.request(api(`/guilds/${guild}/roles/member-counts`), { headers: botHeaders() })).json()) as Record<string, number>;
    expect(counts[roleId]).toBe(1);
  });

  it("returns a guild preview", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/preview`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as { id: string; approximate_member_count: number };
    expect(preview.id).toBe(guild);
    expect(preview.approximate_member_count).toBeGreaterThanOrEqual(1);
  });

  it("bulk-bans users", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/bulk-ban`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ user_ids: [developer] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { banned_users: string[] }).banned_users).toContain(developer);
    const bans = (await (await app.request(api(`/guilds/${guild}/bans`), { headers: botHeaders() })).json()) as Array<{ user: { id: string } }>;
    expect(bans.some((b) => b.user.id === developer)).toBe(true);
  });

  it("attaches the X-Audit-Log-Reason header to bans and the audit log", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/bans/${developer}`), {
      method: "PUT",
      headers: { ...botHeaders(), "X-Audit-Log-Reason": "spamming%20links" },
      body: "{}",
    });
    expect(res.status).toBe(204);
    // The ban record and the audit entry both carry the decoded reason.
    const ban = getDiscordStore(store).bans.findBy("guild_snowflake", guild).find((b) => b.user_snowflake === developer)!;
    expect(ban.reason).toBe("spamming links");
    const log = (await (await app.request(api(`/guilds/${guild}/audit-logs?action_type=22`), { headers: botHeaders() })).json()) as { audit_log_entries: Array<{ reason?: string }> };
    expect(log.audit_log_entries[0]?.reason).toBe("spamming links");
  });

  it("gets the current member then leaves the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const before = await app.request(api(`/users/@me/guilds/${guild}/member`), { headers: botHeaders() });
    expect(before.status).toBe(200);

    const leave = await app.request(api(`/users/@me/guilds/${guild}`), { method: "DELETE", headers: botHeaders() });
    expect(leave.status).toBe(204);
    expect(getDiscordStore(store).members.findBy("guild_snowflake", guild).some((m) => m.user_snowflake === bot)).toBe(false);
  });
});

describe("channel permissions, crosspost, follow, pins, recipients", () => {
  it("upserts and deletes a permission overwrite", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, bot } = ids(store);
    const put = await app.request(api(`/channels/${general}/permissions/${bot}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ type: 1, allow: "1024", deny: "0" }),
    });
    expect(put.status).toBe(204);
    const afterPut = (await (await app.request(api(`/channels/${general}`), { headers: botHeaders() })).json()) as { permission_overwrites: Array<{ id: string; allow: string }> };
    expect(afterPut.permission_overwrites.find((o) => o.id === bot)?.allow).toBe("1024");

    const del = await app.request(api(`/channels/${general}/permissions/${bot}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    const afterDel = (await (await app.request(api(`/channels/${general}`), { headers: botHeaders() })).json()) as { permission_overwrites: Array<{ id: string }> };
    expect(afterDel.permission_overwrites.some((o) => o.id === bot)).toBe(false);
  });

  it("crossposts a message (sets the CROSSPOSTED flag)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const msg = (await (await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "announce" }),
    })).json()) as { id: string };
    const res = await app.request(api(`/channels/${general}/messages/${msg.id}/crosspost`), { method: "POST", headers: botHeaders() });
    expect(res.status).toBe(200);
    // CROSSPOSTED is message flag 1 << 0 per discord-api-types.
    expect(((await res.json()) as { flags: number }).flags & 1).toBe(1);
  });

  it("follows an announcement channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, random } = ids(store);
    const res = await app.request(api(`/channels/${general}/followers`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ webhook_channel_id: random }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_id: string; webhook_id: string };
    expect(body.channel_id).toBe(general);
    expect(body.webhook_id).toBeTruthy();
  });

  it("pins and unpins via the current pins API", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const msg = (await (await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "pin me" }),
    })).json()) as { id: string };

    const pin = await app.request(api(`/channels/${general}/messages/pins/${msg.id}`), { method: "PUT", headers: botHeaders() });
    expect(pin.status).toBe(204);
    let pins = (await (await app.request(api(`/channels/${general}/messages/pins`), { headers: botHeaders() })).json()) as { items: Array<{ message: { id: string } }> };
    expect(pins.items.some((p) => p.message.id === msg.id)).toBe(true);

    const unpin = await app.request(api(`/channels/${general}/messages/pins/${msg.id}`), { method: "DELETE", headers: botHeaders() });
    expect(unpin.status).toBe(204);
    pins = (await (await app.request(api(`/channels/${general}/messages/pins`), { headers: botHeaders() })).json()) as { items: Array<{ message: { id: string } }> };
    expect(pins.items.some((p) => p.message.id === msg.id)).toBe(false);
  });

  it("adds a group-DM recipient and sets voice status", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ids(store);
    const add = await app.request(api(`/channels/${general}/recipients/${developer}`), { method: "PUT", headers: botHeaders() });
    expect(add.status).toBe(204);
    expect(getDiscordStore(store).channels.findOneBy("snowflake", general)!.recipient_snowflakes).toContain(developer);

    const status = await app.request(api(`/channels/${general}/voice-status`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ status: "Movie night" }),
    });
    expect(status.status).toBe(204);
    expect(store.getData(`discord.voice_status.${general}`)).toBe("Movie night");
  });
});
