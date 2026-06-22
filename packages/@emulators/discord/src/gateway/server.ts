import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { type Store } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import { snowflake, toAPIUser, toAPIGuild, toAPIMember, gatewayUrlFromBaseUrl } from "../helpers.js";
import { GatewayOpcodes, GatewayCloseCodes, HEARTBEAT_INTERVAL, type GatewayPayload } from "./opcodes.js";
import { Intents, hasIntent, intentsAllow } from "./intents.js";
import { type DiscordEventBus, type GatewayEvent } from "./dispatcher.js";
import { ZlibCompressor } from "./compression.js";
import type { GatewaySession, ResumableState } from "./session.js";

const API_VERSION = 10;
/** Max events retained per session for RESUME replay. */
const MAX_BUFFER = 1000;
/** How long a disconnected session stays resumable. */
const RESUME_TIMEOUT_MS = 120_000;

/**
 * The Discord Gateway, served over a WebSocket on the same HTTP server as REST.
 * All protocol logic (handshake, heartbeat, intent filtering, dispatch) lives here in
 * the Discord package; core only provides the raw `http.Server` via the generic
 * `ServicePlugin.attach` seam.
 */
export class GatewayServer {
  private readonly wss: WebSocketServer;
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
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    };
    this.server.on("upgrade", this.onUpgrade);
    this.unsubscribe = bus.subscribe((event) => this.fanOut(event));
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const encoding = (url.searchParams.get("encoding") ?? "json") as "json" | "etf";
    const compress = url.searchParams.get("compress");

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
      heartbeatAckPending: false,
    };
    this.sessions.add(session);

    if (encoding !== "json") {
      this.closeSession(session, GatewayCloseCodes.UnknownError, "Only JSON encoding is supported");
      return;
    }

    // discord.py defaults to transport compression; honor zlib-stream (a single zlib
    // context for the connection). Other schemes (e.g. zstd-stream) fall back to plain.
    if (compress === "zlib-stream") session.compressor = new ZlibCompressor();

    this.send(session, { op: GatewayOpcodes.Hello, d: { heartbeat_interval: HEARTBEAT_INTERVAL } });

    ws.on("message", (raw) => this.onMessage(session, raw));
    ws.on("close", () => this.removeSession(session, true));
    ws.on("error", () => this.removeSession(session, true));
  }

  private onMessage(session: GatewaySession, raw: RawData): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      this.closeSession(session, GatewayCloseCodes.DecodeError, "Invalid JSON");
      return;
    }

    switch (payload.op) {
      case GatewayOpcodes.Identify:
        this.handleIdentify(session, payload.d);
        break;
      case GatewayOpcodes.Heartbeat:
        session.heartbeatAckPending = false;
        this.send(session, { op: GatewayOpcodes.HeartbeatAck });
        break;
      case GatewayOpcodes.Resume:
        this.handleResume(session, payload.d);
        break;
      case GatewayOpcodes.RequestGuildMembers:
        this.handleRequestGuildMembers(session, payload.d);
        break;
      case GatewayOpcodes.PresenceUpdate:
      case GatewayOpcodes.VoiceStateUpdate:
        // Accepted but not acted upon.
        break;
      default:
        // Unknown opcodes are ignored (lenient).
        break;
    }
  }

  private handleIdentify(session: GatewaySession, data: unknown): void {
    if (session.identified) {
      this.closeSession(session, GatewayCloseCodes.AlreadyAuthenticated, "Already authenticated");
      return;
    }
    const d = (data ?? {}) as { token?: unknown; intents?: unknown };
    const rawToken = typeof d.token === "string" ? d.token : "";
    const token = rawToken.replace(/^Bot\s+/i, "").trim();
    const intents = typeof d.intents === "number" && Number.isInteger(d.intents) && d.intents >= 0 ? d.intents : null;

    if (intents === null) {
      this.closeSession(session, GatewayCloseCodes.InvalidIntents, "Invalid intents");
      return;
    }

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
      application: application ? { id: application.snowflake, flags: application.flags } : { id: "0", flags: 0 },
    });

    // One GUILD_CREATE per guild the bot is in.
    for (const guildId of guildIds) {
      const guild = ds.guilds.findOneBy("snowflake", guildId);
      if (guild) this.dispatch(session, "GUILD_CREATE", toAPIGuild(guild, ds, { full: true }));
    }
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
  }

  // -------------------------------------------------------------------------
  // Dispatch / fan-out
  // -------------------------------------------------------------------------

  private fanOut(event: GatewayEvent): void {
    for (const session of this.sessions) {
      if (!session.identified) continue;
      if (event.applicationId && session.applicationSnowflake !== event.applicationId) continue;
      if (!intentsAllow(session.intents, event.requiredIntents)) continue;
      if (event.guildId != null && !session.guildIds.has(event.guildId)) continue;
      this.dispatch(session, event.t, this.dataFor(session.intents, session.botUserSnowflake, event));
    }

    // Buffer matching events for disconnected-but-resumable sessions so a RESUME can replay
    // what arrived during the gap, exactly as the real Gateway does.
    for (const state of this.resumable.values()) {
      if (event.applicationId && state.applicationSnowflake !== event.applicationId) continue;
      if (!intentsAllow(state.intents, event.requiredIntents)) continue;
      if (event.guildId != null && !state.guildIds.has(event.guildId)) continue;
      state.seq += 1;
      state.buffer.push({ seq: state.seq, t: event.t, d: this.dataFor(state.intents, state.botUserSnowflake, event) });
      if (state.buffer.length > MAX_BUFFER) state.buffer.shift();
    }
  }

  /**
   * Choose the payload for a recipient. Message content is redacted only when the recipient
   * lacks the MESSAGE_CONTENT intent AND the message is in a guild AND it is neither
   * authored by, nor mentions, the recipient's bot (matching real Discord behavior).
   */
  private dataFor(intents: number, botUserSnowflake: string | null, event: GatewayEvent): unknown {
    if (event.redactedData === undefined) return event.d;
    if (hasIntent(intents, Intents.MessageContent)) return event.d;
    if (event.guildId == null) return event.d; // DMs always include content
    const bot = botUserSnowflake ?? "";
    if (event.messageAuthorId && event.messageAuthorId === bot) return event.d;
    if (event.messageMentionIds && event.messageMentionIds.includes(bot)) return event.d;
    return event.redactedData;
  }

  private dispatch(session: GatewaySession, t: string, d: unknown): void {
    session.seq += 1;
    session.buffer.push({ seq: session.seq, t, d });
    if (session.buffer.length > MAX_BUFFER) session.buffer.shift();
    this.send(session, { op: GatewayOpcodes.Dispatch, s: session.seq, t, d });
  }

  private send(session: GatewaySession, payload: GatewayPayload): void {
    if (session.ws.readyState !== session.ws.OPEN) return;
    const json = JSON.stringify(payload);
    if (session.compressor) {
      session.compressor
        .compress(json)
        .then((buf) => {
          if (session.ws.readyState === session.ws.OPEN) session.ws.send(buf);
        })
        .catch(() => {});
    } else {
      session.ws.send(json);
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

  close(): Promise<void> {
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
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
