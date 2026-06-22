import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake, toAPIUser } from "../helpers.js";
import type { DiscordLobby, DiscordLobbyMember, DiscordLobbyMessage, DiscordUser } from "../entities.js";

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function toAPILobbyMember(m: DiscordLobbyMember): Record<string, unknown> {
  return {
    id: m.user_snowflake,
    metadata: m.metadata,
    flags: m.flags,
  };
}

function toAPILobby(lobby: DiscordLobby, ds: DiscordStore): Record<string, unknown> {
  const members = ds.lobbyMembers.findBy("lobby_snowflake", lobby.snowflake).map(toAPILobbyMember);
  return {
    id: lobby.snowflake,
    application_id: lobby.application_snowflake,
    metadata: lobby.metadata,
    members,
    // linked_channel is omitted unless set (emulator doesn't store full channel objects for lobbies)
    ...(lobby.linked_channel_snowflake != null
      ? { linked_channel: { id: lobby.linked_channel_snowflake, type: 0 } }
      : {}),
  };
}

function toAPILobbyMessage(
  msg: DiscordLobbyMessage,
  ds: DiscordStore,
  applicationSnowflake: string,
): Record<string, unknown> {
  const authorUser = ds.users.findOneBy("snowflake", msg.author_snowflake);
  return {
    id: msg.snowflake,
    type: 0,
    content: msg.content,
    lobby_id: msg.lobby_snowflake,
    channel_id: msg.channel_snowflake ?? msg.lobby_snowflake,
    author: authorUser ? toAPIUser(authorUser) : { id: msg.author_snowflake },
    metadata: msg.metadata,
    flags: 0,
    application_id: applicationSnowflake,
  };
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function lobbiesRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // 1. PUT /lobbies — create or join by secret
  app.put("/api/v:version/lobbies", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const application = auth.application ?? ds.applications.all()[0];
    if (!application) return notFound(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body is fine
    }

    const secret = body.secret as string | undefined;
    const lobbyMetadata = (body.lobby_metadata ?? body.metadata) as Record<string, string> | null | undefined;
    const memberMetadata = body.member_metadata as Record<string, string> | null | undefined;
    const members = body.members as Array<{ id: string; metadata?: Record<string, string> | null; flags?: number }> | undefined;

    // Try to find existing lobby by secret (we store secret as metadata key "__secret")
    let lobby: DiscordLobby | undefined;
    if (secret) {
      const existing = ds.lobbies
        .findBy("application_snowflake", application.snowflake)
        .find((l) => l.metadata?.["__secret"] === secret);
      if (existing) {
        // Join: add current user as member, update lobby metadata if provided
        const updatedMeta: Record<string, string> = {
          ...(existing.metadata ?? {}),
          ...(lobbyMetadata ?? {}),
        };
        ds.lobbies.update(existing.id, { metadata: updatedMeta });
        lobby = ds.lobbies.findOneBy("snowflake", existing.snowflake)!;

        // Add/update caller as member
        if (auth.user) {
          const existingMember = ds.lobbyMembers
            .findBy("lobby_snowflake", lobby.snowflake)
            .find((m) => m.user_snowflake === auth.user!.snowflake);
          if (existingMember) {
            ds.lobbyMembers.update(existingMember.id, { metadata: memberMetadata ?? existingMember.metadata });
          } else {
            ds.lobbyMembers.insert({
              lobby_snowflake: lobby.snowflake,
              user_snowflake: auth.user.snowflake,
              metadata: memberMetadata ?? null,
              flags: 0,
            });
          }
        }
        return c.json(toAPILobby(lobby, ds));
      }
    }

    // Create lobby
    const meta: Record<string, string> | null = secret
      ? { ...(lobbyMetadata ?? {}), __secret: secret }
      : lobbyMetadata ?? null;

    const id = snowflake();
    ds.lobbies.insert({
      snowflake: id,
      application_snowflake: application.snowflake,
      metadata: meta,
      linked_channel_snowflake: null,
    });
    lobby = ds.lobbies.findOneBy("snowflake", id)!;

    // Add caller as member if authenticated user
    if (auth.user) {
      ds.lobbyMembers.insert({
        lobby_snowflake: id,
        user_snowflake: auth.user.snowflake,
        metadata: memberMetadata ?? null,
        flags: 0,
      });
    }

    // Add any additional members from body
    if (members) {
      for (const m of members) {
        // Skip if already added (caller)
        const alreadyAdded = ds.lobbyMembers
          .findBy("lobby_snowflake", id)
          .find((lm) => lm.user_snowflake === m.id);
        if (!alreadyAdded) {
          ds.lobbyMembers.insert({
            lobby_snowflake: id,
            user_snowflake: m.id,
            metadata: m.metadata ?? null,
            flags: m.flags ?? 0,
          });
        }
      }
    }

    return c.json(toAPILobby(lobby, ds));
  });

  // 2. POST /lobbies — create lobby
  app.post("/api/v:version/lobbies", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const application = auth.application ?? ds.applications.all()[0];
    if (!application) return notFound(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body ok
    }

    const metadata = body.metadata as Record<string, string> | null | undefined;
    const members = body.members as Array<{ id: string; metadata?: Record<string, string> | null; flags?: number }> | undefined;

    const id = snowflake();
    ds.lobbies.insert({
      snowflake: id,
      application_snowflake: application.snowflake,
      metadata: metadata ?? null,
      linked_channel_snowflake: null,
    });
    const lobby = ds.lobbies.findOneBy("snowflake", id)!;

    if (members) {
      for (const m of members) {
        ds.lobbyMembers.insert({
          lobby_snowflake: id,
          user_snowflake: m.id,
          metadata: m.metadata ?? null,
          flags: m.flags ?? 0,
        });
      }
    }

    return c.json(toAPILobby(lobby, ds), 201);
  });

  // 3. GET /lobbies/:lobbyId
  app.get("/api/v:version/lobbies/:lobbyId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobby = ds.lobbies.findOneBy("snowflake", c.req.param("lobbyId"));
    if (!lobby) return notFound(c);
    return c.json(toAPILobby(lobby, ds));
  });

  // 4. PATCH /lobbies/:lobbyId — update metadata and/or members
  app.patch("/api/v:version/lobbies/:lobbyId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobby = ds.lobbies.findOneBy("snowflake", c.req.param("lobbyId"));
    if (!lobby) return notFound(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body ok
    }

    if ("metadata" in body) {
      ds.lobbies.update(lobby.id, { metadata: (body.metadata as Record<string, string> | null) ?? null });
    }

    if ("members" in body && Array.isArray(body.members)) {
      const newMembers = body.members as Array<{ id: string; metadata?: Record<string, string> | null; flags?: number }>;
      // Remove all existing members
      const existing = ds.lobbyMembers.findBy("lobby_snowflake", lobby.snowflake);
      for (const m of existing) ds.lobbyMembers.delete(m.id);
      // Insert new set
      for (const m of newMembers) {
        ds.lobbyMembers.insert({
          lobby_snowflake: lobby.snowflake,
          user_snowflake: m.id,
          metadata: m.metadata ?? null,
          flags: m.flags ?? 0,
        });
      }
    }

    const updated = ds.lobbies.findOneBy("snowflake", lobby.snowflake)!;
    return c.json(toAPILobby(updated, ds));
  });

  // 5. DELETE /lobbies/:lobbyId
  app.delete("/api/v:version/lobbies/:lobbyId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) {
      // Safe to call even if already deleted
      return new Response(null, { status: 204 });
    }
    // Remove members and messages
    for (const m of ds.lobbyMembers.findBy("lobby_snowflake", lobbyId)) ds.lobbyMembers.delete(m.id);
    for (const m of ds.lobbyMessages.findBy("lobby_snowflake", lobbyId)) ds.lobbyMessages.delete(m.id);
    ds.lobbies.delete(lobby.id);
    return new Response(null, { status: 204 });
  });

  // 6. PUT /lobbies/:lobbyId/members/:userId — add/update member
  app.put("/api/v:version/lobbies/:lobbyId/members/:userId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const userId = c.req.param("userId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body ok
    }

    const metadata = body.metadata as Record<string, string> | null | undefined;
    const flags = typeof body.flags === "number" ? body.flags : 0;

    const existing = ds.lobbyMembers.findBy("lobby_snowflake", lobbyId).find((m) => m.user_snowflake === userId);
    if (existing) {
      ds.lobbyMembers.update(existing.id, {
        metadata: metadata !== undefined ? (metadata ?? null) : existing.metadata,
        flags,
      });
      const updated = ds.lobbyMembers.findBy("lobby_snowflake", lobbyId).find((m) => m.user_snowflake === userId)!;
      return c.json(toAPILobbyMember(updated));
    } else {
      ds.lobbyMembers.insert({
        lobby_snowflake: lobbyId,
        user_snowflake: userId,
        metadata: metadata ?? null,
        flags,
      });
      const created = ds.lobbyMembers.findBy("lobby_snowflake", lobbyId).find((m) => m.user_snowflake === userId)!;
      return c.json(toAPILobbyMember(created));
    }
  });

  // 8. DELETE /lobbies/:lobbyId/members/@me — must be registered before the :userId wildcard
  app.delete("/api/v:version/lobbies/:lobbyId/members/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    if (!auth.user) return unauthorized(c);
    const existing = ds.lobbyMembers
      .findBy("lobby_snowflake", lobbyId)
      .find((m) => m.user_snowflake === auth.user!.snowflake);
    if (existing) ds.lobbyMembers.delete(existing.id);
    return new Response(null, { status: 204 });
  });

  // 9. POST /lobbies/:lobbyId/members/bulk — must be registered before the :userId wildcard
  app.post("/api/v:version/lobbies/:lobbyId/members/bulk", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body ok
    }

    const members = (body.members ?? body) as Array<{
      id: string;
      metadata?: Record<string, string> | null;
      flags?: number;
      remove_member?: boolean;
    }>;

    const upserted: DiscordLobbyMember[] = [];

    if (Array.isArray(members)) {
      for (const m of members) {
        const existing = ds.lobbyMembers.findBy("lobby_snowflake", lobbyId).find((lm) => lm.user_snowflake === m.id);
        if (m.remove_member) {
          if (existing) ds.lobbyMembers.delete(existing.id);
        } else {
          if (existing) {
            ds.lobbyMembers.update(existing.id, {
              metadata: m.metadata !== undefined ? (m.metadata ?? null) : existing.metadata,
              flags: m.flags ?? existing.flags,
            });
            const updated = ds.lobbyMembers.findBy("lobby_snowflake", lobbyId).find((lm) => lm.user_snowflake === m.id);
            if (updated) upserted.push(updated);
          } else {
            ds.lobbyMembers.insert({
              lobby_snowflake: lobbyId,
              user_snowflake: m.id,
              metadata: m.metadata ?? null,
              flags: m.flags ?? 0,
            });
            const created = ds.lobbyMembers
              .findBy("lobby_snowflake", lobbyId)
              .find((lm) => lm.user_snowflake === m.id);
            if (created) upserted.push(created);
          }
        }
      }
    }

    return c.json(upserted.map(toAPILobbyMember));
  });

  // 13a. POST /lobbies/:lobbyId/members/@me/invites — must be before :userId/invites
  app.post("/api/v:version/lobbies/:lobbyId/members/@me/invites", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    return c.json({ lobby_id: lobbyId, code: snowflake() });
  });

  // 7. DELETE /lobbies/:lobbyId/members/:userId
  app.delete("/api/v:version/lobbies/:lobbyId/members/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const userId = c.req.param("userId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    const existing = ds.lobbyMembers.findBy("lobby_snowflake", lobbyId).find((m) => m.user_snowflake === userId);
    if (existing) ds.lobbyMembers.delete(existing.id);
    return new Response(null, { status: 204 });
  });

  // 13b. POST /lobbies/:lobbyId/members/:userId/invites
  app.post("/api/v:version/lobbies/:lobbyId/members/:userId/invites", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    return c.json({ lobby_id: lobbyId, code: snowflake() });
  });

  // 10. POST /lobbies/:lobbyId/messages — send lobby message
  app.post("/api/v:version/lobbies/:lobbyId/messages", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    const application = auth.application ?? ds.applications.all()[0];
    if (!application) return notFound(c);

    // Resolve the author: prefer the authenticated user, fall back to bot user
    let authorUser: DiscordUser | null = auth.user;
    if (!authorUser) {
      authorUser = ds.users.findOneBy("snowflake", application.bot_user_snowflake) ?? null;
    }
    if (!authorUser) return unauthorized(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body
    }

    const content = (body.content as string | undefined) ?? "";
    const metadata = body.metadata as Record<string, string> | null | undefined;

    const id = snowflake();
    ds.lobbyMessages.insert({
      snowflake: id,
      lobby_snowflake: lobbyId,
      channel_snowflake: lobby.linked_channel_snowflake,
      author_snowflake: authorUser.snowflake,
      content,
      metadata: metadata ?? null,
    });

    const msg = ds.lobbyMessages.findOneBy("snowflake", id)!;
    return c.json(toAPILobbyMessage(msg, ds, application.snowflake));
  });

  // 11. GET /lobbies/:lobbyId/messages — list messages (most recent first)
  app.get("/api/v:version/lobbies/:lobbyId/messages", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    const application = auth.application ?? ds.applications.all()[0];
    const appId = application?.snowflake ?? lobby.application_snowflake;

    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const messages = ds.lobbyMessages
      .findBy("lobby_snowflake", lobbyId)
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1))
      .slice(0, limit)
      .map((msg) => toAPILobbyMessage(msg, ds, appId));

    return c.json(messages);
  });

  // 14. PUT /lobbies/:lobbyId/messages/:messageId/moderation-metadata
  app.put("/api/v:version/lobbies/:lobbyId/messages/:messageId/moderation-metadata", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    return new Response(null, { status: 204 });
  });

  // 12. PATCH /lobbies/:lobbyId/channel-linking
  app.patch("/api/v:version/lobbies/:lobbyId/channel-linking", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body = unlink
    }

    const channelId = (body.channel_id as string | null | undefined) ?? null;
    ds.lobbies.update(lobby.id, { linked_channel_snowflake: channelId });
    const updated = ds.lobbies.findOneBy("snowflake", lobbyId)!;
    return c.json(toAPILobby(updated, ds));
  });
}
