import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds, TEST_BASE_URL } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { getDiscordRuntime } from "../runtime.js";
import { snowflake } from "../helpers.js";
import type { GatewayEvent } from "../gateway/dispatcher.js";

/**
 * Regressions for fidelity gaps surfaced by running real third-party bots against the emulator
 * (discord.js / discord.py / discordgo). Each `it` pins a specific real-bot failure.
 */
describe("real-bot fidelity regressions", () => {
  // discord.js: real Discord makes an application's id equal its bot user's id (same snowflake).
  it("application.id === bot_user.id (users/@me id)", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    expect(ids.app).toBe(ids.bot);
    const me = await json<{ id: string }>(await app.request(api("/users/@me"), { headers: botHeaders() }));
    const appInfo = await json<{ id: string }>(await app.request(api("/applications/@me"), { headers: botHeaders() }));
    expect(appInfo.id).toBe(me.id);
  });

  // discordgo serializes every option with `choices: null` / `channel_types: null` (no omitempty);
  // real Discord tolerates these. They must not 500 or 400 a valid command.
  it("accepts a command whose options carry null choices/channel_types (discordgo idiom)", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    const res = await app.request(api(`/applications/${ids.app}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        name: "godgo-cmd",
        description: "from a discordgo-shaped payload",
        type: 1,
        options: [
          { type: 3, name: "text", description: "a string option", choices: null, channel_types: null, options: null },
          { type: 7, name: "chan", description: "a channel option", channel_types: null },
        ],
      }),
    });
    expect(res.status).toBeLessThan(300);
    const body = await json<{ name: string; options: unknown[] }>(res);
    expect(body.name).toBe("godgo-cmd");
    expect(body.options).toHaveLength(2);
  });

  // discord.py 2.7+ sends with_response=1 (literal '1'); the callback must return the body, not 204.
  it("returns the callback resource for with_response=1 (discord.py)", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    const ds = getDiscordStore(store);
    const interaction = ds.interactions.insert({
      snowflake: snowflake(),
      token: `int-${snowflake()}`,
      type: 2,
      application_snowflake: ids.app,
      guild_snowflake: ids.guild,
      channel_snowflake: ids.general,
      user_snowflake: ids.developer,
      data: { name: "ping" },
      message_snowflake: null,
      callback_used: false,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    });
    const res = await app.request(api(`/interactions/${interaction.snowflake}/${interaction.token}/callback?with_response=1`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "pong" } }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ interaction: { id: string }; resource?: { message?: { content: string } } }>(res);
    expect(body.interaction.id).toBe(interaction.snowflake);
    expect(body.resource?.message?.content).toBe("pong");
  });

  // discord.py edge case: opening a DM with your own id must be rejected.
  it("rejects opening a DM with yourself", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    const res = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ recipient_id: ids.bot }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50007);
  });

  // discord.js / any prefix bot: every REST-posted message is bot-authored, so message-command
  // handlers (`if (author.bot) return`) can't be exercised. The control plane posts as a human.
  it("__emulate/messages posts as an arbitrary (non-bot) user and dispatches MESSAGE_CREATE", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    const events: GatewayEvent[] = [];
    const unsubscribe = getDiscordRuntime(store).bus.subscribe((e) => events.push(e));

    const res = await app.request(`${TEST_BASE_URL}/__emulate/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: ids.general, author_id: ids.developer, content: "!ping" }),
    });
    expect(res.status).toBe(200);
    const msg = await json<{ content: string; author: { id: string; bot?: boolean } }>(res);
    expect(msg.content).toBe("!ping");
    expect(msg.author.id).toBe(ids.developer);
    expect(msg.author.bot ?? false).toBe(false);

    const dispatched = events.find((e) => e.t === "MESSAGE_CREATE");
    expect(dispatched).toBeDefined();
    expect((dispatched!.d as { author: { id: string }; guild_id?: string }).author.id).toBe(ids.developer);
    unsubscribe();
  });

  // discord.py: app_commands.checks.has_permissions reads ONLY interaction.member.permissions; real
  // Discord always resolves it. Without it, every permission-gated command is rejected (even for the
  // guild owner). The seeded `developer` is the guild owner, so permissions must be the full bitset.
  it("interaction member carries resolved permissions (discord.py has_permissions)", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    const res = await app.request(`${TEST_BASE_URL}/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "clear", channelSnowflake: ids.general, guildSnowflake: ids.guild, userSnowflake: ids.developer }),
    });
    const { interaction } = await json<{
      interaction: { member?: { permissions?: string }; guild?: { id: string; locale?: string; features?: unknown[] } };
    }>(res);
    expect(interaction.member?.permissions).toBeTruthy();
    const MANAGE_MESSAGES = 1n << 13n;
    expect(BigInt(interaction.member!.permissions!) & MANAGE_MESSAGES).not.toBe(0n);
    // JDA resolves the interaction guild from a partial `guild` object ({ id, locale, features });
    // without it, guild slash commands are dropped with an "unexpected channel type" throw.
    expect(interaction.guild?.id).toBe(ids.guild);
    expect(Array.isArray(interaction.guild?.features)).toBe(true);
  });

  // Music/voice bots gate commands on the invoker being in a voice channel. The control plane places
  // an arbitrary user in voice (dispatching VOICE_STATE_UPDATE) so those paths can be exercised.
  it("__emulate/voice-state places a user in voice and dispatches VOICE_STATE_UPDATE", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    const events: GatewayEvent[] = [];
    const unsubscribe = getDiscordRuntime(store).bus.subscribe((e) => events.push(e));

    const res = await app.request(`${TEST_BASE_URL}/__emulate/voice-state`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ guild_id: ids.guild, channel_id: ids.voice, user_id: ids.developer }),
    });
    expect(res.status).toBe(200);
    const state = await json<{ channel_id: string; user_id: string }>(res);
    expect(state.channel_id).toBe(ids.voice);
    expect(state.user_id).toBe(ids.developer);

    // Persisted: GET voice-states reflects it.
    const fetched = await app.request(api(`/guilds/${ids.guild}/voice-states/${ids.developer}`), { headers: botHeaders() });
    expect(fetched.status).toBe(200);

    const evt = events.find((e) => e.t === "VOICE_STATE_UPDATE");
    expect(evt).toBeDefined();
    expect((evt!.d as { channel_id: string }).channel_id).toBe(ids.voice);
    unsubscribe();
  });

  // discord.js / @discordjs/rest percent-encode `@original` to `%40original`. Both must edit the
  // original interaction response — this is the editReply/deleteReply path nearly every bot uses
  // after a deferred reply (Discord Tickets and ModBot both broke on it).
  it("edits the original interaction response via both @original and %40original", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);
    // Trigger an interaction and create its original response (so @original resolves).
    const trig = await json<{ id: string; token: string }>(
      await app.request(`${TEST_BASE_URL}/__emulate/interactions`, {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: ids.general, guildSnowflake: ids.guild, userSnowflake: ids.developer }),
      }),
    );
    await app.request(api(`/interactions/${trig.id}/${trig.token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "original" } }),
    });

    for (const seg of ["@original", "%40original"]) {
      const res = await app.request(api(`/webhooks/${ids.app}/${trig.token}/messages/${seg}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ content: `edited via ${seg}` }),
      });
      expect(res.status, `PATCH ${seg}`).toBe(200);
      expect((await json<{ content: string }>(res)).content).toBe(`edited via ${seg}`);
    }
  });
});
