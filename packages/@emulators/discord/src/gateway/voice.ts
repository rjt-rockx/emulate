import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { WebSocketServer, type WebSocket, type RawData } from "ws";

/**
 * Voice connection (voice gateway) opcodes, per the Discord voice documentation. This server
 * implements a full voice connection: the WebSocket control plane (Identify -> Ready -> Select
 * Protocol -> Session Description -> Heartbeat) AND the UDP media plane — IP discovery (the
 * 74-byte request/response handshake) and reception of the RTP-encapsulated, encrypted Opus
 * packets a bot streams, which are relayed to the other identified participants in the same guild.
 * Audio is not decrypted or transcoded — the encrypted RTP payload is forwarded opaquely; a bot can
 * establish a complete voice connection, send audio, and receive the other participants' packets.
 */
export const VoiceOpcodes = {
  Identify: 0,
  SelectProtocol: 1,
  Ready: 2,
  Heartbeat: 3,
  SessionDescription: 4,
  Speaking: 5,
  HeartbeatAck: 6,
  Resume: 7,
  Hello: 8,
  Resumed: 9,
  ClientsConnect: 11,
  ClientDisconnect: 13,
} as const;

const VOICE_ENCRYPTION_MODES = [
  "aead_aes256_gcm_rtpsize",
  "aead_xchacha20_poly1305_rtpsize",
  "xsalsa20_poly1305_lite_rtpsize",
  "xsalsa20_poly1305",
];

const VOICE_HEARTBEAT_INTERVAL = 41_250;

interface VoicePayload {
  op: number;
  d?: unknown;
  seq?: number;
}

interface VoiceParticipant {
  ssrc: number;
  guildId: string;
  userId: string;
  ws: WebSocket;
  gatewayVersion: number;
  /** Learned from the participant's first RTP packet, used to relay audio to it. */
  udpRemote?: { address: string; port: number };
}

export class VoiceGatewayServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  private readonly udp = dgram.createSocket("udp4");
  private udpPort = 0;
  /** Connected participants keyed by SSRC, used to relay RTP packets within a guild. */
  private readonly participants = new Map<number, VoiceParticipant>();
  /** Count of RTP audio packets received (visible to tests/inspector). */
  rtpPacketsReceived = 0;

  constructor() {
    this.udp.on("message", (msg, rinfo) => this.onUdpMessage(msg, rinfo));
    this.udp.on("error", () => {}); // ignore transient UDP errors; the control plane drives the connection
    this.udp.bind(0, "127.0.0.1", () => {
      this.udpPort = this.udp.address().port;
    });
    if (typeof this.udp.unref === "function") this.udp.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? "";
    const vMatch = /[?&]v=(\d+)/.exec(url);
    const gatewayVersion = vMatch ? parseInt(vMatch[1], 10) : 4;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, gatewayVersion));
  }

  private onConnection(ws: WebSocket, gatewayVersion: number): void {
    this.sockets.add(ws);
    const ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const participant: VoiceParticipant = { ssrc, guildId: "", userId: "", ws, gatewayVersion };
    this.participants.set(ssrc, participant);
    this.send(ws, { op: VoiceOpcodes.Hello, d: { heartbeat_interval: VOICE_HEARTBEAT_INTERVAL } });
    ws.on("message", (raw) => this.onMessage(ws, raw, participant));
    const cleanup = () => {
      this.sockets.delete(ws);
      this.participants.delete(ssrc);
      // Notify the remaining participants in the same guild that this client disconnected.
      if (participant.guildId && participant.userId) {
        this.broadcastToGuild(participant, {
          op: VoiceOpcodes.ClientDisconnect,
          d: { user_id: participant.userId },
        });
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  /** Send a control-plane payload to every other identified participant in `from`'s guild. */
  private broadcastToGuild(from: VoiceParticipant, payload: VoicePayload): void {
    for (const p of this.participants.values()) {
      if (p === from || !p.guildId || p.guildId !== from.guildId) continue;
      this.send(p.ws, payload);
    }
  }

  /**
   * Handle a UDP datagram: the 74-byte IP-discovery request (type 0x1) is answered with a
   * discovery response (type 0x2) echoing the sender's external address/port. Anything else is
   * an RTP audio packet — its SSRC (bytes 8-12) identifies the sender, whose UDP address we
   * learn, and the packet is relayed to every other participant in the same guild.
   */
  private onUdpMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length >= 74 && msg.readUInt16BE(0) === 0x0001) {
      const ssrc = msg.readUInt32BE(4);
      const response = Buffer.alloc(74);
      response.writeUInt16BE(0x0002, 0); // response type
      response.writeUInt16BE(70, 2); // message length
      response.writeUInt32BE(ssrc, 4);
      response.write(rinfo.address, 8, "ascii"); // null-padded external address
      response.writeUInt16BE(rinfo.port, 72); // external port
      this.udp.send(response, rinfo.port, rinfo.address);
      return;
    }
    this.rtpPacketsReceived += 1;
    if (msg.length < 12) return;
    const sender = this.participants.get(msg.readUInt32BE(8));
    if (!sender) return;
    sender.udpRemote = { address: rinfo.address, port: rinfo.port };
    // Relay to other participants in the same guild that have a known UDP address.
    for (const p of this.participants.values()) {
      if (p === sender || !p.udpRemote || p.guildId !== sender.guildId) continue;
      this.udp.send(msg, p.udpRemote.port, p.udpRemote.address);
    }
  }

  private onMessage(ws: WebSocket, raw: RawData, participant: VoiceParticipant): void {
    const ssrc = participant.ssrc;
    let payload: VoicePayload;
    try {
      payload = JSON.parse(raw.toString()) as VoicePayload;
    } catch {
      return;
    }
    switch (payload.op) {
      case VoiceOpcodes.Identify: {
        // Bind this participant to its guild (server_id) so RTP can be relayed within it.
        const d = (payload.d ?? {}) as { server_id?: string; user_id?: string };
        participant.guildId = typeof d.server_id === "string" ? d.server_id : "";
        participant.userId = typeof d.user_id === "string" ? d.user_id : "";
        // Ready advertises the SSRC, the UDP media endpoint, and supported encryption modes.
        this.send(ws, {
          op: VoiceOpcodes.Ready,
          d: { ssrc, ip: "127.0.0.1", port: this.udpPort, modes: VOICE_ENCRYPTION_MODES, experiments: [] },
        });
        // Inform this client of the users already connected in the guild (Clients Connect), and
        // inform those existing participants that this user has connected.
        if (participant.guildId && participant.userId) {
          const existing = [...this.participants.values()].filter(
            (p) => p !== participant && p.guildId === participant.guildId && p.userId,
          );
          if (existing.length > 0) {
            this.send(ws, { op: VoiceOpcodes.ClientsConnect, d: { user_ids: existing.map((p) => p.userId) } });
          }
          this.broadcastToGuild(participant, {
            op: VoiceOpcodes.ClientsConnect,
            d: { user_ids: [participant.userId] },
          });
        }
        break;
      }
      case VoiceOpcodes.SelectProtocol: {
        const d = (payload.d ?? {}) as { data?: { mode?: string } };
        const mode = d.data?.mode && VOICE_ENCRYPTION_MODES.includes(d.data.mode) ? d.data.mode : VOICE_ENCRYPTION_MODES[0];
        // Session Description carries the negotiated mode, the 32-byte transport secret_key, and
        // the selected DAVE protocol version (0 = no E2EE; the actual MLS/E2EE exchange is out of
        // scope, so the emulator reports version 0).
        this.send(ws, {
          op: VoiceOpcodes.SessionDescription,
          d: { mode, secret_key: Array.from(randomBytes(32)), audio_codec: "opus", dave_protocol_version: 0 },
        });
        break;
      }
      case VoiceOpcodes.Heartbeat:
        // v8+ wraps the nonce: { d: { t: <nonce> } }. v4 echoes it directly.
        if (participant.gatewayVersion >= 8) {
          this.send(ws, { op: VoiceOpcodes.HeartbeatAck, d: { t: payload.d ?? null } });
        } else {
          this.send(ws, { op: VoiceOpcodes.HeartbeatAck, d: payload.d ?? null });
        }
        break;
      case VoiceOpcodes.Speaking: {
        const d = (payload.d ?? {}) as { speaking?: number; user_id?: string };
        this.send(ws, { op: VoiceOpcodes.Speaking, d: { speaking: d.speaking ?? 0, ssrc, user_id: d.user_id ?? "0" } });
        break;
      }
      case VoiceOpcodes.Resume:
        this.send(ws, { op: VoiceOpcodes.Resumed, d: null });
        break;
      default:
        break;
    }
  }

  private send(ws: WebSocket, payload: VoicePayload): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  close(): Promise<void> {
    for (const ws of this.sockets) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    try {
      this.udp.close();
    } catch {
      // ignore
    }
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
