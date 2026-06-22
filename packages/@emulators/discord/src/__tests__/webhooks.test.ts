import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function generalId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).general;
}

describe("discord channel webhooks", () => {
  it("creates a webhook, lists it, and executes it to post a message", async () => {
    const { app, store } = createDiscordTestApp();
    const channelId = generalId(store);

    const createRes = await app.request(api(`/channels/${channelId}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "CI Bot" }),
    });
    expect(createRes.status).toBe(200);
    const webhook = await json<{ id: string; token: string; name: string; url: string }>(createRes);
    expect(webhook.name).toBe("CI Bot");
    expect(webhook.token).toBeTruthy();
    expect(webhook.url).toContain(webhook.id);

    const list = await json<Array<{ id: string }>>(
      await app.request(api(`/channels/${channelId}/webhooks`), { headers: botHeaders() })
    );
    expect(list.some((w) => w.id === webhook.id)).toBe(true);

    // Execute without wait -> 204
    const execRes = await app.request(api(`/webhooks/${webhook.id}/${webhook.token}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "from webhook" }),
    });
    expect(execRes.status).toBe(204);

    // Execute with wait=true -> returns the message
    const execWait = await app.request(api(`/webhooks/${webhook.id}/${webhook.token}?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "waited" }),
    });
    expect(execWait.status).toBe(200);
    const msg = await json<{ content: string; webhook_id?: string }>(execWait);
    expect(msg.content).toBe("waited");

    // The webhook messages persisted in the channel
    const messages = getDiscordStore(store).messages.findBy("channel_snowflake", channelId);
    expect(messages.filter((m) => m.webhook_snowflake === webhook.id).length).toBe(2);
  });

  it("deletes a webhook by token", async () => {
    const { app, store } = createDiscordTestApp();
    const channelId = generalId(store);
    const webhook = await json<{ id: string; token: string }>(
      await app.request(api(`/channels/${channelId}/webhooks`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "tmp" }),
      })
    );

    const del = await app.request(api(`/webhooks/${webhook.id}/${webhook.token}`), { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(getDiscordStore(store).webhooks.findOneBy("snowflake", webhook.id)).toBeUndefined();
  });
});
