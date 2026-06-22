# Discord API parity matrix — every entity, every call

Generated from the official docs (`discord-api-docs`) and cross-referenced against the
emulator's registered routes. This is the complete REST surface (not a curated subset):
every documented `<Route>` is listed and marked. `[x]` = the route is registered in the
emulator; `[ ]` = not registered. Behavioral-depth caveats (where a registered route is
still thin vs. the docs) are tracked in `discord-audit2/` and worked off separately.

**Coverage: 232/232 documented REST endpoints registered.**

| Entity group | Registered | Documented |
|---|---|---|
| User | 12 | 12 |
| Guild (core, members, roles, emojis, bans, prune, widget, onboarding, welcome-screen) | 45 | 45 |
| Channel & Permissions | 24 | 24 |
| Message, Reactions & Polls | 22 | 22 |
| Emoji | 10 | 10 |
| Sticker | 8 | 8 |
| Soundboard | 7 | 7 |
| Voice | 5 | 5 |
| Invite | 5 | 5 |
| Guild Scheduled Event | 6 | 6 |
| Guild Template | 6 | 6 |
| Stage Instance | 4 | 4 |
| Auto Moderation | 5 | 5 |
| Audit Log | 1 | 1 |
| Webhook | 15 | 15 |
| Application & Application Commands | 19 | 19 |
| Interactions (receiving & responding) | 8 | 8 |
| Application Role Connection Metadata | 2 | 2 |
| OAuth2 & Gateway bootstrap | 4 | 4 |
| Monetization (SKU, Entitlement, Subscription) | 8 | 8 |
| Lobby (Social SDK) | 16 | 16 |

## User

- [x] `GET    /users/@me` — Get Current User
- [x] `GET    /users/{user.id}` — Get User
- [x] `PATCH  /users/@me` — Modify Current User
- [x] `GET    /users/@me/guilds` — Get Current User Guilds
- [x] `GET    /users/@me/guilds/{guild.id}/member` — Get Current User Guild Member
- [x] `DELETE /users/@me/guilds/{guild.id}` — Leave Guild
- [x] `POST   /users/@me/channels` — Create DM
- [x] `POST   /users/@me/channels` — Create Group DM
- [x] `GET    /users/@me/connections` — Get Current User Connections
- [x] `GET    /users/@me/applications/{application.id}/role-connection` — Get Current User Application Role Connection
- [x] `PUT    /users/@me/applications/{application.id}/role-connection` — Update Current User Application Role Connection
- [x] `DELETE /users/@me/applications/{application.id}/role-connection` — Delete Current User Application Role Connection

## Guild (core, members, roles, emojis, bans, prune, widget, onboarding, welcome-screen)

- [x] `GET    /guilds/{guild.id}` — Get Guild
- [x] `GET    /guilds/{guild.id}/preview` — Get Guild Preview
- [x] `PATCH  /guilds/{guild.id}` — Modify Guild
- [x] `GET    /guilds/{guild.id}/channels` — Get Guild Channels
- [x] `POST   /guilds/{guild.id}/channels` — Create Guild Channel
- [x] `PATCH  /guilds/{guild.id}/channels` — Modify Guild Channel Positions
- [x] `GET    /guilds/{guild.id}/threads/active` — List Active Guild Threads
- [x] `GET    /guilds/{guild.id}/members/{user.id}` — Get Guild Member
- [x] `GET    /guilds/{guild.id}/members` — List Guild Members
- [x] `GET    /guilds/{guild.id}/members/search` — Search Guild Members
- [x] `PUT    /guilds/{guild.id}/members/{user.id}` — Add Guild Member
- [x] `PATCH  /guilds/{guild.id}/members/{user.id}` — Modify Guild Member
- [x] `PATCH  /guilds/{guild.id}/members/@me` — Modify Current Member
- [x] `PATCH  /guilds/{guild.id}/members/@me/nick` — Modify Current User Nick
- [x] `PUT    /guilds/{guild.id}/members/{user.id}/roles/{role.id}` — Add Guild Member Role
- [x] `DELETE /guilds/{guild.id}/members/{user.id}/roles/{role.id}` — Remove Guild Member Role
- [x] `DELETE /guilds/{guild.id}/members/{user.id}` — Remove Guild Member
- [x] `GET    /guilds/{guild.id}/bans` — Get Guild Bans
- [x] `GET    /guilds/{guild.id}/bans/{user.id}` — Get Guild Ban
- [x] `PUT    /guilds/{guild.id}/bans/{user.id}` — Create Guild Ban
- [x] `DELETE /guilds/{guild.id}/bans/{user.id}` — Remove Guild Ban
- [x] `POST   /guilds/{guild.id}/bulk-ban` — Bulk Guild Ban
- [x] `GET    /guilds/{guild.id}/roles` — Get Guild Roles
- [x] `GET    /guilds/{guild.id}/roles/{role.id}` — Get Guild Role
- [x] `GET    /guilds/{guild.id}/roles/member-counts` — Get Guild Role Member Counts
- [x] `POST   /guilds/{guild.id}/roles` — Create Guild Role
- [x] `PATCH  /guilds/{guild.id}/roles` — Modify Guild Role Positions
- [x] `PATCH  /guilds/{guild.id}/roles/{role.id}` — Modify Guild Role
- [x] `DELETE /guilds/{guild.id}/roles/{role.id}` — Delete Guild Role
- [x] `GET    /guilds/{guild.id}/prune` — Get Guild Prune Count
- [x] `POST   /guilds/{guild.id}/prune` — Begin Guild Prune
- [x] `GET    /guilds/{guild.id}/regions` — Get Guild Voice Regions
- [x] `GET    /guilds/{guild.id}/invites` — Get Guild Invites
- [x] `GET    /guilds/{guild.id}/integrations` — Get Guild Integrations
- [x] `DELETE /guilds/{guild.id}/integrations/{integration.id}` — Delete Guild Integration
- [x] `GET    /guilds/{guild.id}/widget` — Get Guild Widget Settings
- [x] `PATCH  /guilds/{guild.id}/widget` — Modify Guild Widget
- [x] `GET    /guilds/{guild.id}/widget.json` — Get Guild Widget
- [x] `GET    /guilds/{guild.id}/vanity-url` — Get Guild Vanity URL
- [x] `GET    /guilds/{guild.id}/widget.png` — Get Guild Widget Image
- [x] `GET    /guilds/{guild.id}/welcome-screen` — Get Guild Welcome Screen
- [x] `PATCH  /guilds/{guild.id}/welcome-screen` — Modify Guild Welcome Screen
- [x] `GET    /guilds/{guild.id}/onboarding` — Get Guild Onboarding
- [x] `PUT    /guilds/{guild.id}/onboarding` — Modify Guild Onboarding
- [x] `PUT    /guilds/{guild.id}/incident-actions` — Modify Guild Incident Actions

## Channel & Permissions

- [x] `GET    /channels/{channel.id}` — Get Channel
- [x] `PATCH  /channels/{channel.id}` — Modify Channel
- [x] `PUT    /channels/{channel.id}/voice-status` — Set Voice Channel Status
- [x] `DELETE /channels/{channel.id}` — Delete/Close Channel
- [x] `PUT    /channels/{channel.id}/permissions/{overwrite.id}` — Edit Channel Permissions
- [x] `GET    /channels/{channel.id}/invites` — Get Channel Invites
- [x] `POST   /channels/{channel.id}/invites` — Create Channel Invite
- [x] `DELETE /channels/{channel.id}/permissions/{overwrite.id}` — Delete Channel Permission
- [x] `POST   /channels/{channel.id}/followers` — Follow Announcement Channel
- [x] `POST   /channels/{channel.id}/typing` — Trigger Typing Indicator
- [x] `PUT    /channels/{channel.id}/recipients/{user.id}` — Group DM Add Recipient
- [x] `DELETE /channels/{channel.id}/recipients/{user.id}` — Group DM Remove Recipient
- [x] `POST   /channels/{channel.id}/messages/{message.id}/threads` — Start Thread from Message
- [x] `POST   /channels/{channel.id}/threads` — Start Thread without Message
- [x] `POST   /channels/{channel.id}/threads` — Start Thread in Forum or Media Channel
- [x] `PUT    /channels/{channel.id}/thread-members/@me` — Join Thread
- [x] `PUT    /channels/{channel.id}/thread-members/{user.id}` — Add Thread Member
- [x] `DELETE /channels/{channel.id}/thread-members/@me` — Leave Thread
- [x] `DELETE /channels/{channel.id}/thread-members/{user.id}` — Remove Thread Member
- [x] `GET    /channels/{channel.id}/thread-members/{user.id}` — Get Thread Member
- [x] `GET    /channels/{channel.id}/thread-members` — List Thread Members
- [x] `GET    /channels/{channel.id}/threads/archived/public` — List Public Archived Threads
- [x] `GET    /channels/{channel.id}/threads/archived/private` — List Private Archived Threads
- [x] `GET    /channels/{channel.id}/users/@me/threads/archived/private` — List Joined Private Archived Threads

## Message, Reactions & Polls

- [x] `GET    /channels/{channel.id}/messages` — Get Channel Messages
- [x] `GET    /guilds/{guild.id}/messages/search` — Search Guild Messages
- [x] `GET    /channels/{channel.id}/messages/{message.id}` — Get Channel Message
- [x] `POST   /channels/{channel.id}/messages` — Create Message
- [x] `POST   /channels/{channel.id}/messages/{message.id}/crosspost` — Crosspost Message
- [x] `PUT    /channels/{channel.id}/messages/{message.id}/reactions/{emoji.id}/@me` — Create Reaction
- [x] `DELETE /channels/{channel.id}/messages/{message.id}/reactions/{emoji.id}/@me` — Delete Own Reaction
- [x] `DELETE /channels/{channel.id}/messages/{message.id}/reactions/{emoji.id}/{user.id}` — Delete User Reaction
- [x] `GET    /channels/{channel.id}/messages/{message.id}/reactions/{emoji.id}` — Get Reactions
- [x] `DELETE /channels/{channel.id}/messages/{message.id}/reactions` — Delete All Reactions
- [x] `DELETE /channels/{channel.id}/messages/{message.id}/reactions/{emoji.id}` — Delete All Reactions for Emoji
- [x] `PATCH  /channels/{channel.id}/messages/{message.id}` — Edit Message
- [x] `DELETE /channels/{channel.id}/messages/{message.id}` — Delete Message
- [x] `POST   /channels/{channel.id}/messages/bulk-delete` — Bulk Delete Messages
- [x] `GET    /channels/{channel.id}/messages/pins` — Get Channel Pins
- [x] `PUT    /channels/{channel.id}/messages/pins/{message.id}` — Pin Message
- [x] `DELETE /channels/{channel.id}/messages/pins/{message.id}` — Unpin Message
- [x] `GET    /channels/{channel.id}/pins` — Get Pinned Messages (deprecated)
- [x] `PUT    /channels/{channel.id}/pins/{message.id}` — Pin Message (deprecated)
- [x] `DELETE /channels/{channel.id}/pins/{message.id}` — Unpin Message (deprecated)
- [x] `GET    /channels/{channel.id}/polls/{message.id}/answers/{answer_id}` — Get Answer Voters
- [x] `POST   /channels/{channel.id}/polls/{message.id}/expire` — End Poll

## Emoji

- [x] `GET    /guilds/{guild.id}/emojis` — List Guild Emojis
- [x] `GET    /guilds/{guild.id}/emojis/{emoji.id}` — Get Guild Emoji
- [x] `POST   /guilds/{guild.id}/emojis` — Create Guild Emoji
- [x] `PATCH  /guilds/{guild.id}/emojis/{emoji.id}` — Modify Guild Emoji
- [x] `DELETE /guilds/{guild.id}/emojis/{emoji.id}` — Delete Guild Emoji
- [x] `GET    /applications/{application.id}/emojis` — List Application Emojis
- [x] `GET    /applications/{application.id}/emojis/{emoji.id}` — Get Application Emoji
- [x] `POST   /applications/{application.id}/emojis` — Create Application Emoji
- [x] `PATCH  /applications/{application.id}/emojis/{emoji.id}` — Modify Application Emoji
- [x] `DELETE /applications/{application.id}/emojis/{emoji.id}` — Delete Application Emoji

## Sticker

- [x] `GET    /stickers/{sticker.id}` — Get Sticker
- [x] `GET    /sticker-packs` — List Sticker Packs
- [x] `GET    /sticker-packs/{pack.id}` — Get Sticker Pack
- [x] `GET    /guilds/{guild.id}/stickers` — List Guild Stickers
- [x] `GET    /guilds/{guild.id}/stickers/{sticker.id}` — Get Guild Sticker
- [x] `POST   /guilds/{guild.id}/stickers` — Create Guild Sticker
- [x] `PATCH  /guilds/{guild.id}/stickers/{sticker.id}` — Modify Guild Sticker
- [x] `DELETE /guilds/{guild.id}/stickers/{sticker.id}` — Delete Guild Sticker

## Soundboard

- [x] `POST   /channels/{channel.id}/send-soundboard-sound` — Send Soundboard Sound
- [x] `GET    /soundboard-default-sounds` — List Default Soundboard Sounds
- [x] `GET    /guilds/{guild.id}/soundboard-sounds` — List Guild Soundboard Sounds
- [x] `GET    /guilds/{guild.id}/soundboard-sounds/{sound.id}` — Get Guild Soundboard Sound
- [x] `POST   /guilds/{guild.id}/soundboard-sounds` — Create Guild Soundboard Sound
- [x] `PATCH  /guilds/{guild.id}/soundboard-sounds/{sound.id}` — Modify Guild Soundboard Sound
- [x] `DELETE /guilds/{guild.id}/soundboard-sounds/{sound.id}` — Delete Guild Soundboard Sound

## Voice

- [x] `GET    /voice/regions` — List Voice Regions
- [x] `GET    /guilds/{guild.id}/voice-states/@me` — Get Current User Voice State
- [x] `GET    /guilds/{guild.id}/voice-states/{user.id}` — Get User Voice State
- [x] `PATCH  /guilds/{guild.id}/voice-states/@me` — Modify Current User Voice State
- [x] `PATCH  /guilds/{guild.id}/voice-states/{user.id}` — Modify User Voice State

## Invite

- [x] `GET    /invites/{invite.code}` — Get Invite
- [x] `DELETE /invites/{invite.code}` — Delete Invite
- [x] `GET    /invites/{invite.code}/target-users` — Get Target Users
- [x] `PUT    /invites/{invite.code}/target-users` — Update Target Users
- [x] `GET    /invites/{invite.code}/target-users/job-status` — Get Target Users Job Status

## Guild Scheduled Event

- [x] `GET    /guilds/{guild.id}/scheduled-events` — List Scheduled Events for Guild
- [x] `POST   /guilds/{guild.id}/scheduled-events` — Create Guild Scheduled Event
- [x] `GET    /guilds/{guild.id}/scheduled-events/{guild_scheduled_event.id}` — Get Guild Scheduled Event
- [x] `PATCH  /guilds/{guild.id}/scheduled-events/{guild_scheduled_event.id}` — Modify Guild Scheduled Event
- [x] `DELETE /guilds/{guild.id}/scheduled-events/{guild_scheduled_event.id}` — Delete Guild Scheduled Event
- [x] `GET    /guilds/{guild.id}/scheduled-events/{guild_scheduled_event.id}/users` — Get Guild Scheduled Event Users

## Guild Template

- [x] `GET    /guilds/templates/{template.code}` — Get Guild Template
- [x] `GET    /guilds/{guild.id}/templates` — Get Guild Templates
- [x] `POST   /guilds/{guild.id}/templates` — Create Guild Template
- [x] `PUT    /guilds/{guild.id}/templates/{template.code}` — Sync Guild Template
- [x] `PATCH  /guilds/{guild.id}/templates/{template.code}` — Modify Guild Template
- [x] `DELETE /guilds/{guild.id}/templates/{template.code}` — Delete Guild Template

## Stage Instance

- [x] `POST   /stage-instances` — Create Stage Instance
- [x] `GET    /stage-instances/{channel.id}` — Get Stage Instance
- [x] `PATCH  /stage-instances/{channel.id}` — Modify Stage Instance
- [x] `DELETE /stage-instances/{channel.id}` — Delete Stage Instance

## Auto Moderation

- [x] `GET    /guilds/{guild.id}/auto-moderation/rules` — List Auto Moderation Rules for Guild
- [x] `GET    /guilds/{guild.id}/auto-moderation/rules/{auto_moderation_rule.id}` — Get Auto Moderation Rule
- [x] `POST   /guilds/{guild.id}/auto-moderation/rules` — Create Auto Moderation Rule
- [x] `PATCH  /guilds/{guild.id}/auto-moderation/rules/{auto_moderation_rule.id}` — Modify Auto Moderation Rule
- [x] `DELETE /guilds/{guild.id}/auto-moderation/rules/{auto_moderation_rule.id}` — Delete Auto Moderation Rule

## Audit Log

- [x] `GET    /guilds/{guild.id}/audit-logs` — Get Guild Audit Log

## Webhook

- [x] `POST   /channels/{channel.id}/webhooks` — Create Webhook
- [x] `GET    /channels/{channel.id}/webhooks` — Get Channel Webhooks
- [x] `GET    /guilds/{guild.id}/webhooks` — Get Guild Webhooks
- [x] `GET    /webhooks/{webhook.id}` — Get Webhook
- [x] `GET    /webhooks/{webhook.id}/{webhook.token}` — Get Webhook with Token
- [x] `PATCH  /webhooks/{webhook.id}` — Modify Webhook
- [x] `PATCH  /webhooks/{webhook.id}/{webhook.token}` — Modify Webhook with Token
- [x] `DELETE /webhooks/{webhook.id}` — Delete Webhook
- [x] `DELETE /webhooks/{webhook.id}/{webhook.token}` — Delete Webhook with Token
- [x] `POST   /webhooks/{webhook.id}/{webhook.token}` — Execute Webhook
- [x] `POST   /webhooks/{webhook.id}/{webhook.token}/slack` — Execute Slack-Compatible Webhook
- [x] `POST   /webhooks/{webhook.id}/{webhook.token}/github` — Execute GitHub-Compatible Webhook
- [x] `GET    /webhooks/{webhook.id}/{webhook.token}/messages/{message.id}` — Get Webhook Message
- [x] `PATCH  /webhooks/{webhook.id}/{webhook.token}/messages/{message.id}` — Edit Webhook Message
- [x] `DELETE /webhooks/{webhook.id}/{webhook.token}/messages/{message.id}` — Delete Webhook Message

## Application & Application Commands

- [x] `GET    /applications/@me` — Get Current Application
- [x] `PATCH  /applications/@me` — Edit Current Application
- [x] `GET    /applications/{application.id}/activity-instances/{instance_id}` — Get Application Activity Instance
- [x] `GET    /applications/{application.id}/commands` — Get Global Application Commands
- [x] `POST   /applications/{application.id}/commands` — Create Global Application Command
- [x] `GET    /applications/{application.id}/commands/{command.id}` — Get Global Application Command
- [x] `PATCH  /applications/{application.id}/commands/{command.id}` — Edit Global Application Command
- [x] `DELETE /applications/{application.id}/commands/{command.id}` — Delete Global Application Command
- [x] `PUT    /applications/{application.id}/commands` — Bulk Overwrite Global Application Commands
- [x] `GET    /applications/{application.id}/guilds/{guild.id}/commands` — Get Guild Application Commands
- [x] `POST   /applications/{application.id}/guilds/{guild.id}/commands` — Create Guild Application Command
- [x] `GET    /applications/{application.id}/guilds/{guild.id}/commands/{command.id}` — Get Guild Application Command
- [x] `PATCH  /applications/{application.id}/guilds/{guild.id}/commands/{command.id}` — Edit Guild Application Command
- [x] `DELETE /applications/{application.id}/guilds/{guild.id}/commands/{command.id}` — Delete Guild Application Command
- [x] `PUT    /applications/{application.id}/guilds/{guild.id}/commands` — Bulk Overwrite Guild Application Commands
- [x] `GET    /applications/{application.id}/guilds/{guild.id}/commands/permissions` — Get Guild Application Command Permissions
- [x] `GET    /applications/{application.id}/guilds/{guild.id}/commands/{command.id}/permissions` — Get Application Command Permissions
- [x] `PUT    /applications/{application.id}/guilds/{guild.id}/commands/{command.id}/permissions` — Edit Application Command Permissions
- [x] `PUT    /applications/{application.id}/guilds/{guild.id}/commands/permissions` — Batch Edit Application Command Permissions

## Interactions (receiving & responding)

- [x] `POST   /interactions/{interaction.id}/{interaction.token}/callback` — Create Interaction Response
- [x] `GET    /webhooks/{application.id}/{interaction.token}/messages/@original` — Get Original Interaction Response
- [x] `PATCH  /webhooks/{application.id}/{interaction.token}/messages/@original` — Edit Original Interaction Response
- [x] `DELETE /webhooks/{application.id}/{interaction.token}/messages/@original` — Delete Original Interaction Response
- [x] `POST   /webhooks/{application.id}/{interaction.token}` — Create Followup Message
- [x] `GET    /webhooks/{application.id}/{interaction.token}/messages/{message.id}` — Get Followup Message
- [x] `PATCH  /webhooks/{application.id}/{interaction.token}/messages/{message.id}` — Edit Followup Message
- [x] `DELETE /webhooks/{application.id}/{interaction.token}/messages/{message.id}` — Delete Followup Message

## Application Role Connection Metadata

- [x] `GET    /applications/{application.id}/role-connections/metadata` — Get Application Role Connection Metadata Records
- [x] `PUT    /applications/{application.id}/role-connections/metadata` — Update Application Role Connection Metadata Records

## OAuth2 & Gateway bootstrap

- [x] `GET    /oauth2/applications/@me` — Get Current Bot Application Information
- [x] `GET    /oauth2/@me` — Get Current Authorization Information
- [x] `GET    /gateway` — Get Gateway
- [x] `GET    /gateway/bot` — Get Gateway Bot

## Monetization (SKU, Entitlement, Subscription)

- [x] `GET    /applications/{application.id}/skus` — List SKUs
- [x] `GET    /applications/{application.id}/entitlements` — List Entitlements
- [x] `GET    /applications/{application.id}/entitlements/{entitlement.id}` — Get Entitlement
- [x] `POST   /applications/{application.id}/entitlements/{entitlement.id}/consume` — Consume an Entitlement
- [x] `POST   /applications/{application.id}/entitlements` — Create Test Entitlement
- [x] `DELETE /applications/{application.id}/entitlements/{entitlement.id}` — Delete Test Entitlement
- [x] `GET    /skus/{sku.id}/subscriptions` — List SKU Subscriptions
- [x] `GET    /skus/{sku.id}/subscriptions/{subscription.id}` — Get SKU Subscription

## Lobby (Social SDK)

- [x] `POST   /lobbies` — Create Lobby
- [x] `PUT    /lobbies` — Create or Join Lobby
- [x] `GET    /lobbies/{lobby.id}` — Get Lobby
- [x] `PATCH  /lobbies/{lobby.id}` — Modify Lobby
- [x] `DELETE /lobbies/{lobby.id}` — Delete Lobby
- [x] `PUT    /lobbies/{lobby.id}/members/{user.id}` — Add a Member to a Lobby
- [x] `POST   /lobbies/{lobby.id}/members/bulk` — Bulk Update Lobby Members
- [x] `DELETE /lobbies/{lobby.id}/members/{user.id}` — Remove a Member from a Lobby
- [x] `DELETE /lobbies/{lobby.id}/members/@me` — Leave Lobby
- [x] `PATCH  /lobbies/{lobby.id}/channel-linking` — Link Channel to Lobby
- [x] `PATCH  /lobbies/{lobby.id}/channel-linking` — Unlink Channel from Lobby
- [x] `POST   /lobbies/{lobby.id}/messages` — Send Lobby Message
- [x] `GET    /lobbies/{lobby.id}/messages` — Get Lobby Messages
- [x] `PUT    /lobbies/{lobby.id}/messages/{message.id}/moderation-metadata` — Update Lobby Message Moderation Metadata
- [x] `POST   /lobbies/{lobby.id}/members/@me/invites` — Create Lobby Channel Invite for Self
- [x] `POST   /lobbies/{lobby.id}/members/{user.id}/invites` — Create Lobby Channel Invite for User

---

## Build methodology — page-by-page, doc-driven TDD

The build is **not** endpoint-driven. Each doc page is read in full and its every
expectation — object fields and types, enums, flags, request/response shapes, validation
limits, error codes, behavioral notes, and documented gotchas — is encoded as a spec test
under `src/__tests__/spec/<page>.spec.test.ts` first; the implementation is then built/fixed
until that page's suite is green. A page is **done** only when its spec suite passes.

| Doc page | Spec suite | Status |
|---|---|---|
| `developers/resources/application-role-connection-metadata.mdx` | `spec/application-role-connection-metadata.spec.test.ts` | [x] green (25 cases) |
| `developers/resources/application.mdx` | `spec/application.spec.test.ts` | [x] green (31 cases) |
| `developers/resources/audit-log.mdx` | `spec/audit-log.spec.test.ts` | [ ] not started |
| `developers/resources/auto-moderation.mdx` | `spec/auto-moderation.spec.test.ts` | [x] green (38 cases) |
| `developers/resources/channel.mdx` | `spec/channel.spec.test.ts` | [x] green |
| `developers/resources/emoji.mdx` | `spec/emoji.spec.test.ts` | [ ] not started |
| `developers/resources/entitlement.mdx` | `spec/entitlement.spec.test.ts` | [x] green (25 cases) |
| `developers/resources/guild-scheduled-event.mdx` | `spec/guild-scheduled-event.spec.test.ts` | [x] green (29 cases) |
| `developers/resources/guild-template.mdx` | `spec/guild-template.spec.test.ts` | [x] green (23 cases) |
| `developers/resources/guild.mdx` | `spec/guild.spec.test.ts` | [ ] not started |
| `developers/resources/invite.mdx` | `spec/invite.spec.test.ts` | [x] green |
| `developers/resources/lobby.mdx` | `spec/lobby.spec.test.ts` | [x] green (27 cases) |
| `developers/resources/message.mdx` | `spec/message.spec.test.ts` | [x] green (55 cases) |
| `developers/resources/poll.mdx` | `spec/poll.spec.test.ts` | [x] green (19 cases) |
| `developers/resources/sku.mdx` | `spec/sku.spec.test.ts` | [x] green |
| `developers/resources/soundboard.mdx` | `spec/soundboard.spec.test.ts` | [x] green (21 cases) |
| `developers/resources/stage-instance.mdx` | `spec/stage-instance.spec.test.ts` | [x] green (22 cases) |
| `developers/resources/sticker.mdx` | `spec/sticker.spec.test.ts` | [x] green (24 cases) |
| `developers/resources/subscription.mdx` | `spec/subscription.spec.test.ts` | [x] green (12 cases) |
| `developers/resources/user.mdx` | `spec/user.spec.test.ts` | [x] green (16 assertions) |
| `developers/resources/voice.mdx` | `spec/voice.spec.test.ts` | [x] green |
| `developers/resources/webhook.mdx` | `spec/webhook.spec.test.ts` | [ ] not started |
| `developers/interactions/application-commands.mdx` | `spec/application-commands.spec.test.ts` | [ ] not started |
| `developers/interactions/overview.mdx` | `spec/overview.spec.test.ts` | [ ] not started |
| `developers/interactions/receiving-and-responding.mdx` | `spec/receiving-and-responding.spec.test.ts` | [ ] not started |
| `developers/topics/certified-devices.mdx` | `spec/certified-devices.spec.test.ts` | [ ] not started |
| `developers/topics/oauth2.mdx` | `spec/oauth2.spec.test.ts` | [x] green (30 cases) |
| `developers/topics/opcodes-and-status-codes.mdx` | `spec/opcodes-and-status-codes.spec.test.ts` | [ ] not started |
| `developers/topics/permissions.mdx` | `spec/permissions.spec.test.ts` | [ ] not started |
| `developers/topics/rate-limits.mdx` | `spec/rate-limits.spec.test.ts` | [ ] not started |
| `developers/topics/rpc.mdx` | `spec/rpc.spec.test.ts` | [ ] not started |
| `developers/topics/teams.mdx` | `spec/teams.spec.test.ts` | [ ] not started |
| `developers/topics/threads.mdx` | `spec/threads.spec.test.ts` | [x] green (threads.spec) |
| `developers/topics/voice-connections.mdx` | `spec/voice-connections.spec.test.ts` | [x] green |
| `developers/events/gateway-events.mdx` | `spec/gateway-events.spec.test.ts` | [x] green (shared gateway.spec) |
| `developers/events/gateway.mdx` | `spec/gateway.spec.test.ts` | [x] green (shared gateway.spec) |
| `developers/events/overview.mdx` | `spec/overview.spec.test.ts` | [ ] not started |
| `developers/events/webhook-events.mdx` | `spec/webhook-events.spec.test.ts` | [ ] not started |
| `developers/components/overview.mdx` | `spec/overview.spec.test.ts` | [ ] not started |
| `developers/components/reference.mdx` | `spec/reference.spec.test.ts` | [ ] not started |
| `developers/components/using-message-components.mdx` | `spec/using-message-components.spec.test.ts` | [ ] not started |
| `developers/components/using-modal-components.mdx` | `spec/using-modal-components.spec.test.ts` | [ ] not started |
