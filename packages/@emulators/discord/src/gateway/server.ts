import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { type Store } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import { snowflake, toAPIUser, toAPIGuild, gatewayUrlFromBaseUrl } from "../helpers.js";
import { GatewayOpcodes, GatewayCloseCodes, HEARTBEAT_INTERVAL, type GatewayPayload } from "./opcodes.js";
import { Intents, hasIntent, intentsAllow } from "./intents.js";
import { type DiscordEventBus, type GatewayEvent } from "./dispatcher.js";
import type { GatewaySession } from "./session.js";

const API_VERSION = 10;

/**
 * The Discord Gateway, served over a WebSocket on the same HTTP server as REST.
 * All protocol logic (handshake, heartbeat, intent filtering, dispatch) lives here in
 * the Discord package; core only provides the raw `http.Server` via the generic
 * `ServicePlugin.attach` seam.
 */
export class GatewayServer {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<GatewaySession>();
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

    const session: GatewaySession = {
      ws,
      id: snowflake(),
      sessionId: snowflake(),
      identified: false,
      intents: 0,
      botUserSnowflake: null,
      applicationSnowflake: null,
      guildIds: new Set(),
      seq: 0,
      encoding,
      heartbeatAckPending: false,
    };
    this.sessions.add(session);

    if (encoding !== "json") {
      this.closeSession(session, GatewayCloseCodes.UnknownError, "Only JSON encoding is supported");
      return;
    }

    this.send(session, { op: GatewayOpcodes.Hello, d: { heartbeat_interval: HEARTBEAT_INTERVAL } });

    ws.on("message", (raw) => this.onMessage(session, raw));
    ws.on("close", () => this.removeSession(session));
    ws.on("error", () => this.removeSession(session));
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
        // No replay buffer in P1: force a fresh identify.
        this.send(session, { op: GatewayOpcodes.InvalidSession, d: false });
        break;
      case GatewayOpcodes.PresenceUpdate:
      case GatewayOpcodes.VoiceStateUpdate:
      case GatewayOpcodes.RequestGuildMembers:
        // Accepted but not acted upon in P1.
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

  // -------------------------------------------------------------------------
  // Dispatch / fan-out
  // -------------------------------------------------------------------------

  private fanOut(event: GatewayEvent): void {
    for (const session of this.sessions) {
      if (!session.identified) continue;
      if (!intentsAllow(session.intents, event.requiredIntents)) continue;
      if (event.guildId != null && !session.guildIds.has(event.guildId)) continue;
      const data =
        event.redactedData !== undefined && !hasIntent(session.intents, Intents.MessageContent)
          ? event.redactedData
          : event.d;
      this.dispatch(session, event.t, data);
    }
  }

  private dispatch(session: GatewaySession, t: string, d: unknown): void {
    session.seq += 1;
    this.send(session, { op: GatewayOpcodes.Dispatch, s: session.seq, t, d });
  }

  private send(session: GatewaySession, payload: GatewayPayload): void {
    if (session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify(payload));
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

  private removeSession(session: GatewaySession): void {
    if (!this.sessions.has(session)) return;
    this.sessions.delete(session);
    const ds = getDiscordStore(this.store);
    const record = ds.gatewaySessions.findOneBy("session_id", session.sessionId);
    if (record) ds.gatewaySessions.delete(record.id);
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
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
