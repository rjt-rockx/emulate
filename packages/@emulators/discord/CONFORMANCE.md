# Conformance feedback loop

The goal is 100% parity with the real Discord API. Hand-written tests and doc-reading audits can
only get us close: the thing checking correctness is the same kind of thing that wrote the code, so
it doesn't converge and can even encode our own bugs. This loop fixes that by validating against
**independent oracles** and automating the checks so divergences can only go down.

```
 independent oracle ─► auto-generated checks ─► CI gate ─► ratchet (known-divergence list, ↓ only)
```

## Phase 1 (shipped): OpenAPI response oracle

Discord publishes an official machine-readable spec (`discord/discord-api-spec`, OpenAPI 3.1:
150 paths, 537 schemas). It is vendored at `src/__tests__/oracle/openapi.json`.

- `src/__tests__/oracle/specValidator.ts` matches a concrete request path to a spec path template,
  finds the operation's JSON response schema for the status, and validates the body with ajv
  (JSON Schema 2020-12). It catches **missing required fields, wrong types, and wrong nullability**
  on any response.
- `src/__tests__/oracle/conformance.test.ts` replays a representative request per endpoint
  (GET probes + create/read-back/modify write steps) and asserts every validated response conforms,
  **modulo `KNOWN`** — an explicit, rationale-carrying allowlist of investigated spec-vs-reality
  mismatches (e.g. the spec types deprecated `guild.region` as a string while real Discord returns
  null). Anything not on that list fails.

Rather than hand-listing probes, two sweeps walk the operation surface **systematically**:

- `coverage.test.ts` enumerates every GET operation (103), fills path params from a seeded +
  freshly-created resource map (with per-op overrides for name-colliding params like an application
  vs guild `{emoji_id}`, and direct store seeding for state with no offline creation path — bans,
  voice states, command permissions), probes every reachable one, and validates the response.
  Currently **81 validated, 0 divergent, 0 gaps** (every reachable GET validates).
- `writeSweep.test.ts` enumerates every POST/PATCH (76), synthesizes a minimal request body from each
  operation's request schema (`generateRequestBody`) — with hand-crafted overrides where semantic
  validation needs a richer body — and validates every 2xx response. Currently **41 validated, 0
  divergent, 0 unmappable** (every op is reachable; the rest correctly reject the minimal body).

### Over-emission audit (the spec's blind spot, closed token-free)

OpenAPI objects don't set `additionalProperties: false`, so ajv can't flag *extra* keys we emit that
real Discord never returns. `findOverEmission` closes this: it treats each schema's declared
`properties` as canonical (Discord's schemas enumerate every real field) and flags emitted keys
absent from them, while respecting explicit `additionalProperties` (genuine map types like
`metadata`). Both sweeps gate on zero over-emission modulo `OVER_EMISSION_KNOWN` (real optional
fields the spec scopes more narrowly — message `guild_id`, command `default_permission`, template
`icon_hash`). It found and removed a real over-emission: `owner`/`icon_hash` on the full guild object.

On its first run the oracle found 5 real divergences that all prior audits and 1606 tests had
missed (user/member/app `flags`, guild `home_header`/`nsfw`, member `banner`, app
`type`/`flags_new`/`explicit_content_filter`). The systematic sweeps then found and fixed ~20 more
(invite/automod/scheduled-event/application/template shapes, lobby `flags`, voice-state
`self_stream`) and surfaced missing endpoints since implemented (`update_application`, guild
scheduled-event exceptions, and actioning guild join requests).

### Extending it
- The sweeps are self-extending: seed a new resource into the param map and any operation needing it
  becomes reachable and guarded automatically.
- When a divergence is a genuine spec-vs-reality conflict (the spec is a *Preview*), add it to the
  `KNOWN` allowlist with a one-line rationale rather than bending the emulator away from real
  Discord. The cassette phase (below) is what ultimately adjudicates these.
- Refresh the spec: `curl -sSL -o src/__tests__/oracle/openapi.json https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json`.

## Phase 2 (shipped): property / invariant tests

`oracle/properties.test.ts` asserts generative invariants that kill whole bug classes at once and
guard them forever — every 4xx carries the `{message, code}` envelope with a documented code;
create→read-back round-trips to a byte-identical object for role/channel/message/webhook; list
endpoints reject `limit < 1` and paginate monotonically by snowflake.

## Phase 3 (shipped): real-client acceptance matrix

Two independent client oracles drive real libraries through login -> READY -> REST round-trips
against the emulator. Because each library parses every response through its own strict models, a
wire-shape divergence throws in the client rather than passing a hand-written assertion.

- `discordjs.test.ts` — a real discord.js Client creates a role, channel, message (+edit),
  reaction, webhook, fetches members, and creates an invite. It caught a real bug: discord.js
  sends/reads role color via the newer `colors` object, which the emulator ignored on create.
- `oracle/discordpy.test.ts` + `discordpy_flow.py` — a real discord.py Client (Python, a different
  parser) logs in, reaches READY over the **zlib-stream** gateway, and round-trips channels/roles/
  members/messages. It needs two overrides the harness applies: `Route.BASE` for REST and
  `DiscordWebSocket.DEFAULT_GATEWAY` for the gateway (discord.py 2.x ignores the REST /gateway URL).
  The test auto-skips when `python3`/`discord.py` aren't installed; enable it in CI with
  `pip install "discord.py>=2.3"`.

Next: point one or two representative open-source bots' own test suites at the emulator.

## Phase 4 (deferred — needs a token): record/replay cassettes

Capture real Discord API responses once against a throwaway bot token + test guild, commit redacted
HTTP cassettes, and replay-assert offline. The only oracle that pins down what docs and types do
not (exact null-vs-absent, undocumented fields). This is what resolves the `KNOWN_DIVERGENCES`.

## Exit bar ("are we there yet")

100% of reachable endpoints validate against the spec across the systematic sweeps (no divergences,
no over-emission) + discord.js and discord.py flows green against the emulator + N replay cassettes
match exactly + zero open entries in the divergence ledgers (`AUDIT_R2.md` + the `KNOWN` allowlists).

Current standing: 81 GET + 41 write responses validated with **0 divergences and 0 over-emission**;
**every reachable GET endpoint and every POST/PATCH operation is now exercised** (0 gaps, 0
unmappable) after seeding the state that has no offline creation path (bans, voice states, command
permissions, join requests, entitlements, interactions) directly through the store. The only oracle
not yet satisfied is the token-gated cassette phase, which pins down the residual spec-vs-reality
`KNOWN` entries (e.g. exact null-vs-absent) that no offline source can adjudicate.
