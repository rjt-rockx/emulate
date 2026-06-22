import { describe, it, expect, afterEach } from "vitest";
import dgram from "node:dgram";
import WebSocket from "ws";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "./helpers.js";
import { VoiceOpcodes } from "../gateway/voice.js";

interface VoiceFrame {
  op: number;
  d?: unknown;
}

function connectVoice(url: string): Promise<{ ws: WebSocket; next: (timeout?: number) => Promise<VoiceFrame> }> {
  const ws = new WebSocket(url);
  ws.on("error", () => void 0);
  const buffer: VoiceFrame[] = [];
  const waiters: Array<(f: VoiceFrame) => void> = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as VoiceFrame;
    const w = waiters.shift();
    if (w) w(frame);
    else buffer.push(frame);
  });
  const next = (timeout = 3000) => {
    const queued = buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<VoiceFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("voice frame timeout")), timeout);
      waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, next }));
    ws.once("error", reject);
  });
}

describe("voice gateway handshake", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("completes Hello -> Identify -> Ready -> Select Protocol -> Session Description -> Heartbeat", async () => {
    emu = await startDiscordTestEmulator();
    const voiceUrl = `${emu.gatewayUrl}voice?v=4`;
    const { ws, next } = await connectVoice(voiceUrl);
    sockets.push(ws);

    const hello = await next();
    expect(hello.op).toBe(VoiceOpcodes.Hello);
    expect((hello.d as { heartbeat_interval: number }).heartbeat_interval).toBeGreaterThan(0);

    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "abc", token: "voice_tok" } }));
    const ready = await next();
    expect(ready.op).toBe(VoiceOpcodes.Ready);
    const readyData = ready.d as { ssrc: number; modes: string[]; ip: string };
    expect(readyData.ssrc).toBeGreaterThan(0);
    expect(readyData.modes).toContain("aead_xchacha20_poly1305_rtpsize");

    ws.send(JSON.stringify({ op: VoiceOpcodes.SelectProtocol, d: { protocol: "udp", data: { address: "127.0.0.1", port: 50000, mode: "aead_xchacha20_poly1305_rtpsize" } } }));
    const desc = await next();
    expect(desc.op).toBe(VoiceOpcodes.SessionDescription);
    const descData = desc.d as { mode: string; secret_key: number[] };
    expect(descData.mode).toBe("aead_xchacha20_poly1305_rtpsize");
    expect(descData.secret_key).toHaveLength(32);

    ws.send(JSON.stringify({ op: VoiceOpcodes.Heartbeat, d: 12345 }));
    const ack = await next();
    expect(ack.op).toBe(VoiceOpcodes.HeartbeatAck);
    expect(ack.d).toBe(12345);
  });

  it("performs UDP IP discovery and accepts RTP audio packets", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=4`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "abc", token: "t" } }));
    const ready = await next();
    const { ssrc, ip, port } = ready.d as { ssrc: number; ip: string; port: number };
    expect(port).toBeGreaterThan(0);

    const udp = dgram.createSocket("udp4");
    try {
      // IP discovery: 74-byte request -> 74-byte response echoing our external address/port.
      const discovery = await new Promise<Buffer>((resolve, reject) => {
        udp.on("message", (msg) => resolve(msg));
        udp.on("error", reject);
        const req = Buffer.alloc(74);
        req.writeUInt16BE(0x0001, 0);
        req.writeUInt16BE(70, 2);
        req.writeUInt32BE(ssrc, 4);
        udp.send(req, port, ip);
        setTimeout(() => reject(new Error("discovery timeout")), 3000);
      });
      expect(discovery.readUInt16BE(0)).toBe(0x0002);
      expect(discovery.readUInt32BE(4)).toBe(ssrc);
      const discoveredPort = discovery.readUInt16BE(72);
      expect(discoveredPort).toBeGreaterThan(0);

      // Send a (dummy) RTP audio packet; the server should accept and count it.
      const rtp = Buffer.alloc(32);
      rtp[0] = 0x80;
      rtp[1] = 0x78; // payload type 120 (Opus)
      rtp.writeUInt32BE(ssrc, 8);
      await new Promise<void>((resolve) => udp.send(rtp, port, ip, () => resolve()));
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      udp.close();
    }
    ws.close();
  });

  it("relays RTP audio between two participants in the same guild", async () => {
    emu = await startDiscordTestEmulator();

    // Bring two voice connections (same server_id) to the media stage.
    const join = async (userId: string) => {
      const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=4`);
      sockets.push(ws);
      await next(); // Hello
      ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "guild-1", user_id: userId, session_id: "s", token: "t" } }));
      const ready = await next();
      return { ws, ...(ready.d as { ssrc: number; ip: string; port: number }) };
    };
    const a = await join("user-a");
    const b = await join("user-b");

    const udpA = dgram.createSocket("udp4");
    const udpB = dgram.createSocket("udp4");
    try {
      // B binds and registers its UDP address by sending one packet (so the server learns it).
      const primer = Buffer.alloc(32);
      primer[0] = 0x80;
      primer.writeUInt32BE(b.ssrc, 8);
      await new Promise<void>((r) => udpB.send(primer, b.port, b.ip, () => r()));
      await new Promise((r) => setTimeout(r, 50));

      // A sends an audio packet; the server should relay it to B's UDP socket.
      const received = new Promise<Buffer>((resolve, reject) => {
        udpB.on("message", (m) => resolve(m));
        setTimeout(() => reject(new Error("no relayed packet")), 2000);
      });
      const packet = Buffer.alloc(40);
      packet[0] = 0x80;
      packet[1] = 0x78;
      packet.writeUInt32BE(a.ssrc, 8);
      packet.write("AUDIO", 12, "ascii");
      await new Promise<void>((r) => udpA.send(packet, a.port, a.ip, () => r()));

      const relayed = await received;
      expect(relayed.readUInt32BE(8)).toBe(a.ssrc); // carries A's SSRC
      expect(relayed.subarray(12, 17).toString("ascii")).toBe("AUDIO");
    } finally {
      udpA.close();
      udpB.close();
    }
    a.ws.close();
    b.ws.close();
  });
});
