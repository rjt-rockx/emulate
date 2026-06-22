import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { createDiscordTestApp, api, botHeaders, seededIds } from "../helpers.js";
import { checkResponse, specOperations, generateRequestBody } from "./specValidator.js";

/**
 * Systematic WRITE sweep: enumerate every POST/PATCH operation in the spec, synthesize a minimal
 * request body from its request schema, fill path params from a seeded + created resource map, and
 * validate any 2xx response against the spec. Operations whose generated body fails the emulator's
 * (stricter, semantic) validation return 4xx and are reported as "needs-body", not divergences —
 * the value here is catching write-RESPONSE shape divergences automatically.
 */

const KNOWN: Array<{ path: RegExp; error: string }> = [
  { path: /\/guilds\/\d+/, error: "/region must be string" },
];
const isKnown = (p: string, e: string) => KNOWN.some((k) => k.path.test(p.split("?")[0]) && e.includes(k.error));

describe("OpenAPI WRITE sweep (POST/PATCH responses)", () => {
  it("validates every POST/PATCH response reachable with a generated body", async () => {
    const { app, store } = createDiscordTestApp();
    const ids = seededIds(store);

    const postId = async (path: string, body: unknown): Promise<string | undefined> => {
      const res = await app.request(api(path), { method: "POST", headers: botHeaders(), body: JSON.stringify(body) });
      const b = (await res.json().catch(() => ({}))) as { id?: string };
      return b.id;
    };
    const map: Record<string, string | undefined> = {
      guild_id: ids.guild,
      channel_id: ids.general,
      application_id: ids.app,
      user_id: ids.developer,
      role_id: await postId(`/guilds/${ids.guild}/roles`, { name: "ws-role" }),
      message_id: await postId(`/channels/${ids.general}/messages`, { content: "ws" }),
      command_id: await postId(`/applications/${ids.app}/commands`, { name: "ws-cmd", description: "d", type: 1 }),
    };

    const ops = specOperations().filter((o) => o.method === "POST" || o.method === "PATCH");
    const results: Array<{ op: string; status: number; validated: boolean; errors: string[] }> = [];
    let unmappable = 0;
    let needsBody = 0;
    for (const op of ops) {
      const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!params.every((p) => map[p])) {
        unmappable++;
        continue;
      }
      const concrete = op.path.replace(/\{(\w+)\}/g, (_, p) => map[p]!);
      const body = generateRequestBody(op.path, op.method);
      const res = await app.request(api(concrete), {
        method: op.method,
        headers: botHeaders(),
        body: body == null ? undefined : JSON.stringify(body),
      });
      if (res.status >= 400) {
        needsBody++;
        continue; // generated body insufficient for the emulator's semantic validation
      }
      const respBody = await res.json().catch(() => null);
      const r = checkResponse(op.method, concrete, res.status, respBody);
      const errors = r.errors.filter((e) => !isKnown(concrete, e));
      results.push({ op: `${op.method} ${op.path}`, status: res.status, validated: r.validated, errors });
    }

    const validated = results.filter((r) => r.validated);
    const failing = validated.filter((r) => r.errors.length > 0);
    const lines = [
      `WRITE ops total=${ops.length} reached2xx=${results.length} validated=${validated.length} divergent=${failing.length} needsBody=${needsBody} unmappable=${unmappable}`,
    ];
    for (const f of failing) {
      lines.push(`DIVERGENCE ${f.op} [${f.status}]`);
      for (const e of f.errors.slice(0, 10)) lines.push(`    - ${e}`);
    }
    writeFileSync("/tmp/conformance-write-sweep.txt", lines.join("\n") + "\n");

    expect(validated.length).toBeGreaterThanOrEqual(5);
    expect(failing, `Unexpected write-response divergences:\n${lines.join("\n")}`).toHaveLength(0);
  });
});
