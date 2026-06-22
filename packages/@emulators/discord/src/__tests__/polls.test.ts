import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, TEST_BASE_URL } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function channelId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).channels.findOneBy("name", "general")!.snowflake;
}

const POLL = {
  question: { text: "Best language?" },
  answers: [
    { answer_id: 1, poll_media: { text: "TypeScript" } },
    { answer_id: 2, poll_media: { text: "Python" } },
  ],
  allow_multiselect: false,
  layout_type: 1,
};

describe("discord polls", () => {
  it("creates a message with a poll, casts votes, lists voters, and finalizes", async () => {
    const { app, store } = createDiscordTestApp();
    const ch = channelId(store);
    const ds = getDiscordStore(store);
    const developer = ds.users.findOneBy("username", "developer")!;

    const msg = (await (
      await app.request(api(`/channels/${ch}/messages`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ poll: POLL }),
      })
    ).json()) as { id: string; poll: { question: { text: string }; results: { is_finalized: boolean } } };
    expect(msg.poll.question.text).toBe("Best language?");
    expect(msg.poll.results.is_finalized).toBe(false);

    // cast a vote via the control plane
    const voted = (await (
      await app.request(`${TEST_BASE_URL}/__emulate/poll-vote`, {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ message_id: msg.id, answer_id: 1, user: developer.snowflake }),
      })
    ).json()) as { poll: { results: { answer_counts: Array<{ id: number; count: number }> } } };
    expect(voted.poll.results.answer_counts.find((a) => a.id === 1)?.count).toBe(1);

    // list voters for answer 1
    const voters = (await (
      await app.request(api(`/channels/${ch}/polls/${msg.id}/answers/1`), { headers: botHeaders() })
    ).json()) as { users: Array<{ id: string }> };
    expect(voters.users.some((u) => u.id === developer.snowflake)).toBe(true);

    // finalize
    const expired = (await (
      await app.request(api(`/channels/${ch}/polls/${msg.id}/expire`), { method: "POST", headers: botHeaders() })
    ).json()) as { poll: { results: { is_finalized: boolean } } };
    expect(expired.poll.results.is_finalized).toBe(true);
  });
});
