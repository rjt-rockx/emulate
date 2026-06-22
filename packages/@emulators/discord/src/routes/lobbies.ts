import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  forbidden,
  discordError,
  snowflake,
  toAPIUser,
  invalidFormBody,
  resolveBotUser,
  readBody,
  type DiscordAuth,
} from "../helpers.js";
import type { DiscordLobby, DiscordLobbyMember, DiscordLobbyMessage, DiscordUser } from "../entities.js";

// Lobby member flags

/** Lobby member flags (doc: CanLinkLobby = 1<<0). */
const LobbyMemberFlags = {
  CanLinkLobby: 1 << 0,
} as const;

// Serializers

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
    metadata: sanitizeLobbyMetadata(lobby.metadata),
    members,
    flags: lobby.flags ?? 0,
    // linked_channel is omitted unless set (emulator does not store full channel objects for lobbies).
    ...(lobby.linked_channel_snowflake != null
      ? { linked_channel: { id: lobby.linked_channel_snowflake, type: 0 } }
      : {}),
  };
}

// Lobby validation helpers

/** L2: Validate that combined key+value length <= 1000 for metadata. Returns error message or null. */
function validateMetadataSize(metadata: Record<string, string> | null | undefined): string | null {
  if (!metadata) return null;
  const total = Object.entries(metadata).reduce((sum, [k, v]) => sum + k.length + (typeof v === "string" ? v.length : String(v).length), 0);
  if (total > 1000) return "The total length of all metadata keys and values must not exceed 1000 characters.";
  return null;
}

/** L3: Validate that idle_timeout_seconds is in range 5–604800. Returns error message or null. */
function validateIdleTimeout(idleTimeout: unknown): string | null {
  if (idleTimeout === undefined || idleTimeout === null) return null;
  const n = Number(idleTimeout);
  if (!Number.isInteger(n) || n < 5 || n > 604800) return "Value must be between 5 and 604800.";
  return null;
}

/** Strip the internal `__secret` bookkeeping key from surfaced lobby metadata. */
function sanitizeLobbyMetadata(metadata: Record<string, string> | null): Record<string, string> | null {
  if (!metadata) return metadata;
  if (!("__secret" in metadata)) return metadata;
  const clone = { ...metadata };
  delete clone.__secret;
  return clone;
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
    moderation_metadata: msg.moderation_metadata ?? null,
    flags: msg.flags ?? 0,
    application_id: applicationSnowflake,
  };
}

// Membership helpers

/** The user the caller is acting as (the bearer user, or the bot user for a Bot token). */
function callerUser(ds: DiscordStore, auth: DiscordAuth): DiscordUser | null {
  return auth.user ?? resolveBotUser(ds, auth);
}

function lobbyMemberFor(
  ds: DiscordStore,
  lobbySnowflake: string,
  userSnowflake: string,
): DiscordLobbyMember | undefined {
  return ds.lobbyMembers.findBy("lobby_snowflake", lobbySnowflake).find((m) => m.user_snowflake === userSnowflake);
}

// Route module

export function lobbiesRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // 1. PUT /lobbies — create or join by secret
  app.put("/api/v:version/lobbies", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const application = auth.application ?? ds.applications.all()[0];
    if (!application) return notFound(c);

    const body = await readBody<Record<string, unknown>>(c);

    const secret = body.secret as string | undefined;
    const lobbyMetadata = (body.lobby_metadata ?? body.metadata) as Record<string, string> | null | undefined;
    const memberMetadata = body.member_metadata as Record<string, string> | null | undefined;

    // L2: Validate metadata size.
    const metaSizeErr = validateMetadataSize(lobbyMetadata) ?? validateMetadataSize(memberMetadata);
    if (metaSizeErr) return invalidFormBody(c, { metadata: metaSizeErr });
    // L3: Validate idle_timeout_seconds.
    const idleTimeoutErr = validateIdleTimeout(body.idle_timeout_seconds);
    if (idleTimeoutErr) return invalidFormBody(c, { idle_timeout_seconds: idleTimeoutErr });

    // Try to find existing lobby by secret (stored under the metadata key "__secret").
    if (secret) {
      const existing = ds.lobbies
        .findBy("application_snowflake", application.snowflake)
        .find((l) => l.metadata?.["__secret"] === secret);
      if (existing) {
        const updatedMeta: Record<string, string> = {
          ...(existing.metadata ?? {}),
          ...(lobbyMetadata ?? {}),
        };
        ds.lobbies.update(existing.id, { metadata: updatedMeta });
        const joined = ds.lobbies.findOneBy("snowflake", existing.snowflake)!;

        const user = callerUser(ds, auth);
        if (user) {
          const existingMember = lobbyMemberFor(ds, joined.snowflake, user.snowflake);
          if (existingMember) {
            ds.lobbyMembers.update(existingMember.id, { metadata: memberMetadata ?? existingMember.metadata });
          } else {
            ds.lobbyMembers.insert({
              lobby_snowflake: joined.snowflake,
              user_snowflake: user.snowflake,
              metadata: memberMetadata ?? null,
              flags: 0,
            });
          }
        }
        return c.json(toAPILobby(joined, ds));
      }
    }

    // Create lobby.
    const meta: Record<string, string> | null = secret
      ? { ...(lobbyMetadata ?? {}), __secret: secret }
      : (lobbyMetadata ?? null);

    const id = snowflake();
    ds.lobbies.insert({
      snowflake: id,
      application_snowflake: application.snowflake,
      metadata: meta,
      linked_channel_snowflake: null,
    });
    const lobby = ds.lobbies.findOneBy("snowflake", id)!;

    const user = callerUser(ds, auth);
    if (user) {
      ds.lobbyMembers.insert({
        lobby_snowflake: id,
        user_snowflake: user.snowflake,
        metadata: memberMetadata ?? null,
        flags: 0,
      });
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

    const body = await readBody<Record<string, unknown>>(c);

    const metadata = body.metadata as Record<string, string> | null | undefined;
    const members = body.members as
      | Array<{ id: string; metadata?: Record<string, string> | null; flags?: number }>
      | undefined;

    // L2: Validate metadata size.
    const metaSizeErr = validateMetadataSize(metadata);
    if (metaSizeErr) return invalidFormBody(c, { metadata: metaSizeErr });
    // L3: Validate idle_timeout_seconds.
    const idleTimeoutErr = validateIdleTimeout(body.idle_timeout_seconds);
    if (idleTimeoutErr) return invalidFormBody(c, { idle_timeout_seconds: idleTimeoutErr });

    const id = snowflake();
    ds.lobbies.insert({
      snowflake: id,
      application_snowflake: application.snowflake,
      metadata: metadata ?? null,
      linked_channel_snowflake: null,
    });
    const lobby = ds.lobbies.findOneBy("snowflake", id)!;

    // L10: Do NOT auto-add the bot/application as a lobby member on plain Create.
    // Only add the explicitly specified members from the request body.
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

    const body = await readBody<Record<string, unknown>>(c);

    // L2: Validate metadata size.
    const patchMetadata = "metadata" in body ? (body.metadata as Record<string, string> | null) : undefined;
    const metaSizeErr = validateMetadataSize(patchMetadata ?? undefined);
    if (metaSizeErr) return invalidFormBody(c, { metadata: metaSizeErr });
    // L3: Validate idle_timeout_seconds.
    const idleTimeoutErr = validateIdleTimeout(body.idle_timeout_seconds);
    if (idleTimeoutErr) return invalidFormBody(c, { idle_timeout_seconds: idleTimeoutErr });

    if ("metadata" in body) {
      // Overwrites metadata, preserving the internal secret bookkeeping key if present.
      const next = (body.metadata as Record<string, string> | null) ?? null;
      const secret = lobby.metadata?.["__secret"];
      ds.lobbies.update(lobby.id, {
        metadata: next && secret ? { ...next, __secret: secret } : next,
      });
    }

    if ("members" in body && Array.isArray(body.members)) {
      const newMembers = body.members as Array<{
        id: string;
        metadata?: Record<string, string> | null;
        flags?: number;
      }>;
      const existing = ds.lobbyMembers.findBy("lobby_snowflake", lobby.snowflake);
      for (const m of existing) ds.lobbyMembers.delete(m.id);
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
      // Safe to call even if the lobby was already deleted.
      return new Response(null, { status: 204 });
    }
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

    const body = await readBody<Record<string, unknown>>(c);

    const metadata = body.metadata as Record<string, string> | null | undefined;
    // L1: When flags is omitted from the body, PRESERVE the existing member's flags (do not reset to 0).
    const flagsProvided = typeof body.flags === "number";
    const flagsValue = flagsProvided ? (body.flags as number) : 0;

    // L2: Validate metadata size.
    const metaSizeErr = validateMetadataSize(metadata);
    if (metaSizeErr) return invalidFormBody(c, { metadata: metaSizeErr });

    const existing = lobbyMemberFor(ds, lobbyId, userId);
    if (existing) {
      ds.lobbyMembers.update(existing.id, {
        metadata: metadata !== undefined ? (metadata ?? null) : existing.metadata,
        flags: flagsProvided ? flagsValue : existing.flags,
      });
      return c.json(toAPILobbyMember(lobbyMemberFor(ds, lobbyId, userId)!));
    }
    ds.lobbyMembers.insert({
      lobby_snowflake: lobbyId,
      user_snowflake: userId,
      metadata: metadata ?? null,
      flags: flagsValue,
    });
    return c.json(toAPILobbyMember(lobbyMemberFor(ds, lobbyId, userId)!));
  });

  // 8. DELETE /lobbies/:lobbyId/members/@me — registered before the :userId wildcard
  app.delete("/api/v:version/lobbies/:lobbyId/members/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    const user = callerUser(ds, auth);
    if (!user) return unauthorized(c);
    const existing = lobbyMemberFor(ds, lobbyId, user.snowflake);
    if (existing) ds.lobbyMembers.delete(existing.id);
    return new Response(null, { status: 204 });
  });

  // 9. POST /lobbies/:lobbyId/members/bulk — registered before the :userId wildcard
  app.post("/api/v:version/lobbies/:lobbyId/members/bulk", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);

    const body = await readBody<Record<string, unknown>>(c);

    const members = (body.members ?? body) as Array<{
      id: string;
      metadata?: Record<string, string> | null;
      flags?: number;
      remove_member?: boolean;
    }>;

    const upserted: DiscordLobbyMember[] = [];

    if (Array.isArray(members)) {
      for (const m of members) {
        // L4: An unknown user id must return 404 UNKNOWN_USER (10013).
        if (!m.remove_member) {
          const userExists = ds.users.findOneBy("snowflake", m.id);
          if (!userExists) return discordError(c, 404, "Unknown User", 10013);
        }
        const existing = lobbyMemberFor(ds, lobbyId, m.id);
        if (m.remove_member) {
          if (existing) ds.lobbyMembers.delete(existing.id);
        } else if (existing) {
          ds.lobbyMembers.update(existing.id, {
            metadata: m.metadata !== undefined ? (m.metadata ?? null) : existing.metadata,
            flags: m.flags ?? existing.flags,
          });
          const updated = lobbyMemberFor(ds, lobbyId, m.id);
          if (updated) upserted.push(updated);
        } else {
          ds.lobbyMembers.insert({
            lobby_snowflake: lobbyId,
            user_snowflake: m.id,
            metadata: m.metadata ?? null,
            flags: m.flags ?? 0,
          });
          const created = lobbyMemberFor(ds, lobbyId, m.id);
          if (created) upserted.push(created);
        }
      }
    }

    return c.json(upserted.map(toAPILobbyMember));
  });

  // 13a. POST /lobbies/:lobbyId/members/@me/invites — before :userId/invites
  app.post("/api/v:version/lobbies/:lobbyId/members/@me/invites", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    // Doc (lobby.mdx:292): "The lobby must have a linked channel."
    if (!lobby.linked_channel_snowflake) return forbidden(c);
    // The caller must be a member of the lobby.
    const user = callerUser(ds, auth);
    if (!user || !lobbyMemberFor(ds, lobbyId, user.snowflake)) return forbidden(c);
    // L8: Return { code } only (no lobby_id).
    return c.json({ code: snowflake() });
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
    const existing = lobbyMemberFor(ds, lobbyId, userId);
    if (existing) ds.lobbyMembers.delete(existing.id);
    return new Response(null, { status: 204 });
  });

  // 13b. POST /lobbies/:lobbyId/members/:userId/invites (Bot token)
  app.post("/api/v:version/lobbies/:lobbyId/members/:userId/invites", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    // Doc (lobby.mdx:301): "The lobby must have a linked channel."
    if (!lobby.linked_channel_snowflake) return forbidden(c);
    // The target user must be a member of the lobby.
    const targetUserId = c.req.param("userId");
    if (!lobbyMemberFor(ds, lobbyId, targetUserId)) return forbidden(c);
    // L8: Return { code } only (no lobby_id).
    return c.json({ code: snowflake() });
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

    const authorUser = callerUser(ds, auth);
    if (!authorUser) return unauthorized(c);
    // The calling user must be a member of the lobby.
    if (!lobbyMemberFor(ds, lobbyId, authorUser.snowflake)) return forbidden(c);

    const body = await readBody<Record<string, unknown>>(c);

    const content = (body.content as string | undefined) ?? "";
    if (typeof content !== "string" || content.length === 0) {
      return invalidFormBody(c, { content: "This field is required" });
    }
    const metadata = body.metadata as Record<string, string> | null | undefined;
    const flags = typeof body.flags === "number" ? body.flags : 0;

    const id = snowflake();
    ds.lobbyMessages.insert({
      snowflake: id,
      lobby_snowflake: lobbyId,
      channel_snowflake: lobby.linked_channel_snowflake,
      author_snowflake: authorUser.snowflake,
      content,
      metadata: metadata ?? null,
      flags,
      moderation_metadata: null,
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

    // The calling user must be a member of the lobby.
    const user = callerUser(ds, auth);
    if (!user || !lobbyMemberFor(ds, lobbyId, user.snowflake)) return forbidden(c);

    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const messages = ds.lobbyMessages
      .findBy("lobby_snowflake", lobbyId)
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1))
      .slice(0, limit)
      .map((msg) => toAPILobbyMessage(msg, ds, appId));

    return c.json(messages);
  });

  // 14. PUT /lobbies/:lobbyId/messages/:messageId/moderation-metadata (Bot token)
  app.put("/api/v:version/lobbies/:lobbyId/messages/:messageId/moderation-metadata", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const messageId = c.req.param("messageId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);
    const message = ds.lobbyMessages.findOneBy("snowflake", messageId);
    if (!message || message.lobby_snowflake !== lobbyId) return notFound(c);

    const body = await readBody<Record<string, unknown>>(c);

    // Up to 5 keys; key length <= 1024; value length <= 2000.
    const keys = Object.keys(body);
    if (keys.length > 5) return invalidFormBody(c, { _moderation: "A maximum of 5 keys is allowed." });
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key.length > 1024) return invalidFormBody(c, { [key]: "Key must be 1024 or fewer in length." });
      const str = typeof value === "string" ? value : String(value);
      if (str.length > 2000) return invalidFormBody(c, { [key]: "Value must be 2000 or fewer in length." });
      metadata[key] = str;
    }
    ds.lobbyMessages.update(message.id, { moderation_metadata: metadata });
    return new Response(null, { status: 204 });
  });

  // 12. PATCH /lobbies/:lobbyId/channel-linking (link / unlink)
  app.patch("/api/v:version/lobbies/:lobbyId/channel-linking", async (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const lobbyId = c.req.param("lobbyId");
    const lobby = ds.lobbies.findOneBy("snowflake", lobbyId);
    if (!lobby) return notFound(c);

    // The caller must be a lobby member holding the CanLinkLobby flag.
    const user = callerUser(ds, auth);
    const member = user ? lobbyMemberFor(ds, lobbyId, user.snowflake) : undefined;
    if (!member || (member.flags & LobbyMemberFlags.CanLinkLobby) === 0) return forbidden(c);

    const body = await readBody<Record<string, unknown>>(c);

    const channelId = (body.channel_id as string | null | undefined) ?? null;
    ds.lobbies.update(lobby.id, { linked_channel_snowflake: channelId });
    const updated = ds.lobbies.findOneBy("snowflake", lobbyId)!;
    return c.json(toAPILobby(updated, ds));
  });
}
