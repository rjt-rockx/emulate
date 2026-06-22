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
| 1 | routes: guilds, channels, messages, threads, reactions, extras, polls | group-1.md | [ ] pending |
| 2 | routes: interactions, applicationCommands, commandPermissions, webhooks, oauth, users, roleConnections | group-2.md | [ ] pending |
| 3 | routes: monetization, moderation, guildResources, soundboard, lobbies, templates, misc, integrations, guildMisc, guildSettings, voice, gateway | group-3.md | [ ] pending |
| 4 | core infra: helpers, factories, entities, store, seed, index, permissions, rateLimiter, context, eventWebhooks | group-4.md | [ ] pending |
| 5 | gateway/* and interactions/* internals | group-5.md | [ ] pending |
| 6 | cross-cutting DRY + abstraction opportunities across the whole package, and __tests__ quality | group-6.md | [ ] pending |
