/**
 * Spec suite for `developers/resources/guild-scheduled-event.mdx`.
 *
 * Encodes the page's documented expectations directly: the Guild Scheduled Event object shape
 * (entity_metadata, entity_id, recurrence_rule, image, creator, user_count), the entity-type /
 * privacy-level / status enumerations, the legal status transitions, the entity_type field
 * requirement matrix, every endpoint's request/response contract and error codes, the scheduled
 * event user object, the subscriber endpoints, and the Gateway events each mutation fires.
 * Written from the doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { getDiscordRuntime } from "../../runtime.js";
import { createUser, addGuildMember, createChannel } from "../../factories.js";
import type { GatewayEvent } from "../../gateway/dispatcher.js";

function ctx(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  const ds = getDiscordStore(store);
  // Create a stage channel (type 13) for STAGE_INSTANCE events.
  const stageChannel = createChannel(ds, { name: "Stage", type: 13, guildSnowflake: s.guild });
  return {
    ds,
    developer: s.developer,
    guild: s.guild,
    voiceChannel: s.voice, // type 2 (voice)
    stageChannel: stageChannel.snowflake, // type 13 (stage)
    textChannel: s.general, // type 0
  };
}

/** Capture every gateway event a block of work publishes. */
function captureEvents(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const events: GatewayEvent[] = [];
  const unsubscribe = getDiscordRuntime(store).bus.subscribe((e) => events.push(e));
  return { events, unsubscribe };
}

const START = "2099-01-01T00:00:00.000Z";
const END = "2099-01-01T02:00:00.000Z";

/** A valid EXTERNAL event create body (channel_id null, entity_metadata.location, end time). */
function externalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "External Meetup",
    privacy_level: 2,
    scheduled_start_time: START,
    scheduled_end_time: END,
    entity_type: 3,
    entity_metadata: { location: "Somewhere" },
    ...overrides,
  };
}

/** A valid VOICE event create body (channel_id required, no entity_metadata). */
function voiceBody(channelId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Voice Hangout",
    privacy_level: 2,
    scheduled_start_time: START,
    entity_type: 2,
    channel_id: channelId,
    ...overrides,
  };
}

async function createEvent(app: ReturnType<typeof createDiscordTestApp>["app"], guild: string, body: Record<string, unknown>) {
  const res = await app.request(api(`/guilds/${guild}/scheduled-events`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return { res, json: await json(res)};
}

describe("guild-scheduled-event.mdx — Guild Scheduled Event Object", () => {
  it("Create returns every documented field, including entity_metadata/entity_id/recurrence_rule/image/creator/user_count", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: e } = await createEvent(app, guild, externalBody());
    expect(res.status).toBe(201);
    // Identity + scope fields.
    expect(typeof e.id).toBe("string");
    expect(e.guild_id).toBe(guild);
    // EXTERNAL events carry a null channel_id.
    expect(e.channel_id).toBeNull();
    // creator_id is the acting bot; creator user object is included.
    expect(typeof e.creator_id).toBe("string");
    expect((e.creator as Record<string, unknown>).id).toBe(e.creator_id);
    expect(e.name).toBe("External Meetup");
    expect(e.scheduled_start_time).toBe(START);
    expect(e.scheduled_end_time).toBe(END);
    expect(e.privacy_level).toBe(2);
    expect(e.status).toBe(1);
    expect(e.entity_type).toBe(3);
    // entity_id is present (null for a fresh event) and entity_metadata round-trips.
    expect("entity_id" in e).toBe(true);
    expect((e.entity_metadata as Record<string, unknown>).location).toBe("Somewhere");
    // user_count present; recurrence_rule + image present (null when unset).
    expect(e.user_count).toBe(0);
    expect("recurrence_rule" in e).toBe(true);
    expect("image" in e).toBe(true);
  });

  it("persists and echoes recurrence_rule and image on create", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const recurrence_rule = { start: START, frequency: 2, interval: 1, by_weekday: [2] };
    const { json: e } = await createEvent(
      app,
      guild,
      externalBody({ recurrence_rule, image: "data:image/png;base64,aGVsbG8=" }),
    );
    expect((e.recurrence_rule as Record<string, unknown>).frequency).toBe(2);
    expect((e.recurrence_rule as Record<string, unknown>).interval).toBe(1);
    expect(typeof e.image).toBe("string");
    // The stored row reflects the same values.
    const stored = getDiscordStore(store).scheduledEvents.findOneBy("snowflake", e.id as string)!;
    expect((stored.recurrence_rule as Record<string, unknown>).frequency).toBe(2);
    expect(stored.image).toBeTruthy();
  });
});

describe("guild-scheduled-event.mdx — enumerations", () => {
  it("privacy_level GUILD_ONLY is 2", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody({ privacy_level: 2 }));
    expect(e.privacy_level).toBe(2);
  });

  it("entity types are STAGE_INSTANCE=1, VOICE=2, EXTERNAL=3", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel, stageChannel } = ctx(store);
    // STAGE_INSTANCE requires a stage channel (type 13).
    const stage = await createEvent(app, guild, { ...voiceBody(voiceChannel), entity_type: 1, channel_id: stageChannel });
    expect(stage.json.entity_type).toBe(1);
    const voice = await createEvent(app, guild, voiceBody(voiceChannel));
    expect(voice.json.entity_type).toBe(2);
    const external = await createEvent(app, guild, externalBody());
    expect(external.json.entity_type).toBe(3);
  });

  it("status enum SCHEDULED=1 on a newly-created event", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    expect(e.status).toBe(1);
  });
});

describe("guild-scheduled-event.mdx — Field Requirements By Entity Type", () => {
  it("EXTERNAL requires null channel_id, entity_metadata.location and scheduled_end_time", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    // Missing entity_metadata -> 50035.
    const noMeta = await createEvent(app, guild, externalBody({ entity_metadata: undefined }));
    expect(noMeta.res.status).toBe(400);
    expect(noMeta.json.code).toBe(50035);
    // Missing location -> 50035.
    const noLocation = await createEvent(app, guild, externalBody({ entity_metadata: {} }));
    expect(noLocation.res.status).toBe(400);
    expect(noLocation.json.code).toBe(50035);
    // Missing scheduled_end_time -> 50035.
    const noEnd = await createEvent(app, guild, externalBody({ scheduled_end_time: undefined }));
    expect(noEnd.res.status).toBe(400);
    expect(noEnd.json.code).toBe(50035);
  });

  it("STAGE_INSTANCE and VOICE require a channel_id (50035 when omitted)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    const noChannelVoice = await createEvent(app, guild, voiceBody(voiceChannel, { channel_id: undefined }));
    expect(noChannelVoice.res.status).toBe(400);
    expect(noChannelVoice.json.code).toBe(50035);
    const noChannelStage = await createEvent(app, guild, { ...voiceBody(voiceChannel), entity_type: 1, channel_id: undefined });
    expect(noChannelStage.res.status).toBe(400);
    expect(noChannelStage.json.code).toBe(50035);
  });

  it("STAGE_INSTANCE and VOICE force entity_metadata to null (discarded)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    const { json: e } = await createEvent(app, guild, voiceBody(voiceChannel, { entity_metadata: { location: "ignored" } }));
    expect(e.entity_metadata).toBeNull();
    expect(e.channel_id).toBe(voiceChannel);
  });
});

describe("guild-scheduled-event.mdx — Valid Status Transitions", () => {
  it("allows SCHEDULED -> ACTIVE", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 2 }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: number }>(res)).status).toBe(2);
  });

  it("allows ACTIVE -> COMPLETED", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 2 }),
    });
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 3 }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: number }>(res)).status).toBe(3);
  });

  it("allows SCHEDULED -> CANCELED", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 4 }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: number }>(res)).status).toBe(4);
  });

  it("rejects an illegal transition (SCHEDULED -> COMPLETED) with 400", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 3 }),
    });
    expect(res.status).toBe(400);
  });

  it("a terminal status (COMPLETED or CANCELED) can no longer be updated", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    // Move to CANCELED (terminal).
    await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 4 }),
    });
    // Any further status change is rejected.
    const toActive = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ status: 2 }),
    });
    expect(toActive.status).toBe(400);
  });
});

describe("guild-scheduled-event.mdx — List / Get with_user_count", () => {
  it("List Scheduled Events for Guild returns the guild's events", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = await json<Array<{ id: string; user_count?: number }>>(res);
    expect(list.some((x) => x.id === e.id)).toBe(true);
  });

  it("with_user_count includes user_count on each event", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events?with_user_count=true`), { headers: botHeaders() });
    const list = await json<Array<{ user_count?: number }>>(res);
    expect(typeof list[0].user_count).toBe("number");
  });

  it("Get Guild Scheduled Event returns the event; with_user_count adds user_count", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}?with_user_count=true`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const got = await json<{ id: string; user_count?: number }>(res);
    expect(got.id).toBe(e.id);
    expect(typeof got.user_count).toBe("number");
  });

  it("Get for an unknown event returns 404 Unknown Guild Scheduled Event (10070)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10070);
  });
});

describe("guild-scheduled-event.mdx — Modify", () => {
  it("persists entity_metadata/recurrence_rule/image and discards entity_metadata for non-EXTERNAL", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const patched = (await (
      await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({
          entity_metadata: { location: "New Place" },
          image: "data:image/png;base64,bmV3",
          recurrence_rule: { start: START, frequency: 3, interval: 1, by_weekday: [0, 1, 2, 3, 4] },
        }),
      })
    ).json()) as Record<string, unknown>;
    expect((patched.entity_metadata as Record<string, unknown>).location).toBe("New Place");
    expect(typeof patched.image).toBe("string");
    expect((patched.recurrence_rule as Record<string, unknown>).frequency).toBe(3);
  });

  it("Modify on an unknown event returns 404 (10070)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/999999999999999999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10070);
  });

  it("Modify entity_type to EXTERNAL requires entity_metadata.location (50035 when absent)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    // Start as VOICE so we have a valid event to patch.
    const { json: e } = await createEvent(app, guild, voiceBody(voiceChannel));
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      // Switch to EXTERNAL without providing entity_metadata or scheduled_end_time.
      body: JSON.stringify({ entity_type: 3 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Modify entity_type to EXTERNAL requires scheduled_end_time (50035 when absent)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    const { json: e } = await createEvent(app, guild, voiceBody(voiceChannel));
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      // Provide location but no scheduled_end_time (event has none).
      body: JSON.stringify({ entity_type: 3, entity_metadata: { location: "Somewhere" } }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Modify entity_type to EXTERNAL succeeds with location + scheduled_end_time", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    const { json: e } = await createEvent(app, guild, voiceBody(voiceChannel));
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ entity_type: 3, entity_metadata: { location: "Arena" }, scheduled_end_time: END }),
    });
    expect(res.status).toBe(200);
    const patched = await json(res);
    expect(patched.entity_type).toBe(3);
    expect(patched.channel_id).toBeNull();
    expect((patched.entity_metadata as Record<string, unknown>).location).toBe("Arena");
  });

  it("Modify entity_type to STAGE_INSTANCE requires channel_id (50035 when absent)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    // Start as EXTERNAL, then switch to STAGE_INSTANCE without channel_id.
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ entity_type: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Modify entity_type to VOICE requires channel_id (50035 when absent)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ entity_type: 2 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Modify entity_type to VOICE with channel_id forces entity_metadata to null", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    // Start as EXTERNAL (has entity_metadata).
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ entity_type: 2, channel_id: voiceChannel }),
    });
    expect(res.status).toBe(200);
    const patched = await json(res);
    expect(patched.entity_type).toBe(2);
    expect(patched.entity_metadata).toBeNull();
    expect(patched.channel_id).toBe(voiceChannel);
  });
});

describe("guild-scheduled-event.mdx — Delete", () => {
  it("returns 204 and removes the event", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).scheduledEvents.findOneBy("snowflake", e.id as string)).toBeUndefined();
  });

  it("Delete on an unknown event returns 404 (10070)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/999999999999999999`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10070);
  });
});

describe("guild-scheduled-event.mdx — Subscribers & Get Event Users", () => {
  it("Get Event Users returns the scheduled event user object shape (guild_scheduled_event_id + user)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, developer } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    // Seed a subscriber directly via the subscriber model.
    ds.scheduledEventUsers.insert({ event_snowflake: e.id as string, guild_snowflake: guild, user_snowflake: developer });
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const users = await json<Array<Record<string, unknown>>>(res);
    expect(users.length).toBe(1);
    expect(users[0].guild_scheduled_event_id).toBe(e.id);
    expect((users[0].user as Record<string, unknown>).id).toBe(developer);
    // member is absent unless with_member is requested.
    expect("member" in users[0]).toBe(false);
  });

  it("with_member=true includes guild member data when it exists", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, developer } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    ds.scheduledEventUsers.insert({ event_snowflake: e.id as string, guild_snowflake: guild, user_snowflake: developer });
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users?with_member=true`), { headers: botHeaders() });
    const users = await json<Array<Record<string, unknown>>>(res);
    expect(users[0].member).toBeDefined();
    expect(Array.isArray((users[0].member as Record<string, unknown>).roles)).toBe(true);
  });

  it("honors limit and ascending user_id order; before/after paginate", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    // Create three users with deterministic ascending snowflakes.
    const u1 = createUser(ds, { username: "sub-a", snowflake: "100000000000000001" });
    const u2 = createUser(ds, { username: "sub-b", snowflake: "100000000000000002" });
    const u3 = createUser(ds, { username: "sub-c", snowflake: "100000000000000003" });
    for (const u of [u3, u1, u2]) {
      addGuildMember(ds, guild, u.snowflake);
      ds.scheduledEventUsers.insert({ event_snowflake: e.id as string, guild_snowflake: guild, user_snowflake: u.snowflake });
    }
    // limit=2 -> first two by ascending user id.
    const limited = (await (
      await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users?limit=2`), { headers: botHeaders() })
    ).json()) as Array<{ user: { id: string } }>;
    expect(limited.length).toBe(2);
    expect(limited.map((x) => x.user.id)).toEqual([u1.snowflake, u2.snowflake]);
    // after the first user -> the rest in ascending order.
    const afterFirst = (await (
      await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users?after=${u1.snowflake}`), { headers: botHeaders() })
    ).json()) as Array<{ user: { id: string } }>;
    expect(afterFirst.map((x) => x.user.id)).toEqual([u2.snowflake, u3.snowflake]);
    // before the last user -> users with smaller ids.
    const beforeLast = (await (
      await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users?before=${u3.snowflake}`), { headers: botHeaders() })
    ).json()) as Array<{ user: { id: string } }>;
    expect(beforeLast.map((x) => x.user.id)).toEqual([u1.snowflake, u2.snowflake]);
  });

  it("PUT .../users/@me subscribes the bot and increments user_count; fires USER_ADD", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const botSnowflake = ds.applications.all()[0]!.bot_user_snowflake;
    const { events, unsubscribe } = captureEvents(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });
    unsubscribe();
    expect(res.status).toBe(204);
    // Subscriber row persisted.
    const subscribed = ds.scheduledEventUsers
      .findBy("event_snowflake", e.id as string)
      .some((s) => s.user_snowflake === botSnowflake);
    expect(subscribed).toBe(true);
    // user_count reflects the subscription.
    const got = (await (
      await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}?with_user_count=true`), { headers: botHeaders() })
    ).json()) as { user_count: number };
    expect(got.user_count).toBe(1);
    // USER_ADD gateway event fired.
    const add = events.find((ev) => ev.t === "GUILD_SCHEDULED_EVENT_USER_ADD");
    expect(add).toBeDefined();
    expect((add!.d as Record<string, unknown>).user_id).toBe(botSnowflake);
    expect((add!.d as Record<string, unknown>).guild_scheduled_event_id).toBe(e.id);
  });

  it("DELETE .../users/@me unsubscribes and fires USER_REMOVE", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const botSnowflake = ds.applications.all()[0]!.bot_user_snowflake;
    // First subscribe.
    await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users/@me`), { method: "PUT", headers: botHeaders() });
    const { events, unsubscribe } = captureEvents(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}/users/@me`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    unsubscribe();
    expect(res.status).toBe(204);
    const stillSubscribed = ds.scheduledEventUsers
      .findBy("event_snowflake", e.id as string)
      .some((s) => s.user_snowflake === botSnowflake);
    expect(stillSubscribed).toBe(false);
    const remove = events.find((ev) => ev.t === "GUILD_SCHEDULED_EVENT_USER_REMOVE");
    expect(remove).toBeDefined();
    expect((remove!.d as Record<string, unknown>).user_id).toBe(botSnowflake);
  });
});

describe("guild-scheduled-event.mdx — Gateway events", () => {
  it("Create fires GUILD_SCHEDULED_EVENT_CREATE", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { events, unsubscribe } = captureEvents(store);
    await createEvent(app, guild, externalBody());
    unsubscribe();
    expect(events.some((e) => e.t === "GUILD_SCHEDULED_EVENT_CREATE")).toBe(true);
  });

  it("Modify fires GUILD_SCHEDULED_EVENT_UPDATE and Delete fires GUILD_SCHEDULED_EVENT_DELETE", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const { events, unsubscribe } = captureEvents(store);
    await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Renamed" }),
    });
    await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), { method: "DELETE", headers: botHeaders() });
    unsubscribe();
    expect(events.some((ev) => ev.t === "GUILD_SCHEDULED_EVENT_UPDATE")).toBe(true);
    expect(events.some((ev) => ev.t === "GUILD_SCHEDULED_EVENT_DELETE")).toBe(true);
  });
});

describe("guild-scheduled-event.mdx — auth", () => {
  it("requires a bot token", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(externalBody()),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// G1: Required field validation
// ---------------------------------------------------------------------------
describe("guild-scheduled-event.mdx — G1: Required field validation on Create", () => {
  it("rejects missing name with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, externalBody({ name: undefined }));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("rejects name longer than 100 chars with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, externalBody({ name: "x".repeat(101) }));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("rejects description longer than 1000 chars with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, externalBody({ description: "d".repeat(1001) }));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("rejects missing privacy_level with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, externalBody({ privacy_level: undefined }));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("rejects missing entity_type with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, externalBody({ entity_type: undefined }));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("rejects missing scheduled_start_time with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, externalBody({ scheduled_start_time: undefined }));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });
});

// ---------------------------------------------------------------------------
// G2: Strip non-settable recurrence_rule fields
// ---------------------------------------------------------------------------
describe("guild-scheduled-event.mdx — G2: recurrence_rule non-settable fields are stripped", () => {
  it("strips count, end, and by_year_day from recurrence_rule on create", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: e } = await createEvent(app, guild, externalBody({
      recurrence_rule: {
        start: START,
        frequency: 2,
        interval: 1,
        by_weekday: [2],
        count: 5,
        end: END,
        by_year_day: [1, 2, 3],
      },
    }));
    expect(res.status).toBe(201);
    const rule = e.recurrence_rule as Record<string, unknown>;
    expect("count" in rule).toBe(false);
    expect("end" in rule).toBe(false);
    expect("by_year_day" in rule).toBe(false);
    // Allowed fields preserved.
    expect(rule.frequency).toBe(2);
    expect(rule.by_weekday).toEqual([2]);
  });

  it("strips non-settable fields from recurrence_rule on patch", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const patched = (await (await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        recurrence_rule: { start: START, frequency: 3, interval: 1, by_weekday: [0], count: 99, by_year_day: [7] },
      }),
    })).json()) as Record<string, unknown>;
    const rule = patched.recurrence_rule as Record<string, unknown>;
    expect("count" in rule).toBe(false);
    expect("by_year_day" in rule).toBe(false);
    expect(rule.frequency).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// G3: 100-event cap
// ---------------------------------------------------------------------------
describe("guild-scheduled-event.mdx — G3: 100 SCHEDULED+ACTIVE event cap", () => {
  it("rejects the 101st SCHEDULED/ACTIVE event with 30038", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild } = ctx(store);
    // Insert 100 events directly (faster than 100 API calls).
    for (let i = 0; i < 100; i++) {
      ds.scheduledEvents.insert({
        snowflake: `9${String(i).padStart(17, "0")}`,
        guild_snowflake: guild,
        channel_snowflake: null,
        creator_snowflake: null,
        name: `Event ${i}`,
        description: null,
        scheduled_start_time: START,
        scheduled_end_time: END,
        privacy_level: 2,
        status: 1, // SCHEDULED
        entity_type: 3,
        user_count: 0,
        entity_snowflake: null,
        entity_metadata: { location: "somewhere" },
        recurrence_rule: null,
        image: null,
      });
    }
    const { res, json: body } = await createEvent(app, guild, externalBody());
    expect(res.status).toBe(400);
    expect(body.code).toBe(30038);
  });
});

// ---------------------------------------------------------------------------
// G4: channel_id existence and type validation
// ---------------------------------------------------------------------------
describe("guild-scheduled-event.mdx — G4: channel_id validation for STAGE/VOICE events", () => {
  it("rejects VOICE event with non-existent channel_id (10003)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, voiceBody("000000000000000001"));
    expect(res.status).toBe(404);
    expect(body.code).toBe(10003);
  });

  it("rejects VOICE event with a text channel (type 0) as channel_id (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, textChannel } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, voiceBody(textChannel));
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("rejects STAGE_INSTANCE event with a voice channel (type 2) as channel_id (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    const { res, json: body } = await createEvent(app, guild, { ...voiceBody(voiceChannel), entity_type: 1 });
    expect(res.status).toBe(400);
    expect(body.code).toBe(50035);
  });

  it("accepts STAGE_INSTANCE event with a stage channel (type 13)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, stageChannel } = ctx(store);
    const { res, json: e } = await createEvent(app, guild, { ...voiceBody(stageChannel), entity_type: 1, channel_id: stageChannel });
    expect(res.status).toBe(201);
    expect(e.entity_type).toBe(1);
  });

  it("accepts VOICE event with a voice channel (type 2)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, voiceChannel } = ctx(store);
    const { res, json: e } = await createEvent(app, guild, voiceBody(voiceChannel));
    expect(res.status).toBe(201);
    expect(e.entity_type).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G6: PATCH validation
// ---------------------------------------------------------------------------
describe("guild-scheduled-event.mdx — G6: PATCH field validation", () => {
  it("rejects a name longer than 100 chars on PATCH (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects invalid privacy_level on PATCH (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ privacy_level: 99 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a non-ISO timestamp for scheduled_start_time on PATCH (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${e.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ scheduled_start_time: "not-a-date" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

describe("guild-scheduled-event.mdx — per-occurrence exceptions", () => {
  const exceptionsPath = (guild: string, eventId: string) =>
    api(`/guilds/${guild}/scheduled-events/${eventId}/exceptions`);

  it("creates an exception, embeds it in the event, then modifies and deletes it", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const eventId = (e as { id: string }).id;

    // Create an exception overriding a single occurrence.
    const createRes = await app.request(exceptionsPath(guild, eventId), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ original_scheduled_start_time: START, scheduled_start_time: END, is_canceled: false }),
    });
    expect(createRes.status).toBe(200);
    const ex = await json<{ event_id: string; event_exception_id: string; scheduled_start_time: string; is_canceled: boolean }>(createRes);
    expect(ex.event_id).toBe(eventId);
    expect(ex.scheduled_start_time).toBe(END);
    expect(ex.is_canceled).toBe(false);

    // It is embedded in the event's guild_scheduled_event_exceptions list.
    const getRes = await app.request(api(`/guilds/${guild}/scheduled-events/${eventId}`), { headers: botHeaders() });
    const fetched = await json<{ guild_scheduled_event_exceptions: Array<{ event_exception_id: string }> }>(getRes);
    expect(fetched.guild_scheduled_event_exceptions.map((x) => x.event_exception_id)).toContain(ex.event_exception_id);

    // Modify it (cancel the occurrence).
    const patchRes = await app.request(`${exceptionsPath(guild, eventId)}/${ex.event_exception_id}`, {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ is_canceled: true }),
    });
    expect(patchRes.status).toBe(200);
    expect((await json<{ is_canceled: boolean }>(patchRes)).is_canceled).toBe(true);

    // Delete it.
    const delRes = await app.request(`${exceptionsPath(guild, eventId)}/${ex.event_exception_id}`, {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(delRes.status).toBe(204);
    const afterRes = await app.request(api(`/guilds/${guild}/scheduled-events/${eventId}`), { headers: botHeaders() });
    const after = await json<{ guild_scheduled_event_exceptions: unknown[] }>(afterRes);
    expect(after.guild_scheduled_event_exceptions).toHaveLength(0);
  });

  it("requires original_scheduled_start_time (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const { json: e } = await createEvent(app, guild, externalBody());
    const res = await app.request(exceptionsPath(guild, (e as { id: string }).id), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ is_canceled: true }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("404s for an exception on a missing event", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ctx(store);
    const res = await app.request(exceptionsPath(guild, "999999999999999999"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ original_scheduled_start_time: START }),
    });
    expect(res.status).toBe(404);
  });
});
