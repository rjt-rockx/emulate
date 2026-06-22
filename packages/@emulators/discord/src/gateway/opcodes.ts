/** Discord Gateway opcodes (mirror of discord-api-types GatewayOpcodes, v10). */
export const GatewayOpcodes = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  RequestGuildMembers: 8,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

/** Gateway close codes the emulator may send. */
export const GatewayCloseCodes = {
  UnknownError: 4000,
  UnknownOpcode: 4001,
  DecodeError: 4002,
  NotAuthenticated: 4003,
  AuthenticationFailed: 4004,
  AlreadyAuthenticated: 4005,
  InvalidSeq: 4007,
  RateLimited: 4008,
  SessionTimedOut: 4009,
  InvalidShard: 4010,
  ShardingRequired: 4011,
  InvalidApiVersion: 4012,
  InvalidIntents: 4013,
  DisallowedIntents: 4014,
} as const;

/** Heartbeat interval advertised in the Hello payload (ms). */
export const HEARTBEAT_INTERVAL = 41_250;

/** Universal gateway payload envelope: { op, d, s, t }. */
export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}
