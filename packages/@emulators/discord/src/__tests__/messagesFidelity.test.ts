import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function chan(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).channels.findOneBy("name", "general")!.snowflake;
}

async function post(app: ReturnType<typeof createDiscordTestApp>["app"], channel: string, body: unknown) {
  const res = await app.request(api(`/channels/${channel}/messages`), { method: "POST", headers: botHeaders(), body: JSON.stringify(body) });
  return res.json() as Promise<Record<string, unknown>>;
}

describe("message fidelity", () => {
  it("allowed_mentions suppresses @everyone", async () => {
    const { app, store } = createDiscordTestApp();
    const channel = chan(store);
    const suppressed = await post(app, channel, { content: "@everyone hi", allowed_mentions: { parse: [] } });
    expect(suppressed.mention_everyone).toBe(false);
    const allowed = await post(app, channel, { content: "@everyone hi" });
    expect(allowed.mention_everyone).toBe(true);
  });

  it("allowed_mentions whitelists specific users", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const channel = chan(store);
    const dev = ds.users.findOneBy("username", "developer")!.snowflake;
    const bot = ds.users.findOneBy("username", "emulate-bot")!.snowflake;
    const msg = await post(app, channel, {
      content: `<@${dev}> and <@${bot}>`,
      allowed_mentions: { parse: [], users: [dev] },
    });
    expect(msg.mentions).toEqual([expect.objectContaining({ id: dev })]);
  });

  it("a message_reference makes the message a reply (type 19) with referenced_message", async () => {
    const { app, store } = createDiscordTestApp();
    const channel = chan(store);
    const original = await post(app, channel, { content: "parent" });
    const reply = await post(app, channel, { content: "child", message_reference: { message_id: original.id } });
    expect(reply.type).toBe(19);
    expect((reply.referenced_message as { id: string }).id).toBe(original.id);
  });

  it("poll duration is converted to an expiry timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const channel = chan(store);
    const msg = await post(app, channel, {
      poll: { question: { text: "Pizza?" }, answers: [{ answer_id: 1, poll_media: { text: "Yes" } }], duration: 24 },
    });
    const poll = msg.poll as { expiry: string | null };
    expect(poll.expiry).toBeTruthy();
    expect(new Date(poll.expiry!).getTime()).toBeGreaterThan(Date.now());
  });

  it("webhook execute honors a custom username and avatar", async () => {
    const { app, store } = createDiscordTestApp();
    const channel = chan(store);
    const hook = (await (await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "default-name" }),
    })).json()) as { id: string; token: string };

    const msg = (await (await app.request(api(`/webhooks/${hook.id}/${hook.token}?wait=true`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "via hook", username: "Custom Bot", avatar_url: "http://example/a.png" }),
    })).json()) as { author: { username: string; avatar: string | null; bot: boolean } };

    expect(msg.author.username).toBe("Custom Bot");
    expect(msg.author.avatar).toBe("http://example/a.png");
    expect(msg.author.bot).toBe(true);
  });
});
