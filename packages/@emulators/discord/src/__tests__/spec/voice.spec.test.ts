/**
 * Spec suite for `developers/resources/voice.mdx`.
 *
 * Encodes the page's documented expectations directly: the Voice State object shape (every
 * field), the Voice Region object shape, and every REST endpoint's request/response contract,
 * status codes, JSON params, and behavioral caveats. Written from the doc first; the
 * implementation in src/routes/voice.ts is built/fixed until this is green.
 *
 * Voice states are normally created by the gateway (Voice State Update, op 4). These in-process
 * REST tests seed a voice state directly into the store so the read/modify endpoints have
 * something to act on.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import type { Store } from "@emulators/core";

function ids(store: Store) {
  const ds = getDiscordStore(store);
  return {
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    bot: ds.users.findOneBy("username", "emulate-bot")!.snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    voiceChannel: ds.channels.findOneBy("name", "General")!.snowflake,
  };
}

/** Seed a connected voice state for a user in a guild and return the stored record's id. */
function seedVoiceState(
  store: Store,
  opts: { guild: string; user: string; channel: string; overrides?: Record<string, unknown> },
): number {
  const ds = getDiscordStore(store);
  const record = ds.voiceStates.insert({
    guild_snowflake: opts.guild,
    channel_snowflake: opts.channel,
    user_snowflake: opts.user,
    session_id: "90326bd25d71d39b9ef95b299e3872ff",
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: true,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
    ...(opts.overrides ?? {}),
  });
  return record.id;
}

describe("voice.mdx — Voice State Object", () => {
  it("serializes every documented Voice State field with the correct types", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    seedVoiceState(store, { guild, user: bot, channel: voiceChannel });

    const res = await app.request(api(`/guilds/${guild}/voice-states/${bot}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const v = await json(res);

    // guild_id? — present here because this is a guild voice state.
    expect(v.guild_id).toBe(guild);
    // channel_id — ?snowflake (the channel the user is connected to).
    expect(v.channel_id).toBe(voiceChannel);
    // user_id — snowflake.
    expect(v.user_id).toBe(bot);
    // session_id — string.
    expect(typeof v.session_id).toBe("string");
    // deaf / mute — server (guild) deafen/mute booleans.
    expect(v.deaf).toBe(false);
    expect(v.mute).toBe(false);
    // self_deaf / self_mute — local booleans.
    expect(v.self_deaf).toBe(false);
    expect(v.self_mute).toBe(true);
    // self_video — boolean (camera enabled).
    expect(typeof v.self_video).toBe("boolean");
    // suppress — boolean (permission to speak denied).
    expect(v.suppress).toBe(false);
    // request_to_speak_timestamp — ?ISO8601 timestamp; null when not requested.
    expect(v.request_to_speak_timestamp).toBeNull();
  });

  it("includes the member object for a guild voice state", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    seedVoiceState(store, { guild, user: bot, channel: voiceChannel });
    const v = (await (
      await app.request(api(`/guilds/${guild}/voice-states/${bot}`), { headers: botHeaders() })
    ).json()) as Record<string, unknown>;
    // member? — the guild member this voice state is for (the bot is a member of Emulate Server).
    expect(v.member).toBeDefined();
    const member = v.member as Record<string, unknown>;
    expect(Array.isArray(member.roles)).toBe(true);
    expect("joined_at" in member).toBe(true);
  });

  it("channel_id is nullable per the ?snowflake type", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    seedVoiceState(store, { guild, user: bot, channel: voiceChannel, overrides: { channel_snowflake: null } });
    const v = (await (
      await app.request(api(`/guilds/${guild}/voice-states/${bot}`), { headers: botHeaders() })
    ).json()) as Record<string, unknown>;
    expect(v.channel_id).toBeNull();
  });

  it("request_to_speak_timestamp round-trips an ISO8601 string", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    const ts = "2021-03-31T18:45:31.297561+00:00";
    seedVoiceState(store, { guild, user: bot, channel: voiceChannel, overrides: { request_to_speak_timestamp: ts } });
    const v = (await (
      await app.request(api(`/guilds/${guild}/voice-states/${bot}`), { headers: botHeaders() })
    ).json()) as Record<string, unknown>;
    expect(v.request_to_speak_timestamp).toBe(ts);
  });
});

describe("voice.mdx — Voice Region Object / List Voice Regions", () => {
  it("GET /voice/regions returns an array of voice region objects with the documented shape", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/voice/regions"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const regions = await json<Array<Record<string, unknown>>>(res);
    expect(Array.isArray(regions)).toBe(true);
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      // id — string (unique ID for the region).
      expect(typeof r.id).toBe("string");
      // name — string.
      expect(typeof r.name).toBe("string");
      // optimal — boolean.
      expect(typeof r.optimal).toBe("boolean");
      // deprecated — boolean.
      expect(typeof r.deprecated).toBe("boolean");
      // custom — boolean.
      expect(typeof r.custom).toBe("boolean");
    }
  });
});

describe("voice.mdx — Get Current User Voice State", () => {
  it("GET /guilds/{id}/voice-states/@me returns the current user's voice state", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    seedVoiceState(store, { guild, user: bot, channel: voiceChannel });
    const res = await app.request(api(`/guilds/${guild}/voice-states/@me`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const v = await json(res);
    expect(v.user_id).toBe(bot);
    expect(v.channel_id).toBe(voiceChannel);
  });

  it("requires authentication", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/voice-states/@me`));
    expect(res.status).toBe(401);
  });
});

describe("voice.mdx — Get User Voice State", () => {
  it("GET /guilds/{id}/voice-states/{user.id} returns the specified user's voice state", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer, voiceChannel } = ids(store);
    seedVoiceState(store, { guild, user: developer, channel: voiceChannel });
    const res = await app.request(api(`/guilds/${guild}/voice-states/${developer}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const v = await json(res);
    expect(v.user_id).toBe(developer);
  });
});

describe("voice.mdx — Modify Current User Voice State", () => {
  it("returns 204 No Content and applies channel_id, suppress, request_to_speak_timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    const id = seedVoiceState(store, { guild, user: bot, channel: voiceChannel });
    const ts = "2026-06-22T18:45:31.297561+00:00";
    const res = await app.request(api(`/guilds/${guild}/voice-states/@me`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: voiceChannel, suppress: true, request_to_speak_timestamp: ts }),
    });
    expect(res.status).toBe(204);
    const ds = getDiscordStore(store);
    const state = ds.voiceStates.get(id)!;
    expect(state.suppress).toBe(true);
    expect(state.channel_snowflake).toBe(voiceChannel);
    expect(state.request_to_speak_timestamp).toBe(ts);
  });

  it("can clear request_to_speak_timestamp by setting it to null (?ISO8601 type)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    const id = seedVoiceState(store, {
      guild,
      user: bot,
      channel: voiceChannel,
      overrides: { request_to_speak_timestamp: "2026-06-22T00:00:00.000000+00:00" },
    });
    const res = await app.request(api(`/guilds/${guild}/voice-states/@me`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ request_to_speak_timestamp: null }),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).voiceStates.get(id)!.request_to_speak_timestamp).toBeNull();
  });

  it("can suppress yourself (the caveat: you can always suppress yourself)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    const id = seedVoiceState(store, { guild, user: bot, channel: voiceChannel });
    const res = await app.request(api(`/guilds/${guild}/voice-states/@me`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ suppress: true }),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).voiceStates.get(id)!.suppress).toBe(true);
  });

  it("requires authentication", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/voice-states/@me`), {
      method: "PATCH",
      body: JSON.stringify({ suppress: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe("voice.mdx — Modify User Voice State", () => {
  it("returns 204 No Content and applies channel_id and suppress", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer, voiceChannel } = ids(store);
    const id = seedVoiceState(store, { guild, user: developer, channel: voiceChannel });
    const res = await app.request(api(`/guilds/${guild}/voice-states/${developer}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: voiceChannel, suppress: true }),
    });
    expect(res.status).toBe(204);
    const state = getDiscordStore(store).voiceStates.get(id)!;
    expect(state.suppress).toBe(true);
    expect(state.channel_snowflake).toBe(voiceChannel);
  });

  it("caveat: suppressing removes the user's request_to_speak_timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer, voiceChannel } = ids(store);
    const id = seedVoiceState(store, {
      guild,
      user: developer,
      channel: voiceChannel,
      overrides: { request_to_speak_timestamp: "2026-06-22T00:00:00.000000+00:00", suppress: false },
    });
    const res = await app.request(api(`/guilds/${guild}/voice-states/${developer}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ suppress: true }),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).voiceStates.get(id)!.request_to_speak_timestamp).toBeNull();
  });

  it("caveat: unsuppressing a non-bot user sets request_to_speak_timestamp to the current time", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer, voiceChannel } = ids(store);
    const id = seedVoiceState(store, {
      guild,
      user: developer,
      channel: voiceChannel,
      overrides: { suppress: true, request_to_speak_timestamp: null },
    });
    const res = await app.request(api(`/guilds/${guild}/voice-states/${developer}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ suppress: false }),
    });
    expect(res.status).toBe(204);
    const state = getDiscordStore(store).voiceStates.get(id)!;
    expect(state.suppress).toBe(false);
    // developer is a non-bot user, so request_to_speak_timestamp is set to "now".
    expect(typeof state.request_to_speak_timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(state.request_to_speak_timestamp!))).toBe(false);
  });

  it("caveat: unsuppressing a bot user does NOT set request_to_speak_timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    const id = seedVoiceState(store, {
      guild,
      user: bot,
      channel: voiceChannel,
      overrides: { suppress: true, request_to_speak_timestamp: null },
    });
    const res = await app.request(api(`/guilds/${guild}/voice-states/${bot}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ suppress: false }),
    });
    expect(res.status).toBe(204);
    const state = getDiscordStore(store).voiceStates.get(id)!;
    expect(state.suppress).toBe(false);
    expect(state.request_to_speak_timestamp).toBeNull();
  });

  it("the Modify User Voice State JSON params do NOT include request_to_speak_timestamp", async () => {
    // Per the doc, only channel_id and suppress are accepted here; an attempt to set
    // request_to_speak_timestamp directly must be ignored (it is governed by the suppress caveat).
    const { app, store } = createDiscordTestApp();
    const { guild, bot, voiceChannel } = ids(store);
    const id = seedVoiceState(store, {
      guild,
      user: bot,
      channel: voiceChannel,
      overrides: { request_to_speak_timestamp: null },
    });
    const res = await app.request(api(`/guilds/${guild}/voice-states/${bot}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ request_to_speak_timestamp: "2030-01-01T00:00:00.000000+00:00" }),
    });
    expect(res.status).toBe(204);
    // The bot was not (un)suppressed and the param is not part of this endpoint, so it stays null.
    expect(getDiscordStore(store).voiceStates.get(id)!.request_to_speak_timestamp).toBeNull();
  });

  it("requires a bot token", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/voice-states/${developer}`), {
      method: "PATCH",
      body: JSON.stringify({ suppress: true }),
    });
    expect(res.status).toBe(401);
  });
});
