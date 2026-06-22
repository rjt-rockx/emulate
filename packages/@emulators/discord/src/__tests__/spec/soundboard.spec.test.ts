/**
 * Spec suite for `developers/resources/soundboard.mdx`.
 *
 * Encodes the page's documented expectations directly: the Soundboard Sound object shape
 * (default vs guild sounds), and every endpoint — Send Soundboard Sound (fires a
 * VOICE_CHANNEL_EFFECT_SEND gateway event), List Default Sounds, List/Get/Create/Modify/Delete
 * Guild Soundboard Sound — with response/status/error contracts, the GUILD_SOUNDBOARD_SOUND_*
 * gateway events on CRUD, and the create validation (name 2-32, sound data, volume 0-1).
 * Written from the doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { getDiscordRuntime } from "../../runtime.js";
import type { GatewayEvent } from "../../gateway/dispatcher.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    voiceChannel: ds.channels.all().find((c) => c.type === 2)!.snowflake,
    application: ds.applications.all()[0]!,
  };
}

/** Capture gateway events published on the per-store bus during `fn`. */
function captureEvents(store: ReturnType<typeof createDiscordTestApp>["store"]): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  getDiscordRuntime(store).bus.subscribe((e) => events.push(e));
  return events;
}

// A 1x1 minimal data URI; the emulator does not decode the bytes but requires the field.
const SOUND_DATA = "data:audio/mpeg;base64,SUQzAAAAAAAB";

async function createSound(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  guild: string,
  body: Record<string, unknown> = { name: "airhorn", sound: SOUND_DATA, volume: 0.8 },
) {
  const res = await app.request(api(`/guilds/${guild}/soundboard-sounds`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return { res, sound: (await res.json()) as Record<string, unknown> };
}

describe("soundboard.mdx — Soundboard Sound object", () => {
  it("List Default Soundboard Sounds returns sounds with the documented shape", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/soundboard-default-sounds"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const sounds = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(sounds)).toBe(true);
    expect(sounds.length).toBeGreaterThan(0);
    for (const s of sounds) {
      expect(typeof s.name).toBe("string");
      // sound_id is a snowflake (string).
      expect(typeof s.sound_id).toBe("string");
      expect(typeof s.volume).toBe("number");
      expect("emoji_id" in s).toBe(true);
      expect("emoji_name" in s).toBe(true);
      expect(typeof s.available).toBe("boolean");
      // Default sounds have no guild_id.
      expect("guild_id" in s).toBe(false);
    }
  });

  it("default 'quack' sound matches the documented example object", async () => {
    const { app } = createDiscordTestApp();
    const sounds = (await (
      await app.request(api("/soundboard-default-sounds"), { headers: botHeaders() })
    ).json()) as Array<Record<string, unknown>>;
    const quack = sounds.find((s) => s.name === "quack");
    expect(quack).toBeDefined();
    expect(quack!.sound_id).toBe("1");
    expect(quack!.volume).toBe(1);
    expect(quack!.emoji_id).toBeNull();
    expect(quack!.emoji_name).toBe("\u{1F986}");
    expect(quack!.available).toBe(true);
  });

  it("expands the default-sounds list toward the real set (more than the example)", async () => {
    const { app } = createDiscordTestApp();
    const sounds = (await (
      await app.request(api("/soundboard-default-sounds"), { headers: botHeaders() })
    ).json()) as Array<Record<string, unknown>>;
    expect(sounds.length).toBeGreaterThanOrEqual(8);
    // sound_ids must be unique.
    const seen = new Set(sounds.map((s) => s.sound_id));
    expect(seen.size).toBe(sounds.length);
  });
});

describe("soundboard.mdx — Create Guild Soundboard Sound", () => {
  it("returns 201 with a guild sound carrying the documented fields and fires CREATE", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, application } = ids(store);
    const events = captureEvents(store);
    const { res, sound: s } = await createSound(app, guild, {
      name: "Yay",
      sound: SOUND_DATA,
      volume: 1,
      emoji_id: "989193655938064464",
    });
    expect(res.status).toBe(201);
    expect(s.name).toBe("Yay");
    expect(typeof s.sound_id).toBe("string");
    expect(s.volume).toBe(1);
    expect(s.emoji_id).toBe("989193655938064464");
    expect("emoji_name" in s).toBe(true);
    expect(s.guild_id).toBe(guild);
    expect(s.available).toBe(true);
    // Bot has expressions perms by default, so the creator user is included.
    expect((s.user as Record<string, unknown>).id).toBe(application.bot_user_snowflake);

    const create = events.find((e) => e.t === "GUILD_SOUNDBOARD_SOUND_CREATE");
    expect(create).toBeDefined();
    expect(create!.guildId).toBe(guild);
    expect((create!.d as Record<string, unknown>).sound_id).toBe(s.sound_id);
  });

  it("volume defaults to 1 when omitted", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: s } = await createSound(app, guild, { name: "boop", sound: SOUND_DATA });
    expect(s.volume).toBe(1);
  });

  it("rejects a name shorter than 2 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { res } = await createSound(app, guild, { name: "a", sound: SOUND_DATA });
    expect(res.status).toBe(400);
    const { sound: err } = await createSound(app, guild, { name: "a", sound: SOUND_DATA });
    expect((err as { code: number }).code).toBe(50035);
  });

  it("rejects a name longer than 32 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { res, sound: err } = await createSound(app, guild, { name: "x".repeat(33), sound: SOUND_DATA });
    expect(res.status).toBe(400);
    expect((err as { code: number }).code).toBe(50035);
  });

  it("rejects an empty/invalid sound data uri when one is provided (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "bad-sound", sound: "" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a volume outside 0-1 (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { res, sound: err } = await createSound(app, guild, { name: "loud", sound: SOUND_DATA, volume: 5 });
    expect(res.status).toBe(400);
    expect((err as { code: number }).code).toBe(50035);
  });

  it("accepts boundary names (2 and 32 chars) and volume 0 / 1", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    expect((await createSound(app, guild, { name: "ab", sound: SOUND_DATA, volume: 0 })).res.status).toBe(201);
    expect((await createSound(app, guild, { name: "z".repeat(32), sound: SOUND_DATA, volume: 1 })).res.status).toBe(
      201,
    );
  });

  it("Create on an unknown guild returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/soundboard-sounds"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ok", sound: SOUND_DATA }),
    });
    expect(res.status).toBe(404);
  });
});

describe("soundboard.mdx — List / Get Guild Soundboard Sound", () => {
  it("List returns { items: [...] } including the created sound", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((s) => s.sound_id === created.sound_id)).toBe(true);
  });

  it("Get returns the soundboard sound for the id", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/${created.sound_id}`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Record<string, unknown>;
    expect(s.sound_id).toBe(created.sound_id);
    expect(s.guild_id).toBe(guild);
  });

  it("Get for an unknown sound returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/999999999999999999`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("soundboard.mdx — Modify Guild Soundboard Sound", () => {
  it("updates name/volume/emoji and fires UPDATE", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const events = captureEvents(store);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/${created.sound_id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "renamed", volume: 0.5, emoji_name: "\u{1F525}" }),
    });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Record<string, unknown>;
    expect(s.name).toBe("renamed");
    expect(s.volume).toBe(0.5);
    expect(s.emoji_name).toBe("\u{1F525}");
    expect(events.some((e) => e.t === "GUILD_SOUNDBOARD_SOUND_UPDATE")).toBe(true);
  });

  it("rejects a name outside 2-32 chars on modify (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/${created.sound_id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "z".repeat(33) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("Modify on an unknown sound returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/999999999999999999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("soundboard.mdx — Delete Guild Soundboard Sound", () => {
  it("returns 204 and fires DELETE", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const events = captureEvents(store);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/${created.sound_id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).soundboardSounds.findOneBy("snowflake", created.sound_id as string)).toBeUndefined();
    const del = events.find((e) => e.t === "GUILD_SOUNDBOARD_SOUND_DELETE");
    expect(del).toBeDefined();
    expect((del!.d as Record<string, unknown>).sound_id).toBe(created.sound_id);
  });

  it("Delete on an unknown sound returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/soundboard-sounds/999999999999999999`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("soundboard.mdx — Send Soundboard Sound", () => {
  it("fires a VOICE_CHANNEL_EFFECT_SEND gateway event with the sound id", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const events = captureEvents(store);

    const res = await app.request(api(`/channels/${voiceChannel}/send-soundboard-sound`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sound_id: created.sound_id, source_guild_id: guild }),
    });
    expect(res.status).toBe(204);

    const effect = events.find((e) => e.t === "VOICE_CHANNEL_EFFECT_SEND");
    expect(effect).toBeDefined();
    const d = effect!.d as Record<string, unknown>;
    expect(d.channel_id).toBe(voiceChannel);
    expect(d.guild_id).toBe(guild);
    expect("user_id" in d).toBe(true);
    expect(d.sound_id).toBe(created.sound_id);
  });

  it("returns 404 for an unknown channel", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999/send-soundboard-sound"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sound_id: "1" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("soundboard.mdx — GUILD_SOUNDBOARD_SOUNDS_UPDATE bulk event", () => {
  it("fires GUILD_SOUNDBOARD_SOUNDS_UPDATE with the full sound list after Create", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const events = captureEvents(store);
    const { sound: created } = await createSound(app, guild, { name: "beep", sound: SOUND_DATA, volume: 1 });
    const bulk = events.find((e) => e.t === "GUILD_SOUNDBOARD_SOUNDS_UPDATE");
    expect(bulk).toBeDefined();
    const d = bulk!.d as Record<string, unknown>;
    expect(d.guild_id).toBe(guild);
    expect(Array.isArray(d.soundboard_sounds)).toBe(true);
    const sounds = d.soundboard_sounds as Array<Record<string, unknown>>;
    expect(sounds.some((s) => s.sound_id === created.sound_id)).toBe(true);
  });

  it("fires GUILD_SOUNDBOARD_SOUNDS_UPDATE after Modify", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild);
    const events = captureEvents(store);
    await app.request(api(`/guilds/${guild}/soundboard-sounds/${created.sound_id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "boop" }),
    });
    const bulk = events.find((e) => e.t === "GUILD_SOUNDBOARD_SOUNDS_UPDATE");
    expect(bulk).toBeDefined();
    const d = bulk!.d as Record<string, unknown>;
    expect(d.guild_id).toBe(guild);
    const sounds = d.soundboard_sounds as Array<Record<string, unknown>>;
    expect(sounds.some((s) => s.name === "boop")).toBe(true);
  });

  it("fires GUILD_SOUNDBOARD_SOUNDS_UPDATE after Delete (sound absent from list)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { sound: created } = await createSound(app, guild, { name: "todelete", sound: SOUND_DATA, volume: 1 });
    const events = captureEvents(store);
    await app.request(api(`/guilds/${guild}/soundboard-sounds/${created.sound_id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    const bulk = events.find((e) => e.t === "GUILD_SOUNDBOARD_SOUNDS_UPDATE");
    expect(bulk).toBeDefined();
    const d = bulk!.d as Record<string, unknown>;
    const sounds = d.soundboard_sounds as Array<Record<string, unknown>>;
    expect(sounds.some((s) => s.sound_id === created.sound_id)).toBe(false);
  });
});
