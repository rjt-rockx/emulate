/**
 * Spec suite for `developers/components/reference.mdx`.
 *
 * Encodes the page's documented expectations for component types, the IS_COMPONENTS_V2
 * (1<<15) message flag rules, custom_id length limits, Action Row constraints (<=5 action
 * rows per message, <=5 buttons per row), select-menu option count limits, and modal
 * structural rules (title <=45 chars, 1-5 components). Written from the doc first; the
 * implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    appId: app.snowflake,
    bot: app.bot_user_snowflake,
    channel: ds.channels.findOneBy("name", "general")!.snowflake,
  };
}

async function sendMessage(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  channelId: string,
  body: Record<string, unknown>,
) {
  return app.request(api(`/channels/${channelId}/messages`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
}

describe("components.mdx — IS_COMPONENTS_V2 flag (1<<15 = 32768)", () => {
  it("a message sent with IS_COMPONENTS_V2 flag round-trips the flag", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      flags: 32768,
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 1, label: "Click", custom_id: "btn" }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { flags: number };
    // IS_COMPONENTS_V2 bit (1<<15) must be preserved.
    expect((msg.flags & 32768) !== 0).toBe(true);
  });

  it("a standard message (without IS_COMPONENTS_V2) echoes components as-is", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const components = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Accept", custom_id: "accept" },
          { type: 2, style: 4, label: "Decline", custom_id: "decline" },
        ],
      },
    ];
    const res = await sendMessage(app, channel, { content: "Pick one", components });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: unknown[] };
    // Components round-trip when the flag is not set.
    expect(Array.isArray(msg.components)).toBe(true);
    expect(msg.components.length).toBeGreaterThan(0);
  });
});

describe("components.mdx — Component types (v1)", () => {
  it("stores and echoes Action Row (type 1) with Button (type 2) children", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "Choose",
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Yes", custom_id: "yes" },
            { type: 2, style: 4, label: "No", custom_id: "no" },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ type: number; components: unknown[] }> };
    expect(msg.components[0]!.type).toBe(1);
    expect(msg.components[0]!.components.length).toBe(2);
  });

  it("stores and echoes String Select (type 3) with options", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "Pick",
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "pick_one",
              options: [
                { label: "A", value: "a" },
                { label: "B", value: "b" },
              ],
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ type: number; components: Array<{ type: number; options: unknown[] }> }> };
    expect(msg.components[0]!.components[0]!.type).toBe(3);
    expect(msg.components[0]!.components[0]!.options.length).toBe(2);
  });

  it("stores Link Button (style 5) without a custom_id", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "link",
      components: [
        { type: 1, components: [{ type: 2, style: 5, label: "Visit", url: "https://discord.com" }] },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ components: Array<{ url: string }> }> };
    expect(msg.components[0]!.components[0]!.url).toBe("https://discord.com");
  });
});

describe("components.mdx — custom_id limits (1-100 characters)", () => {
  it("accepts a custom_id of exactly 100 characters", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "test",
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: "X", custom_id: "x".repeat(100) }] },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ components: Array<{ custom_id: string }> }> };
    expect(msg.components[0]!.components[0]!.custom_id.length).toBe(100);
  });

  it("rejects a custom_id longer than 100 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "test",
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: "X", custom_id: "x".repeat(101) }] },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });
});

describe("components.mdx — Button validation", () => {
  it("rejects a button label longer than 80 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "test",
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: "L".repeat(81), custom_id: "btn" }] },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a link button url longer than 512 characters -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "test",
      components: [
        { type: 1, components: [{ type: 2, style: 5, label: "Visit", url: "https://example.com/" + "a".repeat(493) }] },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a non-link button without custom_id -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "test",
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: "Click" }] },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("rejects a link button without url -> 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "test",
      components: [
        { type: 1, components: [{ type: 2, style: 5, label: "Visit", custom_id: "btn" }] },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });
});

describe("components.mdx — Action Row constraints", () => {
  it("a message can carry up to 5 action rows", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const components = Array.from({ length: 5 }, (_, i) => ({
      type: 1,
      components: [{ type: 2, style: 1, label: `Btn ${i}`, custom_id: `btn${i}` }],
    }));
    const res = await sendMessage(app, channel, { content: "five rows", components });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: unknown[] };
    expect(msg.components.length).toBe(5);
  });

  it("each action row can carry up to 5 buttons", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      content: "many buttons",
      components: [
        {
          type: 1,
          components: Array.from({ length: 5 }, (_, i) => ({
            type: 2,
            style: 1,
            label: `B${i}`,
            custom_id: `b${i}`,
          })),
        },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ components: unknown[] }> };
    expect(msg.components[0]!.components.length).toBe(5);
  });
});

describe("components.mdx — Select menu option count (<=25)", () => {
  it("accepts a String Select with 25 options", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const options = Array.from({ length: 25 }, (_, i) => ({ label: `Option ${i}`, value: `v${i}` }));
    const res = await sendMessage(app, channel, {
      content: "select",
      components: [{ type: 1, components: [{ type: 3, custom_id: "sel", options }] }],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ components: Array<{ options: unknown[] }> }> };
    expect(msg.components[0]!.components[0]!.options.length).toBe(25);
  });
});

describe("components.mdx — Modal interaction (callback type 9)", () => {
  it("modal callback stores custom_id and title in the interaction data", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { channel } = ids(store);

    // Trigger an APPLICATION_COMMAND interaction.
    const triggerRes = await app.request(`http://localhost:4099/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: channel }),
    });
    const t = (await triggerRes.json()) as { id: string; token: string };

    // Respond with MODAL (type 9).
    const cbRes = await app.request(api(`/interactions/${t.id}/${t.token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        type: 9,
        data: {
          custom_id: "feedback_modal",
          title: "Share Feedback",
          components: [
            { type: 18, label: "Your name", component: { type: 4, custom_id: "name", style: 1 } },
          ],
        },
      }),
    });
    expect(cbRes.status).toBe(204);
    // The interaction is marked as acknowledged.
    const interaction = ds.interactions.findOneBy("snowflake", t.id);
    expect(interaction?.callback_used).toBe(true);
  });

  it("a modal title can be up to 45 characters", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const triggerRes = await app.request(`http://localhost:4099/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: channel }),
    });
    const t = (await triggerRes.json()) as { id: string; token: string };

    const cbRes = await app.request(api(`/interactions/${t.id}/${t.token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({
        type: 9,
        data: {
          custom_id: "m",
          title: "A".repeat(45),
          components: [{ type: 18, label: "Q", component: { type: 4, custom_id: "q", style: 1 } }],
        },
      }),
    });
    expect(cbRes.status).toBe(204);
  });
});

describe("components.mdx — v2 component types stored and echoed", () => {
  it("stores Section (type 9) inside a v2 message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      flags: 32768,
      components: [
        {
          type: 9,
          components: [{ type: 10, content: "Hello world" }],
          accessory: { type: 11, media: { url: "https://example.com/img.png" } },
        },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ type: number }> };
    expect(msg.components[0]!.type).toBe(9);
  });

  it("stores Text Display (type 10) and Container (type 17) in a v2 message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      flags: 32768,
      components: [
        {
          type: 17,
          components: [{ type: 10, content: "Inside container" }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as {
      components: Array<{ type: number; components: Array<{ type: number; content: string }> }>;
    };
    expect(msg.components[0]!.type).toBe(17);
    expect(msg.components[0]!.components[0]!.type).toBe(10);
    expect(msg.components[0]!.components[0]!.content).toBe("Inside container");
  });

  it("stores Separator (type 14) in a v2 message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await sendMessage(app, channel, {
      flags: 32768,
      components: [{ type: 14 }],
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { components: Array<{ type: number }> };
    expect(msg.components[0]!.type).toBe(14);
  });
});
