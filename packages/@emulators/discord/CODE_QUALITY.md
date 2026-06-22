# Code-quality / best-practices audit ledger

The `@emulators/discord` package was built and remediated through many parallel agents, so the
likely hotspots are duplication and missing shared abstractions rather than correctness (the
behavior is covered by ~1450 tests). This pass is an open-ended, unopinionated review of code
authoring quality. Six Opus auditors each take a slice and report genuine improvements (not
style preferences) to `/home/user/discord-quality/group-{1..6}.md`.

## Rubric (reference, not a cage — auditors are open-ended)

1. **DRY / duplication** — repeated blocks (auth boilerplate, entity lookups, pagination,
   validation, event publishing, error envelopes) that should be one shared helper/middleware;
   copy-pasted logic that has drifted.
2. **Reinventing the wheel** — hand-rolled implementations of things the stdlib, an existing
   dependency, `@emulators/core`, or an existing in-package helper already provides.
3. **Missing abstractions for cross-cutting concerns** — auth, permission checks, pagination
   (before/after/limit), entity-by-snowflake lookup, audit recording, gateway event dispatch,
   request-body validation handled ad-hoc per route instead of via a helper/middleware/mutation
   layer.
4. **Consistency & idioms** — the same task done differently across files (error helpers,
   auth guards, pagination, response building, naming).
5. **Type safety** — overuse of `any` / `as` / `Record<string, unknown>` body casts, risky
   non-null `!`, unvalidated access.
6. **Cohesion & file organization** — god files, grab-bag modules, serializers split between
   `helpers.ts` and route-local, things in the wrong place.
7. **Performance / data access** — repeated `findBy(...).find(...)` linear scans where a
   secondary index exists; N+1; recomputation.
8. **Error handling** — swallowed errors, inconsistent validation, inconsistent error codes.
9. **Test quality** — duplicated setup, missing shared fixtures/builders, tautological or weak
   assertions.

Each finding: `file:line`, what it is, why it matters (how much duplication / risk), and a
concrete minimal refactor. Note where the current approach is fine. Severity by impact, not taste.

## Groups

| Group | Scope | Report | Status |
|---|---|---|---|
| 1 | routes: guilds, channels, messages, threads, reactions, extras, polls | group-1.md | [x] done |
| 2 | routes: interactions, applicationCommands, commandPermissions, webhooks, oauth, users, roleConnections | group-2.md | [x] done |
| 3 | routes: monetization, moderation, guildResources, soundboard, lobbies, templates, misc, integrations, guildMisc, guildSettings, voice, gateway | group-3.md | [x] done |
| 4 | core infra: helpers, factories, entities, store, seed, index, permissions, rateLimiter, context, eventWebhooks | group-4.md | [x] done |
| 5 | gateway/* and interactions/* internals | group-5.md | [x] done |
| 6 | cross-cutting DRY + abstraction opportunities across the whole package, and __tests__ quality | group-6.md | [x] done |

---

## Consolidated findings

Verdict on the user's questions:
- **Reinventing the wheel: minimal, and what exists is justified.** `@emulators/core` is
  GitHub-shaped (`{message, documentation_url}`, HMAC, `X-GitHub-Event`) and genuinely unusable
  for Discord's `{message, code}` envelope, Bot/Bearer auth, and Ed25519 event webhooks. The
  hand-rolled protocol code (ETF subset to avoid the native `erlpack` addon, zlib wrapper,
  Ed25519 via Node `crypto`, UDP/RTP) has no library substitute. `permissions`, `rateLimiter`,
  `context`, `factories` are clean; all 18 `unknown*` helpers are used; the entity-vs-`setData`
  split is principled.
- **Hand-rolling where we should reuse: concentrated at the top of every handler.** The leaf
  primitives are good; the gap is *composition* helpers bundling the repeated 3-5 line sequences.

### High-leverage extractions (~1,700 LOC removable, no behavior change)
| Pattern | Sites | Helper |
|---|---|---|
| bot-auth guard | 146 | `requireBot(c, store) -> {auth, ds} \| Response` |
| test app+ids prologue | 1,009 + 46 | `setupDiscordTest()` / `seededIds(store)` |
| load-or-404 | ~96 | `loadOr404` / `requireGuild\|Channel\|Message` |
| guild-member lookup | 72 | `getGuildMember(ds, g, u)` / `hasGuildMember` |
| publish + audit pair | ~47 | `emitMutation(ds, bus, {event, audit})` |
| request body parse | 63 | `readBody<T>(c)` |
| inline 50035 validation | 19 | shared field validators |
| pagination | ~13 | `parsePagination` / `sliceBySnowflake` |
| `(await res.json()) as T` | 586 | `json<T>(res)` (tests) |

### Latent correctness fixes found (fix regardless of LOC)
1. **Dead shadowed routes** (group 3): scheduled-event-users + sticker-packs registered in two
   modules; Hono first-match-wins makes the misc/integrations copies dead code with divergent
   shapes. Delete the duplicates.
2. **Lobby module-global state** (group 3): `moderationMetadata`/`messageFlags` Maps leak across
   store instances; move to `store.setData`.
3. **`fanOut` redaction drift** (group 5): live-session and resumable-buffer loops duplicated the
   filter tree and drifted; unify into one filter+payload helper.
4. **Pagination snowflake bug** (group 3): `monetization.ts` compares snowflakes as strings;
   everywhere else uses BigInt. `paginateBySnowflake` fixes it once.
5. **Serializer drift** (groups 3/4): `toAPIGuild` re-inlines sticker/soundboard shapes that
   `toAPISticker`/`toAPISound` already produce; integration shape exists in 3 forms.
6. **`stageInstances` missing `guild_snowflake` index** (group 4): full-collection scan on every
   GUILD_CREATE. One-word fix.
7. Dead `heartbeatAckPending` field (group 5) and dead `vanity_uses` column (group 4).
8. **helpers.ts (874 lines, 7 concerns)** should split into modules behind a re-export barrel
   (non-breaking); the serializer layer should be unified so foundation can import all `toAPI*`.

### Remediation tiers
- T1 (correctness + foundation helpers + test fixtures) — done first, additive, low risk.
- T2 (route call-site migration to the new helpers) — disjoint worktree waves.
- T3 (test-fixture migration; helpers.ts split) — follow-up.
