/**
 * Spec suite for `developers/resources/poll.mdx`.
 *
 * Encodes the page's documented expectations: the Poll object and Poll Create Request structures
 * (<=10 answers, question text <=300, answer text <=55, duration default 24h, allow_multiselect
 * default false), the Poll Answer / Poll Results objects, and the Get Answer Voters endpoint
 * (after + limit 1-100 default 25). Written from the doc first; the implementation is built/fixed
 * until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, TEST_BASE_URL, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

type Json = Record<string, unknown>;

function ctx(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  const ds = getDiscordStore(store);
  return {
    ds,
    general: s.general,
    developer: s.developer,
    bot: s.bot,
  };
}

async function postPoll(app: ReturnType<typeof createDiscordTestApp>["app"], channel: string, poll: unknown): Promise<Response> {
  return app.request(api(`/channels/${channel}/messages`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ poll }),
  });
}

const BASIC_POLL = {
  question: { text: "Best language?" },
  answers: [
    { answer_id: 1, poll_media: { text: "TypeScript" } },
    { answer_id: 2, poll_media: { text: "Python" } },
  ],
};

async function vote(app: ReturnType<typeof createDiscordTestApp>["app"], messageId: string, answerId: number, user: string, remove = false): Promise<void> {
  await app.request(`${TEST_BASE_URL}/__emulate/poll-vote`, {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ message_id: messageId, answer_id: answerId, user, remove }),
  });
}

// ---------------------------------------------------------------------------
// Poll object structure
// ---------------------------------------------------------------------------

describe("poll.mdx — Poll object structure", () => {
  it("a created poll exposes question, answers, expiry, allow_multiselect, layout_type, results", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { poll: Json };
    const poll = msg.poll;
    expect((poll.question as Json).text).toBe("Best language?");
    expect(Array.isArray(poll.answers)).toBe(true);
    expect((poll.answers as Array<Json>)).toHaveLength(2);
    expect("expiry" in poll).toBe(true);
    expect(poll.allow_multiselect).toBe(false); // default
    expect(poll.layout_type).toBe(1); // DEFAULT
    expect("results" in poll).toBe(true);
  });

  it("each answer has answer_id and poll_media", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { poll: { answers: Array<Json> } };
    const a = msg.poll.answers[0];
    expect(a.answer_id).toBe(1);
    expect((a.poll_media as Json).text).toBe("TypeScript");
  });

  it("results carries is_finalized:false and an answer_counts list", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { poll: { results: Json } };
    expect(msg.poll.results.is_finalized).toBe(false);
    expect(Array.isArray(msg.poll.results.answer_counts)).toBe(true);
  });

  it("answer_counts entries have id, count, and me_voted", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { id: string };
    await vote(app, msg.id, 1, developer);
    const fetched = (await (await app.request(api(`/channels/${general}/messages/${msg.id}`), { headers: botHeaders() })).json()) as {
      poll: { results: { answer_counts: Array<{ id: number; count: number; me_voted: boolean }> } };
    };
    const entry = fetched.poll.results.answer_counts.find((a) => a.id === 1)!;
    expect(entry.count).toBe(1);
    expect("me_voted" in entry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Poll Create Request
// ---------------------------------------------------------------------------

describe("poll.mdx — Poll Create Request", () => {
  it("duration is converted to an expiry timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const msg = (await (await postPoll(app, general, { ...BASIC_POLL, duration: 24 })).json()) as { poll: { expiry: string } };
    expect(msg.poll.expiry).toBeTruthy();
    expect(new Date(msg.poll.expiry).getTime()).toBeGreaterThan(Date.now());
  });

  it("when duration is absent it defaults to 24h", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const before = Date.now();
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { poll: { expiry: string } };
    expect(msg.poll.expiry).toBeTruthy();
    const expiry = new Date(msg.poll.expiry).getTime();
    // ~24h ahead (allow a generous window for execution drift).
    expect(expiry).toBeGreaterThan(before + 23 * 3600_000);
    expect(expiry).toBeLessThan(before + 25 * 3600_000);
  });

  it("allow_multiselect defaults to false but is honored when set true", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const msg = (await (await postPoll(app, general, { ...BASIC_POLL, allow_multiselect: true })).json()) as { poll: { allow_multiselect: boolean } };
    expect(msg.poll.allow_multiselect).toBe(true);
  });

  it("rejects a poll with more than 10 answers -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const answers = Array.from({ length: 11 }, (_, i) => ({ answer_id: i + 1, poll_media: { text: `a${i}` } }));
    const res = await postPoll(app, general, { question: { text: "Q?" }, answers });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a question text longer than 300 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await postPoll(app, general, { question: { text: "x".repeat(301) }, answers: [{ answer_id: 1, poll_media: { text: "y" } }] });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects an answer text longer than 55 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await postPoll(app, general, { question: { text: "Q?" }, answers: [{ answer_id: 1, poll_media: { text: "z".repeat(56) } }] });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts a poll at the boundary (10 answers, 300-char question, 55-char answer)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const answers = Array.from({ length: 10 }, (_, i) => ({ answer_id: i + 1, poll_media: { text: i === 0 ? "z".repeat(55) : `a${i}` } }));
    const res = await postPoll(app, general, { question: { text: "x".repeat(300) }, answers });
    expect(res.status).toBe(200);
  });

  it("rejects a poll duration greater than 32 days (768 hours) -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await postPoll(app, general, { ...BASIC_POLL, duration: 769 });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts a poll duration at the boundary (768 hours)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await postPoll(app, general, { ...BASIC_POLL, duration: 768 });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// allow_multiselect:false clears prior votes
// ---------------------------------------------------------------------------

describe("poll.mdx — voting semantics", () => {
  it("allow_multiselect:false clears a voter's other-answer votes on a new vote", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const msg = (await (await postPoll(app, general, { ...BASIC_POLL, allow_multiselect: false })).json()) as { id: string };
    await vote(app, msg.id, 1, developer);
    await vote(app, msg.id, 2, developer);
    const fetched = (await (await app.request(api(`/channels/${general}/messages/${msg.id}`), { headers: botHeaders() })).json()) as {
      poll: { results: { answer_counts: Array<{ id: number; count: number }> } };
    };
    const counts = fetched.poll.results.answer_counts;
    // Only the latest answer (2) should hold the vote; answer 1 should be cleared.
    expect(counts.find((a) => a.id === 1)?.count ?? 0).toBe(0);
    expect(counts.find((a) => a.id === 2)?.count).toBe(1);
  });

  it("allow_multiselect:true keeps votes on multiple answers", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const msg = (await (await postPoll(app, general, { ...BASIC_POLL, allow_multiselect: true })).json()) as { id: string };
    await vote(app, msg.id, 1, developer);
    await vote(app, msg.id, 2, developer);
    const fetched = (await (await app.request(api(`/channels/${general}/messages/${msg.id}`), { headers: botHeaders() })).json()) as {
      poll: { results: { answer_counts: Array<{ id: number; count: number }> } };
    };
    const counts = fetched.poll.results.answer_counts;
    expect(counts.find((a) => a.id === 1)?.count).toBe(1);
    expect(counts.find((a) => a.id === 2)?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Get Answer Voters
// ---------------------------------------------------------------------------

describe("poll.mdx — Get Answer Voters", () => {
  it("returns a { users } object of the voters for the answer", async () => {
    const { app, store } = createDiscordTestApp();
    const { general, developer } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { id: string };
    await vote(app, msg.id, 1, developer);
    const res = await app.request(api(`/channels/${general}/polls/${msg.id}/answers/1`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ users: Array<Json> }>(res);
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.some((u) => u.id === developer)).toBe(true);
  });

  it("honors the limit query param (1-100, default 25)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { id: string };
    const u1 = ds.users.findOneBy("username", "developer")!.snowflake;
    const u2 = ds.users.findOneBy("username", "emulate-bot")!.snowflake;
    await vote(app, msg.id, 1, u1);
    await vote(app, msg.id, 1, u2);
    const res = await app.request(api(`/channels/${general}/polls/${msg.id}/answers/1?limit=1`), { headers: botHeaders() });
    const body = await json<{ users: Array<Json> }>(res);
    expect(body.users).toHaveLength(1);
  });

  it("honors the after query param", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, general } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { id: string };
    const low = "100000000000000001";
    const high = "100000000000000002";
    ds.users.insert({ snowflake: low, username: "vlow", discriminator: "0", global_name: null, avatar: null, bot: false, system: false, mfa_enabled: false, banner: null, accent_color: null, locale: "en-US", verified: false, email: null, flags: 0, premium_type: 0, public_flags: 0 } as never);
    ds.users.insert({ snowflake: high, username: "vhigh", discriminator: "0", global_name: null, avatar: null, bot: false, system: false, mfa_enabled: false, banner: null, accent_color: null, locale: "en-US", verified: false, email: null, flags: 0, premium_type: 0, public_flags: 0 } as never);
    await vote(app, msg.id, 1, low);
    await vote(app, msg.id, 1, high);
    const res = await app.request(api(`/channels/${general}/polls/${msg.id}/answers/1?after=${low}`), { headers: botHeaders() });
    const body = await json<{ users: Array<Json> }>(res);
    expect(body.users.map((u) => u.id)).toEqual([high]);
  });

  it("Get Answer Voters for an unknown message returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/polls/999999999999999999/answers/1`), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// End Poll
// ---------------------------------------------------------------------------

describe("poll.mdx — End Poll", () => {
  it("expiring a poll finalizes its results and returns the message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const msg = (await (await postPoll(app, general, BASIC_POLL)).json()) as { id: string };
    const res = await app.request(api(`/channels/${general}/polls/${msg.id}/expire`), { method: "POST", headers: botHeaders() });
    expect(res.status).toBe(200);
    const finalized = await json<{ id: string; poll: { results: { is_finalized: boolean } } }>(res);
    expect(finalized.id).toBe(msg.id);
    expect(finalized.poll.results.is_finalized).toBe(true);
  });

  it("End Poll for an unknown poll message returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ctx(store);
    const res = await app.request(api(`/channels/${general}/polls/999999999999999999/expire`), { method: "POST", headers: botHeaders() });
    expect(res.status).toBe(404);
  });
});
