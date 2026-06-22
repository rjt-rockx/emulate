import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  createDiscordTestApp,
  startDiscordTestEmulator,
  api,
  botHeaders,
  TEST_BASE_URL,
  type RunningDiscordEmulator,
} from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { generateEd25519KeyPair, verifyInteraction } from "../interactions/ed25519.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).applications.all()[0].snowflake;
}

describe("discord application commands", () => {
  it("registers and lists global and guild commands statefully", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);

    const createRes = await app.request(api(`/applications/${aid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ping", description: "Replies with pong" }),
    });
    expect(createRes.status).toBe(201);
    const cmd = (await createRes.json()) as { id: string; name: string };
    expect(cmd.name).toBe("ping");

    const list = (await (await app.request(api(`/applications/${aid}/commands`), { headers: botHeaders() })).json()) as Array<{ name: string }>;
    expect(list.some((c) => c.name === "ping")).toBe(true);

    const gid = getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "hello", description: "guild only" }),
    });
    const guildList = (await (
      await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), { headers: botHeaders() })
    ).json()) as Array<{ name: string }>;
    expect(guildList.some((c) => c.name === "hello")).toBe(true);

    const del = await app.request(api(`/applications/${aid}/commands/${cmd.id}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    expect(getDiscordStore(store).commands.findOneBy("snowflake", cmd.id)).toBeUndefined();
  });
});

describe("discord interactions over the gateway", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("dispatches INTERACTION_CREATE and the bot reply creates a message", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const aid = ds.applications.all()[0].snowflake;
    // register a command
    await fetch(api(`/applications/${aid}/commands`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ping", description: "x" }),
    });

    // connect a bot and identify
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json`);
    ws.on("error", () => void 0); // swallow late socket errors after the server closes
    sockets.push(ws);
    const frames: Array<{ op: number; t?: string | null; d?: unknown }> = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (data) => {
      frames.push(JSON.parse(data.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    const waitFor = async (t: string, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = frames.find((f) => f.t === t);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    };
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildMessages } }));
    await waitFor("READY");

    // trigger the slash command
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const triggerRes = await fetch(`${emu.baseUrl}/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: channelId }),
    });
    const trigger = (await triggerRes.json()) as { id: string; token: string };

    const interaction = await waitFor("INTERACTION_CREATE");
    expect((interaction.d as { data: { name: string } }).data.name).toBe("ping");

    // bot responds via the callback endpoint
    const cbRes = await fetch(api(`/interactions/${trigger.id}/${trigger.token}/callback`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "pong" } }),
    });
    expect(cbRes.status).toBe(204);

    const msg = await waitFor("MESSAGE_CREATE");
    expect((msg.d as { content: string }).content).toBe("pong");

    // original response is retrievable
    const original = await fetch(api(`/webhooks/${aid}/${trigger.token}/messages/@original`, emu.baseUrl), {
      headers: botHeaders(),
    });
    expect(original.status).toBe(200);
    expect(((await original.json()) as { content: string }).content).toBe("pong");
  });
});

describe("discord HTTP interactions endpoint (Ed25519)", () => {
  let appServer: http.Server | undefined;
  afterEach(() => appServer?.close());

  it("signs the delivery, the app verifies it, and the response creates a message", async () => {
    const { publicKeyHex, privateKeyPem } = generateEd25519KeyPair();
    let verified = false;
    let received = 0;

    appServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const sig = req.headers["x-signature-ed25519"] as string;
        const ts = req.headers["x-signature-timestamp"] as string;
        verified = verifyInteraction(ts, raw, sig, publicKeyHex);
        received += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ type: 4, data: { content: "from http endpoint" } }));
      });
    });
    await new Promise<void>((r) => appServer!.listen(0, r));
    const endpointUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/interactions`;

    const { app, store } = createDiscordTestApp({
      application: { public_key: publicKeyHex, private_key: privateKeyPem, interactions_endpoint_url: endpointUrl },
    });
    const ds = getDiscordStore(store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const before = ds.messages.findBy("channel_snowflake", channelId).length;

    const res = await app.request(`${TEST_BASE_URL}/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: channelId }),
    });
    const body = (await res.json()) as { delivered: string; response: { type: number; data: { content: string } } | null };

    expect(verified).toBe(true);
    expect(received).toBe(1);
    // An app with an interactions endpoint receives the HTTP delivery ONLY (not the Gateway).
    expect(body.delivered).toBe("http");
    expect(body.response?.data.content).toBe("from http endpoint");
    // the app's response created a message in the channel
    const after = ds.messages.findBy("channel_snowflake", channelId);
    expect(after.length).toBe(before + 1);
    expect(after.some((m) => m.content === "from http endpoint")).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const { publicKeyHex } = generateEd25519KeyPair();
    expect(verifyInteraction("123", '{"type":1}', "00".repeat(64), publicKeyHex)).toBe(false);
  });
});
