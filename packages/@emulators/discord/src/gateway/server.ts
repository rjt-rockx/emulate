import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { deflateSync } from "node:zlib";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { type Store } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import { snowflake, toAPIUser, toAPIGuild, toAPIMember, toAPIVoiceState, gatewayUrlFromBaseUrl } from "../helpers.js";
import { GatewayOpcodes, GatewayCloseCodes, HEARTBEAT_INTERVAL, type GatewayPayload } from "./opcodes.js";
import { Intents, ALL_INTENTS, hasIntent, intentsAllow, disallowedPrivilegedIntents } from "./intents.js";
import { type DiscordEventBus, type GatewayEvent } from "./dispatcher.js";
import { ZlibCompressor } from "./compression.js";
import { VoiceGatewayServer } from "./voice.js";
import { packETF, unpackETF } from "./etf.js";
import type { GatewaySession, ResumableState } from "./session.js";

const API_VERSION = 10;
/** Max events retained per session for RESUME replay. */
const MAX_BUFFER = 1000;
/** How long a disconnected session stays resumable. */
const RESUME_TIMEOUT_MS = 120_000;

/**
 * The recipient fields the fan-out filter reads and mutates. Both live `GatewaySession`s
 * and disconnected `ResumableState`s satisfy this, so one filter path serves both.
 */
interface FanOutRecipient {
  intents: number;
  botUserSnowflake: string | null;
  applicationSnowflake: string | null;
  guildIds: Set<string>;
}

/**
 * The Discord Gateway, served over a WebSocket on the same HTTP server as REST.
 * All protocol logic (handshake, heartbeat, intent filtering, dispatch) lives here in
 * the Discord package; core only provides the raw `http.Server` via the generic
 * `ServicePlugin.attach` seam.
 */
export class GatewayServer {
  private readonly wss: WebSocketServer;
  private readonly voice = new VoiceGatewayServer();
  private readonly sessions = new Set<GatewaySession>();
  /** Disconnected-but-resumable sessions, keyed by Discord session id. */
  private readonly resumable = new Map<string, ResumableState>();
  private readonly unsubscribe: () => void;
  private readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly server: Server,
    private readonly store: Store,
    private readonly baseUrl: string,
    bus: DiscordEventBus,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.onUpgrade = (req, socket, head) => {
      // Voice connections (advertised at /voice in VOICE_SERVER_UPDATE) get the voice gateway;
      // everything else is the main gateway.
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path.startsWith("/voice")) {
        this.voice.handleUpgrade(req, socket, head);
      } else {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
      }
    };
    this.server.on("upgrade", this.onUpgrade);
    this.unsubscribe = bus.subscribe((event) => this.fanOut(event));
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /** Heartbeat interval advertised to clients (overridable via store data for testing). */
  private heartbeatInterval(): number {
    const v = this.store.getData<number>("discord.gateway.heartbeat_interval");
    return typeof v === "number" && v > 0 ? v : HEARTBEAT_INTERVAL;
  }

  /** Inbound-command rate limit per window (default Discord's 120 / 60s). */
  private commandLimit(): { limit: number; windowMs: number } {
    const limit = this.store.getData<number>("discord.gateway.command_limit");
    const windowMs = this.store.getData<number>("discord.gateway.command_window_ms");
    return {
      limit: typeof limit === "number" && limit > 0 ? limit : 120,
      windowMs: typeof windowMs === "number" && windowMs > 0 ? windowMs : 60_000,
    };
  }

  /**
   * Privileged-intent mask the app is NOT approved for (store-configurable, default 0 =
   * allow all). Requesting any of these privileged intents closes the connection with 4014.
   */
  private disallowedIntents(): number {
    const v = this.store.getData<number>("discord.gateway.disallowed_intents");
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
  }

  /**
   * Validate the optional Identify `shard` field. Returns the normalized [shard_id, num_shards]
   * pair when present and valid, `null` when absent, and `"invalid"` when malformed or out of
   * range (a non-array, wrong length, non-integer, num_shards < 1, or shard_id outside
   * `0 <= shard_id < num_shards`).
   */
  private validateShard(raw: unknown): [number, number] | null | "invalid" {
    if (raw === undefined || raw === null) return null;
    if (!Array.isArray(raw) || raw.length !== 2) return "invalid";
    const [shardId, numShards] = raw;
    if (
      typeof shardId !== "number" ||
      typeof numShards !== "number" ||
      !Number.isInteger(shardId) ||
      !Number.isInteger(numShards) ||
      numShards < 1 ||
      shardId < 0 ||
      shardId >= numShards
    ) {
      return "invalid";
    }
    return [shardId, numShards];
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const encoding = (url.searchParams.get("encoding") ?? "json") as "json" | "etf";
    const compress = url.searchParams.get("compress");
    const heartbeatInterval = this.heartbeatInterval();

    const session: GatewaySession = {
      ws,
      id: snowflake(),
      sessionId: snowflake(),
      identified: false,
      token: null,
      intents: 0,
      botUserSnowflake: null,
      applicationSnowflake: null,
      guildIds: new Set(),
      seq: 0,
      buffer: [],
      encoding,
      heartbeatInterval,
      commandWindowStart: Date.now(),
      commandCount: 0,
    };
    this.sessions.add(session);

    if (encoding !== "json" && encoding !== "etf") {
      this.closeSession(session, GatewayCloseCodes.UnknownError, "Unsupported encoding");
      return;
    }

    // discord.py defaults to transport compression; honor zlib-stream (a single zlib
    // context for the connection). Other schemes (e.g. zstd-stream) fall back to plain.
    if (compress === "zlib-stream") session.compressor = new ZlibCompressor();

    this.send(session, { op: GatewayOpcodes.Hello, d: { heartbeat_interval: heartbeatInterval } });

    ws.on("message", (raw) => this.onMessage(session, raw));
    ws.on("close", () => this.removeSession(session, true));
    ws.on("error", () => this.removeSession(session, true));
  }

  /**
   * Arm (or re-arm) the zombie timer: if the client doesn't heartbeat within ~1.5x the
   * advertised interval, the connection is declared dead and closed with 4009.
   */
  private armZombieTimer(session: GatewaySession): void {
    if (session.zombieTimer) clearTimeout(session.zombieTimer);
    const timer = setTimeout(() => {
      this.closeSession(session, GatewayCloseCodes.SessionTimedOut, "Session timed out");
    }, Math.ceil(session.heartbeatInterval * 1.5));
    if (typeof timer.unref === "function") timer.unref();
    session.zombieTimer = timer;
  }

  /** Count an inbound command; returns false if the per-window limit is exceeded. */
  private withinCommandLimit(session: GatewaySession): boolean {
    const { limit, windowMs } = this.commandLimit();
    const now = Date.now();
    if (now - session.commandWindowStart >= windowMs) {
      session.commandWindowStart = now;
      session.commandCount = 0;
    }
    session.commandCount += 1;
    return session.commandCount <= limit;
  }

  private onMessage(session: GatewaySession, raw: RawData): void {
    // Inbound frames must not exceed 4096 bytes; Discord closes with 4002 (events/gateway.mdx).
    const size = Array.isArray(raw)
      ? raw.reduce((n, b) => n + b.byteLength, 0)
      : (raw as ArrayBufferLike).byteLength;
    if (size > 4096) {
      this.closeSession(session, GatewayCloseCodes.DecodeError, "Payload exceeds 4096 bytes");
      return;
    }
    let payload: GatewayPayload;
    try {
      if (session.encoding === "etf") {
        const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
        payload = unpackETF(buf) as GatewayPayload;
      } else {
        payload = JSON.parse(raw.toString());
      }
    } catch {
      this.closeSession(session, GatewayCloseCodes.DecodeError, "Failed to decode payload");
      return;
    }

    // Per-connection command rate limit (Discord closes 4008 when exceeded).
    if (!this.withinCommandLimit(session)) {
      this.closeSession(session, GatewayCloseCodes.RateLimited, "Rate limited");
      return;
    }

    // Opcodes other than IDENTIFY/RESUME/HEARTBEAT require an established session.
    const preAuthAllowed =
      payload.op === GatewayOpcodes.Identify ||
      payload.op === GatewayOpcodes.Resume ||
      payload.op === GatewayOpcodes.Heartbeat;
    if (!session.identified && !preAuthAllowed) {
      this.closeSession(session, GatewayCloseCodes.NotAuthenticated, "Not authenticated");
      return;
    }

    switch (payload.op) {
      case GatewayOpcodes.Identify:
        this.handleIdentify(session, payload.d);
        break;
      case GatewayOpcodes.Heartbeat:
        if (session.identified) this.armZombieTimer(session); // a live heartbeat clears the zombie countdown
        this.send(session, { op: GatewayOpcodes.HeartbeatAck });
        break;
      case GatewayOpcodes.Resume:
        this.handleResume(session, payload.d);
        break;
      case GatewayOpcodes.RequestGuildMembers:
        this.handleRequestGuildMembers(session, payload.d);
        break;
      case GatewayOpcodes.VoiceStateUpdate:
        this.handleVoiceStateUpdate(session, payload.d);
        break;
      case GatewayOpcodes.PresenceUpdate:
        // Accepted but not acted upon.
        break;
      default:
        // An opcode the Gateway never receives from clients -> 4001.
        this.closeSession(session, GatewayCloseCodes.UnknownOpcode, "Unknown opcode");
        break;
    }
  }

  private handleIdentify(session: GatewaySession, data: unknown): void {
    if (session.identified) {
      this.closeSession(session, GatewayCloseCodes.AlreadyAuthenticated, "Already authenticated");
      return;
    }
    const d = (data ?? {}) as {
      token?: unknown;
      intents?: unknown;
      shard?: unknown;
      large_threshold?: unknown;
      compress?: unknown;
    };
    const rawToken = typeof d.token === "string" ? d.token : "";
    const token = rawToken.replace(/^Bot\s+/i, "").trim();
    const intents = typeof d.intents === "number" && Number.isInteger(d.intents) && d.intents >= 0 ? d.intents : null;

    // 4013 for a non-integer/negative value OR for any bit outside the valid intent set
    // (events/gateway.mdx: "invalid intents"). ALL_INTENTS is the OR of every defined bit.
    if (intents === null || (intents & ~ALL_INTENTS) !== 0) {
      this.closeSession(session, GatewayCloseCodes.InvalidIntents, "Invalid intents");
      return;
    }

    // Sharding: `shard` is an optional [shard_id, num_shards] pair. Validate the bounds
    // (0 <= shard_id < num_shards, both non-negative integers) and reject with 4010 otherwise.
    const shard = this.validateShard(d.shard);
    if (shard === "invalid") {
      this.closeSession(session, GatewayCloseCodes.InvalidShard, "Invalid shard");
      return;
    }

    // Privileged intents the app is not approved for close the connection with 4014. The
    // emulator reads the disallowed-privileged mask from store data (default 0 = allow all).
    const disallowedMask = this.disallowedIntents();
    if (disallowedPrivilegedIntents(intents, disallowedMask) !== 0) {
      this.closeSession(session, GatewayCloseCodes.DisallowedIntents, "Disallowed intents");
      return;
    }

    // large_threshold (50-250, default 50) is read and clamped to the documented range. The
    // emulator always sends the full member list, so the value is accepted for parity but not
    // otherwise acted upon.
    const _largeThreshold =
      typeof d.large_threshold === "number" && Number.isInteger(d.large_threshold)
        ? Math.min(250, Math.max(50, d.large_threshold))
        : 50;
    void _largeThreshold;

    // Honor Identify-level payload compression (compress: true) when no transport compression was
    // negotiated on the URL. Unlike transport zlib-stream (one shared context), Identify-level
    // compression makes each payload an independent, complete zlib block, so it uses a per-message
    // deflate rather than the streaming ZlibCompressor.
    if (d.compress === true && !session.compressor) session.payloadDeflate = true;

    const ds = getDiscordStore(this.store);
    const tokenRecord = ds.tokens.findOneBy("token", token);
    if (!tokenRecord || tokenRecord.type !== "bot") {
      this.closeSession(session, GatewayCloseCodes.AuthenticationFailed, "Authentication failed");
      return;
    }

    const botUser = ds.users.findOneBy("snowflake", tokenRecord.user_snowflake);
    if (!botUser) {
      this.closeSession(session, GatewayCloseCodes.AuthenticationFailed, "Authentication failed");
      return;
    }
    const application = tokenRecord.application_snowflake
      ? ds.applications.findOneBy("snowflake", tokenRecord.application_snowflake)
      : ds.applications.findOneBy("bot_user_snowflake", botUser.snowflake);

    const guildIds = new Set(
      ds.members.findBy("user_snowflake", botUser.snowflake).map((m) => m.guild_snowflake),
    );

    session.identified = true;
    session.token = token;
    session.intents = intents;
    session.botUserSnowflake = botUser.snowflake;
    session.applicationSnowflake = application?.snowflake ?? null;
    session.guildIds = guildIds;

    ds.gatewaySessions.insert({
      session_id: session.sessionId,
      bot_user_snowflake: botUser.snowflake,
      application_snowflake: application?.snowflake ?? null,
      intents,
      connected_at: new Date().toISOString(),
    });

    // READY
    this.dispatch(session, "READY", {
      v: API_VERSION,
      user: { ...toAPIUser(botUser, true), bot: true },
      guilds: [...guildIds].map((id) => ({ id, unavailable: true })),
      session_id: session.sessionId,
      resume_gateway_url: gatewayUrlFromBaseUrl(this.baseUrl),
      // `shard` is echoed back only when the client supplied it when identifying.
      ...(shard ? { shard } : {}),
      application: application ? { id: application.snowflake, flags: application.flags } : { id: "0", flags: 0 },
      geo_ordered_rtc_regions: [],
    });

    // One GUILD_CREATE per guild the bot is in.
    for (const guildId of guildIds) {
      const guild = ds.guilds.findOneBy("snowflake", guildId);
      if (guild) this.dispatch(session, "GUILD_CREATE", toAPIGuild(guild, ds, { full: true }));
    }

    this.armZombieTimer(session);
  }

  private handleRequestGuildMembers(session: GatewaySession, data: unknown): void {
    if (!session.identified) return;
    const d = (data ?? {}) as { guild_id?: string; user_ids?: string[] | string; nonce?: string; limit?: number };
    const guildId = typeof d.guild_id === "string" ? d.guild_id : "";
    if (!guildId || !session.guildIds.has(guildId)) return;
    const ds = getDiscordStore(this.store);
    let members = ds.members.findBy("guild_snowflake", guildId);
    if (d.user_ids) {
      const ids = new Set(Array.isArray(d.user_ids) ? d.user_ids : [d.user_ids]);
      members = members.filter((m) => ids.has(m.user_snowflake));
    }
    this.dispatch(session, "GUILD_MEMBERS_CHUNK", {
      guild_id: guildId,
      members: members.map((m) => toAPIMember(m, ds)),
      chunk_index: 0,
      chunk_count: 1,
      ...(d.nonce ? { nonce: d.nonce } : {}),
    });
  }

  /**
   * RESUME (op 6): re-bind a reconnecting client to a session left behind by a recent
   * disconnect, replay every buffered event newer than the client's last seq, then send
   * RESUMED. A missing session id or token mismatch yields InvalidSession(false), telling
   * the client to start over with a fresh IDENTIFY.
   */
  private handleResume(session: GatewaySession, data: unknown): void {
    if (session.identified) {
      this.closeSession(session, GatewayCloseCodes.AlreadyAuthenticated, "Already authenticated");
      return;
    }
    const d = (data ?? {}) as { token?: unknown; session_id?: unknown; seq?: unknown };
    const rawToken = typeof d.token === "string" ? d.token : "";
    const token = rawToken.replace(/^Bot\s+/i, "").trim();
    const sessionId = typeof d.session_id === "string" ? d.session_id : "";
    const clientSeq = typeof d.seq === "number" && Number.isFinite(d.seq) ? d.seq : 0;

    const state = this.resumable.get(sessionId);
    if (!state || state.token !== token) {
      this.send(session, { op: GatewayOpcodes.InvalidSession, d: false });
      return;
    }
    // A seq beyond anything we ever dispatched is invalid -> 4007.
    if (clientSeq > state.seq) {
      this.closeSession(session, GatewayCloseCodes.InvalidSeq, "Invalid seq");
      return;
    }

    // Consume the snapshot and graft it onto the new connection, keeping the same session id.
    clearTimeout(state.timer);
    this.resumable.delete(sessionId);
    session.identified = true;
    session.sessionId = state.sessionId;
    session.token = state.token;
    session.intents = state.intents;
    session.botUserSnowflake = state.botUserSnowflake;
    session.applicationSnowflake = state.applicationSnowflake;
    session.guildIds = state.guildIds;
    session.seq = state.seq;
    session.buffer = state.buffer;

    const ds = getDiscordStore(this.store);
    if (!ds.gatewaySessions.findOneBy("session_id", session.sessionId)) {
      ds.gatewaySessions.insert({
        session_id: session.sessionId,
        bot_user_snowflake: session.botUserSnowflake ?? "",
        application_snowflake: session.applicationSnowflake,
        intents: session.intents,
        connected_at: new Date().toISOString(),
      });
    }

    // Replay missed events at their original sequence numbers, then RESUMED.
    for (const event of session.buffer) {
      if (event.seq > clientSeq) {
        this.send(session, { op: GatewayOpcodes.Dispatch, s: event.seq, t: event.t, d: event.d });
      }
    }
    this.dispatch(session, "RESUMED", {});
    this.armZombieTimer(session);
  }

  /**
   * Voice State Update (op 4): the bot is joining, moving between, or leaving a voice channel.
   * Persists the voice state, broadcasts VOICE_STATE_UPDATE to the guild, and (on join/move)
   * sends VOICE_SERVER_UPDATE to the joining session with a token and the voice endpoint host.
   * Note: real-time audio transport (the voice WebSocket + UDP/RTP) is not emulated; this
   * covers the signaling/state plane that voice-aware bots and libraries depend on.
   */
  private handleVoiceStateUpdate(session: GatewaySession, data: unknown): void {
    if (!session.identified || !session.botUserSnowflake) return;
    const d = (data ?? {}) as {
      guild_id?: string;
      channel_id?: string | null;
      self_mute?: boolean;
      self_deaf?: boolean;
      self_video?: boolean;
    };
    const guildId = typeof d.guild_id === "string" ? d.guild_id : null;
    if (!guildId) return; // DM/private-call voice is not emulated
    const ds = getDiscordStore(this.store);
    const userId = session.botUserSnowflake;
    const existing = ds.voiceStates.findBy("guild_snowflake", guildId).find((v) => v.user_snowflake === userId);

    if (d.channel_id == null) {
      // Leaving voice.
      if (existing) ds.voiceStates.delete(existing.id);
      this.fanOut({
        t: "VOICE_STATE_UPDATE",
        guildId,
        requiredIntents: Intents.GuildVoiceStates,
        d: {
          guild_id: guildId,
          channel_id: null,
          user_id: userId,
          session_id: session.sessionId,
          deaf: false,
          mute: false,
          self_deaf: d.self_deaf ?? false,
          self_mute: d.self_mute ?? false,
          self_video: d.self_video ?? false,
          suppress: false,
          request_to_speak_timestamp: null,
        },
      });
      return;
    }

    // Joining or moving.
    const fields = {
      guild_snowflake: guildId,
      channel_snowflake: d.channel_id,
      user_snowflake: userId,
      session_id: session.sessionId,
      deaf: false,
      mute: false,
      self_deaf: d.self_deaf ?? false,
      self_mute: d.self_mute ?? false,
      self_video: d.self_video ?? false,
      suppress: false,
      request_to_speak_timestamp: null,
    };
    if (existing) ds.voiceStates.update(existing.id, fields);
    else ds.voiceStates.insert(fields);
    const state = ds.voiceStates.findBy("guild_snowflake", guildId).find((v) => v.user_snowflake === userId)!;

    this.fanOut({
      t: "VOICE_STATE_UPDATE",
      guildId,
      requiredIntents: Intents.GuildVoiceStates,
      d: toAPIVoiceState(state, ds),
    });
    // Endpoint host + /voice path (no scheme), pointing at this emulator's voice gateway.
    const endpoint = `${this.baseUrl.replace(/^https?:\/\//, "")}/voice`;
    this.dispatch(session, "VOICE_SERVER_UPDATE", { token: `voice_${snowflake()}`, guild_id: guildId, endpoint });
  }

  // -------------------------------------------------------------------------
  // Dispatch / fan-out
  // -------------------------------------------------------------------------

  private fanOut(event: GatewayEvent): void {
    for (const session of this.sessions) {
      if (!session.identified) continue;
      this.routeToRecipient(session, event, (payload) => this.dispatch(session, event.t, payload));
    }

    // Buffer matching events for disconnected-but-resumable sessions so a RESUME can replay
    // what arrived during the gap, exactly as the real Gateway does.
    for (const state of this.resumable.values()) {
      this.routeToRecipient(state, event, (payload) => {
        state.seq += 1;
        state.buffer.push({ seq: state.seq, t: event.t, d: payload });
        if (state.buffer.length > MAX_BUFFER) state.buffer.shift();
      });
    }
  }

  /**
   * Apply the shared fan-out filter to one recipient and, when the event is deliverable,
   * invoke `deliver` with the recipient-appropriate payload. Centralizing the membership,
   * intent, and content-redaction logic here keeps the live-session and resumable-buffer
   * paths from drifting apart.
   */
  private routeToRecipient(r: FanOutRecipient, event: GatewayEvent, deliver: (payload: unknown) => void): void {
    if (event.applicationId && r.applicationSnowflake !== event.applicationId) return;

    // Membership transition targeted at one bot, bypassing the guild-membership filter:
    // a bot added to a guild mid-session (GUILD_CREATE) is not yet "in" the guild, and a
    // leaving bot (GUILD_DELETE) must still receive the event before we drop the guild.
    if (event.targetUserId) {
      if (r.botUserSnowflake !== event.targetUserId) return;
      if (event.t === "GUILD_CREATE" && event.guildId) r.guildIds.add(event.guildId);
      deliver(event.d);
      if (event.t === "GUILD_DELETE" && event.guildId) r.guildIds.delete(event.guildId);
      return;
    }

    if (!intentsAllow(r.intents, event.requiredIntents)) return;
    if (event.guildId != null && !r.guildIds.has(event.guildId)) return;
    deliver(this.dataFor(r.intents, r.botUserSnowflake, event));
    // A whole-guild delete (broadcast, untargeted) drops it from every recipient's set.
    if (event.t === "GUILD_DELETE" && event.guildId) r.guildIds.delete(event.guildId);
  }

  /**
   * Choose the payload for a recipient. Message content is redacted only when the recipient
   * lacks the MESSAGE_CONTENT intent AND the message is in a guild AND it is neither
   * authored by, nor mentions, the recipient's bot (matching real Discord behavior).
   */
  private dataFor(intents: number, botUserSnowflake: string | null, event: GatewayEvent): unknown {
    return this.withGatewayGuildId(event, this.chooseData(intents, botUserSnowflake, event));
  }

  /** Pick the (possibly content-redacted) base payload for a recipient. */
  private chooseData(intents: number, botUserSnowflake: string | null, event: GatewayEvent): unknown {
    if (event.redactedData === undefined) return event.d;
    if (hasIntent(intents, Intents.MessageContent)) return event.d;
    if (event.guildId == null) return event.d; // DMs always include content
    const bot = botUserSnowflake ?? "";
    if (event.messageAuthorId && event.messageAuthorId === bot) return event.d;
    if (event.messageMentionIds && event.messageMentionIds.includes(bot)) return event.d;
    return event.redactedData;
  }

  /**
   * The REST message shape omits guild_id (it is not part of MessageResponse), but gateway
   * MESSAGE_CREATE/MESSAGE_UPDATE payloads carry it. Inject it here — cloning, never mutating the
   * shared REST payload object — so the one serializer stays REST-correct.
   */
  private withGatewayGuildId(event: GatewayEvent, data: unknown): unknown {
    if (event.t !== "MESSAGE_CREATE" && event.t !== "MESSAGE_UPDATE") return data;
    if (event.guildId == null || data == null || typeof data !== "object") return data;
    return { ...(data as Record<string, unknown>), guild_id: event.guildId };
  }

  private dispatch(session: GatewaySession, t: string, d: unknown): void {
    session.seq += 1;
    session.buffer.push({ seq: session.seq, t, d });
    if (session.buffer.length > MAX_BUFFER) session.buffer.shift();
    this.send(session, { op: GatewayOpcodes.Dispatch, s: session.seq, t, d });
  }

  private send(session: GatewaySession, payload: GatewayPayload): void {
    if (session.ws.readyState !== session.ws.OPEN) return;
    const encoded: string | Buffer = session.encoding === "etf" ? packETF(payload) : JSON.stringify(payload);
    if (session.compressor) {
      // Transport zlib-stream: one shared, Z_SYNC_FLUSH-terminated stream.
      session.compressor
        .compress(encoded)
        .then((buf) => {
          if (session.ws.readyState === session.ws.OPEN) session.ws.send(buf);
        })
        .catch(() => {});
    } else if (session.payloadDeflate) {
      // Identify-level compress:true: each payload is an independent, complete zlib block.
      session.ws.send(deflateSync(typeof encoded === "string" ? Buffer.from(encoded) : encoded));
    } else {
      session.ws.send(encoded);
    }
  }

  private closeSession(session: GatewaySession, code: number, reason: string): void {
    try {
      session.ws.close(code, reason);
    } catch {
      // ignore
    }
    this.removeSession(session);
  }

  private removeSession(session: GatewaySession, resumable = false): void {
    if (!this.sessions.has(session)) return;
    this.sessions.delete(session);
    if (session.zombieTimer) clearTimeout(session.zombieTimer);
    session.compressor?.close();
    const ds = getDiscordStore(this.store);
    const record = ds.gatewaySessions.findOneBy("session_id", session.sessionId);
    if (record) ds.gatewaySessions.delete(record.id);

    // Retain an identified session briefly so the client can RESUME and replay missed events.
    if (resumable && session.identified && session.token && !this.resumable.has(session.sessionId)) {
      const timer = setTimeout(() => this.resumable.delete(session.sessionId), RESUME_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      this.resumable.set(session.sessionId, {
        sessionId: session.sessionId,
        token: session.token,
        intents: session.intents,
        botUserSnowflake: session.botUserSnowflake,
        applicationSnowflake: session.applicationSnowflake,
        guildIds: session.guildIds,
        seq: session.seq,
        buffer: session.buffer,
        timer,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    this.unsubscribe();
    this.server.off("upgrade", this.onUpgrade);
    for (const session of this.sessions) {
      try {
        session.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    for (const state of this.resumable.values()) clearTimeout(state.timer);
    this.resumable.clear();
    await this.voice.close();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
