# Native Agent control

Moss exposes a small deterministic control API and an ordinary scode plugin.
Browser management and Agent calls use `AgentManagementOperations`, the same
current owner/member checks, and the same native runtime adapter. An optional
Moss coordinator Agent uses these tools without replacing the original
delegator with its own ambient authority. No extra MCP server is needed.

`src/server/agentControl/contract.ts` owns argument validation and tool schemas.
Adapters must not copy the catalog, construct another issuer, or turn a peer
chat message into a control grant. Stack owns deployment composition, Edge and
Cloud own placement, and Nexus owns native identity and collaboration access.

## Authorization and identity

The operator sets `MOSS_AGENT_CONTROL_DEPLOYMENT_ID` to a stable deployment ID.
The gateway is disabled otherwise. Using an ordinary human Moss login, issue
`POST /api/v1/agent-control/delegations` with:

```json
{
  "actorSessionId": "existing-moss-session-id",
  "target": { "deploymentId": "my-box", "ownerId": "actual-owner-id" },
  "actions": ["agents.list", "agents.inspect", "agents.spawn", "runtime.inspect"],
  "ttlSeconds": 120
}
```

The source actor must be that human's current managed cohost session. The
server reads its durable binding and the actual authenticated native session,
including owner, Agent, SID, repository and live execution; JSON cannot replace
them. Each call rechecks membership, permissions, original login revocation,
delegation expiry/revocation and the actor's current attempt. Resuming the
source session requires a new explicit delegation. The target is an installed
deployment, not a URL, shell command, remote executable or supplied credential.

The returned short-lived bearer uses the existing Moss signer and revocation
authority with a distinct audience. It cannot log into browser APIs, refresh,
or mint another delegation. Its scope is bounded by both the original human
grant and current permissions. Role labels do not bypass that intersection.

This is **delegated managed-session authority**: possession of the bearer is
the request authentication. Native inspection verifies the assigned managed
actor; it does not attest which external process holds that bearer. A scode
tool-call ID provides correlation only. This API does not enroll an arbitrary
external Agent, assert an external Nexus certificate identity, or establish
cross-domain trust. Those paths must use the native Nexus enrollment contract.
Deploy the bearer only into the intended Agent's private tool environment.

## Native tools

Build the standalone Node 22 entry with `node scripts/build-agent-control.mjs`.
Pass the just-issued response over private stdin to:

```text
node dist/agent-control/moss-agent-control.mjs install <new-private-directory> <https-moss-origin>
```

No login password/token is installed. The entry verifies capabilities, creates
an exclusive private directory and writes a plugin manifest from the local
catalog. POSIX modes are 0700/0600; Windows setup removes inherited directory
access and grants the current user's SID. The directory must have a trusted
parent. It refuses overwriting an existing installation. Keep Node 22 on the
trusted runtime PATH. `http` is accepted only for loopback; remote access
requires HTTPS and redirects are refused.

Install that local plugin using the existing scode plugin manager. Existing
ToolSearch/deferred discovery and host permission checks apply. Spawn is a
mutating `workspace-write` tool, not a read-only lookup. This does not change
the caller's permission mode or interactive approval route.

The plugin requires scode's `SUDOCODE_TOOL_CALL_ID` context. It hashes the
delegation ID and actual invocation ID into a stable operation ID; it never
generates a new command ID to recover a lost response. No-context calls are
refused. The ID is not computed from the message body: distinct identical
requests remain possible.

The credential lasts at most 300 seconds and never outlives its parent login.
There is no background refresh using a saved human credential. Expiry requires
explicit reconnect; durable installation does not make a token permanent.
A user-facing reconnect/approval UI is still an integration task.

## Outcomes and recovery

`POST /api/v1/agent-control/invoke` reserves a durable operation before dispatch.
Revocation and final admission serialize on the same delegation row. Network
RPC and effects run outside that transaction. Concurrent/repeated requests
with the same ID return that operation; an ID/body conflict is refused.

Receipts bind the human, assigned actor, credential ID, deployment, action and
requested/effective input hashes. After admission, cancellation, response loss
or receipt failure is `unknown`, never a claim of no effect. No automatic
resend, fallback or second execution occurs. Use `moss_control_operation` to
read the original receipt. The original human can also GET
`/api/v1/agent-control/operations/<id>` after actor exit or delegation revocation.
That recovery read cannot execute an operation. Only a durable `rejected`
receipt establishes `not_submitted`; an HTTP error does not.

Revocation prevents subsequent admission, not remote rollback or cancellation
of an already-started session. No cross-system atomic quiescence is claimed.

## Current boundary and validation

Implemented tools list/inspect existing Agents, start an authorized Agent
session, inspect the owner runtime and query receipts. Deploy and join are not
advertised: they need the approved Stack/Edge plan and native join executor.
The native plugin is not an alternative SSH executor or a generic remote shell.

Qualification covers real Moss HTTP/SQLite and a separately bundled native
tool process, plus real HTTP response loss after one effect and receipt-only
recovery. Native-session and effect fault cases use isolated fixture ports;
they are not real DGX mTLS, cross-domain join or seven-party acceptance. The
existing DGX product and production services are unchanged by these tests.
