# Conformance audit — round 2 (6 independent opus auditors)

Six independent, randomized, read-only audits cross-checked the emulator against the official
docs (`discord-api-docs`) and `discord-api-types/v10`. Raw per-group reports:
`/home/user/discord-audit-r2/group-{1..6}.md`.

Totals: **0 Blocker, 23 High, 48 Medium, ~50 Low, 36 Nit** (~157 raw; ~110 unique after dedup).
No blockers: the happy paths are faithful. The gaps are concentrated in negative-path
validation, permission enforcement, a handful of serializer fields, and pagination edges — and
the existing tests mostly do not cover those negatives (several actively assert the wrong value).

## Cross-cutting themes (deduplicated)

### T1. Permission enforcement is opt-in and most mutating routes never check it — DESIGN CALL
`requirePermission` is a no-op unless `discord.enforce_permissions` is seeded on (`helpers.ts:152`),
AND most mutating routes never call it at all, so even turning enforcement on does nothing for:
channel modify/delete + overwrites (`channels.ts:152/286/337/373`), every thread route
(`threads.ts`), soundboard CRUD/send (`soundboard.ts`), stage instances (`moderation.ts:187/238/275`),
voice-state modify (`voice.ts`), templates (`templates.ts`, `MANAGE_GUILD`), audit log
(`guildMisc.ts:143`, `VIEW_AUDIT_LOG`), auto-moderation (`moderation.ts`, `MANAGE_GUILD` +
`MODERATE_MEMBERS`), modify/delete guild (`guilds.ts:233/298`, `MANAGE_GUILD`/ownership),
auto-mod TIMEOUT. Discord returns `50013`. Two sub-decisions: (a) wire the missing
`requirePermission` calls so enforcement *works* when enabled; (b) whether enforcement should
default ON.

### T2. Missing 50035 validation on create/modify (silent-default instead of reject)
- Scheduled event: required `name`/`scheduled_start_time`/`privacy_level`/`entity_type` defaulted;
  no name length; `recurrence_rule` unvalidated; channel existence/type unchecked (G1/G2/G4 grp1).
- Modify Guild: no enum/range validation (`afk_timeout` must be 60/300/900/1800/3600), no name
  length, and it persists undocumented `mfa_level`/`nsfw_level` (G1 grp4).
- Auto-moderation: `actions`/`name` not required; `trigger_metadata` requiredness per trigger type
  not enforced (A2/A3/A4 grp4).
- Components: no action-row composition rules (≤5 rows, ≤5 buttons/row, no button+select mix),
  no duplicate-`custom_id` check, `max_values:0` allowed, no modal-only/message-only type gating,
  premium (style 6) button unmodelled (C1/C3/C4/C5/C6 grp6).
- Interactions: callback-type vs interaction-type not cross-validated (UPDATE_MESSAGE on a command,
  MODAL on a PING/MODAL_SUBMIT all 204); DEFERRED accepts non-EPHEMERAL flags; PING accepts any
  callback (R1/R2/R3 grp6).
- App commands: CHAT_INPUT name regex missing `'` + Deva/Thai; `min/max_length` (0–6000) and
  `min/max_value` coherence unvalidated; options accepted on non-CHAT_INPUT; per-type cap message
  hardcodes "(100)" (A1/A2/A3/A4/A7 grp6).
- Thread create: any `type` accepted; `auto_archive_duration` enum unvalidated; `REQUIRE_TAG`/5-tag
  cap not enforced on create (T-3/T-4/T-5 grp5). Edit Channel Permissions: required `type` defaulted
  (C-3 grp5).
- Create App Emoji: no name/image validation (E1 grp3). Invite: `target_type` companion id not
  required (I1 grp3). Lobby: metadata ≤1000 and `idle_timeout_seconds` 5–604800 unvalidated;
  bulk-add doesn't 404 unknown users (L2/L3/L4 grp2).

### T3. Handlers ignore the requested id / fall back to all()[0] — CORRECTNESS/ISOLATION
- roleConnections GET/PUT for an unknown/foreign `appId` falls back to `applications.all()[0]` — a
  bot can read/clobber another app's metadata (A1 grp1). **Highest-impact isolation bug.**
- OAuth token returns `guilds.all()[0]` instead of the authorized guild (O2 grp3).
- OAuth token endpoint issues a token with a missing/empty `client_secret` or unknown `client_id`
  (O1 grp3). Refresh grant doesn't bind to the client (O5 grp3).
- App-emoji GET/PATCH/DELETE not scoped to `:appId` (E2 grp3).

### T4. Serializer field presence / nullability divergences
- `toAPIMessage` always emits `mention_channels: []` (should be omitted; crosspost-only) (M1 grp1).
- Search Guild Messages keeps `reactions` and omits required `doing_deep_historical_index` (M2 grp1).
- `referenced_message` dropped (should be `null`) for replies whose parent was deleted (M5 grp1).
- `ENTITLEMENT_DELETE` carries `deleted: false` (must be `true`) (E1 grp4).
- Forum thread `message_count` includes the initial message (off by one) (C-1 grp5).
- Group-DM `recipients` serialized as id strings, not user objects (C-6 grp5).
- `default_forum_layout` emitted on media (16) channels (C-7 grp5).
- 429 body always carries `code: 0` (should be absent) (R1 grp2).
- Scheduled-event `description` omitted instead of `null` (G5 grp1).
- Permission-gated `user` field always emitted on sticker/emoji/soundboard objects (S1 grp1/E6 grp3/S-2 grp5).

### T5. Pagination edges
- `limit=0` returns a full page or empty instead of validating: bans→1000 (B1 grp3), entitlements
  (E3 grp4), subscriptions (Sub-2 grp5), user guilds (U5 grp2), poll voters (P2 grp3, where
  negative limit hits `.slice(0,-n)` and silently drops voters).
- `before` cursor windows from the low end rather than nearest the cursor (B3 grp3, E4 grp4).

### T6. Gateway protocol gaps (grp3)
- Invalid/unknown intent bits (e.g. `1<<30`) not closed with 4013 (`ALL_INTENTS` defined but unused).
- 4096-byte inbound limit (4002) and API-version (4012) unenforced.
- `REQUEST_GUILD_MEMBERS` ignores `query`/`limit`/`presences` and never returns `not_found`.

### T7. App event webhooks are a manual stub (grp4)
`dispatchEventWebhook` only fires from the `/__emulate/event-webhook` control route; no real action
(entitlement lifecycle, bot-added, OAuth deauth) auto-fires `APPLICATION_AUTHORIZED`/`ENTITLEMENT_*`.

### T8. Tests that ENSHRINE divergence (must fix the test, not just the code)
- `message.spec.test.ts:411` — integer nonce coerced to string asserted as expected.
- `rate-limits.spec.test.ts:314-325` — asserts different major ids produce different bucket hashes
  (opposite of the spec's "non-inclusive of top-level resources").
- `user.spec.test.ts` — `limit=0 → []` and always-present optional fields locked in.
- `threads.spec.test.ts:276` — `message_count === 1` for an initial-post-only forum thread.
- `permissions.spec.test.ts:422` — "unknown channel returns ALL_PERMISSIONS".
- `sku.spec.test.ts:81` — asserts exactly the 6-field SKU shape as desired.

## Defensible / out-of-scope (recommend: document, do not "fix")
- Rate-limit generous defaults (500/s vs Discord 50/s), per-store not per-token; microsecond/offset
  timestamp format; `approximate_presence_count == member_count`; static `session_start_limit`;
  always-1 shards; `invalidFormBody` always `BASE_TYPE_BAD_LENGTH` sub-code (cosmetic but pervasive);
  lobby/dev rate limits; status auto-transitions; team management endpoints.

## Disposition
- **Genuine conformance bugs to fix:** ~85 (the High + most Medium + the clear Low in T2–T6).
- **Tests to correct (T8):** 6 files assert non-Discord behavior.
- **Design call (T1):** permission enforcement wiring + default.
- **Document-as-known-divergence:** the items above.

## Remediation outcome (shipped)

Full-pass remediation completed: a shared-foundation wave plus six disjoint route waves, all merged
green. **+152 tests (1452 -> 1604), type-check + lint clean.** Decision on T1: wire the missing
`requirePermission` calls everywhere they were absent but KEEP the opt-in default (off), so the
emulator returns 50013 once `discord.enforce_permissions` is enabled and stays lenient otherwise.

### Wave A — shared foundation (serializers, pagination, gateway, ratelimit, permissions)
mention_channels omit; referenced_message null for reply types; scheduled-event description null;
default_forum_layout forum-only; thread total_message_sent separate from message_count;
recipients as user objects; toAPIEmoji/Sticker/Sound gained an includeUser gate; parsePagination
clamps limit>=1 and sliceBySnowflake windows from the cursor; 429 body drops code:0;
X-RateLimit-Bucket is non-inclusive of the major resource; IDENTIFY rejects out-of-range intent
bits (4013) and >4096-byte frames (4002); unknown channel yields no permissions (not ALL);
ENTITLEMENT_DELETE reports deleted:true. (permissions.spec + rate-limits.spec corrected.)

### Wave B — route-local validation + permission wiring + per-resource tests (T8 corrected)
- guild/audit-log: modify-guild enum/range/name validation, dropped undocumented mfa_level/nsfw_level,
  MANAGE_GUILD/VIEW_AUDIT_LOG wiring, audit entries omit empty changes + use canonical serializers.
- scheduled-events/stickers/templates: required-field/cap/channel-type validation, recurrence strip,
  sticker user-gating/Lottie/slots, full template-snapshot materialization, is_dirty/updated_at,
  MANAGE_GUILD wiring.
- components/messages/polls: action-row/select/custom_id/premium validation, integer nonce preserved,
  fail_if_not_exists, distinct bulk-delete age error, thread counter increment, poll author/limit/channel.
- channels/threads: MANAGE_CHANNELS/ROLES/THREADS wiring, auto_archive_duration + thread-type
  validation, forum message_count=0/total=1, archived-announcement threads, REQUIRE_TAG/5-tag cap,
  thread-member archived/type guards.
- oauth/users/roleConnections/invites/lobbies: OAuth client-auth + authorized-guild + refresh binding,
  roleConnections foreign-appId 404, invite target_type companion validation, ban limit=0, INVITE_CREATE
  fields, pin timestamp, lobby metadata/idle/flags-preserve/bulk-404/invite-shape, group-DM CHANNEL_CREATE,
  username case-insensitive/whitespace, email-scope gating.
- automod/stage/voice/soundboard/monetization/app-emoji/search: MANAGE_GUILD(+MODERATE_MEMBERS) wiring,
  actions/name/trigger_metadata required, stage channel-type + moderator perm + single-instance,
  voice stage-channel + perms, soundboard perms + sound_id/sound required + user-gating, subscription
  user_id required, app-emoji name/image validation + :appId scoping, event_webhooks_status 1|2,
  guild-message-search strips reactions + adds doing_deep_historical_index + limit.

### Intentionally NOT changed (documented known divergences)
Rate-limit generous defaults (500/s vs 50/s) and per-store (not per-token) scoping; microsecond/offset
timestamp format; approximate_presence_count == member_count; static session_start_limit / always-1
shards; invalidFormBody always BASE_TYPE_BAD_LENGTH sub-code; lobby/dev rate limits; scheduled-event
status auto-transitions; team-management endpoints; app event-webhooks auto-firing (W1/W2 — the manual
control endpoint remains); and the assorted Low/Nit items each group marked skip.
