# Personal Moss Agent access

The product design is maintained in the [cloud plan source](https://github.com/sudoprivacy/sudostack/pull/100).
This document describes the implemented API boundary. The per-member Feishu
path is opt-in and remains subject to CI, release and production acceptance.

## Identity and runtime

One stable identity is derived from the organization and human user IDs.
It has a distinct native Agent home from the user's default personal Agent.
Reading the descriptor does not create a Session or start a Pod.

The existing Agent management list includes eligible owners' Moss Agents.
Its detail and conversation actions reuse the shared SudoWork workbench and
cohost/scode runtime. Starting another owner's conversation retains that
owner's role, credentials and billing identity and records the actual manager.

## Endpoints

All requests require the normal authenticated access token. Responses use
`Cache-Control: no-store`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/moss/agent` | Return the caller's `{ ref, agentName, displayName, ownerId, orgId }`; refuse when membership or Moss access is unavailable. |
| GET | `/api/v1/moss/member-access/:userId` | An organization administrator reads `{ orgId, userId, isEnabled, isGranted, source, memberStatus }`. The result distinguishes the stored/default grant from current effective use for a disabled member. |
| PUT | `/api/v1/moss/member-access/:userId` | An active administrator in the current organization, with `admin:users`, grants/revokes the named member using `{ "enabled": true/false }`. Foreign members are not addressable. |

Active organization administrators have access by default. Other members
require an explicit grant. An explicit revocation overrides the default.
SudoWork login, IM pairing, a cached role, and knowledge of an Agent reference
do not grant Moss use or additional data-source privileges.

Moss Web exposes this same API at **Users → member actions → Moss 使用权**.
The dialog reads current access, grants or revokes it, and requires a fresh
read after an ambiguous write failure. Switching organizations closes the
dialog and cancels its pending requests. A current super administrator can
manage members only within the explicitly selected organization context.

Membership and grants are checked at creation, runtime recovery and before
each established WebSocket input frame, including server-internal channels.
Native Nexus references retain the same checks. Revocation preserves the
Agent identity and existing history, prevents automatic revival on history
reads, and refuses new execution/input. Restoring access retains the identity.
When the owner's role changes, an existing Session cannot retain its old
runtime privileges. New input/recovery requires a fresh conversation under
the current role; the old history remains readable.

## Validation and rollout

### Per-member Feishu connection

Existing connections retain their owner mode. An organization administrator
can explicitly opt a Feishu connection into `moss-member` mode through
`PUT /api/v1/moss/im/connections/:connectionOwnerId/:pluginId` with
`{ "appId": "cli_…", "tenantKey": "…" }`. The server pins the tenant, app,
organization, connection owner, connection ID and a configuration revision.
The running plugin must report the matching app ID. This operation preserves
other configuration and credentials and invalidates previous binding proofs.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/v1/moss/im/bindings` | Read only the authenticated human's current organization bindings and their connection availability. |
| POST | `/api/v1/moss/im/bind` | Redeem `{ "code": "…" }` from the bot's private message using a human Moss/SudoWork login and current Moss access. API-key/internal tokens cannot redeem proofs. |
| DELETE | `/api/v1/moss/im/bindings/:id` | The authenticated human removes their own binding; Agent identity, Sessions and history remain. This also works after Moss use is revoked. |

The Web **Agent → 我的 Moss Agent** entry opens the existing Agent detail
and workbench. Only the owner sees its Feishu binding panel. The private
proof is masked in the form, cleared on submit, expires after ten minutes,
is stored only as a digest, and can be claimed once. A failed private send
never falls back to posting that proof in a group. Legacy pairing approvals
and sender display names do not establish a human account binding.

Only stable, human SDK events from the pinned tenant are accepted. The
receiving connection's current local registration and HA lease are checked
before queued work and immediately before model input. Membership, binding,
Moss access and Session role are rechecked independently of that lease.

The persisted IM pointer is keyed by organization, Moss Agent, connection
and group/private chat. Web activity cannot silently move it. `/new` creates
a new Session and retains the old one; `/resume <id>` verifies the same
organization, owner and Moss Agent and does not post old history to the group.
Connection failure retains the pointer and refuses a silent clean restart.
Owner mode and member mode share the runner transport and reply streaming.

An event ID is durably claimed before processing. A duplicate event, including
an unknown dispatch after a crash, never automatically repeats model input.
Receipts retain the actual user, Agent and Session. Binding or permission
revocation prevents further input; neither transfers a Session to another user.

`moss_im_link_challenges`, `moss_im_conversations` and `moss_im_deliveries`
share SQLite initialization and PostgreSQL migration 23. Tests exercise real
SQLite authorization and the executor with a controlled runtime. A real
PostgreSQL test races independent connection pools for proof redemption,
pointer updates and event claims when `MOSS_PG_TEST_URL` is available.

### Production acceptance still required

Tests cover concurrent identity lookup, owner/organization separation,
grant/revoke, stale/forged roles, disabled/moved users, native-reference
authorization, database failure and real HTTP/WebSocket revocation.
The HTTP fixture replaces execution and placement; it does not establish
production model charging or Feishu message handling.

`moss_member_access` uses the same DDL for SQLite initialization and the
versioned PostgreSQL migration. There is no credential migration or automatic
conversion of existing bot pairings into human account bindings. Production
cutover, real Feishu replies, two-member continuity and live owner billing
remain separate acceptance steps. Previously verified bot-owner billing is
not evidence of the new per-member path.

Before rolling back to a server that predates member routing, disable the
member-mode connection through its owner API and verify that it is stopped.
Keep its credentials, bindings, Session pointers and histories. An old binary
does not understand the new routing mode and must not receive these messages
as a fallback bot-owner conversation. Re-enable it only on a version that
supports and verifies the configured member mode.
