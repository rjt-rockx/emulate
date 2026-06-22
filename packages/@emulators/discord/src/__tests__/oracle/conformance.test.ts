import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, seededIds } from "../helpers.js";
import { checkResponse, matchSpecPath, specOperations } from "./specValidator.js";

/**
 * REST conformance against Discord's official OpenAPI spec. Each probe makes a real emulator
 * request and validates the response body against the spec's schema for that route + status.
 * The spec is an independent oracle, so a failure here is a genuine wire-shape divergence.
 */

interface Probe {
  method: string;
  path: string;
}

function probes(ids: ReturnType<typeof seededIds>): Probe[] {
  return [
    { method: "GET", path: `/users/@me` },
    { method: "GET", path: `/users/${ids.developer}` },
    { method: "GET", path: `/guilds/${ids.guild}` },
    { method: "GET", path: `/guilds/${ids.guild}?with_counts=true` },
    { method: "GET", path: `/guilds/${ids.guild}/preview` },
    { method: "GET", path: `/guilds/${ids.guild}/channels` },
    { method: "GET", path: `/guilds/${ids.guild}/roles` },
    { method: "GET", path: `/guilds/${ids.guild}/members` },
    { method: "GET", path: `/guilds/${ids.guild}/members/${ids.developer}` },
    { method: "GET", path: `/guilds/${ids.guild}/bans` },
    { method: "GET", path: `/guilds/${ids.guild}/emojis` },
    { method: "GET", path: `/guilds/${ids.guild}/stickers` },
    { method: "GET", path: `/guilds/${ids.guild}/scheduled-events` },
    { method: "GET", path: `/guilds/${ids.guild}/integrations` },
    { method: "GET", path: `/guilds/${ids.guild}/invites` },
    { method: "GET", path: `/guilds/${ids.guild}/webhooks` },
    { method: "GET", path: `/guilds/${ids.guild}/templates` },
    { method: "GET", path: `/guilds/${ids.guild}/auto-moderation/rules` },
    { method: "GET", path: `/channels/${ids.general}` },
    { method: "GET", path: `/channels/${ids.general}/messages` },
    { method: "GET", path: `/channels/${ids.general}/webhooks` },
    { method: "GET", path: `/channels/${ids.general}/invites` },
    { method: "GET", path: `/channels/${ids.general}/pins` },
    { method: "GET", path: `/applications/@me` },
    { method: "GET", path: `/applications/${ids.app}/commands` },
    { method: "GET", path: `/applications/${ids.app}/emojis` },
    { method: "GET", path: `/gateway` },
    { method: "GET", path: `/gateway/bot` },
    { method: "GET", path: `/voice/regions` },
    { method: "GET", path: `/sticker-packs` },
  ];
}

/**
 * The ratchet: divergences we have INVESTIGATED and accept, each with a rationale. Anything not
 * listed here is a genuine, unexplained divergence and fails the suite. This list may only shrink;
 * the cassette/real-API phase is what resolves the spec-vs-reality entries.
 */
const KNOWN_DIVERGENCES: Array<{ path: RegExp; error: string; reason: string }> = [
  {
    path: /\/guilds\/\d+/,
    error: "/region must be string",
    reason:
      "The Preview spec types guild.region as a non-null string, but the field is deprecated and " +
      "real Discord returns null. We follow real Discord; pending cassette confirmation.",
  },
];

function isKnown(probePath: string, error: string): boolean {
  return KNOWN_DIVERGENCES.some((k) => k.path.test(probePath.split("?")[0]) && error.includes(k.error));
}

describe("OpenAPI conformance (official discord-api-spec oracle)", () => {
  it("every validated response matches the spec (modulo documented divergences)", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);

    const all: Array<{ probe: Probe; status: number; matched: boolean; validated: boolean; errors: string[] }> = [];
    for (const probe of probes(ids)) {
      const res = await app.request(api(probe.path), { headers: botHeaders() });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const r = checkResponse(probe.method, probe.path, res.status, body);
      // Drop investigated/accepted divergences; everything left is a real failure.
      const errors = r.errors.filter((e) => !isKnown(probe.path, e));
      all.push({ probe, status: res.status, matched: r.matched, validated: r.validated, errors });
    }

    const validated = all.filter((a) => a.validated);
    const failing = validated.filter((a) => a.errors.length > 0);

    const lines = [`validated=${validated.length} matched=${all.filter((a) => a.matched).length}/${all.length} divergent=${failing.length}`];
    for (const f of failing) {
      lines.push(`DIVERGENCE ${f.probe.method} ${f.probe.path} [${f.status}]`);
      for (const e of f.errors.slice(0, 12)) lines.push(`    - ${e}`);
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/conformance-report.txt", lines.join("\n") + "\n");

    // We must actually be validating a meaningful surface (guards against the oracle silently
    // matching nothing), and there must be no un-accepted divergences.
    expect(validated.length).toBeGreaterThanOrEqual(20);
    expect(failing, `Unexpected spec divergences:\n${lines.join("\n")}`).toHaveLength(0);
  });

  it("the emulator's routes are matchable to spec paths (coverage signal)", () => {
    // Sanity: the spec exposes a large operation surface we can map against.
    expect(specOperations().length).toBeGreaterThan(100);
    expect(matchSpecPath("/api/v10/channels/123/messages")).toBe("/channels/{channel_id}/messages");
    expect(matchSpecPath("/api/v10/users/@me")).toBe("/users/@me");
  });
});
