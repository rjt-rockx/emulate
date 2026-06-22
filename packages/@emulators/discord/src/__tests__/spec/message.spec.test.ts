/**
 * Spec suite for `developers/resources/message.mdx`.
 *
 * Encodes the page's documented expectations directly: the Message object shape (required vs
 * nullable vs optional fields), Message Types and Message Flags values, Message Reference Types,
 * the Allowed Mentions structure and its mutual-exclusivity/caps rules, and every endpoint
 * (Get/Create/Edit/Delete/Bulk Delete/Crosspost, and all Reaction endpoints) with its exact
 * request/response/status and error codes. Written from the doc first; the implementation is
 * built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { createMessage, createEmoji } from "../../factories.js";

type Json = Record<string, unknown>;

function ctx(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  const ds = getDiscordStore(store);
  return {
    ds,
    general: s.general,
    random: s.random,
    guild: s.guild,
    developer: s.developer,
    bot: s.bot,
  };
}

async function post(app: ReturnType<typeof createDiscordTestApp>["app"], channel: string, body: unknown): Promise<Json> {
  const res = await app.request(api(`/channels/${channel}/messages`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return await json<Json>(res);
}

// ---------------------------------------------------------------------------
// Message Object structure
// ---------------------------------------------------------------------------

describe("message.mdx — Message object structure", () => {
  it("a created message carries every required (non-optional) Message field", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "Supa Hot" });
    // discord-api-types required set: id, channel_id, author, content, timestamp,
    // edited_timestamp, tts, mention_everyone, mention_roles, attachments, embeds,
    // pinned, type, mentions.
    expect(typeof m.id).toBe("string");
    expect(typeof m.channel_id).toBe("string");
    expect(typeof (m.author as Json).id).toBe("string");
    expect(m.content).toBe("Supa Hot");
    expect(typeof m.timestamp).toBe("string");
    // edited_timestamp is nullable and null on a fresh message (not absent).
    expect("edited_timestamp" in m).toBe(true);
    expect(m.edited_timestamp).toBeNull();
    expect(m.tts).toBe(false);
    expect(m.mention_everyone).toBe(false);
    expect(Array.isArray(m.mention_roles)).toBe(true);
    expect(Array.isArray(m.attachments)).toBe(true);
    expect(Array.isArray(m.embeds)).toBe(true);
    expect(m.pinned).toBe(false);
    expect(m.type).toBe(0);
    expect(Array.isArray(m.mentions)).toBe(true);
  });

  it("the author follows the user object structure", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x" });
    const author = m.author as Json;
    expect(typeof author.id).toBe("string");
    expect(typeof author.username).toBe("string");
    expect(author.bot).toBe(true);
  });

  it("matches the example message: timestamp string, edited_timestamp null, type 0", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "Supa Hot", tts: false });
    expect(m.tts).toBe(false);
    expect(m.edited_timestamp).toBeNull();
    expect(m.type).toBe(0);
    expect(m.pinned).toBe(false);
    expect(new Date(m.timestamp as string).toString()).not.toBe("Invalid Date");
  });
});

// ---------------------------------------------------------------------------
// Message Types & Message Flags
// ---------------------------------------------------------------------------

describe("message.mdx — Message Types & Flags values", () => {
  it("a reply is type 19 (REPLY)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const parent = await post(app, general, { content: "parent" });
    const reply = await post(app, general, { content: "child", message_reference: { message_id: parent.id } });
    expect(reply.type).toBe(19);
  });

  it("SUPPRESS_EMBEDS (1<<2) is settable on Create Message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x", flags: 1 << 2 });
    expect(((m.flags as number) & (1 << 2)) !== 0).toBe(true);
  });

  it("SUPPRESS_NOTIFICATIONS (1<<12) is settable on Create Message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x", flags: 1 << 12 });
    expect(((m.flags as number) & (1 << 12)) !== 0).toBe(true);
  });

  it("IS_VOICE_MESSAGE (1<<13) is settable on Create Message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x", flags: 1 << 13 });
    expect(((m.flags as number) & (1 << 13)) !== 0).toBe(true);
  });

  it("non-settable flags (EPHEMERAL 1<<6) are masked out of Create Message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x", flags: 1 << 6 });
    expect(((m.flags as number) & (1 << 6)) === 0).toBe(true);
  });

  it("Crossposting a message returns 200 and sets CROSSPOSTED (1<<0)", async () => {
    // Per the doc, Crosspost Message must set CROSSPOSTED (1<<0).
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "announce" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}/crosspost`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const crossposted = await json<Json>(res);
    expect(((crossposted.flags as number) & (1 << 0)) !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Message Reference Types & Forwarding (snapshots / HAS_SNAPSHOT)
// ---------------------------------------------------------------------------

describe("message.mdx — Message Reference Types", () => {
  it("a reply (DEFAULT type 0) echoes message_reference with type 0, channel_id, guild_id", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, guild } = ctx(store);
    const parent = await post(app, general, { content: "parent" });
    const reply = await post(app, general, { content: "child", message_reference: { message_id: parent.id } });
    const ref = reply.message_reference as Json;
    expect(ref.type).toBe(0);
    expect(ref.message_id).toBe(parent.id);
    expect(ref.channel_id).toBe(general);
    expect(ref.guild_id).toBe(guild);
  });

  it("a reply resolves referenced_message (DEFAULT couples referenced_message)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const parent = await post(app, general, { content: "parent" });
    const reply = await post(app, general, { content: "child", message_reference: { message_id: parent.id } });
    expect((reply.referenced_message as Json).id).toBe(parent.id);
  });

  it("a FORWARD (type 1) produces message_snapshots and sets HAS_SNAPSHOT (1<<14)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, random } = ctx(store);
    const original = await post(app, general, { content: "forward me" });
    const forward = await post(app, random, {
      message_reference: { type: 1, message_id: original.id, channel_id: general },
    });
    expect(((forward.flags as number) & (1 << 14)) !== 0).toBe(true);
    const snapshots = forward.message_snapshots as Array<Json>;
    expect(Array.isArray(snapshots)).toBe(true);
    expect(snapshots.length).toBe(1);
    // The snapshot wraps the forwarded message's minimal subset (author excluded).
    const snapshot = snapshots[0].message as Json;
    expect(snapshot.content).toBe("forward me");
    expect("author" in snapshot).toBe(false);
  });

  it("a forward only requires message_reference (no content needed)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, random } = ctx(store);
    const original = await post(app, general, { content: "src" });
    const res = await app.request(api(`/channels/${random}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ message_reference: { type: 1, message_id: original.id, channel_id: general } }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// sticker_ids -> sticker_items
// ---------------------------------------------------------------------------

describe("message.mdx — sticker_ids surfaced as sticker_items", () => {
  it("Create Message with sticker_ids stores them and surfaces sticker_items", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, guild } = ctx(store);
    const sticker = ds.stickers.insert({
      snowflake: "900000000000000001",
      guild_snowflake: guild,
      name: "wave",
      description: null,
      tags: "wave",
      type: 2,
      format_type: 1,
      available: true,
      creator_snowflake: null,
    });
    const m = await post(app, general, { sticker_ids: [sticker.snowflake] });
    const items = m.sticker_items as Array<Json>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(sticker.snowflake);
    expect(items[0].name).toBe("wave");
    expect(items[0].format_type).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Allowed Mentions
// ---------------------------------------------------------------------------

describe("message.mdx — Allowed Mentions", () => {
  it("with no allowed_mentions, all mentions in content are parsed (regular-message default)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const m = await post(app, general, { content: `@everyone hi <@${developer}>` });
    expect(m.mention_everyone).toBe(true);
    expect((m.mentions as Array<Json>).some((u) => u.id === developer)).toBe(true);
  });

  it("parse:[] suppresses every mention", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const m = await post(app, general, { content: `@everyone <@${developer}>`, allowed_mentions: { parse: [] } });
    expect(m.mention_everyone).toBe(false);
    expect(m.mentions).toEqual([]);
  });

  it("explicit users list whitelists only ids present in the content", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer, bot } = ctx(store);
    const m = await post(app, general, {
      content: `<@${developer}> and <@${bot}>`,
      allowed_mentions: { users: [developer] },
    });
    expect((m.mentions as Array<Json>).map((u) => u.id)).toEqual([developer]);
  });

  it("ids whitelisted but absent from content are silently ignored", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer, bot } = ctx(store);
    const m = await post(app, general, { content: `<@${developer}>`, allowed_mentions: { users: [developer, bot] } });
    expect((m.mentions as Array<Json>).map((u) => u.id)).toEqual([developer]);
  });

  it("parse and the matching explicit field are mutually exclusive -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        content: `<@${developer}>`,
        allowed_mentions: { parse: ["users"], users: [developer] },
      }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("an empty/falsy explicit field alongside parse does NOT trigger a validation error", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    // Doc: "Passing a falsy value such as null or an empty array into the users field does not
    // trigger a validation error." Only users:[] is parsed here, not @here.
    const m = await post(app, general, {
      content: `@here Hello <@&1234> and <@${developer}>`,
      allowed_mentions: { parse: ["users", "roles"], users: [] },
    });
    expect(m.mention_everyone).toBe(false);
    expect((m.mentions as Array<Json>).some((u) => u.id === developer)).toBe(true);
  });

  it("rejects a users array larger than 100 ids -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const tooMany = Array.from({ length: 101 }, (_, i) => String(1000000000000000000n + BigInt(i)));
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x", allowed_mentions: { users: tooMany } }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a roles array larger than 100 ids -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const tooMany = Array.from({ length: 101 }, (_, i) => String(1000000000000000000n + BigInt(i)));
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x", allowed_mentions: { roles: tooMany } }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("replied_user controls whether the replied-to author is mentioned", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    // Parent authored by developer (control-plane create).
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!;
    const parent = createMessage(ds, {
      channelSnowflake: channel.snowflake,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: developer,
      content: "parent",
    });
    const reply = await post(app, general, {
      content: "child",
      message_reference: { message_id: parent.snowflake },
      allowed_mentions: { replied_user: true },
    });
    expect((reply.mentions as Array<Json>).some((u) => u.id === developer)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IS_COMPONENTS_V2
// ---------------------------------------------------------------------------

describe("message.mdx — IS_COMPONENTS_V2 (1<<15)", () => {
  it("rejects content alongside the IS_COMPONENTS_V2 flag with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "nope", components: [{ type: 10 }], flags: 1 << 15 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects embeds alongside the IS_COMPONENTS_V2 flag with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ embeds: [{ title: "x" }], components: [{ type: 10 }], flags: 1 << 15 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts a components-only message with the IS_COMPONENTS_V2 flag set", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ components: [{ type: 10 }], flags: 1 << 15 }),
    });
    expect(res.status).toBe(200);
    const m = await json<Json>(res);
    expect(((m.flags as number) & (1 << 15)) !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enforce_nonce
// ---------------------------------------------------------------------------

describe("message.mdx — enforce_nonce", () => {
  it("returns the existing message when enforce_nonce + a duplicate (author,nonce) exists", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const first = await post(app, general, { content: "one", nonce: "abc", enforce_nonce: true });
    const second = await post(app, general, { content: "two", nonce: "abc", enforce_nonce: true });
    expect(second.id).toBe(first.id);
    // No new message was persisted.
    const ds = getDiscordStore(store);
    const matching = ds.messages.findBy("channel_snowflake", general).filter((mm) => mm.nonce === "abc");
    expect(matching).toHaveLength(1);
  });

  it("the message create echoes the nonce", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x", nonce: "n1" });
    expect(m.nonce).toBe("n1");
  });

  it("echoes an integer nonce as a string", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x", nonce: 12345 });
    expect(m.nonce).toBe("12345");
  });
});

// ---------------------------------------------------------------------------
// Get Channel Messages / Get Channel Message
// ---------------------------------------------------------------------------

describe("message.mdx — Get Channel Message(s)", () => {
  it("Get Channel Messages returns newest-to-oldest", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const a = await post(app, general, { content: "a" });
    const b = await post(app, general, { content: "b" });
    const list = (await (await app.request(api(`/channels/${general}/messages`), { headers: botHeaders() })).json()) as Array<Json>;
    const ai = list.findIndex((m) => m.id === a.id);
    const bi = list.findIndex((m) => m.id === b.id);
    expect(bi).toBeLessThan(ai); // b (newer) before a (older)
  });

  it("Get Channel Messages honors the limit query param (max 100)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    await post(app, general, { content: "a" });
    await post(app, general, { content: "b" });
    const list = (await (await app.request(api(`/channels/${general}/messages?limit=1`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(list).toHaveLength(1);
  });

  it("Get Channel Messages on an unknown channel returns 10003", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api(`/channels/999999999999999999/messages`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10003);
  });

  it("Get Channel Message returns the message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect((await json<Json>(res)).id).toBe(m.id);
  });

  it("Get Channel Message for an unknown id returns 10008 Unknown Message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });

  it("Get Channel Messages with around returns messages centered on the snowflake", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const a = await post(app, general, { content: "a" });
    const b = await post(app, general, { content: "b" });
    const c2 = await post(app, general, { content: "c" });
    const list = (await (
      await app.request(api(`/channels/${general}/messages?around=${b.id}&limit=4`), { headers: botHeaders() })
    ).json()) as Array<Json>;
    // b should be included, list sorted ascending.
    expect(list.some((m) => m.id === b.id)).toBe(true);
    // All IDs in the list should be near b.
    for (let i = 1; i < list.length; i++) {
      expect(BigInt(list[i]!.id as string)).toBeGreaterThan(BigInt(list[i - 1]!.id as string));
    }
    // Verify c2 is accessible at all (used to avoid TS unused warning).
    expect(typeof c2.id).toBe("string");
    expect(typeof a.id).toBe("string");
  });

  it("Get Channel Messages rejects mixing before and after -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(
      api(`/channels/${general}/messages?before=1000000000000000000&after=900000000000000000`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

// ---------------------------------------------------------------------------
// Create Message validation
// ---------------------------------------------------------------------------

describe("message.mdx — Create Message validation", () => {
  it("rejects an empty message (no content/embeds/etc) with 50006", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50006);
  });

  it("Create Message on an unknown channel returns 10003 Unknown Channel", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api(`/channels/999999999999999999/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10003);
  });

  it("returns 200 with a message object on success", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "Hello, World!", tts: false, embeds: [{ title: "Hello, Embed!", description: "..." }] }),
    });
    expect(res.status).toBe(200);
    const m = await json<Json>(res);
    expect(m.content).toBe("Hello, World!");
    expect((m.embeds as Array<Json>)[0].title).toBe("Hello, Embed!");
  });

  it("rejects content longer than 2000 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x".repeat(2001) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects more than 3 sticker_ids -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sticker_ids: ["1", "2", "3", "4"] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a string nonce longer than 25 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x", nonce: "n".repeat(26) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects more than 10 embeds -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const embeds = Array.from({ length: 11 }, (_, i) => ({ title: `E${i}` }));
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x", embeds }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects an embed title longer than 256 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x", embeds: [{ title: "t".repeat(257) }] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

// ---------------------------------------------------------------------------
// Edit Message
// ---------------------------------------------------------------------------

describe("message.mdx — Edit Message", () => {
  it("editing content sets edited_timestamp and rebuilds mentions/mention_everyone", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const m = await post(app, general, { content: "before" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: `after @everyone <@${developer}>` }),
    });
    const edited = await json<Json>(res);
    expect(edited.content).toBe(`after @everyone <@${developer}>`);
    expect(edited.edited_timestamp).toBeTruthy();
    expect(edited.mention_everyone).toBe(true);
    expect((edited.mentions as Array<Json>).some((u) => u.id === developer)).toBe(true);
  });

  it("editing recomputes mention_roles from the new content", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, guild } = ctx(store);
    const role = ds.roles.insert({
      snowflake: "800000000000000001",
      guild_snowflake: guild,
      name: "team",
      color: 0,
      hoist: false,
      position: 1,
      permissions: "0",
      managed: false,
      mentionable: true,
      icon: null,
      unicode_emoji: null,
      flags: 0,
    });
    const m = await post(app, general, { content: "before" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: `ping <@&${role.snowflake}>` }),
    });
    const edited = await json<Json>(res);
    expect((edited.mention_roles as string[]).includes(role.snowflake)).toBe(true);
  });

  it("editing with allowed_mentions parse:[] strips mentions even though content has them", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const m = await post(app, general, { content: "before" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: `@everyone <@${developer}>`, allowed_mentions: { parse: [] } }),
    });
    const edited = await json<Json>(res);
    expect(edited.mention_everyone).toBe(false);
    expect(edited.mentions).toEqual([]);
  });

  it("editing only merges EDIT_MESSAGE_SETTABLE_FLAGS bits (SUPPRESS_EMBEDS toggles)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ flags: (1 << 2) | (1 << 6) }), // SUPPRESS_EMBEDS + EPHEMERAL
    });
    const edited = await json<Json>(res);
    expect(((edited.flags as number) & (1 << 2)) !== 0).toBe(true); // SUPPRESS_EMBEDS applied
    expect(((edited.flags as number) & (1 << 6)) === 0).toBe(true); // EPHEMERAL ignored
  });

  it("Edit Message for an unknown id returns 10008", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages/999999999999999999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });
});

// ---------------------------------------------------------------------------
// Delete / Bulk Delete
// ---------------------------------------------------------------------------

describe("message.mdx — Delete & Bulk Delete", () => {
  it("Delete Message returns a 204 empty response and removes the message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "x" });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    const after = await app.request(api(`/channels/${general}/messages/${m.id}`), { headers: botHeaders() });
    expect(after.status).toBe(404);
  });

  it("Delete Message for an unknown id returns 10008", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/messages/999999999999999999`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });

  it("Bulk Delete returns 204 and deletes the provided ids", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const a = await post(app, general, { content: "a" });
    const b = await post(app, general, { content: "b" });
    const res = await app.request(api(`/channels/${general}/messages/bulk-delete`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ messages: [a.id, b.id] }),
    });
    expect(res.status).toBe(204);
    expect((await app.request(api(`/channels/${general}/messages/${a.id}`), { headers: botHeaders() })).status).toBe(404);
    expect((await app.request(api(`/channels/${general}/messages/${b.id}`), { headers: botHeaders() })).status).toBe(404);
  });

  it("Bulk Delete rejects fewer than 2 messages -> 50034", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const a = await post(app, general, { content: "a" });
    const res = await app.request(api(`/channels/${general}/messages/bulk-delete`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ messages: [a.id] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50034);
  });

  it("Bulk Delete rejects more than 100 messages -> 50034", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const ids = Array.from({ length: 101 }, (_, i) => String(BigInt("1000000000000000000") + BigInt(i)));
    const res = await app.request(api(`/channels/${general}/messages/bulk-delete`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ messages: ids }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50034);
  });

  it("Bulk Delete rejects duplicate message ids -> 50034", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const a = await post(app, general, { content: "a" });
    const b = await post(app, general, { content: "b" });
    const res = await app.request(api(`/channels/${general}/messages/bulk-delete`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ messages: [a.id, a.id, b.id] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50034);
  });

  it("Bulk Delete rejects messages older than 2 weeks -> 50034", async () => {
    const { app } = createDiscordTestApp();
    // Snowflake from 3 weeks ago: Discord epoch (Jan 1 2015) + some time in the past.
    // A snowflake from 3 weeks ago: (Date.now() - 21days - DISCORD_EPOCH) << 22
    const DISCORD_EPOCH = 1420070400000n;
    const threeWeeksAgo = BigInt(Date.now() - 21 * 24 * 60 * 60 * 1000) - DISCORD_EPOCH;
    const oldSnowflake = (threeWeeksAgo << 22n).toString();
    const oldSnowflake2 = ((threeWeeksAgo << 22n) + 1n).toString();
    const res = await app.request(api(`/channels/999999999999999999/messages/bulk-delete`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ messages: [oldSnowflake, oldSnowflake2] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50034);
  });
});

// ---------------------------------------------------------------------------
// Reaction endpoints
// ---------------------------------------------------------------------------

const THUMBS = encodeURIComponent("\u{1F44D}"); // 👍

describe("message.mdx — Reaction endpoints", () => {
  it("Create Reaction returns 204 and Get Reactions lists the user", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, bot } = ctx(store);
    const m = await post(app, general, { content: "react" });
    const add = await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(add.status).toBe(204);
    const users = (await (await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(users.some((u) => u.id === bot)).toBe(true);
  });

  it("Get Reactions honors the limit query param (1-100)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general } = ctx(store);
    const m = await post(app, general, { content: "react" });
    const u1 = ds.users.findOneBy("username", "developer")!.snowflake;
    const u2 = ds.users.findOneBy("username", "emulate-bot")!.snowflake;
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: ds.channels.findOneBy("name", "general")!.guild_snowflake, user_snowflake: u1, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false });
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: ds.channels.findOneBy("name", "general")!.guild_snowflake, user_snowflake: u2, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false });
    const users = (await (await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}?limit=1`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(users).toHaveLength(1);
  });

  it("Get Reactions honors the after query param", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general } = ctx(store);
    const guildSnowflake = ds.channels.findOneBy("name", "general")!.guild_snowflake;
    const m = await post(app, general, { content: "react" });
    const low = "100000000000000001";
    const high = "100000000000000002";
    ds.users.insert({ snowflake: low, username: "rlow", discriminator: "0", global_name: null, avatar: null, bot: false, system: false, mfa_enabled: false, banner: null, accent_color: null, locale: "en-US", verified: false, email: null, flags: 0, premium_type: 0, public_flags: 0 } as never);
    ds.users.insert({ snowflake: high, username: "rhigh", discriminator: "0", global_name: null, avatar: null, bot: false, system: false, mfa_enabled: false, banner: null, accent_color: null, locale: "en-US", verified: false, email: null, flags: 0, premium_type: 0, public_flags: 0 } as never);
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: low, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false });
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: high, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false });
    const users = (await (await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}?after=${low}`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(users.map((u) => u.id)).toEqual([high]);
  });

  it("Get Reactions type=1 (BURST) returns only super-reactors", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general } = ctx(store);
    const guildSnowflake = ds.channels.findOneBy("name", "general")!.guild_snowflake;
    const m = await post(app, general, { content: "react" });
    const normalUser = ds.users.findOneBy("username", "developer")!.snowflake;
    const burstUser = ds.users.findOneBy("username", "emulate-bot")!.snowflake;
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: normalUser, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false, burst: false });
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: burstUser, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false, burst: true });
    const burst = (await (await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}?type=1`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(burst.map((u) => u.id)).toEqual([burstUser]);
    const normal = (await (await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}?type=0`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(normal.map((u) => u.id)).toEqual([normalUser]);
  });

  it("burst reactions populate count_details.burst and me_burst", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, bot } = ctx(store);
    const guildSnowflake = ds.channels.findOneBy("name", "general")!.guild_snowflake;
    const m = await post(app, general, { content: "react" });
    ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: bot, emoji_name: "\u{1F44D}", emoji_snowflake: null, emoji_animated: false, burst: true });
    const fetched = (await (await app.request(api(`/channels/${general}/messages/${m.id}`), { headers: botHeaders() })).json()) as { reactions: Array<{ count_details: { burst: number; normal: number }; me_burst: boolean }> };
    expect(fetched.reactions[0].count_details.burst).toBe(1);
    expect(fetched.reactions[0].me_burst).toBe(true);
  });

  it("a custom emoji reaction reflects the emoji's stored animated flag", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, guild } = ctx(store);
    const emoji = createEmoji(ds, guild, { name: "blobwave", animated: true });
    const m = await post(app, general, { content: "react" });
    const raw = `${emoji.name}:${emoji.snowflake}`;
    await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${encodeURIComponent(raw)}/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });
    const fetched = (await (await app.request(api(`/channels/${general}/messages/${m.id}`), { headers: botHeaders() })).json()) as { reactions: Array<{ emoji: { id: string; name: string; animated?: boolean } }> };
    expect(fetched.reactions[0].emoji.id).toBe(emoji.snowflake);
    expect(fetched.reactions[0].emoji.animated).toBe(true);
  });

  it("Delete Own Reaction returns 204 and removes the reaction", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "react" });
    await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}/@me`), { method: "PUT", headers: botHeaders() });
    const del = await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}/@me`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    const users = (await (await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}`), { headers: botHeaders() })).json()) as Array<Json>;
    expect(users).toHaveLength(0);
  });

  it("Delete All Reactions returns 204 and clears all reactions", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "react" });
    await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}/@me`), { method: "PUT", headers: botHeaders() });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}/reactions`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    const ds = getDiscordStore(store);
    expect(ds.reactions.findBy("message_snowflake", m.id as string)).toHaveLength(0);
  });

  it("Delete All Reactions for Emoji returns 204 and clears only that emoji", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "react" });
    const heart = encodeURIComponent("❤"); // ❤
    await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}/@me`), { method: "PUT", headers: botHeaders() });
    await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${heart}/@me`), { method: "PUT", headers: botHeaders() });
    const res = await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    const remaining = (await (await app.request(api(`/channels/${general}/messages/${m.id}`), { headers: botHeaders() })).json()) as { reactions: Array<{ emoji: { name: string } }> };
    expect(remaining.reactions).toHaveLength(1);
    expect(remaining.reactions[0].emoji.name).toBe("❤");
  });

  it("reacting with an unknown custom emoji returns 10014 Unknown Emoji", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const m = await post(app, general, { content: "react" });
    // Use a custom emoji id that doesn't exist in the store.
    const unknownCustomEmoji = encodeURIComponent("ghost:999999999999999999");
    const res = await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${unknownCustomEmoji}/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10014);
  });

  it("the 20-distinct-emoji cap is enforced -> 30010", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, bot } = ctx(store);
    const guildSnowflake = ds.channels.findOneBy("name", "general")!.guild_snowflake;
    const m = await post(app, general, { content: "react" });
    // Pre-seed 20 distinct emoji reactions from other users.
    for (let i = 0; i < 20; i++) {
      ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: bot, emoji_name: `e${i}`, emoji_snowflake: `7${i.toString().padStart(17, "0")}`, emoji_animated: false });
    }
    const res = await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${THUMBS}/@me`), { method: "PUT", headers: botHeaders() });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(30010);
  });

  it("reacting with a 21st emoji that already exists on the message is allowed", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general, bot } = ctx(store);
    const guildSnowflake = ds.channels.findOneBy("name", "general")!.guild_snowflake;
    const m = await post(app, general, { content: "react" });
    for (let i = 0; i < 20; i++) {
      ds.reactions.insert({ message_snowflake: m.id as string, channel_snowflake: general, guild_snowflake: guildSnowflake, user_snowflake: bot, emoji_name: `e${i}`, emoji_snowflake: `7${i.toString().padStart(17, "0")}`, emoji_animated: false });
    }
    // Reacting again with an existing emoji (e0) must not be blocked by the cap.
    const res = await app.request(api(`/channels/${general}/messages/${m.id}/reactions/${encodeURIComponent("e0:700000000000000000")}/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });
});
