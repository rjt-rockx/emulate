import type { WebSocket } from "ws";

/** Per-connection Gateway state held in memory by the GatewayServer. */
export interface GatewaySession {
  ws: WebSocket;
  /** Internal connection id (also used as the inspector record key). */
  id: string;
  /** Discord session id surfaced in READY / resume. */
  sessionId: string;
  identified: boolean;
  intents: number;
  botUserSnowflake: string | null;
  applicationSnowflake: string | null;
  /** Guild ids the bot is a member of (drives guild-scoped event filtering). */
  guildIds: Set<string>;
  /** Last sequence number sent on this connection. */
  seq: number;
  encoding: "json" | "etf";
  heartbeatAckPending: boolean;
}
