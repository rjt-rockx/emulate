/**
 * Spec suite for `developers/resources/stage-instance.mdx`.
 *
 * Encodes the page's documented expectations directly: the Stage Instance object shape (including
 * guild_scheduled_event_id), the Privacy Levels (PUBLIC 1 deprecated, GUILD_ONLY 2), every endpoint's
 * request/response/status, the Create JSON params (channel_id, topic 1-120, privacy_level,
 * send_start_notification, guild_scheduled_event_id), the STAGE_INSTANCE_* Gateway events, and the
 * 10067 Unknown Stage Instance / 10003 Unknown Channel error codes. Written from the doc first; the
 * implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    channel: ds.channels.findOneBy("name", "General")!.snowflake, // the seeded voice/stage-capable channel
  };
}

async function createStage(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(api("/stage-instances"), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("stage-instance.mdx — Stage Instance object", () => {
  it("Create returns a Stage instance with EVERY documented field present", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "Town Hall" });
    expect(status).toBe(201);
    expect(typeof json.id).toBe("string");
    expect(json.guild_id).toBe(guild);
    expect(json.channel_id).toBe(channel);
    expect(json.topic).toBe("Town Hall");
    expect(typeof json.privacy_level).toBe("number");
    expect("discoverable_disabled" in json).toBe(true);
    expect("guild_scheduled_event_id" in json).toBe(true);
  });

  it("privacy_level defaults to GUILD_ONLY (2) when omitted", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { json } = await createStage(app, { channel_id: channel, topic: "Default" });
    expect(json.privacy_level).toBe(2);
  });

  it("guild_scheduled_event_id is null when not provided", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { json } = await createStage(app, { channel_id: channel, topic: "No event" });
    expect(json.guild_scheduled_event_id).toBeNull();
  });

  it("persists and emits guild_scheduled_event_id when provided", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { json } = await createStage(app, { channel_id: channel, topic: "Event stage", guild_scheduled_event_id: "947656305244532806" });
    expect(json.guild_scheduled_event_id).toBe("947656305244532806");
    // And it survives a subsequent Get.
    const got = await app.request(api(`/stage-instances/${channel}`), { headers: botHeaders() });
    expect(((await got.json()) as { guild_scheduled_event_id: string }).guild_scheduled_event_id).toBe("947656305244532806");
  });

  it("discoverable_disabled defaults to false (per the doc example) when not provided", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { json } = await createStage(app, { channel_id: channel, topic: "Default disabled" });
    expect(json.discoverable_disabled).toBe(false);
  });

  it("discoverable_disabled reflects the input value when provided", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { json } = await createStage(app, { channel_id: channel, topic: "Explicit true", discoverable_disabled: true });
    expect(json.discoverable_disabled).toBe(true);
  });
});

describe("stage-instance.mdx — Privacy Levels", () => {
  it("accepts PUBLIC (1, deprecated)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "Public", privacy_level: 1 });
    expect(status).toBe(201);
    expect(json.privacy_level).toBe(1);
  });

  it("accepts GUILD_ONLY (2)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "Guild only", privacy_level: 2 });
    expect(status).toBe(201);
    expect(json.privacy_level).toBe(2);
  });

  it("rejects an out-of-range privacy_level with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "Bad", privacy_level: 5 });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });
});

describe("stage-instance.mdx — Create params", () => {
  it("topic shorter than 1 char is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "" });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("topic longer than 120 chars is rejected with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "x".repeat(121) });
    expect(status).toBe(400);
    expect(json.code).toBe(50035);
  });

  it("a topic of exactly 120 chars is accepted", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "x".repeat(120) });
    expect(status).toBe(201);
    expect((json.topic as string).length).toBe(120);
  });

  it("send_start_notification is accepted (does not appear on the object)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const { status, json } = await createStage(app, { channel_id: channel, topic: "Notify", send_start_notification: true });
    expect(status).toBe(201);
    // send_start_notification is an action flag, not a Stage Instance object field.
    expect("send_start_notification" in json).toBe(false);
  });

  it("an unknown channel_id returns 10003 Unknown Channel", async () => {
    const { app } = createDiscordTestApp();
    const { status, json } = await createStage(app, { channel_id: "999999999999999999", topic: "Nope" });
    expect(status).toBe(404);
    expect(json.code).toBe(10003);
  });
});

describe("stage-instance.mdx — Get / Modify / Delete", () => {
  it("Get returns the stage instance for the Stage channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    await createStage(app, { channel_id: channel, topic: "Live" });
    const res = await app.request(api(`/stage-instances/${channel}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { topic: string }).topic).toBe("Live");
  });

  it("Get a channel without a stage instance returns 10067 Unknown Stage Instance", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/stage-instances/${channel}`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10067);
  });

  it("Modify updates privacy_level and returns the updated instance", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    await createStage(app, { channel_id: channel, topic: "Live", privacy_level: 2 });
    const res = await app.request(api(`/stage-instances/${channel}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ privacy_level: 1 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { privacy_level: number }).privacy_level).toBe(1);
  });

  it("Modify a non-existent stage instance returns 10067", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/stage-instances/${channel}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ privacy_level: 1 }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10067);
  });

  it("Delete returns 204 No Content and removes the instance", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    await createStage(app, { channel_id: channel, topic: "Live" });
    const res = await app.request(api(`/stage-instances/${channel}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).stageInstances.findOneBy("channel_snowflake", channel)).toBeUndefined();
  });

  it("Delete a non-existent stage instance returns 10067", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/stage-instances/${channel}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10067);
  });
});

describe("stage-instance.mdx — Gateway events", () => {
  it("Create/Modify/Delete each fire their STAGE_INSTANCE_* dispatch (observed via the parallel audit-log entry)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const ds = getDiscordStore(store);
    const before = ds.auditLog.all().length;
    await createStage(app, { channel_id: channel, topic: "Live" });
    await app.request(api(`/stage-instances/${channel}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ topic: "Updated" }),
    });
    await app.request(api(`/stage-instances/${channel}`), { method: "DELETE", headers: botHeaders() });
    const after = ds.auditLog.all().slice(before).map((e) => e.action_type);
    // StageInstanceCreate(83), Update(84), Delete(85).
    expect(after).toContain(83);
    expect(after).toContain(84);
    expect(after).toContain(85);
  });
});
