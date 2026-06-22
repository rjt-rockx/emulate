import { describe, it, expect, afterEach } from "vitest";
import { Client, GatewayIntentBits, Events, type Message } from "discord.js";
import { startDiscordTestEmulator, api, botHeaders, type RunningDiscordEmulator } from "./helpers.js";
import { getDiscordStore } from "../store.js";

/**
 * The highest-fidelity proof: a real discord.js Client logging into the emulator,
 * reaching READY, and receiving a messageCreate dispatched from a REST message POST.
 */
describe("discord.js integration", () => {
  let emu: RunningDiscordEmulator | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.destroy().catch(() => {});
    client = undefined;
    await emu?.close();
    emu = undefined;
  });

  it("logs in, becomes ready, and receives a messageCreate from a REST post", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    const messageCreate = new Promise<Message>((resolve) => client!.once(Events.MessageCreate, (m) => resolve(m)));

    await client.login("test_bot_token");
    const readyClient = await ready;
    expect(readyClient.user.username).toBe("emulate-bot");
    expect(readyClient.guilds.cache.size).toBeGreaterThan(0);

    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;
    const res = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "hi discord.js" }),
    });
    expect(res.status).toBe(200);

    const message = await messageCreate;
    expect(message.content).toBe("hi discord.js");
  }, 25000);
});
