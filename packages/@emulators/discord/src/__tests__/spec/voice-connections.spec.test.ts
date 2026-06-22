/**
 * Spec suite for `developers/topics/voice-connections.mdx`.
 *
 * Encodes the documented voice connection lifecycle: the voice gateway opcodes, the handshake
 * order (Hello -> Identify -> Ready -> Select Protocol -> Session Description -> Heartbeat), the
 * Ready/Session Description payload shapes, the encryption modes list, the UDP IP Discovery
 * packet format (74-byte 0x1 request / 0x2 response), RTP relay, and Resume.
 *
 * Out of scope (documented as not bit-identical): the actual voice payload encryption
 * (libsodium / AEAD), the DAVE / E2EE (MLS) protocol opcodes, and the v8 binary sequence-number
 * framing. These specs assert the JSON handshake/shape contract that IS emulated, not the crypto
 * or binary framing. The voice gateway opens real WebSocket + UDP sockets; we follow the existing
 * voiceGateway.test.ts patterns (afterEach close, ws.on('error',...)) to avoid flakiness.
 */
import { describe, it, expect, afterEach } from "vitest";
import dgram from "node:dgram";
import WebSocket from "ws";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "../helpers.js";
import { VoiceOpcodes } from "../../gateway/voice.js";

interface VoiceFrame {
  op: number;
  d?: unknown;
  seq?: number;
}

/** Open a voice-gateway WebSocket and expose a promise-based `next()` frame reader. */
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

describe("voice-connections.mdx — Voice Gateway opcodes", () => {
  it("defines every documented voice opcode with the correct numeric value", () => {
    // From the opcodes referenced throughout the page.
    expect(VoiceOpcodes.Identify).toBe(0);
    expect(VoiceOpcodes.SelectProtocol).toBe(1);
    expect(VoiceOpcodes.Ready).toBe(2);
    expect(VoiceOpcodes.Heartbeat).toBe(3);
    expect(VoiceOpcodes.SessionDescription).toBe(4);
    expect(VoiceOpcodes.Speaking).toBe(5);
    expect(VoiceOpcodes.HeartbeatAck).toBe(6);
    expect(VoiceOpcodes.Resume).toBe(7);
    expect(VoiceOpcodes.Hello).toBe(8);
    expect(VoiceOpcodes.Resumed).toBe(9);
    expect(VoiceOpcodes.ClientsConnect).toBe(11);
    expect(VoiceOpcodes.ClientDisconnect).toBe(13);
  });
});

describe("voice-connections.mdx — Handshake lifecycle", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("sends Opcode 8 Hello first, with a positive heartbeat_interval", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    const hello = await next();
    // The handshake opens with Hello (op 8); heartbeat_interval comes from here, not Ready.
    expect(hello.op).toBe(VoiceOpcodes.Hello);
    const d = hello.d as { heartbeat_interval: number };
    expect(typeof d.heartbeat_interval).toBe("number");
    expect(d.heartbeat_interval).toBeGreaterThan(0);
  });

  it("responds to Opcode 0 Identify with an Opcode 2 Ready carrying ssrc, ip, port, and modes", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello

    ws.send(
      JSON.stringify({
        op: VoiceOpcodes.Identify,
        d: {
          server_id: "41771983423143937",
          user_id: "104694319306248192",
          session_id: "my_session_id",
          token: "my_token",
          max_dave_protocol_version: 1,
        },
      }),
    );
    const ready = await next();
    expect(ready.op).toBe(VoiceOpcodes.Ready);
    const d = ready.d as { ssrc: number; ip: string; port: number; modes: string[] };
    // ssrc — unsigned integer SSRC for this client.
    expect(typeof d.ssrc).toBe("number");
    expect(d.ssrc).toBeGreaterThan(0);
    // ip / port — the UDP media endpoint to connect to.
    expect(typeof d.ip).toBe("string");
    expect(typeof d.port).toBe("number");
    expect(d.port).toBeGreaterThan(0);
    // modes — supported encryption modes, as an array.
    expect(Array.isArray(d.modes)).toBe(true);
  });

  it("Ready advertises the required and preferred AEAD encryption modes", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    const ready = await next();
    const modes = (ready.d as { modes: string[] }).modes;
    // "You must support aead_xchacha20_poly1305_rtpsize."
    expect(modes).toContain("aead_xchacha20_poly1305_rtpsize");
    // "You should prefer to use aead_aes256_gcm_rtpsize when it is available."
    expect(modes).toContain("aead_aes256_gcm_rtpsize");
  });

  it("answers Opcode 1 Select Protocol with an Opcode 4 Session Description echoing the chosen mode and a 32-byte secret_key", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    await next(); // Ready

    ws.send(
      JSON.stringify({
        op: VoiceOpcodes.SelectProtocol,
        d: { protocol: "udp", data: { address: "127.0.0.1", port: 1337, mode: "aead_aes256_gcm_rtpsize" } },
      }),
    );
    const desc = await next();
    expect(desc.op).toBe(VoiceOpcodes.SessionDescription);
    const d = desc.d as { mode: string; secret_key: number[]; dave_protocol_version?: number };
    // mode — the selected encryption mode is echoed back.
    expect(d.mode).toBe("aead_aes256_gcm_rtpsize");
    // secret_key — a 32-byte array used for transport encryption.
    expect(Array.isArray(d.secret_key)).toBe(true);
    expect(d.secret_key).toHaveLength(32);
    for (const b of d.secret_key) {
      expect(typeof b).toBe("number");
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
    // dave_protocol_version — the negotiated DAVE protocol version (per the Session Description example).
    expect(typeof d.dave_protocol_version).toBe("number");
  });

  it("falls back to a supported mode when Select Protocol requests an unknown one", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    const ready = await next();
    const modes = (ready.d as { modes: string[] }).modes;
    ws.send(
      JSON.stringify({
        op: VoiceOpcodes.SelectProtocol,
        d: { protocol: "udp", data: { address: "127.0.0.1", port: 1337, mode: "not_a_real_mode" } },
      }),
    );
    const desc = await next();
    expect(modes).toContain((desc.d as { mode: string }).mode);
  });

  it("completes the full documented handshake order in sequence", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);

    // 1. Hello (op 8)
    expect((await next()).op).toBe(VoiceOpcodes.Hello);
    // 2. Identify (op 0) -> Ready (op 2)
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    expect((await next()).op).toBe(VoiceOpcodes.Ready);
    // 3. Select Protocol (op 1) -> Session Description (op 4)
    ws.send(
      JSON.stringify({
        op: VoiceOpcodes.SelectProtocol,
        d: { protocol: "udp", data: { address: "127.0.0.1", port: 1337, mode: "aead_xchacha20_poly1305_rtpsize" } },
      }),
    );
    expect((await next()).op).toBe(VoiceOpcodes.SessionDescription);
    // 4. Heartbeat (op 3) -> Heartbeat ACK (op 6)
    ws.send(JSON.stringify({ op: VoiceOpcodes.Heartbeat, d: 1501184119561 }));
    expect((await next()).op).toBe(VoiceOpcodes.HeartbeatAck);
  });
});

describe("voice-connections.mdx — Heartbeating", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("replies to Opcode 3 Heartbeat with an Opcode 6 Heartbeat ACK echoing the nonce (below-V8 form)", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=4`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    await next(); // Ready

    ws.send(JSON.stringify({ op: VoiceOpcodes.Heartbeat, d: 1501184119561 }));
    const ack = await next();
    expect(ack.op).toBe(VoiceOpcodes.HeartbeatAck);
    // Below V8: { op: 6, d: <nonce> } — the previously sent nonce is echoed back.
    expect(ack.d).toBe(1501184119561);
  });

  it("replies to Opcode 3 Heartbeat with v8 ACK shape { d: { t: <nonce> } } for v8 connections", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    await next(); // Ready

    const nonce = 1501184119999;
    ws.send(JSON.stringify({ op: VoiceOpcodes.Heartbeat, d: nonce }));
    const ack = await next();
    expect(ack.op).toBe(VoiceOpcodes.HeartbeatAck);
    // V8+: { op: 6, d: { t: <nonce> } }
    expect(typeof ack.d).toBe("object");
    expect((ack.d as { t: number }).t).toBe(nonce);
  });
});

describe("voice-connections.mdx — Speaking", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("acknowledges an Opcode 5 Speaking payload, reflecting the speaking mask and an ssrc", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=4`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    await next(); // Ready

    // speaking = 5 means Priority (1<<2) | Microphone (1<<0), per the bitmask in the doc.
    ws.send(JSON.stringify({ op: VoiceOpcodes.Speaking, d: { speaking: 5, delay: 0, ssrc: 1 } }));
    const speaking = await next();
    expect(speaking.op).toBe(VoiceOpcodes.Speaking);
    const d = speaking.d as { speaking: number; ssrc: number };
    expect(d.speaking).toBe(5);
    expect(typeof d.ssrc).toBe("number");
  });
});

describe("voice-connections.mdx — Resuming Voice Connection", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("responds to Opcode 7 Resume with an Opcode 9 Resumed (d: null)", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(
      JSON.stringify({
        op: VoiceOpcodes.Resume,
        d: { server_id: "41771983423143937", session_id: "my_session_id", token: "my_token", seq_ack: 10 },
      }),
    );
    const resumed = await next();
    expect(resumed.op).toBe(VoiceOpcodes.Resumed);
    // Example Resumed Payload: { op: 9, d: null }
    expect(resumed.d).toBeNull();
  });
});

describe("voice-connections.mdx — IP Discovery", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("answers a 74-byte 0x1 discovery request with a 0x2 response of the documented shape", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
    sockets.push(ws);
    await next(); // Hello
    ws.send(JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "1", user_id: "2", session_id: "s", token: "t" } }));
    const ready = await next();
    const { ssrc, ip, port } = ready.d as { ssrc: number; ip: string; port: number };

    const udp = dgram.createSocket("udp4");
    try {
      const response = await new Promise<Buffer>((resolve, reject) => {
        udp.on("message", (msg) => resolve(msg));
        udp.on("error", reject);
        // Request packet: Type (2 bytes = 0x1), Length (2 bytes = 70), SSRC (4 bytes), then
        // 64-byte address + 2-byte port fields, total 74 bytes (all big-endian).
        const req = Buffer.alloc(74);
        req.writeUInt16BE(0x0001, 0);
        req.writeUInt16BE(70, 2);
        req.writeUInt32BE(ssrc, 4);
        udp.send(req, port, ip);
        setTimeout(() => reject(new Error("discovery timeout")), 3000);
      });
      // Response is 74 bytes.
      expect(response.length).toBe(74);
      // Type = 0x2 (response).
      expect(response.readUInt16BE(0)).toBe(0x0002);
      // Length = 70 (message length excluding Type and Length fields).
      expect(response.readUInt16BE(2)).toBe(70);
      // SSRC echoed back.
      expect(response.readUInt32BE(4)).toBe(ssrc);
      // Address: null-terminated string starting at byte 8.
      const nul = response.indexOf(0, 8);
      const address = response.subarray(8, nul === -1 ? 72 : nul).toString("ascii");
      expect(address.length).toBeGreaterThan(0);
      // Port: unsigned short at the final 2 bytes (offset 72).
      expect(response.readUInt16BE(72)).toBeGreaterThan(0);
    } finally {
      udp.close();
    }
    ws.close();
  });
});

describe("voice-connections.mdx — RTP relay", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("relays an RTP voice packet between two participants in the same guild", async () => {
    emu = await startDiscordTestEmulator();

    const join = async (userId: string) => {
      const { ws, next } = await connectVoice(`${emu.gatewayUrl}voice?v=8`);
      sockets.push(ws);
      await next(); // Hello
      ws.send(
        JSON.stringify({ op: VoiceOpcodes.Identify, d: { server_id: "guild-relay", user_id: userId, session_id: "s", token: "t" } }),
      );
      const ready = await next();
      return { ws, ...(ready.d as { ssrc: number; ip: string; port: number }) };
    };
    const a = await join("user-a");
    const b = await join("user-b");

    const udpA = dgram.createSocket("udp4");
    const udpB = dgram.createSocket("udp4");
    try {
      // B registers its UDP address by sending one packet so the server learns where to relay.
      const primer = Buffer.alloc(32);
      primer[0] = 0x80; // Version + Flags (0x80) per the Voice Packet Structure.
      primer[1] = 0x78; // Payload Type (0x78).
      primer.writeUInt32BE(b.ssrc, 8);
      await new Promise<void>((r) => udpB.send(primer, b.port, b.ip, () => r()));
      await new Promise((r) => setTimeout(r, 50));

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
      // The relayed packet carries A's SSRC (bytes 8-12) and original payload.
      expect(relayed.readUInt32BE(8)).toBe(a.ssrc);
      expect(relayed.subarray(12, 17).toString("ascii")).toBe("AUDIO");
    } finally {
      udpA.close();
      udpB.close();
    }
    a.ws.close();
    b.ws.close();
  });
});
