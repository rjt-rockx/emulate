/**
 * Spec suite for `developers/resources/lobby.mdx`.
 *
 * Encodes the page's documented expectations directly: the Lobby object, the Lobby Member
 * object (and the CanLinkLobby flag = 1<<0), the Lobby Message object, and every endpoint —
 * Create / Create-or-Join / Get / Modify / Delete lobby, add / bulk-update / remove members,
 * @me leave, channel-linking, send / get messages (membership-gated), moderation metadata,
 * and the channel-invite endpoints (membership + linked channel required). Written from the
 * doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, bearerHeaders, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { createUser, createToken } from "../../factories.js";

const CAN_LINK_LOBBY = 1 << 0;

function setup() {
  const ctx = createDiscordTestApp();
  const ds = getDiscordStore(ctx.store);
  const application = ds.applications.all()[0]!;
  const guild = ds.guilds.findOneBy("name", "Emulate Server")!;
  const textChannel = ds.channels.all().find((c) => c.type === 0 && c.guild_snowflake === guild.snowflake)!;
  // A non-member user with a Social-SDK bearer token (used to test membership gating).
  const outsider = createUser(ds, { username: "outsider", global_name: "Outsider" });
  createToken(ds, {
    token: "outsider_bearer",
    type: "bearer",
    userSnowflake: outsider.snowflake,
    applicationSnowflake: application.snowflake,
    scopes: ["sdk.social_layer"],
  });
  return {
    ...ctx,
    ds,
    application,
    guild: guild.snowflake,
    textChannel: textChannel.snowflake,
    outsider: outsider.snowflake,
  };
}

async function createLobby(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  body: Record<string, unknown> = {},
) {
  const res = await app.request(api("/lobbies"), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return { res, lobby: await json(res)};
}

describe("lobby.mdx — Lobby & Lobby Member object", () => {
  it("Create Lobby returns 201 with id/application_id/metadata/members", async () => {
    const { app, application } = setup();
    const { res, lobby } = await createLobby(app, { metadata: { topic: "we need more redstone" } });
    expect(res.status).toBe(201);
    expect(typeof lobby.id).toBe("string");
    expect(lobby.application_id).toBe(application.snowflake);
    expect((lobby.metadata as Record<string, string>).topic).toBe("we need more redstone");
    expect(Array.isArray(lobby.members)).toBe(true);
  });

  it("adds provided members with id/metadata/flags (lobby member shape)", async () => {
    const { app, ds } = setup();
    const u = createUser(ds, { username: "redstone-fan" });
    const { lobby } = await createLobby(app, {
      members: [{ id: u.snowflake, metadata: { role: "builder" }, flags: CAN_LINK_LOBBY }],
    });
    const members = lobby.members as Array<Record<string, unknown>>;
    const m = members.find((x) => x.id === u.snowflake);
    expect(m).toBeDefined();
    expect((m!.metadata as Record<string, string>).role).toBe("builder");
    expect(m!.flags).toBe(CAN_LINK_LOBBY);
  });

  it("CanLinkLobby flag has value 1<<0", () => {
    expect(CAN_LINK_LOBBY).toBe(1);
  });

  it("Get Lobby returns the lobby; unknown id returns 404", async () => {
    const { app } = setup();
    const { lobby } = await createLobby(app, { metadata: { mode: "casual" } });
    const ok = await app.request(api(`/lobbies/${lobby.id}`), { headers: botHeaders() });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe(lobby.id);

    const missing = await app.request(api("/lobbies/999999999999999999"), { headers: botHeaders() });
    expect(missing.status).toBe(404);
  });
});

describe("lobby.mdx — Create or Join Lobby (PUT /lobbies)", () => {
  it("creates a lobby for a secret, then joins the same lobby on a repeat call", async () => {
    const { app } = setup();
    const create = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ secret: "redstone-secret", lobby_metadata: { map: "forest" } }),
    });
    expect(create.status).toBe(200);
    const first = (await create.json()) as { id: string };

    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ secret: "redstone-secret" }),
    });
    expect(join.status).toBe(200);
    expect(((await join.json()) as { id: string }).id).toBe(first.id);
  });

  it("does not surface the internal secret in the lobby metadata", async () => {
    const { app } = setup();
    const create = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ secret: "hidden-secret", lobby_metadata: { map: "desert" } }),
    });
    const lobby = (await create.json()) as { metadata: Record<string, string> | null };
    expect(lobby.metadata?.map).toBe("desert");
    expect(lobby.metadata?.__secret).toBeUndefined();
    expect(lobby.metadata?.secret).toBeUndefined();
  });
});

describe("lobby.mdx — Modify Lobby", () => {
  it("overwrites metadata and replaces the member set", async () => {
    const { app, ds } = setup();
    const a = createUser(ds, { username: "member-a" });
    const b = createUser(ds, { username: "member-b" });
    const { lobby } = await createLobby(app, { members: [{ id: a.snowflake }] });

    const res = await app.request(api(`/lobbies/${lobby.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { status: "active" }, members: [{ id: b.snowflake }] }),
    });
    expect(res.status).toBe(200);
    const updated = await json<{ metadata: Record<string, string>; members: Array<{ id: string }> }>(res);
    expect(updated.metadata.status).toBe("active");
    // a was replaced out, b is present.
    expect(updated.members.some((m) => m.id === b.snowflake)).toBe(true);
    expect(updated.members.some((m) => m.id === a.snowflake)).toBe(false);
  });

  it("Modify on an unknown lobby returns 404", async () => {
    const { app } = setup();
    const res = await app.request(api("/lobbies/999999999999999999"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe("lobby.mdx — Delete Lobby", () => {
  it("returns 204, is idempotent, and removes the lobby", async () => {
    const { app, store } = setup();
    const { lobby } = await createLobby(app);
    const del = await app.request(api(`/lobbies/${lobby.id}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    // Safe to call again even though it is already deleted.
    const again = await app.request(api(`/lobbies/${lobby.id}`), { method: "DELETE", headers: botHeaders() });
    expect(again.status).toBe(204);
    expect(getDiscordStore(store).lobbies.findOneBy("snowflake", lobby.id as string)).toBeUndefined();
  });
});

describe("lobby.mdx — Members (add / bulk / remove / leave)", () => {
  it("Add a Member upserts and returns the lobby member object", async () => {
    const { app, ds } = setup();
    const u = createUser(ds, { username: "joiner" });
    const { lobby } = await createLobby(app);
    const add = await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { team: "red" }, flags: CAN_LINK_LOBBY }),
    });
    expect(add.status).toBe(200);
    const m = (await add.json()) as { id: string; metadata: Record<string, string>; flags: number };
    expect(m.id).toBe(u.snowflake);
    expect(m.metadata.team).toBe("red");
    expect(m.flags).toBe(CAN_LINK_LOBBY);

    // Calling again updates the existing member rather than duplicating.
    const update = await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { team: "blue" } }),
    });
    expect(((await update.json()) as { metadata: Record<string, string> }).metadata.team).toBe("blue");
    const all = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id as string).filter((x) => x.user_snowflake === u.snowflake);
    expect(all.length).toBe(1);
  });

  it("Bulk Update upserts non-removed members and drops remove_member entries", async () => {
    const { app, ds } = setup();
    const a = createUser(ds, { username: "bulk-a" });
    const b = createUser(ds, { username: "bulk-b" });
    const { lobby } = await createLobby(app, { members: [{ id: a.snowflake }] });
    const res = await app.request(api(`/lobbies/${lobby.id}/members/bulk`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        members: [
          { id: b.snowflake, metadata: { team: "blue" } },
          { id: a.snowflake, remove_member: true },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const upserted = await json<Array<{ id: string }>>(res);
    // Only the upserted member is returned; the removed one is excluded.
    expect(upserted.some((m) => m.id === b.snowflake)).toBe(true);
    expect(upserted.some((m) => m.id === a.snowflake)).toBe(false);
    // a is gone from the lobby; b remains.
    const lobbyMembers = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id as string).map((m) => m.user_snowflake);
    expect(lobbyMembers).not.toContain(a.snowflake);
    expect(lobbyMembers).toContain(b.snowflake);
  });

  it("Remove a Member returns 204 and is safe on a non-member", async () => {
    const { app, ds } = setup();
    const u = createUser(ds, { username: "leaver" });
    const { lobby } = await createLobby(app, { members: [{ id: u.snowflake }] });
    const res = await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    // Second remove of a now-absent member still 204.
    const again = await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(again.status).toBe(204);
  });

  it("Remove a Member on an unknown lobby returns 404", async () => {
    const { app } = setup();
    const res = await app.request(api("/lobbies/999999999999999999/members/123"), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("Leave Lobby (@me) removes the calling user and returns 204", async () => {
    const { app, outsider } = setup();
    // outsider joins by secret (bearer), then leaves via @me.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "leave-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    const leave = await app.request(api(`/lobbies/${lobby.id}/members/@me`), {
      method: "DELETE",
      headers: bearerHeaders("outsider_bearer"),
    });
    expect(leave.status).toBe(204);
    const get = await app.request(api(`/lobbies/${lobby.id}`), { headers: botHeaders() });
    const after = (await get.json()) as { members: Array<{ id: string }> };
    expect(after.members.some((m) => m.id === outsider)).toBe(false);
  });
});

describe("lobby.mdx — Channel linking (membership + CanLinkLobby + linked channel)", () => {
  it("a member with CanLinkLobby links a channel and the lobby surfaces it", async () => {
    const { app, ds, outsider, textChannel } = setup();
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "link-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    // Grant the outsider the CanLinkLobby flag.
    const member = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsider)!;
    ds.lobbyMembers.update(member.id, { flags: CAN_LINK_LOBBY });

    const res = await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    expect(res.status).toBe(200);
    const linked = await json<{ linked_channel?: { id: string } }>(res);
    expect(linked.linked_channel?.id).toBe(textChannel);
  });

  it("a member WITHOUT CanLinkLobby is forbidden from linking", async () => {
    const { app, outsider, ds, textChannel } = setup();
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "noflag-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    // Member exists but flags = 0.
    const member = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsider)!;
    ds.lobbyMembers.update(member.id, { flags: 0 });
    const res = await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    expect(res.status).toBe(403);
  });

  it("unlinking (empty / null channel_id) returns a lobby without a linked channel", async () => {
    const { app, ds, outsider, textChannel } = setup();
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "unlink-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    const member = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsider)!;
    ds.lobbyMembers.update(member.id, { flags: CAN_LINK_LOBBY });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    const unlink = await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({}),
    });
    expect(unlink.status).toBe(200);
    expect(((await unlink.json()) as { linked_channel?: unknown }).linked_channel).toBeUndefined();
  });
});

describe("lobby.mdx — Lobby messages (membership-gated)", () => {
  it("a member sends a message and gets back the documented Lobby Message object", async () => {
    const { app, application, outsider } = setup();
    // L10: Bot is NOT auto-added as member; outsider joins via secret and IS a member.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "msg-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    const res = await app.request(api(`/lobbies/${lobby.id}/messages`), {
      method: "POST",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ content: "Hello lobby!", metadata: { priority: "high" } }),
    });
    expect(res.status).toBe(200);
    const m = await json(res);
    expect(typeof m.id).toBe("string");
    expect(typeof m.type).toBe("number");
    expect(m.content).toBe("Hello lobby!");
    expect(m.lobby_id).toBe(lobby.id);
    // channel_id is included for messages-interface compatibility and equals lobby_id.
    expect(m.channel_id).toBe(lobby.id);
    expect((m.author as Record<string, unknown>).id).toBe(outsider);
    expect((m.metadata as Record<string, string>).priority).toBe("high");
    expect(typeof m.flags).toBe("number");
    expect(m.application_id).toBe(application.snowflake);
  });

  it("rejects an empty content message (content must be non-empty)", async () => {
    const { app } = setup();
    // Use outsider who IS a member via secret join.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "empty-content-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    const res = await app.request(api(`/lobbies/${lobby.id}/messages`), {
      method: "POST",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("a non-member is forbidden from sending a message", async () => {
    const { app, ds } = setup();
    // Create lobby with a specific member, outsider is NOT that member.
    const u = createUser(ds, { username: "lobby-owner-msg" });
    createToken(ds, { token: "owner_bearer_msg", type: "bearer", userSnowflake: u.snowflake, applicationSnowflake: null, scopes: [], expiresAt: new Date(Date.now() + 1e9).toISOString(), refreshToken: null });
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("owner_bearer_msg"),
      body: JSON.stringify({ secret: "no-outsider" }),
    });
    const lobby = (await join.json()) as { id: string };
    // outsider did not join, so should be forbidden
    const res = await app.request(api(`/lobbies/${lobby.id}/messages`), {
      method: "POST",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ content: "let me in" }),
    });
    expect(res.status).toBe(403);
  });

  it("Get Lobby Messages returns most-recent-first and honors the limit", async () => {
    const { app } = setup();
    // Use outsider who IS a member via secret join.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "msg-list-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    for (const content of ["first", "second", "third"]) {
      await app.request(api(`/lobbies/${lobby.id}/messages`), {
        method: "POST",
        headers: bearerHeaders("outsider_bearer"),
        body: JSON.stringify({ content }),
      });
    }
    const res = await app.request(api(`/lobbies/${lobby.id}/messages?limit=2`), { headers: bearerHeaders("outsider_bearer") });
    expect(res.status).toBe(200);
    const messages = await json<Array<{ content: string }>>(res);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe("third");
  });

  it("a non-member is forbidden from listing messages", async () => {
    const { app, ds } = setup();
    const u = createUser(ds, { username: "lobby-lister" });
    createToken(ds, { token: "lister_bearer", type: "bearer", userSnowflake: u.snowflake, applicationSnowflake: null, scopes: [], expiresAt: new Date(Date.now() + 1e9).toISOString(), refreshToken: null });
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("lister_bearer"),
      body: JSON.stringify({ secret: "list-gating" }),
    });
    const lobby = (await join.json()) as { id: string };
    // outsider did not join
    const res = await app.request(api(`/lobbies/${lobby.id}/messages`), {
      headers: bearerHeaders("outsider_bearer"),
    });
    expect(res.status).toBe(403);
  });
});

describe("lobby.mdx — Update Lobby Message Moderation Metadata", () => {
  it("persists moderation metadata and surfaces it on the message; returns 204", async () => {
    const { app } = setup();
    // L10: Use outsider who IS a member via secret join.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "modmeta-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    const sent = (await (
      await app.request(api(`/lobbies/${lobby.id}/messages`), {
        method: "POST",
        headers: bearerHeaders("outsider_bearer"),
        body: JSON.stringify({ content: "moderated" }),
      })
    ).json()) as { id: string };

    const put = await app.request(api(`/lobbies/${lobby.id}/messages/${sent.id}/moderation-metadata`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ decision: "approved", reason: "clean" }),
    });
    expect(put.status).toBe(204);

    // The moderation metadata is surfaced on subsequent reads.
    const list = (await (
      await app.request(api(`/lobbies/${lobby.id}/messages`), { headers: bearerHeaders("outsider_bearer") })
    ).json()) as Array<{ id: string; moderation_metadata?: Record<string, string> }>;
    const found = list.find((m) => m.id === sent.id)!;
    expect(found.moderation_metadata?.decision).toBe("approved");
    expect(found.moderation_metadata?.reason).toBe("clean");
  });

  it("rejects more than 5 moderation keys (50035)", async () => {
    const { app } = setup();
    // L10: Use outsider who IS a member via secret join.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "modmeta-toomany" }),
    });
    const lobby = (await join.json()) as { id: string };
    const sent = (await (
      await app.request(api(`/lobbies/${lobby.id}/messages`), {
        method: "POST",
        headers: bearerHeaders("outsider_bearer"),
        body: JSON.stringify({ content: "x" }),
      })
    ).json()) as { id: string };
    const res = await app.request(api(`/lobbies/${lobby.id}/messages/${sent.id}/moderation-metadata`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

describe("lobby.mdx — Channel invites (membership + linked channel)", () => {
  it("returns a lobby invite object ({ code }) when the lobby has a linked channel", async () => {
    const { app, ds, outsider, textChannel } = setup();
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "invite-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    const member = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsider)!;
    ds.lobbyMembers.update(member.id, { flags: CAN_LINK_LOBBY });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });

    const res = await app.request(api(`/lobbies/${lobby.id}/members/@me/invites`), {
      method: "POST",
      headers: bearerHeaders("outsider_bearer"),
    });
    expect(res.status).toBe(200);
    const invite = await json<{ code: string }>(res);
    expect(typeof invite.code).toBe("string");
  });

  it("Create invite for self fails for a non-member", async () => {
    const { app, ds, textChannel } = setup();
    // L10: Create lobby with outsider (a member), set CanLinkLobby, link channel.
    // Outsider IS a member but we test a different user who is NOT a member.
    const nonMember = createUser(ds, { username: "non-member-invite" });
    createToken(ds, { token: "nonmember_bearer", type: "bearer", userSnowflake: nonMember.snowflake, applicationSnowflake: null, scopes: [], expiresAt: new Date(Date.now() + 1e9).toISOString(), refreshToken: null });
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "invite-fail-test" }),
    });
    const lobby = (await join.json()) as { id: string };
    // Grant outsider CanLinkLobby and link channel.
    const member = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === ds.users.findOneBy("username", "outsider")!.snowflake)!;
    ds.lobbyMembers.update(member.id, { flags: CAN_LINK_LOBBY });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    // nonMember is NOT a lobby member — should be forbidden.
    const res = await app.request(api(`/lobbies/${lobby.id}/members/@me/invites`), {
      method: "POST",
      headers: bearerHeaders("nonmember_bearer"),
    });
    expect(res.status).not.toBe(200);
  });

  it("Create invite for user (Bot token) returns a code when a channel is linked", async () => {
    const { app, ds, textChannel } = setup();
    const target = createUser(ds, { username: "invitee" });
    // L10: Bot creates lobby but is NOT auto-added as member. Add it explicitly.
    const { lobby } = await createLobby(app);
    const botUser = ds.users.findOneBy("bot", true)!;
    // Add bot as a member with CanLinkLobby so it can do channel-linking.
    await app.request(api(`/lobbies/${lobby.id}/members/${botUser.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ flags: CAN_LINK_LOBBY }),
    });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    // target must be a lobby member before the invite endpoint is called
    await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });
    const res = await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    expect(typeof (await json<{ code: string }>(res)).code).toBe("string");
  });

  it("@me/invites fails (403) when the lobby has no linked channel", async () => {
    const { app } = setup();
    // L10: Use outsider who IS a member via secret join; test failure is "no linked channel".
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "me-no-channel" }),
    });
    const lobby = (await join.json()) as { id: string };
    // No channel-linking step -- lobby has no linked_channel_snowflake
    const res = await app.request(api(`/lobbies/${lobby.id}/members/@me/invites`), {
      method: "POST",
      headers: bearerHeaders("outsider_bearer"),
    });
    expect(res.status).toBe(403);
  });

  it(":userId/invites fails (403) when the lobby has no linked channel", async () => {
    const { app, ds } = setup();
    const target = createUser(ds, { username: "target2" });
    // L10: Use outsider who IS a member via secret join.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "userid-no-channel" }),
    });
    const lobby = (await join.json()) as { id: string };
    // Add target as member, but no channel-linking step.
    await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });
    const res = await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(403);
  });

  it(":userId/invites fails (403) when the target user is not a lobby member", async () => {
    const { app, ds, textChannel } = setup();
    const target = createUser(ds, { username: "nonmember" });
    // L10: Use outsider who IS a member via secret join; grant CanLinkLobby so it can link channel.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "target-not-member" }),
    });
    const lobby = (await join.json()) as { id: string };
    const outsiderUser = ds.users.findOneBy("username", "outsider")!;
    const memberRecord = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsiderUser.snowflake)!;
    ds.lobbyMembers.update(memberRecord.id, { flags: CAN_LINK_LOBBY });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    // target is NOT added as a lobby member
    const res = await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// L1 / L2 / L3 / L4 / L8 / L10 — conformance negative tests
// ---------------------------------------------------------------------------

describe("lobby.mdx — L1: PUT /members/:userId preserves flags when omitted", () => {
  it("L1: second PUT without flags preserves the flags set on the first PUT", async () => {
    const { app, ds } = setup();
    const u = createUser(ds, { username: "l1tester" });
    const { lobby } = await createLobby(app, {});

    // First PUT: set flags = CAN_LINK_LOBBY (1).
    await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ flags: CAN_LINK_LOBBY }),
    });

    // Second PUT: omit flags entirely; metadata changes but flags must be preserved.
    const res2 = await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { updated: "yes" } }),
    });
    expect(res2.status).toBe(200);
    const m = await json<{ flags: number }>(res2);
    expect(m.flags).toBe(CAN_LINK_LOBBY); // flags must not be reset to 0
  });
});

describe("lobby.mdx — L2: metadata size limit (1000 chars total)", () => {
  it("L2: POST /lobbies with oversize metadata returns 400 with code 50035", async () => {
    const { app } = setup();
    // Build metadata whose keys+values sum to more than 1000 chars.
    const bigVal = "x".repeat(1000);
    const res = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { key: bigVal } }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("L2: PATCH /lobbies/:id with oversize metadata returns 400 with code 50035", async () => {
    const { app } = setup();
    const { lobby } = await createLobby(app, {});
    const bigVal = "x".repeat(1000);
    const res = await app.request(api(`/lobbies/${lobby.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { key: bigVal } }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("L2: PUT /lobbies/:id/members/:userId with oversize metadata returns 400 with code 50035", async () => {
    const { app, ds } = setup();
    const u = createUser(ds, { username: "l2meta" });
    const { lobby } = await createLobby(app, {});
    const bigVal = "x".repeat(1000);
    const res = await app.request(api(`/lobbies/${lobby.id}/members/${u.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { key: bigVal } }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

describe("lobby.mdx — L3: idle_timeout_seconds validation (5–604800)", () => {
  it("L3: idle_timeout_seconds below 5 returns 400 with code 50035", async () => {
    const { app } = setup();
    const res = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ idle_timeout_seconds: 4 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("L3: idle_timeout_seconds above 604800 returns 400 with code 50035", async () => {
    const { app } = setup();
    const res = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ idle_timeout_seconds: 604801 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("L3: idle_timeout_seconds exactly 5 is accepted", async () => {
    const { app } = setup();
    const { res } = await createLobby(app, { idle_timeout_seconds: 5 });
    expect(res.status).toBe(201);
  });

  it("L3: idle_timeout_seconds exactly 604800 is accepted", async () => {
    const { app } = setup();
    const { res } = await createLobby(app, { idle_timeout_seconds: 604800 });
    expect(res.status).toBe(201);
  });
});

describe("lobby.mdx — L4: bulk update rejects unknown user ids with 404/10013", () => {
  it("L4: unknown user id in bulk members array (not remove_member) returns 404 with code 10013", async () => {
    const { app } = setup();
    const { lobby } = await createLobby(app, {});
    // L4 check is on the POST /lobbies/:id/members/bulk endpoint.
    const res = await app.request(api(`/lobbies/${lobby.id}/members/bulk`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        members: [{ id: "999999999999999001", metadata: {}, flags: 0 }],
      }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10013);
  });

  it("L4: remove_member=true with an unknown user id is allowed (idempotent remove)", async () => {
    // The spec does not require a 404 when removing a non-existent member; it should be a no-op.
    const { app } = setup();
    const { lobby } = await createLobby(app, {});
    const res = await app.request(api(`/lobbies/${lobby.id}/members/bulk`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        members: [{ id: "999999999999999002", remove_member: true }],
      }),
    });
    // Should succeed (200) or at minimum not return a user-unknown error.
    expect([200, 204]).toContain(res.status);
  });
});

describe("lobby.mdx — L8: invite endpoints return only { code } (no lobby_id)", () => {
  it("L8: @me/invites response contains code but NOT lobby_id", async () => {
    const { app, ds, textChannel } = setup();
    // Create lobby via PUT (outsider joins with a secret so they ARE a member with CanLinkLobby).
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "l8-secret" }),
    });
    const lobby = (await join.json()) as { id: string };
    const outsiderUser = ds.users.findOneBy("username", "outsider")!;
    const memberRecord = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsiderUser.snowflake)!;
    ds.lobbyMembers.update(memberRecord.id, { flags: CAN_LINK_LOBBY });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });

    const res = await app.request(api(`/lobbies/${lobby.id}/members/@me/invites`), {
      method: "POST",
      headers: bearerHeaders("outsider_bearer"),
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(typeof body.code).toBe("string");
    expect("lobby_id" in body).toBe(false); // L8: lobby_id must NOT be present
  });

  it("L8: :userId/invites response contains code but NOT lobby_id", async () => {
    const { app, ds, textChannel } = setup();
    // Create lobby and add a target member.
    const join = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ secret: "l8-user-secret" }),
    });
    const lobby = (await join.json()) as { id: string };
    const outsiderUser = ds.users.findOneBy("username", "outsider")!;
    const memberRecord = ds.lobbyMembers.findBy("lobby_snowflake", lobby.id).find((m) => m.user_snowflake === outsiderUser.snowflake)!;
    ds.lobbyMembers.update(memberRecord.id, { flags: CAN_LINK_LOBBY });
    await app.request(api(`/lobbies/${lobby.id}/channel-linking`), {
      method: "PATCH",
      headers: bearerHeaders("outsider_bearer"),
      body: JSON.stringify({ channel_id: textChannel }),
    });
    const target = createUser(ds, { username: "l8target" });
    await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });

    const res = await app.request(api(`/lobbies/${lobby.id}/members/${target.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(typeof body.code).toBe("string");
    expect("lobby_id" in body).toBe(false); // L8: lobby_id must NOT be present
  });
});

describe("lobby.mdx — L10: POST /lobbies does NOT auto-add the bot as a member", () => {
  it("L10: Create Lobby returns an empty members array (bot not auto-added)", async () => {
    const { app } = setup();
    const { res, lobby } = await createLobby(app, {});
    expect(res.status).toBe(201);
    const members = lobby.members as unknown[];
    expect(members.length).toBe(0);
  });

  it("L10: bot is not a member of a newly created lobby — POST messages fails with 403", async () => {
    const { app } = setup();
    const { lobby } = await createLobby(app, {});
    // The bot was NOT auto-added; posting a message requires membership.
    const msgRes = await app.request(api(`/lobbies/${lobby.id}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "unauthorized" }),
    });
    expect(msgRes.status).toBe(403);
  });
});
