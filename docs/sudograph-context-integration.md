# Canonical model context at execution

The existing Moss ACP bridge supports Sudo Code's opt-in `hostContext` v1
protocol. An authorized host supplies `resolveHostContext` as a function in
`BackendSpawnOptions`; the cohost, local, Docker and legacy Kubernetes Sudo Code
backends pass it into the same bridge used for ordinary conversations. The
function is an internal runtime port. It is never
accepted from a prompt, HTTP request, client metadata or serialized manifest.

The closure binds one canonical project and rechecks current model access on
each read, including after asynchronous I/O. Its arguments identify the Moss
session and the engine's native session, not caller-selected model paths.
It returns the current deterministically compiled context as text. It must not
summarize a conversation into a competing definition or grant permissions based
on a prompt. Source credentials and worker paths stay behind the host boundary.

The bridge requires the engine to advertise v1 before creating or loading a
session. It opts that session into execution-time reads instead of sending an
initial mutable snapshot. Immediately before each actual model turn, the engine
requests the bound context through the existing ACP connection. The bridge
returns the newly read text followed by any fixed application role. Business
context is absent from user messages and their persisted history. Ordinary
sessions without the callback retain their existing static instruction behavior.

An unsupported engine, empty/malformed result or reader refusal cannot fall
back to a previous snapshot. A callback completing after interruption or
connection loss cannot disclose its text. Reader errors return an explicit
refusal without forwarding possible credentials. The engine refuses the turn
before making a provider request. No extra model workflow prompt or parallel
agent/renderer protocol is introduced.

## Acceptance and current limits

`acpHostContext.node-test.ts` is in the ordinary Node test runner. It covers
creation/resume negotiation, fresh reads, unchanged legacy sessions, rejected
capabilities, foreign session IDs, read failures and cancellation during reads.
The existing bridge and Nexus transport tests continue to exercise their shared
message and lifecycle paths.

The explicit acceptance below uses an installed compiler, a checksum-pinned real
engine process and the actual Moss ACP bridge. It registers a fresh SQLite
fixture, edits one canonical business definition, and captures complete provider
requests around the edit. It requires exact compiled context, matching graph
and context revisions, preserved user history, no business context copied into
that history, no model request after a synthetic host refusal, and unchanged
source bytes. A deterministic loopback provider needs no real API credentials.

```sh
node --import tsx scripts/e2e/accept-sudograph-context.ts \
  --engine /absolute/path/scode \
  --engine-sha256 "$SCODE_SHA256" \
  --python /absolute/path/installed-compiler/bin/python \
  --evidence /absolute/path/acceptance
```

Use the checksum from the selected, verified engine artifact. The evidence
directory retains captured requests, transcript, diagnostics and source/model
fixtures. A failed run does not create a successful receipt.

The native session runner reconstructs this port from the durable project binding
and shared production host factory, and refuses startup when a bound model has
no authorized worker. No function is serialized through the durable manifest.
The real-engine acceptance uses stdio and current database membership revocation,
not a managed Nexus mailbox. Deployed tenant grants, worker placement and Vault
connectivity, WebUI routes, authenticated review/comment delivery, supported
official engine adoption and the human journey remain separate acceptance.
The WebUI must not store a second canonical model or reinterpret a Desktop
SQLite path on its own host.

## Durable project and conversation references

Authenticated clients can list their current authorized projects with
`GET /api/v1/ontology/projects` and pass one `project_id` as
`ontology_project_id` to the ordinary `POST /api/v1/sessions` entry. Discovery
uses the same current MCP membership, visibility, tool review and credential
policy as runner execution. The response contains canonical references only,
without worker addresses, secrets, context snapshots or counts of hidden models.
`GET /api/v1/sessions/:id/ontology-project` recovers that conversation's binding
for its actual current owner; administrative session attachment does not grant
access to another owner's model.

Creation authorizes the registered project before its SQL transaction, then
persists the ordinary session, its creation event and immutable model binding
together, before starting any attempt. Failed admission or persistence leaves no
unbound ordinary session that could resume without model context. Disable/re-enable
generations fence project changes during creation. The runner still rechecks
current membership, worker policy and binding on startup and every actual turn.
An unsupported engine refuses the bound session; it cannot fall back to legacy
instructions. No model path, worker URL, credential, callback or business text is
accepted from this field or stored in client metadata.

These routes expose already registered canonical projects. They do not let a
client register an arbitrary worker or declare a source scan complete. Source
intake/worker provisioning, the WebUI project selector and end-user review/comment
acceptance remain separate integration work. Ordinary sessions omit
`ontology_project_id` and retain their existing path.

The Moss database now has a project registry and immutable conversation
bindings, shared by SQLite and PostgreSQL. It stores the tenant, authority,
registered execution worker, model and source references. It stores no model
YAML, credentials, database address or worker filesystem path. Re-registering
the same authority is idempotent; another authority cannot create a second
project identity for the same worker/model. Changing a registered binding needs
an explicit migration rather than a prompt-selected target.

`OntologyProjectRegistry.bind` checks the persisted conversation owner and
tenant. Many conversations may reference the same project. Reopening a graph
cannot silently retarget an existing conversation. Its context reader can be
reconstructed after reopening the host database and reads the current binding
and policy before and after worker I/O. Session deletion, ownership changes,
project disable/re-enable and authorization refusal prevent disclosure; none
may fall back to a cached model snapshot or ordinary legacy instructions.

The authorization and worker ports are trusted host functions. Authorization
must reuse current membership, source and resource policy; this registry does
not create another grant system. A provider that cannot enforce a requested
row/field scope must refuse it, rather than authorize an unrestricted context.
The worker port must resolve the registered execution location and pinned
compiler package. The source/model references in this table do not establish
network reachability or production authorization.

The maintained real-engine acceptance above now closes and reopens the actual
Moss database before constructing its reader. Ordinary Node tests also check
cross-tenant/owner rejection, duplicate registration, multi-session bindings,
current reads and revocation during I/O. The production factory below supplies
these ports from the existing MCP catalogue and current policy. A missing worker,
review or credential fails explicitly. Source intake and deployed cloud journeys
remain outstanding. No public API for arbitrary registration is exposed.

`SessionRunnerDaemon` checks the persisted binding during startup and resume,
compares its owner and tenant with the runner identity, and rechecks model access
before spawning the existing native backend. It passes the same live resolver
through the existing backend/ACP connection. There is no callback, worker path or
business snapshot in the manifest. Ordinary conversations remain unchanged.
Real database/daemon tests cover recovery, fresh context across turns, revoked
access, missing adapters and forged manifest identities; existing cancellation,
maintenance and exit lifecycle tests retain their assertions and deadlines.

## Registered MCP worker profile

`ReviewedMcpAccess` now shares the existing MCP network, credential, current-member
and IT tool-review checks with `AgentToolGateway`. Agent execution retains its
separate Registry task/grant and asset checks. A trusted host may read an explicitly
reviewed read operation; this is not a public route for an agent to avoid those
execution gates. Agent- or skill-bound MCP endpoints are refused for this host
profile until the host can prove the corresponding asset identity.

`McpOntologyContextPorts` resolves the worker reference through that same MCP
catalogue. Each endpoint serves one complete registered model with the fixed
`sudograph_context` tool and an empty argument object. `registerModelContextTool`
implements that profile on the deployment's authenticated MCP server. It invokes
the supplied canonical reader on every call, validates the returned context, and
never accepts a path, model, source, actor or authorization policy from tool input.
Provider/compiler failures are sanitized before leaving the worker.

The wire envelope is `sudograph-worker-context/v1`, with exact `authority_ref`,
`model_ref`, sorted unique `source_refs`, `scope: full-registered-model`, and the
compiler context. The host compares every identity with its persisted binding.
This profile grants the complete registered model only. It does not implement
row/field filtering; a restricted projection or another scope needs its own
explicit supported contract and must not silently return the full model.

Reads recheck current membership, endpoint policy, reviewed descriptor and
credentials before dispatch and after worker I/O. Revocation or changes discard
the result. The existing network pins, deadlines, scalar schema and 128,000-byte
MCP result limit remain unchanged. An oversized context fails explicitly; it is
not silently truncated or retried through a different transport. MCP audit records
contain actor/session/tool/status metadata, without the context, source records,
provider errors or credentials. No task grant or model snapshot is fabricated.

The ordinary Node runner includes real HTTP/MCP tests for current reads,
revocation during I/O, changed tool definitions, identity/scope mismatches,
network/output limits and worker input/error enforcement. The real-engine
acceptance above now closes/reopens the actual Moss database and uses this MCP
worker profile against the installed compiler before capturing model requests.
Its member revocation changes the actual host database. Nexus secret values in
the credential checks remain synthetic; these checks do not establish production
Nexus/Vault connectivity, source intake, a deployed worker, WebUI or ShareOne
comment delivery. Those remain integration work.

## Production runner composition

`sessionRunnerCli` builds `createSessionRunnerHost` from the opened Moss store.
Ordinary conversations keep their existing backend. A persisted model binding
activates the existing MCP catalogue and IT reviews on the same database driver;
the factory does not construct another AuthService, policy database or Registry
task grant. Both the agent tool gateway and model context reader use the shared
current-member check, including organization membership, department visibility
and global account lock/disable. A saved admin role does not bypass visibility.

System credential definitions use the same organization-scoped resolver as the
existing agent gateway. Values are read through the existing Nexus Vault client
with `MOSS_NEXUS_MODE=external` and its deployment-owned endpoint, authentication
and mTLS settings. The runner never starts an embedded Nexus daemon and never
reads credential configuration from `manifest.session.env`. Missing external
Nexus for a `secret_ref` fails explicitly; no-auth MCP servers need no Vault
connection. Runner shutdown and failed startup release the owned client.

HTTP/MCP tests exercise this production factory without injecting authorization
or context ports, including live member/account/visibility/policy revocation and
current credential resolution. Their Nexus values are synthetic; deployment
connectivity and end-user journeys still require production acceptance.

## Project-scoped conversation discovery

The existing `GET /api/v1/sessions` accepts optional `ontology_project_id` with
the same opaque UUID used at creation. The database filters through the canonical
binding before returning sessions; ordinary owner, department, organization,
active-only and source filters still apply. An unbound, deleted or reassigned
session cannot acquire project membership through client metadata.

Successful scoped replies include `ontology_project_id` after the current access
and lifecycle checks. Consumers must match that acknowledgement against their
request before using the list. An older server that ignores the query cannot be
treated as returning project-scoped history. Ordinary replies remain unchanged.

Project discovery rechecks current MCP/source access before and after the read
and rejects project lifecycle changes during it. A denied project is an error,
not an empty list or fallback to ordinary sessions. No context text, records or
parallel project/session registry is loaded to construct the result. Calls that
omit the project keep the ordinary session-list behavior. This API supports the
shared workbench; it does not establish its UI or cloud review/comment journey.

## Compiler worker executable

`bun run build:node` also builds `bin/sudograph-context-worker.mjs`. It uses the
published `@sudowork/sudograph-runtime` package, pinned by release URL and Bun lock
integrity, and the same installed Python compiler as Desktop. There is no second
compiler subprocess implementation or copied model in Moss.

An operator supplies a deployment-owned configuration file, for example:

```json
{
  "binding": {
    "authorityRef": "sales-project",
    "modelRef": "sales-model",
    "sourceRefs": ["registered-sales-source"]
  },
  "runtime": {
    "python": "/opt/sudograph/bin/python",
    "compilerRoot": "/srv/sudograph/worker",
    "modelDirectory": "/srv/sudograph/models"
  },
  "actor": "sales-model-worker",
  "host": "127.0.0.1",
  "port": 9041
}
```

The runtime must already contain the installed compiler and canonical registered
model. Inject `SUDOGRAPH_WORKER_TOKEN` from the deployment's secret manager; it is
required, contains 32-512 printable ASCII characters, and is not stored in that
configuration. Start the worker with:

```sh
node bin/sudograph-context-worker.mjs /etc/sudograph/worker.json
```

Register its exact `/mcp` endpoint in the existing Moss MCP catalogue, approve its
read-only descriptor through the existing IT tool review, and reference the same
credential using an organization-scoped system `secret_ref`. Remote deployment
owns the authenticated network route/TLS and Nexus secret injection. The worker
does not start Nexus or publish itself into the catalogue. Default binding is
loopback; a zero port is available for isolated acceptance. Readiness reports the
listening port only; it does not claim source registration or complete coverage.

The endpoint requires authentication before MCP handling, rejects browser origins
and alternate paths, and exposes only the empty-argument context tool. Model,
actor, paths and policy cannot be selected by a request. Canonical reads execute
through the published client on every call; compiler errors are sanitized by the
shared worker contract. Configuration is copied at server creation.

The maintained acceptance driver accepts `--worker bin/sudograph-context-worker.mjs`
to launch that actual packaged process with an isolated deployment file and
process-owned credential. It registers and modifies the canonical model through
the published SDK, then verifies the production runner/HTTP/MCP/engine chain.
This remains fixture acceptance, not production worker rollout, source intake,
Nexus mailbox transport or ShareOne comment delivery.
