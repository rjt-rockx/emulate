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
 * packets a bot streams. The one thing that does not happen is relaying that audio to other
 * participants, because in the emulator there are none; a bot can otherwise establish a complete
 * voice connection and send audio that the server receives.
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

export class VoiceGatewayServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  private readonly udp = dgram.createSocket("udp4");
  private udpPort = 0;
  /** Count of RTP audio packets received (visible to tests/inspector). */
  rtpPacketsReceived = 0;

  constructor() {
    this.udp.on("message", (msg, rinfo) => this.onUdpMessage(msg, rinfo));
    this.udp.on("error", () => {});
    this.udp.bind(0, "127.0.0.1", () => {
      this.udpPort = this.udp.address().port;
    });
    if (typeof this.udp.unref === "function") this.udp.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    const ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.send(ws, { op: VoiceOpcodes.Hello, d: { heartbeat_interval: VOICE_HEARTBEAT_INTERVAL } });
    ws.on("message", (raw) => this.onMessage(ws, raw, ssrc));
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("error", () => this.sockets.delete(ws));
  }

  /**
   * Handle a UDP datagram: the 74-byte IP-discovery request (type 0x1) is answered with a
   * discovery response (type 0x2) echoing the sender's external address/port; anything else is
   * treated as an RTP audio packet and accepted (received, not relayed).
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
  }

  private onMessage(ws: WebSocket, raw: RawData, ssrc: number): void {
    let payload: VoicePayload;
    try {
      payload = JSON.parse(raw.toString()) as VoicePayload;
    } catch {
      return;
    }
    switch (payload.op) {
      case VoiceOpcodes.Identify:
        // Ready advertises the SSRC, the UDP media endpoint, and supported encryption modes.
        this.send(ws, {
          op: VoiceOpcodes.Ready,
          d: { ssrc, ip: "127.0.0.1", port: this.udpPort, modes: VOICE_ENCRYPTION_MODES, experiments: [] },
        });
        break;
      case VoiceOpcodes.SelectProtocol: {
        const d = (payload.d ?? {}) as { data?: { mode?: string } };
        const mode = d.data?.mode && VOICE_ENCRYPTION_MODES.includes(d.data.mode) ? d.data.mode : VOICE_ENCRYPTION_MODES[0];
        this.send(ws, {
          op: VoiceOpcodes.SessionDescription,
          d: { mode, secret_key: Array.from(randomBytes(32)), audio_codec: "opus" },
        });
        break;
      }
      case VoiceOpcodes.Heartbeat:
        // v4 echoes the heartbeat nonce back in the ack.
        this.send(ws, { op: VoiceOpcodes.HeartbeatAck, d: payload.d ?? null });
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
