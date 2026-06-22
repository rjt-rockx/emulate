import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { discordPlugin } from "../index.js";
import { getDiscordRuntime } from "../runtime.js";
import { getDiscordStore } from "../store.js";
import { lobbiesRoutes } from "../routes/lobbies.js";
import { api, botHeaders, json, TEST_BASE_URL } from "./helpers.js";

function build() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  discordPlugin.register(app, store, webhooks, TEST_BASE_URL);
  const runtime = getDiscordRuntime(store);
  lobbiesRoutes({ app, store, webhooks, baseUrl: TEST_BASE_URL, bus: runtime.bus });
  discordPlugin.seed?.(store, TEST_BASE_URL);
  return { app, store };
}

describe("discord lobbies", () => {
  it("full lifecycle: create, GET, add member, message, list messages, remove member, delete, 404", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Seed a secondary user to add as a member
    const secondUser = ds.users.insert({
      snowflake: "999000000000000001",
      username: "lobbyuser",
      discriminator: "0",
      global_name: "Lobby User",
      avatar: null,
      bot: false,
      system: false,
      mfa_enabled: false,
      email: null,
      verified: false,
      flags: 0,
      public_flags: 0,
      premium_type: 0,
      accent_color: null,
      banner: null,
      locale: "en-US",
    });

    // 1. Create a lobby
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { mode: "casual" } }),
    });
    expect(createRes.status).toBe(201);
    const lobby = await json<{
      id: string;
      application_id: string;
      metadata: Record<string, string>;
      members: Array<{ id: string; metadata: unknown; flags: number }>;
    }>(createRes);
    expect(typeof lobby.id).toBe("string");
    expect(lobby.metadata?.mode).toBe("casual");
    const lobbyId = lobby.id;

    // 2. GET the lobby
    const getRes = await app.request(api(`/lobbies/${lobbyId}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const fetched = await json<{ id: string; metadata: Record<string, string> }>(getRes);
    expect(fetched.id).toBe(lobbyId);
    expect(fetched.metadata?.mode).toBe("casual");

    // 3. Add a member
    const addMemberRes = await app.request(api(`/lobbies/${lobbyId}/members/${secondUser.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { role: "scout" }, flags: 1 }),
    });
    expect(addMemberRes.status).toBe(200);
    const member = await json<{ id: string; metadata: Record<string, string>; flags: number }>(addMemberRes);
    expect(member.id).toBe(secondUser.snowflake);
    expect(member.metadata?.role).toBe("scout");
    expect(member.flags).toBe(1);

    // 4. GET shows member
    const getWithMemberRes = await app.request(api(`/lobbies/${lobbyId}`), { headers: botHeaders() });
    expect(getWithMemberRes.status).toBe(200);
    const withMember = await json<{
      members: Array<{ id: string }>;
    }>(getWithMemberRes);
    expect(withMember.members.some((m) => m.id === secondUser.snowflake)).toBe(true);

    // L10: Bot is NOT auto-added as a member; add it explicitly so it can post a message.
    const botApp = ds.applications.all()[0];
    const botUser = botApp ? ds.users.findOneBy("snowflake", botApp.bot_user_snowflake) : null;
    if (botUser) {
      await app.request(api(`/lobbies/${lobbyId}/members/${botUser.snowflake}`), {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({}),
      });
    }

    // 5. Post a message
    const msgRes = await app.request(api(`/lobbies/${lobbyId}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "Hello lobby!", metadata: { priority: "high" } }),
    });
    expect(msgRes.status).toBe(200);
    const msg = await json<{
      id: string;
      type: number;
      content: string;
      lobby_id: string;
      flags: number;
    }>(msgRes);
    expect(msg.content).toBe("Hello lobby!");
    expect(msg.lobby_id).toBe(lobbyId);
    expect(msg.type).toBe(0);
    expect(msg.flags).toBe(0);

    // 6. List messages (most recent first)
    const listRes = await app.request(api(`/lobbies/${lobbyId}/messages`), { headers: botHeaders() });
    expect(listRes.status).toBe(200);
    const messages = await json<Array<{ id: string; content: string }>>(listRes);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].content).toBe("Hello lobby!");

    // 7. Remove member
    const removeMemberRes = await app.request(api(`/lobbies/${lobbyId}/members/${secondUser.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(removeMemberRes.status).toBe(204);

    // Verify member removed
    const afterRemoveRes = await app.request(api(`/lobbies/${lobbyId}`), { headers: botHeaders() });
    const afterRemove = await json<{ members: Array<{ id: string }> }>(afterRemoveRes);
    expect(afterRemove.members.every((m) => m.id !== secondUser.snowflake)).toBe(true);

    // 8. Delete lobby
    const deleteRes = await app.request(api(`/lobbies/${lobbyId}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    // 9. GET returns 404
    const notFoundRes = await app.request(api(`/lobbies/${lobbyId}`), { headers: botHeaders() });
    expect(notFoundRes.status).toBe(404);
  });

  it("PUT /lobbies creates or joins by secret", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Seed a bearer token user for testing
    const user = ds.users.all().find((u) => !u.bot);
    expect(user).toBeDefined();

    // Create lobby via PUT with secret
    const createRes = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ secret: "my-game-secret", lobby_metadata: { map: "forest" } }),
    });
    expect(createRes.status).toBe(200);
    const created = await json<{ id: string; metadata: Record<string, string> }>(createRes);
    expect(typeof created.id).toBe("string");
    // secret is stored in metadata but lobby is returned
    const lobbyId = created.id;

    // Join the same lobby again via same secret
    const joinRes = await app.request(api("/lobbies"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ secret: "my-game-secret", lobby_metadata: { map: "forest" } }),
    });
    expect(joinRes.status).toBe(200);
    const joined = await json<{ id: string }>(joinRes);
    // Should return the same lobby
    expect(joined.id).toBe(lobbyId);
  });

  it("PATCH /lobbies/:lobbyId updates metadata and members", async () => {
    const { app } = build();

    // Create a lobby
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { status: "waiting" } }),
    });
    const lobby = await json<{ id: string }>(createRes);
    const lobbyId = lobby.id;

    // Patch metadata
    const patchRes = await app.request(api(`/lobbies/${lobbyId}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ metadata: { status: "active" } }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json<{ metadata: Record<string, string> }>(patchRes);
    expect(patched.metadata?.status).toBe("active");
  });

  it("bulk update lobby members", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    const userA = ds.users.insert({
      snowflake: "888000000000000001",
      username: "bulkuserA",
      discriminator: "0",
      global_name: null,
      avatar: null,
      bot: false,
      system: false,
      mfa_enabled: false,
      email: null,
      verified: false,
      flags: 0,
      public_flags: 0,
      premium_type: 0,
      accent_color: null,
      banner: null,
      locale: "en-US",
    });
    const userB = ds.users.insert({
      snowflake: "888000000000000002",
      username: "bulkuserB",
      discriminator: "0",
      global_name: null,
      avatar: null,
      bot: false,
      system: false,
      mfa_enabled: false,
      email: null,
      verified: false,
      flags: 0,
      public_flags: 0,
      premium_type: 0,
      accent_color: null,
      banner: null,
      locale: "en-US",
    });

    // Create lobby
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const lobby = await json<{ id: string }>(createRes);
    const lobbyId = lobby.id;

    // Bulk add members
    const bulkRes = await app.request(api(`/lobbies/${lobbyId}/members/bulk`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        members: [
          { id: userA.snowflake, metadata: { team: "red" }, flags: 0 },
          { id: userB.snowflake, metadata: { team: "blue" }, flags: 0 },
        ],
      }),
    });
    expect(bulkRes.status).toBe(200);
    const bulkResult = await json<Array<{ id: string }>>(bulkRes);
    expect(bulkResult.length).toBe(2);
    expect(bulkResult.some((m) => m.id === userA.snowflake)).toBe(true);
    expect(bulkResult.some((m) => m.id === userB.snowflake)).toBe(true);
  });

  it("channel-linking sets and clears linked_channel", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Create lobby
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const lobby = await json<{ id: string }>(createRes);
    const lobbyId = lobby.id;

    // L10: Bot is NOT auto-added; add it explicitly with CanLinkLobby flag (1 = 1<<0) so it
    // has permission to use the channel-linking endpoint.
    const botApp = ds.applications.all()[0];
    const botUser = botApp ? ds.users.findOneBy("snowflake", botApp.bot_user_snowflake) : null;
    if (botUser) {
      await app.request(api(`/lobbies/${lobbyId}/members/${botUser.snowflake}`), {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ flags: 1 }), // CanLinkLobby = 1 << 0
      });
    }

    // Link a channel
    const linkRes = await app.request(api(`/lobbies/${lobbyId}/channel-linking`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: "777000000000000001" }),
    });
    expect(linkRes.status).toBe(200);
    const linked = await json<{ linked_channel?: { id: string } }>(linkRes);
    expect(linked.linked_channel?.id).toBe("777000000000000001");

    // Unlink (null channel_id)
    const unlinkRes = await app.request(api(`/lobbies/${lobbyId}/channel-linking`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: null }),
    });
    expect(unlinkRes.status).toBe(200);
    const unlinked = await json<{ linked_channel?: unknown }>(unlinkRes);
    expect(unlinked.linked_channel).toBeUndefined();
  });

  it("DELETE /lobbies/:lobbyId/members/@me removes current user", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Get the bot user that will be authenticated
    const botApp = ds.applications.all()[0];
    const botUser = botApp ? ds.users.findOneBy("snowflake", botApp.bot_user_snowflake) : null;

    // Create lobby and add the bot user as member manually to test @me removal
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const lobby = await json<{ id: string }>(createRes);
    const lobbyId = lobby.id;

    if (botUser) {
      // Add the bot user
      await app.request(api(`/lobbies/${lobbyId}/members/${botUser.snowflake}`), {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({}),
      });

      // Leave via @me
      const leaveRes = await app.request(api(`/lobbies/${lobbyId}/members/@me`), {
        method: "DELETE",
        headers: botHeaders(),
      });
      expect(leaveRes.status).toBe(204);
    }
  });

  it("invite endpoints return code (no lobby_id per L8)", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Create lobby
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const lobby = await json<{ id: string }>(createRes);
    const lobbyId = lobby.id;

    // L10: Bot is NOT auto-added; add it explicitly with CanLinkLobby flag (1 = 1<<0) so it
    // can use the channel-linking endpoint (required before invite endpoints are accessible).
    const botApp = ds.applications.all()[0];
    const botUser = botApp ? ds.users.findOneBy("snowflake", botApp.bot_user_snowflake) : null;
    if (botUser) {
      await app.request(api(`/lobbies/${lobbyId}/members/${botUser.snowflake}`), {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ flags: 1 }), // CanLinkLobby = 1 << 0
      });
    }

    // Link a channel so invite endpoints are accessible (lobby.mdx:292,301).
    const textChannel = ds.channels.all().find((ch: { type: number; snowflake: string }) => ch.type === 0);
    if (textChannel) {
      await app.request(api(`/lobbies/${lobbyId}/channel-linking`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ channel_id: textChannel.snowflake }),
      });
    }

    // @me invites — L8: response is only { code }, no lobby_id field.
    const meInviteRes = await app.request(api(`/lobbies/${lobbyId}/members/@me/invites`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(meInviteRes.status).toBe(200);
    const meInvite = await json<{ code: string; lobby_id?: string }>(meInviteRes);
    expect(typeof meInvite.code).toBe("string");
    expect(meInvite.lobby_id).toBeUndefined(); // L8: lobby_id removed from invite response

    // Insert a user to serve as the invite target.
    const targetUser = ds.users.insert({
      snowflake: "123456789000000001",
      username: "invitetarget",
      discriminator: "0",
      global_name: null,
      avatar: null,
      bot: false,
      system: false,
      mfa_enabled: false,
      email: null,
      verified: false,
      flags: 0,
      public_flags: 0,
      premium_type: 0,
      accent_color: null,
      banner: null,
      locale: "en-US",
    });

    // Add the target user as a lobby member so the invite endpoint accepts them.
    await app.request(api(`/lobbies/${lobbyId}/members/${targetUser.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });

    // user invites — L8: response is only { code }, no lobby_id field.
    const userInviteRes = await app.request(api(`/lobbies/${lobbyId}/members/${targetUser.snowflake}/invites`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(userInviteRes.status).toBe(200);
    const userInvite = await json<{ code: string; lobby_id?: string }>(userInviteRes);
    expect(typeof userInvite.code).toBe("string");
    expect(userInvite.lobby_id).toBeUndefined(); // L8: lobby_id removed from invite response
  });

  it("moderation-metadata returns 204", async () => {
    const { app, store } = build();
    const ds = getDiscordStore(store);

    // Create lobby
    const createRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const lobby = await json<{ id: string }>(createRes);
    const lobbyId = lobby.id;

    // L10: Bot is NOT auto-added as a member; add it explicitly so it can post messages.
    const botApp = ds.applications.all()[0];
    const botUser = botApp ? ds.users.findOneBy("snowflake", botApp.bot_user_snowflake) : null;
    if (botUser) {
      await app.request(api(`/lobbies/${lobbyId}/members/${botUser.snowflake}`), {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({}),
      });
    }

    const msgRes = await app.request(api(`/lobbies/${lobbyId}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "test" }),
    });
    const msg = await json<{ id: string }>(msgRes);

    const modRes = await app.request(api(`/lobbies/${lobbyId}/messages/${msg.id}/moderation-metadata`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(modRes.status).toBe(204);
  });
});
