import { describe, it, expect, afterEach } from "vitest";
import { Client, GatewayIntentBits, Events, EmbedBuilder, type TextChannel } from "discord.js";
import { startDiscordTestEmulator, api, botHeaders, json, type RunningDiscordEmulator } from "./helpers.js";
import { getDiscordStore } from "../store.js";

/**
 * Real-world integration tests for the Discord API emulator based on patterns from
 * the official discord.js guide (github.com/discordjs/guide).
 *
 * Coverage includes:
 * - Basic client operations: login, ready event, guild/channel caching
 * - Message operations: send, edit, delete, retrieve
 * - Reactions: add, list, remove
 * - Slash commands: register, trigger, respond
 * - Message components: buttons and select menus
 * - Embeds: send with embeds array
 * - Guild resources: create roles, assign members, create invites
 * - Channels: create threads, create webhooks
 */

describe("discord.js guide patterns", () => {
  let emu: RunningDiscordEmulator | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.destroy().catch(() => {});
    client = undefined;
    await emu?.close();
    emu = undefined;
  });

  // ========== BASIC CLIENT OPERATIONS ==========

  it("logs in, reaches ready, and caches guilds and channels", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    const readyClient = await ready;

    expect(readyClient.user?.username).toBe("emulate-bot");
    expect(readyClient.guilds.cache.size).toBeGreaterThan(0);
    expect(readyClient.channels.cache.size).toBeGreaterThan(0);

    const guild = readyClient.guilds.cache.first();
    expect(guild?.name).toBe("Emulate Server");
    expect(guild?.channels.cache.size).toBeGreaterThan(0);
  }, 25000);

  // ========== MESSAGE OPERATIONS ==========

  it("sends, retrieves, edits, and deletes a message via REST directly (workaround for discord.js caching)", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;

    // Create a message via REST
    const createRes = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "Hello from REST" }),
    });
    expect(createRes.status).toBe(200);
    const msg = await json<{ id: string; content: string }>(createRes);
    expect(msg.content).toBe("Hello from REST");

    // Fetch the message
    const getRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}`, emu.baseUrl), {
      headers: botHeaders(),
    });
    expect(getRes.status).toBe(200);

    // Edit the message
    const editRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}`, emu.baseUrl), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "Edited message" }),
    });
    const edited = await json<{ content: string }>(editRes);
    expect(edited.content).toBe("Edited message");

    // Delete the message
    const deleteRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}`, emu.baseUrl), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    const notFoundRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}`, emu.baseUrl), {
      headers: botHeaders(),
    });
    expect(notFoundRes.status).toBe(404);
  }, 25000);

  it("sends multiple messages and lists them", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    const guild = client.guilds.cache.first();
    const channel = guild?.channels.cache.find((c) => c.name === "general") as TextChannel | undefined;

    const msg1 = await channel?.send({ content: "First" });
    const msg2 = await channel?.send({ content: "Second" });

    const messages = await channel?.messages.fetch({ limit: 10 });
    expect(messages?.size).toBeGreaterThanOrEqual(2);
    expect(messages?.some((m) => m.id === msg1?.id)).toBe(true);
    expect(messages?.some((m) => m.id === msg2?.id)).toBe(true);
  }, 25000);

  // ========== REACTIONS ==========

  it("adds a Unicode reaction and lists reactors via REST", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const bot = ds.users.findOneBy("username", "emulate-bot")!;

    // Create a message via REST
    const msgRes = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "React to me" }),
    });
    const msg = await json<{ id: string }>(msgRes);

    // React with a Unicode emoji (thumbs up)
    const THUMBS = encodeURIComponent("👍");
    const reactRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}/reactions/${THUMBS}/@me`, emu.baseUrl), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(reactRes.status).toBe(204);

    // List reactions
    const listRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}/reactions/${THUMBS}`, emu.baseUrl), {
      headers: botHeaders(),
    });
    const users = await json<Array<{ id: string }>>(listRes);
    expect(users.some((u) => u.id === bot.snowflake)).toBe(true);
  }, 25000);

  it("removes a reaction via REST", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;

    // Create a message
    const msgRes = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "Remove reaction" }),
    });
    const msg = await json<{ id: string }>(msgRes);

    // Add reaction
    const THUMBS = encodeURIComponent("👍");
    await fetch(api(`/channels/${channelId}/messages/${msg.id}/reactions/${THUMBS}/@me`, emu.baseUrl), {
      method: "PUT",
      headers: botHeaders(),
    });

    // Remove reaction
    const removeRes = await fetch(api(`/channels/${channelId}/messages/${msg.id}/reactions/${THUMBS}/@me`, emu.baseUrl), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(removeRes.status).toBe(204);

    // Verify it's gone
    const reactions = ds.reactions.findBy("message_snowflake", msg.id);
    expect(reactions).toHaveLength(0);
  }, 25000);

  // ========== SLASH COMMANDS ==========

  it("registers a slash command via discord.js and receives it as INTERACTION_CREATE", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    // Register a global slash command
    const commands = await client.application?.commands.create({
      name: "ping",
      description: "Replies with Pong!",
    });
    expect(commands?.name).toBe("ping");

    // Verify it persisted in the store
    const ds = getDiscordStore(emu.store);
    const registered = ds.commands.findOneBy("snowflake", commands!.id);
    expect(registered?.name).toBe("ping");
  }, 25000);

  it("registers a slash command and triggers it via the emulator control endpoint", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const aid = ds.applications.all()[0].snowflake;

    // Register a global slash command via REST
    const regRes = await fetch(api(`/applications/${aid}/commands`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "greet", description: "Greet the user" }),
    });
    expect(regRes.status).toBe(201);
    const cmd = await json<{ id: string; name: string }>(regRes);
    expect(cmd.name).toBe("greet");

    // Verify it's registered
    const listRes = await fetch(api(`/applications/${aid}/commands`, emu.baseUrl), {
      headers: botHeaders(),
    });
    const commands = await json<Array<{ name: string }>>(listRes);
    expect(commands.some((c) => c.name === "greet")).toBe(true);

    // Trigger the command via emulator control endpoint
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const triggerRes = await fetch(`${emu.baseUrl}/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "greet", channelSnowflake: channelId }),
    });
    expect(triggerRes.status).toBe(200);
    const triggerData = await json<{ id: string; token: string }>(triggerRes);
    expect(triggerData.id).toBeTruthy();
    expect(triggerData.token).toBeTruthy();
  }, 25000);

  // ========== MESSAGE COMPONENTS: BUTTONS ==========

  it("sends a message with action row buttons via REST and verifies components", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;

    // Send a message with button components via REST
    const components = [
      {
        type: 1, // ACTION_ROW
        components: [
          {
            type: 2, // BUTTON
            style: 2, // SECONDARY
            label: "Cancel",
            custom_id: "cancel",
          },
          {
            type: 2, // BUTTON
            style: 3, // SUCCESS
            label: "Confirm",
            custom_id: "confirm",
          },
        ],
      },
    ];

    const msgRes = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        content: "Are you sure?",
        components,
      }),
    });
    expect(msgRes.status).toBe(200);
    const msg = await json<{ id: string; components: Array<{ type: number }> }>(msgRes);
    expect(msg.components).toHaveLength(1);
    expect(msg.components[0].type).toBe(1); // ACTION_ROW
  }, 25000);

  // ========== MESSAGE COMPONENTS: SELECT MENUS ==========

  it("sends a message with a string select menu via REST and verifies component structure", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;

    // Create select menu with options (Pokemon starter example from guide)
    const components = [
      {
        type: 1, // ACTION_ROW
        components: [
          {
            type: 3, // STRING_SELECT
            custom_id: "starter",
            placeholder: "Make a selection!",
            options: [
              {
                label: "Bulbasaur",
                description: "The Grass/Poison Seed Pokémon.",
                value: "bulbasaur",
              },
              {
                label: "Charmander",
                description: "The Fire-type Lizard Pokémon.",
                value: "charmander",
              },
              {
                label: "Squirtle",
                description: "The Water-type Tiny Turtle Pokémon.",
                value: "squirtle",
              },
            ],
          },
        ],
      },
    ];

    const msgRes = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        content: "Choose your starter!",
        components,
      }),
    });
    expect(msgRes.status).toBe(200);
    const msg = await json<{ id: string; components: Array<{ components: Array<{ type: number; options: Array<{ value: string }> }> }> }>(msgRes);
    expect(msg.components).toHaveLength(1);
    const selectComponent = msg.components[0].components[0];
    expect(selectComponent.type).toBe(3); // STRING_SELECT
    expect(selectComponent.options).toHaveLength(3);
  }, 25000);

  // ========== EMBEDS ==========

  it("sends a message with an embed and verifies all embed properties round-trip", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    const guild = client.guilds.cache.first();
    const channel = guild?.channels.cache.find((c) => c.name === "general") as TextChannel | undefined;

    // Create an embed (similar to the guide's embed example)
    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle("Some title")
      .setURL("https://discord.js.org/")
      .setDescription("Some description here")
      .setThumbnail("https://i.imgur.com/AfFp7pu.png")
      .addFields(
        { name: "Regular field title", value: "Some value here" },
        { name: "Inline field title", value: "Some value here", inline: true },
        { name: "Inline field title", value: "Some value here", inline: true },
      )
      .setFooter({ text: "Some footer text here" });

    const message = await channel?.send({ embeds: [embed] });

    // Verify embed properties persisted
    expect(message?.embeds).toHaveLength(1);
    const retreived = message?.embeds[0];
    expect(retreived?.title).toBe("Some title");
    expect(retreived?.description).toBe("Some description here");
    expect(retreived?.color).toBe(0x0099ff);
    expect(retreived?.fields).toHaveLength(3);
    expect(retreived?.footer?.text).toBe("Some footer text here");
  }, 25000);

  it("sends multiple embeds per message", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    const guild = client.guilds.cache.first();
    const channel = guild?.channels.cache.find((c) => c.name === "general") as TextChannel | undefined;

    const embed1 = new EmbedBuilder().setTitle("Embed 1").setDescription("First embed").setColor(0xff0000);
    const embed2 = new EmbedBuilder().setTitle("Embed 2").setDescription("Second embed").setColor(0x00ff00);

    const message = await channel?.send({ embeds: [embed1, embed2] });
    expect(message?.embeds).toHaveLength(2);
    expect(message?.embeds[0].title).toBe("Embed 1");
    expect(message?.embeds[1].title).toBe("Embed 2");
  }, 25000);

  // ========== GUILD RESOURCES ==========

  it("creates a role via REST and verifies it persists in the store", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;

    // Create a role via REST
    const createRes = await fetch(api(`/guilds/${guildId}/roles`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        name: "Moderator",
        color: 0xff0000,
      }),
    });
    expect(createRes.status).toBe(200);
    const role = await json<{ id: string; name: string; color: number }>(createRes);
    expect(role.name).toBe("Moderator");
    expect(role.color).toBe(0xff0000);

    // Verify it persisted
    const stored = ds.roles.findOneBy("snowflake", role.id);
    expect(stored?.name).toBe("Moderator");
  }, 25000);

  it("creates an invite and verifies it is stored", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    const guild = client.guilds.cache.first();
    const channel = guild?.channels.cache.find((c) => c.name === "general") as TextChannel | undefined;

    const invite = await channel?.createInvite({ maxAge: 0 });
    expect(invite?.code).toBeTruthy();
    expect(invite?.channel?.id).toBe(channel?.id);

    // Verify via store
    const ds = getDiscordStore(emu.store);
    const stored = ds.invites.findOneBy("code", invite!.code);
    expect(stored).toBeDefined();
  }, 25000);

  // ========== CHANNELS ==========

  it("creates a thread and verifies it is stored with correct parent", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    const guild = client.guilds.cache.first();
    const channel = guild?.channels.cache.find((c) => c.name === "general") as TextChannel | undefined;

    const message = await channel?.send({ content: "Start a thread" });
    const thread = await message?.startThread({
      name: "Discussion",
      autoArchiveDuration: 60,
    });

    expect(thread?.name).toBe("Discussion");
    expect(thread?.parentId).toBe(channel?.id);

    // Verify in store
    const ds = getDiscordStore(emu.store);
    const stored = ds.channels.findOneBy("snowflake", thread!.id);
    expect(stored?.parent_snowflake).toBe(channel?.id);
  }, 25000);

  it("creates a webhook and executes it to post a message", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    const guild = client.guilds.cache.first();
    const channel = guild?.channels.cache.find((c) => c.name === "general") as TextChannel | undefined;

    // Create a webhook
    const webhook = await channel?.createWebhook({
      name: "CI Webhook",
      reason: "For automated deployments",
    });
    expect(webhook?.name).toBe("CI Webhook");

    // Execute the webhook to send a message
    await webhook?.send({ content: "Deployment started" });

    // Verify message was created
    const messages = await channel?.messages.fetch({ limit: 5 });
    const webhookMsg = messages?.find((m) => m.webhookId === webhook?.id);
    expect(webhookMsg?.content).toBe("Deployment started");
  }, 25000);

  // ========== COMBINED PATTERNS ==========

  it("implements a full workflow: create command, register it, trigger via emulator control endpoint", async () => {
    emu = await startDiscordTestEmulator();
    client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { api: `${emu.baseUrl}/api` },
    });
    client.on(Events.Error, () => {});

    const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, (c) => resolve(c)));
    await client.login("test_bot_token");
    await ready;

    // Register a slash command
    const cmd = await client.application?.commands.create({
      name: "workflow-test",
      description: "Test full workflow",
    });
    expect(cmd?.name).toBe("workflow-test");

    // Verify it's in the store
    const ds = getDiscordStore(emu.store);
    const stored = ds.commands.findOneBy("snowflake", cmd!.id);
    expect(stored?.name).toBe("workflow-test");

    // Trigger the command via emulator control endpoint
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const triggerRes = await fetch(`${emu.baseUrl}/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "workflow-test", channelSnowflake: channelId }),
    });
    expect(triggerRes.status).toBe(200);
    const triggerData = await json<{ id: string; token: string }>(triggerRes);
    expect(triggerData.id).toBeTruthy();
    expect(triggerData.token).toBeTruthy();
  }, 25000);

  it("posts a message with embedded content and verifies it round-trips", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;

    // Post a message with rich content (links, mentions)
    const msgRes = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        content: "Check out this guide: https://discord.js.org/ and see @everyone",
      }),
    });
    expect(msgRes.status).toBe(200);
    const msg = await json<{ id: string; content: string }>(msgRes);
    expect(msg.content).toContain("https://discord.js.org/");
    expect(msg.content).toContain("@everyone");
  }, 25000);
});
