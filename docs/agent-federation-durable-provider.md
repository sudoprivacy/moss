# Durable external Agent execution (2026-10-15)

This extends the synthetic external-hosted Pilot with a second real Provider, immutable execution definitions, version/channel controls and canonical Moss execution ownership. It remains an experimental profile, not production admission or complete ADR-003/004 acceptance. Earlier dated Dify review reports describe their own historical revisions.

## Product flow

Moss organization administrator → 智能体管理 → 专属智能体 → 外部托管 → 接入外部智能体. Select Dify or Custom HTTP, supply the provider connection and reviewed definition, authorize users and approve publication. Internally hosted creation remains in 内部托管. Administrators manage organization publication; the entry does not become a user's personal agent.

In **版本与频道**, publish an immutable version label from an approved candidate, select stable/canary with compare-and-swap revision checks, roll a channel back to an approved prior version, or revoke a version. Revocation is irreversible and disables every channel pointing to that version. Candidate or credential edits still require new approval. Version snapshots exclude credentials and mutable ACLs; dispatch always rechecks the current binding, access, policy and credential state.

SudoWork desktop/WebUI share **智能体库 → 专属智能体 → 外部托管** and the unified conversation page. A new conversation selects stable, canary or an explicit approved version. Existing conversations retain their first accepted version. Changing to a different version requires a new conversation, including when a previously selected channel moves. The server persists a `VERSION_CHANGE_REQUIRES_NEW_SESSION` rejection without an Attempt if a client tries to change an existing conversation's version.

**版本依据** loads evidence on demand. The selected release is admission evidence; the actual provider run/revision is separate execution evidence. The catalog's `source_digest` describes the current candidate; it is not a digest of every historical release or the current channel target. Public version options omit connection snapshots, credentials and reviewer notes.

## Contracts and capabilities

| Family | API version | Responsibility |
|---|---|---|
| Product Task | `task.sudo.dev/v1alpha1` | SubmitTask → immutable TaskSpec/Resolution → accepted Attempt; rejected requests have no Attempt |
| Federation | `agent-federation.sudo.dev/v1alpha1` | Manifest, immutable release, channel, capability and remote-run evidence |
| Durable HTTP | `agent-http.sudo.dev/v1alpha2` | Authenticated manifest, idempotent submission and run lookup |
| Client projection | `external-provider.sudo.dev/v1alpha5` | Directory, history, events and task evidence |

Moss owns the editable schema/types; Stack generates exact committed bytes; Work pins the exact Stack artifacts and Moss source lock. These experimental artifacts do not change Stack's stable exports. The same adapter registry selects admission capabilities and execution implementations; unsupported provider kinds fail explicitly.

| Capability | Dify | Legacy HTTP v1alpha1 | Durable HTTP v1alpha2 |
|---|---|---|---|
| Real service in this delivery | Existing Dify Chatflow | Protocol fixture only | Independent deployed process calling SudoRouter |
| Streaming | Upstream stream normalized to cursor events | No | No; bounded polling |
| Remote idempotency | Unsupported | Unsupported | Invocation ID + complete request digest |
| Resume after Moss owner loss | Unknown; no automatic resend | Unknown; no automatic resend | Query same run; missing run may receive the identical idempotent body only when no known remote handle exists |
| Immutable remote execution | Source snapshot only | Source snapshot only | Bundled executable digest + immutable definition, checked in request/result |
| Cancel | Unsupported | Unsupported | Public capability remains unsupported; private API can cancel accepted, undispatched runs only |
| Callbacks, tool trace, human approval | Unsupported | Unsupported | Unsupported |

The new provider does not emulate LangGraph, Coze or OpenOcta APIs. Those require their own actual adapters and acceptance environments. It uses a deployment-authorized SudoRouter model endpoint; the user's model credential stays at the provider. Executable/configuration pinning does not freeze upstream model weights. Claimed source identity remains `unverified`; this implementation does not issue Nexus principal certificates or implement cross-domain ReBAC.

## Persistence and recovery

Moss's canonical `tasks`, `sessions`, `session_attempts`, `server_instances` and `session_events` hold execution facts. `product_task_records` holds immutable TaskSpec/Resolution; provider session context and attempt leases are adjuncts. Compatibility views do not duplicate identities. Native runtime listing, recovery and launch paths explicitly exclude external sessions.

Each controller lifetime has a fresh server instance ID. Each owned Attempt has a random token and a 30-second database-clock lease. Result/event writes check current Attempt, instance, token and lease. A replacement controller can resume durable HTTP observation after expiry; the previous owner cannot write. The exact invocation context, including the original null provider session ID, is persisted before dispatch. A recovered request does not reconstruct that field from later conversation state or renew its original deadline.

The provider commits dispatch intent before calling the model. A lost model result becomes unknown and is never automatically rerun. Moss recovery and provider recovery are different: a live provider can answer a new Moss observer, but a crashed provider cannot promise recovery of an in-flight upstream model response.

Pilot runtime migration is transactional: preserve IDs/request hashes/checkpoints/event bytes, verify copied facts, clear old payloads and seal old runtime tables against writes. **Stop old writers and back up before migration.** Mixed old/new writers and rolling schema rollback are unsupported. Restore the pre-cutover backup with all new writers stopped if rollback is required.

## Bounds and deployment

Existing Moss synthetic bounds remain: 100 ms minimum dispatch budget, 120-second maximum duration, 8,000-character instruction, 128,000-character answer, per-organization 10,000 total task reservations, daily event compaction, 30-day payload retention and 90-day redacted audit retention. Idempotency tombstones and unresolved unknown outcomes remain protected. Capacity exhaustion fails explicitly.

The independent Provider additionally limits 32 active requests per client, 100,000 reservations per client, 100 conversation turns, 20 recent context messages and 128,000 context characters. Completed payloads retire after 30 days; unknown runs remain locked. Maintenance uses shared database scheduling and bounded batches. These are enforced ceilings, not a production throughput/SLA claim.

See [deployment instructions](../deploy/http-agent-provider/README.md) for pinned Docker image construction, protected credentials, database choices, backup/restore and old artifact routing. SQLite is a single writable-volume deployment. Shared PostgreSQL permits application replica ownership, but this delivery does not install database HA, multi-region routing, a revision-aware upgrade gateway, or Cloud/Private/Edge production operations.

## Validation and remaining scope

Tests include SQLite and real PostgreSQL, migration rollback/order/byte preservation, two independent controller pools, a real child-process SIGKILL and real lease expiry, provider link interruption, stale-owner rejection, exact-run recovery and single model dispatch with a controlled model executor. Real service verification separately uses Dify and the deployed HTTP provider with SudoRouter, two-turn 42 → 50, provider restart/replay, version publication/canary/rollback/revocation, and user-visible execution evidence.

The browser harness runs actual admin/catalog/conversation components and authenticated transport with real Nexus/remote providers, but fixture identity/layout shells. It is not a full login/packaged Electron E2E. Logs, source revisions, image digest and current CI belong in the final review evidence package; historical reports are not current-head evidence.

Still outside this deliverable: portable Nexus Agent identity, running upstream cancellation and callbacks, Dify immutable execution support, general DLP/downstream tool/data governance, customer data admission, imported executable packages/Sudo Runtime conversion, and production infrastructure/SLA/cost acceptance. Completing these needs the relevant upstream APIs, identity/governance integration and an actual production topology and workload; merely adding configuration switches would not validate them.
