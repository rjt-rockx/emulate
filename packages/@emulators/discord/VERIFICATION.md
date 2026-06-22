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
| `developers/resources/auto-moderation.mdx` | `auto-moderation.spec.test.ts` | [ ] pending |
| `developers/resources/stage-instance.mdx` | `stage-instance.spec.test.ts` | [ ] pending |
| `developers/components/reference.mdx` | `components.spec.test.ts` | [ ] pending |
| `developers/resources/webhook.mdx` | `webhook.spec.test.ts` | [ ] pending |
| `developers/components/using-message-components.mdx`  *(non-contract / N/A)* | `using-message-components.spec.test.ts` | [ ] pending |
| `developers/resources/sku.mdx` | `sku.spec.test.ts` | [ ] pending |
| `developers/events/webhook-events.mdx` | `webhook-events.spec.test.ts` | [ ] pending |

## Group B

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/application-role-connection-metadata.mdx` | `application-role-connection-metadata.spec.test.ts` | [ ] pending |
| `developers/interactions/receiving-and-responding.mdx` | `receiving-and-responding.spec.test.ts` | [ ] pending |
| `developers/resources/invite.mdx` | `invite.spec.test.ts` | [ ] pending |
| `developers/resources/message.mdx` | `message.spec.test.ts` | [ ] pending |
| `developers/resources/channel.mdx` | `channel.spec.test.ts (+ threads.spec.test.ts)` | [ ] pending |
| `developers/events/gateway.mdx` | `gateway.spec.test.ts (+ gateway*.test.ts)` | [ ] pending |
| `developers/topics/oauth2.mdx` | `oauth2.spec.test.ts (+ strict-scopes.spec.test.ts)` | [ ] pending |

## Group C

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/topics/permissions.mdx` | `permissions.spec.test.ts (+ permissionEnforcement.test.ts)` | [ ] pending |
| `developers/resources/voice.mdx` | `voice.spec.test.ts` | [ ] pending |
| `developers/topics/rpc.mdx`  *(non-contract / N/A)* | `rpc.spec.test.ts` | [ ] pending |
| `developers/topics/opcodes-and-status-codes.mdx` | `opcodes-and-status-codes.spec.test.ts` | [ ] pending |
| `developers/topics/teams.mdx` | `teams.spec.test.ts` | [ ] pending |
| `developers/resources/poll.mdx` | `poll.spec.test.ts` | [ ] pending |
| `developers/resources/soundboard.mdx` | `soundboard.spec.test.ts` | [ ] pending |

## Group D

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/subscription.mdx` | `subscription.spec.test.ts` | [ ] pending |
| `developers/resources/user.mdx` | `user.spec.test.ts` | [ ] pending |
| `developers/events/overview.mdx`  *(non-contract / N/A)* | `overview.spec.test.ts` | [ ] pending |
| `developers/resources/emoji.mdx` | `emoji.spec.test.ts` | [ ] pending |
| `developers/resources/guild.mdx` | `guild.spec.test.ts` | [ ] pending |
| `developers/resources/sticker.mdx` | `sticker.spec.test.ts` | [ ] pending |
| `developers/topics/voice-connections.mdx` | `voice-connections.spec.test.ts` | [ ] pending |

## Group E

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/components/using-modal-components.mdx`  *(non-contract / N/A)* | `using-modal-components.spec.test.ts` | [ ] pending |
| `developers/components/overview.mdx`  *(non-contract / N/A)* | `overview.spec.test.ts` | [ ] pending |
| `developers/topics/certified-devices.mdx`  *(non-contract / N/A)* | `certified-devices.spec.test.ts` | [ ] pending |
| `developers/resources/application.mdx` | `application.spec.test.ts` | [ ] pending |
| `developers/events/gateway-events.mdx` | `gateway.spec.test.ts` | [ ] pending |
| `developers/topics/rate-limits.mdx` | `rate-limits.spec.test.ts` | [ ] pending |
| `developers/resources/lobby.mdx` | `lobby.spec.test.ts` | [ ] pending |

## Group F

| Doc page | Spec | Verified? |
|---|---|---|
| `developers/resources/entitlement.mdx` | `entitlement.spec.test.ts` | [ ] pending |
| `developers/interactions/overview.mdx`  *(non-contract / N/A)* | `overview.spec.test.ts` | [ ] pending |
| `developers/resources/guild-template.mdx` | `guild-template.spec.test.ts` | [ ] pending |
| `developers/resources/audit-log.mdx` | `audit-log.spec.test.ts` | [ ] pending |
| `developers/interactions/application-commands.mdx` | `application-commands.spec.test.ts` | [ ] pending |
| `developers/topics/threads.mdx` | `threads.spec.test.ts (topic)` | [ ] pending |
| `developers/resources/guild-scheduled-event.mdx` | `guild-scheduled-event.spec.test.ts` | [ ] pending |

