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

