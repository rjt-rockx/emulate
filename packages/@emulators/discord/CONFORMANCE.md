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
  on any response. (It does not flag *extra* fields — OpenAPI objects don't set
  `additionalProperties: false` — so over-emission is caught by the audits/property phase instead.)
- `src/__tests__/oracle/conformance.test.ts` replays a representative request per endpoint and
  asserts every validated response conforms, **modulo `KNOWN_DIVERGENCES`** — an explicit, rationale-
  carrying allowlist of investigated/accepted mismatches (e.g. the spec types deprecated
  `guild.region` as a string while real Discord returns null). Anything not on that list fails.

On its first run the oracle found 5 real divergences that all prior audits and 1606 tests had
missed (user/member/app `flags`, guild `home_header`/`nsfw`, member `banner`, app
`type`/`flags_new`/`explicit_content_filter`) — now fixed.

### Extending it
- Add endpoints to the `probes()` list (GETs are the cheapest parity surface). The more we probe,
  the more of the 150-operation surface is guarded.
- When a divergence is a genuine spec-vs-reality conflict (the spec is a *Preview*), add it to
  `KNOWN_DIVERGENCES` with a one-line rationale rather than bending the emulator away from real
  Discord. The cassette phase (below) is what ultimately adjudicates these.
- Refresh the spec: `curl -sSL -o src/__tests__/oracle/openapi.json https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json`.

## Phase 2 (next): property / invariant tests

Generative invariants that kill whole bug classes at once and guard them forever — every 4xx
carries the `{message, code}` envelope with a non-zero documented code; create→GET round-trips to an
equal object; every list endpoint rejects `limit < 1` and paginates monotonically by snowflake.

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

100% of registered endpoints validate against the spec across the suite + discord.js and discord.py
flows green against the emulator + N replay cassettes match exactly + zero open entries in the
divergence ledgers (`AUDIT_R2.md` + `KNOWN_DIVERGENCES`).
