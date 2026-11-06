# Standard ACP execution in the canonical session runner

`StandardAcpBackend` adapts a host-approved ACP connection to `SessionBackend`.
It does not select provider accounts, rewrite task text, construct provider
requests or introduce another Task state machine. Protocol development and
qualification use controlled producers without any model credentials.

## Trusted composition and authority

An embedding host can supply `SessionRunnerHost.standardAcpLauncher`. Its
read-only `prepare` resolves a deployment-owned profile, native agent identity,
workspace and runtime authority. `authorize` must recheck account/pool/workspace
access; `start` launches only that deployment. User input cannot choose an
executable, environment, credential or launcher module. Optional MCP servers
and permission decisions also come from this trusted host. Unsupported scode
instructions, host context, skills and MCP settings are rejected explicitly.

The selected `standard_acp` engine and approved profile ID persist in the
existing Session record. Unknown engine values are rejected. `RuntimeBackend`
dispatches explicitly and cannot fall back to scode when a native launcher is
missing. The ordinary public `RuntimeService` currently refuses native ACP
creation and cold spawning before mutating state: production admission and
launcher composition have not yet been registered.

## History, writer and input durability

The `standard_acp_sessions` adjunct contains the official producer's session ID
and one writer claim. Task status, Attempt lifecycle, heartbeat, transcript,
event log and runner IPC remain owned by their existing canonical stores.
Claims and identity publication are fenced by owner, organization, profile,
current live Attempt and optional server-instance leaseholder. Workspace,
agent and deployment authority cannot change during recovery.

Reserve the claim before launch/open. Publish the actual native history ID
before readiness or model input. A lost first-open response stays unknown and
requires operator reconciliation; even confirmed process cleanup does not
authorize creating a replacement history. Recovery loads the exact previously
bound ID. Only positive confirmation that the physical process/Pod writer is
gone releases a claim; a signal or transport close alone is insufficient.
An obsolete writer's nonce cannot release its successor.

Explicit user input UUIDs are journaled in canonical session events before
dispatch and cannot be resubmitted, including after cold recovery. Input with
no UUID receives a generated ID; this compatibility path cannot deduplicate a
caller's independently repeated payload. The runner's `stdin_ack` means local
dispatch, not durable provider acceptance. An uncertain result is never proof
that external tool side effects did not occur. This is not an exactly-once
external-effects guarantee or a completed public Task acceptance API.

## Projection and shutdown

Literal single-text input is passed through the standard driver. Live text and
thought chunks are streamed through the existing runner; tool updates retain
their raw ACP form. Startup/load history notifications are suppressed because
the existing Moss projection is retained: full ACP history reconciliation and
tool-specific UI rendering are still future work. Moss transcript identity is
preserved independently of the official native history ID.

Cancellation is confirmed by the prompt completion, not by sending a cancel
notification. Disconnects preserve partial transcript output and an unconfirmed
event, then finalize the existing runner lifecycle. Pending turn projection is
drained before physical writer cleanup and lease release. Startup buffering and
per-turn projected output are bounded; broader flow-control/performance budgets
are not yet qualified.

## Qualification and remaining work

### Owner-authenticated Nexus launch composition

`NexusStandardAcpLauncher` is the managed-host implementation of the launch
plan. A trusted resolver supplies the approved binding, private connection and
subprocess spec. It uses the existing owner-delegated runtime connection,
`ManagedAgentClient.startSession` and `NexusAcpTransport`; provider requests,
account login and text rewriting remain outside this component. The ACP driver
owns official session/new/load; no official history ID is passed as a Nexus
native-scode resume ID. The start RPC is sent once, with no body owner override.

The product's scheduler must supply a fenced account/PVC-wide lease with live
authorization, quarantine and supervisor confirmation. This is an authority
port, not a second queue or lease database. Neither the start receipt nor a
registry `terminated`/not-found response alone proves the physical writer is
gone. The launcher keeps control-plane reads available after transport closure
and releases the lease only after the bound execution is retired and the
supervisor attests termination. Missing replies, changed identity, failed reads
and incomplete cleanup retain exclusion for operator reconciliation. Foreign
execution replies are never cancelled by this controller.

`nexusStandardAcpLauncher.node-test.ts` combines a controlled managed control
plane with actual stdio producer processes. These tests qualify the composition
and failure boundaries; they are not a live Nexus daemon, installed Claude
runtime or gVisor qualification. The production resolver, scheduler lease port
and supervisor attestation are still not registered, and public admission stays
closed. Scode transport callers retain the existing default close behavior.

`standardAcpBackend.node-test.ts` uses real stdio processes and runner sockets;
`standardAcpSessionBinding.node-test.ts` exercises SQLite and, when
`MOSS_PG_TEST_URL` is set, actual PostgreSQL with two independent pools. Both are
part of `npm test`. Tests cover literal input, streaming, cancellation, exact
history recovery, foreign ownership, writer cleanup, concurrent claims, input
deduplication and unknown outcomes without a model account.

Remaining: registered production launcher/profile resolution, Task/API routing,
sudoapi admission/queue/account authority, gVisor deployment, actual authorized
A2A work, tool UI, usage attribution and end-to-end performance/cache evidence.
No account selection is needed to develop these protocol and hosting layers.
