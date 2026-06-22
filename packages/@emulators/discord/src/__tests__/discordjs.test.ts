import { describe, it, expect, afterEach } from "vitest";
import { Client, GatewayIntentBits, Events, ChannelType, type Message, type TextChannel } from "discord.js";
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

  it("creates and manages resources through discord.js (strict client-side parsing)", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});
    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    const rc = await ready;

    // Every call below round-trips a REST response through discord.js's strict structure parsers;
    // any wire-shape divergence throws here rather than passing a hand-written assertion.
    const guild = await rc.guilds.fetch(rc.guilds.cache.first()!.id);

    const role = await guild.roles.create({ name: "djs-role", color: 0x00ff00, hoist: true, mentionable: true });
    expect(role.name).toBe("djs-role");
    expect(role.color).toBe(0x00ff00);

    const channel = (await guild.channels.create({ name: "djs-chan", type: ChannelType.GuildText, topic: "made by djs" })) as TextChannel;
    expect(channel.name).toBe("djs-chan");
    expect(channel.type).toBe(ChannelType.GuildText);

    const sent = await channel.send({ content: "hello from djs" });
    expect(sent.content).toBe("hello from djs");
    const edited = await sent.edit("edited by djs");
    expect(edited.content).toBe("edited by djs");

    const reaction = await sent.react("👍");
    expect(reaction.emoji.name).toBe("👍");

    const webhook = await channel.createWebhook({ name: "djs-hook" });
    expect(webhook.name).toBe("djs-hook");

    const fetchedMembers = await guild.members.fetch();
    expect(fetchedMembers.size).toBeGreaterThan(0);

    const invite = await channel.createInvite();
    expect(typeof invite.code).toBe("string");
  }, 30000);
});
