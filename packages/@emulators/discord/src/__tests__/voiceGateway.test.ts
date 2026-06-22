import { describe, it, expect, afterEach } from "vitest";
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
});
