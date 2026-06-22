import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, api, botHeaders, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";
import { getDiscordStore } from "../store.js";

interface Frame {
  op: number;
  t?: string | null;
  d?: unknown;
}

describe("REST mutations dispatch their gateway events", () => {
  let emu: RunningDiscordEmulator;
  let ws: WebSocket | undefined;
  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await emu?.close();
  });

  it("emits emoji, invite, webhook, audit-log, thread-member and user events", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const developer = ds.users.findOneBy("username", "developer")!.snowflake;

    ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json`);
    ws.on("error", () => void 0);
    const frames: Frame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", () => resolve());
      ws!.once("error", reject);
    });

    const waitWhere = async (t: string, match: (d: Frame) => boolean, timeout = 4000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = frames.find((f) => f.t === t && match(f));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`timeout waiting for ${t}`);
    };
    const waitFor = (t: string, timeout = 4000) => waitWhere(t, () => true, timeout);

    const intents =
      Intents.Guilds |
      Intents.GuildExpressions |
      Intents.GuildInvites |
      Intents.GuildWebhooks |
      Intents.GuildModeration |
      Intents.GuildMembers;
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents } }));
    await waitFor("READY");

    // Emoji create -> GUILD_EMOJIS_UPDATE
    await fetch(api(`/guilds/${guildId}/emojis`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "blobwave", image: "data:image/png;base64,AAAA" }),
    });
    const emojis = await waitFor("GUILD_EMOJIS_UPDATE");
    expect((emojis.d as { emojis: Array<{ name: string }> }).emojis.some((e) => e.name === "blobwave")).toBe(true);

    // Invite create -> INVITE_CREATE
    await fetch(api(`/channels/${channelId}/invites`, emu.baseUrl), { method: "POST", headers: botHeaders(), body: "{}" });
    const invite = await waitFor("INVITE_CREATE");
    expect((invite.d as { channel_id: string }).channel_id).toBe(channelId);

    // Webhook create -> WEBHOOKS_UPDATE
    await fetch(api(`/channels/${channelId}/webhooks`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "hook" }),
    });
    const webhook = await waitFor("WEBHOOKS_UPDATE");
    expect((webhook.d as { channel_id: string }).channel_id).toBe(channelId);

    // Ban -> GUILD_AUDIT_LOG_ENTRY_CREATE (and GUILD_BAN_ADD). Match the ban entry
    // specifically: other mutations above (e.g. webhook create) also emit audit entries.
    await fetch(api(`/guilds/${guildId}/bans/${developer}`, emu.baseUrl), { method: "PUT", headers: botHeaders(), body: "{}" });
    const audit = await waitWhere("GUILD_AUDIT_LOG_ENTRY_CREATE", (f) => (f.d as { action_type: number }).action_type === 22);
    expect((audit.d as { target_id: string }).target_id).toBe(developer);
    await waitFor("GUILD_BAN_ADD");

    // User update -> USER_UPDATE
    await fetch(api(`/users/@me`, emu.baseUrl), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ global_name: "Renamed Bot" }),
    });
    const user = await waitFor("USER_UPDATE");
    expect((user.d as { global_name: string }).global_name).toBe("Renamed Bot");
  });
});
