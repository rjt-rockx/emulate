import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  return seededIds(store);
}

async function createRole(app: ReturnType<typeof createDiscordTestApp>["app"], guild: string, name: string): Promise<string> {
  const res = await app.request(api(`/guilds/${guild}/roles`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ name }),
  });
  return (await json<{ id: string }>(res)).id;
}

describe("member + role management", () => {
  it("adds and removes a single role on a member", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const roleId = await createRole(app, guild, "VIP");

    const add = await app.request(api(`/guilds/${guild}/members/${bot}/roles/${roleId}`), { method: "PUT", headers: botHeaders() });
    expect(add.status).toBe(204);
    let member = await json<{ roles: string[] }>(await app.request(api(`/guilds/${guild}/members/${bot}`), { headers: botHeaders() }));
    expect(member.roles).toContain(roleId);

    const remove = await app.request(api(`/guilds/${guild}/members/${bot}/roles/${roleId}`), { method: "DELETE", headers: botHeaders() });
    expect(remove.status).toBe(204);
    member = await json<{ roles: string[] }>(await app.request(api(`/guilds/${guild}/members/${bot}`), { headers: botHeaders() }));
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
    expect((await json<{ nick: string }>(res)).nick).toBe("Botster");
    const member = await json<{ nick: string }>(await app.request(api(`/guilds/${guild}/members/${bot}`), { headers: botHeaders() }));
    expect(member.nick).toBe("Botster");
  });

  it("searches members by username prefix", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/members/search?query=emul&limit=10`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const members = await json<Array<{ user: { username: string } }>>(res);
    expect(members.some((m) => m.user.username === "emulate-bot")).toBe(true);
  });

  it("gets a single role, reorders, and counts members", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const roleId = await createRole(app, guild, "Staff");
    await app.request(api(`/guilds/${guild}/members/${bot}/roles/${roleId}`), { method: "PUT", headers: botHeaders() });

    const single = await app.request(api(`/guilds/${guild}/roles/${roleId}`), { headers: botHeaders() });
    expect((await json<{ id: string }>(single)).id).toBe(roleId);

    const reorder = await app.request(api(`/guilds/${guild}/roles`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify([{ id: roleId, position: 3 }]),
    });
    expect(reorder.status).toBe(200);
    expect(getDiscordStore(store).roles.findOneBy("snowflake", roleId)!.position).toBe(3);

    const counts = await json<Record<string, number>>(await app.request(api(`/guilds/${guild}/roles/member-counts`), { headers: botHeaders() }));
    expect(counts[roleId]).toBe(1);
  });

  it("returns a guild preview", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/preview`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const preview = await json<{ id: string; approximate_member_count: number }>(res);
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
    expect((await json<{ banned_users: string[] }>(res)).banned_users).toContain(developer);
    const bans = await json<Array<{ user: { id: string } }>>(await app.request(api(`/guilds/${guild}/bans`), { headers: botHeaders() }));
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
    const log = await json<{ audit_log_entries: Array<{ reason?: string }> }>(await app.request(api(`/guilds/${guild}/audit-logs?action_type=22`), { headers: botHeaders() }));
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
    const afterPut = await json<{ permission_overwrites: Array<{ id: string; allow: string }> }>(await app.request(api(`/channels/${general}`), { headers: botHeaders() }));
    expect(afterPut.permission_overwrites.find((o) => o.id === bot)?.allow).toBe("1024");

    const del = await app.request(api(`/channels/${general}/permissions/${bot}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    const afterDel = await json<{ permission_overwrites: Array<{ id: string }> }>(await app.request(api(`/channels/${general}`), { headers: botHeaders() }));
    expect(afterDel.permission_overwrites.some((o) => o.id === bot)).toBe(false);
  });

  it("crossposts a message (sets the CROSSPOSTED flag)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const msg = await json<{ id: string }>(await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "announce" }),
    }));
    const res = await app.request(api(`/channels/${general}/messages/${msg.id}/crosspost`), { method: "POST", headers: botHeaders() });
    expect(res.status).toBe(200);
    // CROSSPOSTED is message flag 1 << 0 per discord-api-types.
    expect((await json<{ flags: number }>(res)).flags & 1).toBe(1);
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
    const body = await json<{ channel_id: string; webhook_id: string }>(res);
    expect(body.channel_id).toBe(general);
    expect(body.webhook_id).toBeTruthy();
  });

  it("pins and unpins via the current pins API", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const msg = await json<{ id: string }>(await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "pin me" }),
    }));

    const pin = await app.request(api(`/channels/${general}/messages/pins/${msg.id}`), { method: "PUT", headers: botHeaders() });
    expect(pin.status).toBe(204);
    let pins = await json<{ items: Array<{ message: { id: string } }> }>(await app.request(api(`/channels/${general}/messages/pins`), { headers: botHeaders() }));
    expect(pins.items.some((p) => p.message.id === msg.id)).toBe(true);

    const unpin = await app.request(api(`/channels/${general}/messages/pins/${msg.id}`), { method: "DELETE", headers: botHeaders() });
    expect(unpin.status).toBe(204);
    pins = await json<{ items: Array<{ message: { id: string } }> }>(await app.request(api(`/channels/${general}/messages/pins`), { headers: botHeaders() }));
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
