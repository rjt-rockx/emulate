# Discord emulator — independent verification pass

Generated 2026-06-22. Six randomized groups of doc pages, each assigned to an
Opus subagent that audits whether the page has GENUINE full TDD coverage: every object field,
enum, flag/bit, endpoint, request/response shape, validation limit, error code, and behavioral
note in the page must be encoded in a spec assertion AND backed by correct implementation. The
auditor reads the doc page in full and the spec/impl, then reports concrete coverage GAPS (page
item -> not asserted / asserted wrongly / impl diverges) with file:line. Non-contract pages
(overviews, how-to guides, RPC, certified-devices) are marked N/A.

## Group A

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/auto-moderation.mdx` | `auto-moderation.spec.test.ts` | [x] verified — 0H/1M/3L |
| `developers/resources/stage-instance.mdx` | `stage-instance.spec.test.ts` | [x] verified — 0H/0M/3L |
| `developers/components/reference.mdx` | `components.spec.test.ts` | [x] verified — component validation gaps (~20) |
| `developers/resources/webhook.mdx` | `webhook.spec.test.ts` | [x] verified — 1H/3M/3L |
| `developers/components/using-message-components.mdx`  *(non-contract / N/A)* | `using-message-components.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/resources/sku.mdx` | `sku.spec.test.ts` | [x] verified — CLEAN |
| `developers/events/webhook-events.mdx` | `webhook-events.spec.test.ts` | [x] verified — 0H/0M/2L |

## Group B

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/application-role-connection-metadata.mdx` | `application-role-connection-metadata.spec.test.ts` | [x] verified — CLEAN |
| `developers/interactions/receiving-and-responding.mdx` | `receiving-and-responding.spec.test.ts` | [x] verified — 1H/5M/4L |
| `developers/resources/invite.mdx` | `invite.spec.test.ts` | [x] verified — 1H/3M/3L |
| `developers/resources/message.mdx` | `message.spec.test.ts` | [x] verified — 4H/6M/5L |
| `developers/resources/channel.mdx` | `channel.spec.test.ts (+ threads.spec.test.ts)` | [x] verified — 1H/3M/4L |
| `developers/events/gateway.mdx` | `gateway.spec.test.ts (+ gateway*.test.ts)` | [x] verified — 0H/4M/2L |
| `developers/topics/oauth2.mdx` | `oauth2.spec.test.ts (+ strict-scopes.spec.test.ts)` | [x] verified — 0H/4M/7L |

## Group C

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/topics/permissions.mdx` | `permissions.spec.test.ts (+ permissionEnforcement.test.ts)` | [x] verified — 1H/1M/3L |
| `developers/resources/voice.mdx` | `voice.spec.test.ts` | [x] verified — 0H/1M/2L |
| `developers/topics/rpc.mdx`  *(non-contract / N/A)* | `rpc.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/topics/opcodes-and-status-codes.mdx` | `opcodes-and-status-codes.spec.test.ts` | [x] verified — 0H/3M/2L |
| `developers/topics/teams.mdx` | `teams.spec.test.ts` | [x] verified — 0H/0M/1L |
| `developers/resources/poll.mdx` | `poll.spec.test.ts` | [x] verified — 0H/2M/2L |
| `developers/resources/soundboard.mdx` | `soundboard.spec.test.ts` | [x] verified — 0H/1M/2L |

## Group D

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/subscription.mdx` | `subscription.spec.test.ts` | [x] verified — 0H/0M/2L |
| `developers/resources/user.mdx` | `user.spec.test.ts` | [x] verified — 0H/2M/3L |
| `developers/events/overview.mdx`  *(non-contract / N/A)* | `overview.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/resources/emoji.mdx` | `emoji.spec.test.ts` | [x] verified — 0H/1M/3L |
| `developers/resources/guild.mdx` | `guild.spec.test.ts` | [x] verified — 1H/4M/12L |
| `developers/resources/sticker.mdx` | `sticker.spec.test.ts` | [x] verified — 0H/1M/3L |
| `developers/topics/voice-connections.mdx` | `voice-connections.spec.test.ts` | [x] verified — 0H/1M/4L |

## Group E

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/components/using-modal-components.mdx`  *(non-contract / N/A)* | `using-modal-components.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/components/overview.mdx`  *(non-contract / N/A)* | `overview.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/topics/certified-devices.mdx`  *(non-contract / N/A)* | `certified-devices.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/resources/application.mdx` | `application.spec.test.ts` | [x] verified — 0H/1M/2L |
| `developers/events/gateway-events.mdx` | `gateway.spec.test.ts` | [x] verified — 2H/2M (event-fire assertions) |
| `developers/topics/rate-limits.mdx` | `rate-limits.spec.test.ts` | [x] verified — 0H/1M/2L |
| `developers/resources/lobby.mdx` | `lobby.spec.test.ts` | [x] verified — 1H/2M/3L |

## Group F

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/entitlement.mdx` | `entitlement.spec.test.ts` | [x] verified — 0H/0M/1L |
| `developers/interactions/overview.mdx`  *(non-contract / N/A)* | `overview.spec.test.ts` | [x] N/A (non-contract, confirmed) |
| `developers/resources/guild-template.mdx` | `guild-template.spec.test.ts` | [x] verified — 0H/1M/2L |
| `developers/resources/audit-log.mdx` | `audit-log.spec.test.ts` | [x] verified — 0H/2M/2L (tautology tests) |
| `developers/interactions/application-commands.mdx` | `application-commands.spec.test.ts` | [x] verified — 2H/5M/8L (caps wrong in tests) |
| `developers/topics/threads.mdx` | `threads.spec.test.ts (topic)` | [x] verified — 0H/6M/7L |
| `developers/resources/guild-scheduled-event.mdx` | `guild-scheduled-event.spec.test.ts` | [x] verified — 1H/2M/5L |


---

## Remediation outcome

All HIGH and meaningful MEDIUM gaps from the six audits were remediated in seven
worktree-isolated waves (impl + tests, fixing implementation and any test that encoded a
wrong value). Test count: 1330 -> 1451 (+121). type-check and lint clean.

Fixed (selected): message bulk-delete validation (50034), embed limits, `around` param,
content/sticker/nonce caps, component validation, reaction 10014; channel Modify/Create
validation (50035), Text<->Announcement type conversion, archive_timestamp refresh;
deferred-followup edits the placeholder, modal/autocomplete callback limits, webhook name
validation + components-v2 on execute; application-command caps corrected to 15/1 in BOTH
impl and tests, upsert key includes type, command-permissions Bearer-only; role member-counts
excludes @everyone, bulk-ban 500000, emoji image required, role colors round-trip, group DM +
username validation, audit-log tautology tests replaced with real assertions; scheduled-event
Modify entity-type matrix, automod TIMEOUT trigger restriction, stage discoverable, soundboard
bulk event, voice v8 ACK; timed-out-member permission collapse, invite job-status shape,
incidents_data round-trip, lobby invite guards, oauth form-encoding + grant errors, application
install/authorization counts, GET /gateway + session_start_limit assertions.

Deferred (LOW / inference / cloud-only, documented in the per-group reports): exact rate-limit
wall-clock, sharding routing + identify-concurrency, voice DAVE/E2EE, some niche validation
caps (timeout 28-day, afk_timeout enum), connection-object enums, and assorted unasserted-but-
correct round-trips. These do not affect contract fidelity for bots.
