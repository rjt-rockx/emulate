import type { WebSocket } from "ws";
import type { ZlibCompressor } from "./compression.js";

/** A dispatched event retained so a resuming client can replay what it missed. */
export interface BufferedEvent {
  seq: number;
  t: string;
  d: unknown;
}

/** Per-connection Gateway state held in memory by the GatewayServer. */
export interface GatewaySession {
  ws: WebSocket;
  /** Internal connection id (also used as the inspector record key). */
  id: string;
  /** Discord session id surfaced in READY / resume. */
  sessionId: string;
  identified: boolean;
  /** Bot token this session authenticated with (validated on RESUME). */
  token: string | null;
  intents: number;
  botUserSnowflake: string | null;
  applicationSnowflake: string | null;
  /** Guild ids the bot is a member of (drives guild-scoped event filtering). */
  guildIds: Set<string>;
  /** Last sequence number sent on this connection. */
  seq: number;
  /** Recently dispatched events, retained for RESUME replay (bounded). */
  buffer: BufferedEvent[];
  encoding: "json" | "etf";
  /** Set when the connection requested transport compression (zlib-stream): one shared zlib stream. */
  compressor?: ZlibCompressor;
  /**
   * Set when the connection requested Identify-level payload compression (`compress: true`) and no
   * transport compression. Each dispatched payload is its own independent, complete zlib block —
   * distinct from the shared-context `compressor` stream above.
   */
  payloadDeflate?: boolean;
  /** Heartbeat interval (ms) advertised to this connection; drives zombie detection. */
  heartbeatInterval: number;
  /** Timer that closes the connection (4009) if no heartbeat arrives in time. */
  zombieTimer?: ReturnType<typeof setTimeout>;
  /** Start of the current command-rate-limit window (ms epoch). */
  commandWindowStart: number;
  /** Number of inbound commands counted in the current window. */
  commandCount: number;
}

/**
 * Snapshot of an identified session kept after disconnect so a reconnecting client can
 * RESUME: replay buffered events newer than the client's last seq, then receive RESUMED.
 */
export interface ResumableState {
  sessionId: string;
  token: string;
  intents: number;
  botUserSnowflake: string | null;
  applicationSnowflake: string | null;
  guildIds: Set<string>;
  seq: number;
  buffer: BufferedEvent[];
  timer: ReturnType<typeof setTimeout>;
}
