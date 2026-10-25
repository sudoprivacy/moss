# Personal Moss Agent access

The product design is maintained in the [cloud plan source](https://github.com/sudoprivacy/sudostack/pull/100).
This document describes the implemented API boundary. It does not declare the
Feishu per-member routing or production acceptance complete.

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

Tests cover concurrent identity lookup, owner/organization separation,
grant/revoke, stale/forged roles, disabled/moved users, native-reference
authorization, database failure and real HTTP/WebSocket revocation.
The HTTP fixture replaces execution and placement; it does not establish
production model charging or Feishu message handling.

`moss_member_access` uses the same DDL for SQLite initialization and the
versioned PostgreSQL migration. There is no credential migration or automatic
conversion of existing bot pairings into human account bindings. Production
cutover and live owner billing remain separate acceptance steps.
