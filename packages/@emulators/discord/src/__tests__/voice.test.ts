import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, api, botHeaders, json, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";
import { getDiscordStore } from "../store.js";

interface Frame {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

function connect(url: string): Promise<{ ws: WebSocket; frames: Frame[]; waitFor: (t: string, timeout?: number) => Promise<Frame> }> {
  const ws = new WebSocket(url);
    ws.on("error", () => void 0); // swallow late socket errors after the server closes
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Frame);
    waiters.splice(0).forEach((w) => w());
  });
  const waitFor = async (t: string, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = frames.find((f) => f.t === t || (t.startsWith("op:") && f.op === Number(t.slice(3))));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 30);
      });
    }
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, frames, waitFor }));
    ws.once("error", reject);
  });
}

describe("voice state signaling", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("op-4 join produces a voice state, VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const voiceChannel = ds.channels.findBy("guild_snowflake", guildId).find((ch) => ch.type === 2)!;
    const botId = ds.users.findOneBy("username", "emulate-bot")!.snowflake;

    const { ws, waitFor } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildVoiceStates } }));
    await waitFor("READY");

    // Join a voice channel.
    ws.send(JSON.stringify({ op: GatewayOpcodes.VoiceStateUpdate, d: { guild_id: guildId, channel_id: voiceChannel.snowflake, self_mute: false, self_deaf: false } }));

    const stateUpdate = await waitFor("VOICE_STATE_UPDATE");
    expect((stateUpdate.d as { channel_id: string; user_id: string }).channel_id).toBe(voiceChannel.snowflake);
    expect((stateUpdate.d as { user_id: string }).user_id).toBe(botId);

    const serverUpdate = await waitFor("VOICE_SERVER_UPDATE");
    const sd = serverUpdate.d as { token: string; guild_id: string; endpoint: string };
    expect(sd.guild_id).toBe(guildId);
    expect(sd.token).toBeTruthy();
    expect(sd.endpoint).toBeTruthy();

    // REST reflects the stored voice state.
    const res = await fetch(api(`/guilds/${guildId}/voice-states/${botId}`, emu.baseUrl), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect((await json<{ channel_id: string }>(res)).channel_id).toBe(voiceChannel.snowflake);
  });

  it("op-4 with null channel leaves voice and clears the state", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const voiceChannel = ds.channels.findBy("guild_snowflake", guildId).find((ch) => ch.type === 2)!;
    const botId = ds.users.findOneBy("username", "emulate-bot")!.snowflake;

    const { ws, waitFor } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildVoiceStates } }));
    await waitFor("READY");

    ws.send(JSON.stringify({ op: GatewayOpcodes.VoiceStateUpdate, d: { guild_id: guildId, channel_id: voiceChannel.snowflake } }));
    await waitFor("VOICE_SERVER_UPDATE");
    expect(ds.voiceStates.findBy("guild_snowflake", guildId).some((v) => v.user_snowflake === botId)).toBe(true);

    ws.send(JSON.stringify({ op: GatewayOpcodes.VoiceStateUpdate, d: { guild_id: guildId, channel_id: null } }));
    // Wait until the leave is processed.
    for (let i = 0; i < 100 && ds.voiceStates.findBy("guild_snowflake", guildId).some((v) => v.user_snowflake === botId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ds.voiceStates.findBy("guild_snowflake", guildId).some((v) => v.user_snowflake === botId)).toBe(false);
  });

  it("PATCH voice-states/@me updates suppress/request-to-speak", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const stageChannel = ds.channels.findBy("guild_snowflake", guildId).find((ch) => ch.type === 2)!;
    const botId = ds.users.findOneBy("username", "emulate-bot")!.snowflake;

    const { ws, waitFor } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildVoiceStates } }));
    await waitFor("READY");
    ws.send(JSON.stringify({ op: GatewayOpcodes.VoiceStateUpdate, d: { guild_id: guildId, channel_id: stageChannel.snowflake } }));
    await waitFor("VOICE_SERVER_UPDATE");

    const patch = await fetch(api(`/guilds/${guildId}/voice-states/@me`, emu.baseUrl), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: stageChannel.snowflake, suppress: false, request_to_speak_timestamp: new Date().toISOString() }),
    });
    expect(patch.status).toBe(204);
    const state = ds.voiceStates.findBy("guild_snowflake", guildId).find((v) => v.user_snowflake === botId)!;
    expect(state.suppress).toBe(false);
    expect(state.request_to_speak_timestamp).toBeTruthy();
  });
});
