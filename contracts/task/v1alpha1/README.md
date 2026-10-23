# Experimental Product Task ingress

`task.sudo.dev/v1alpha1` implements the current external query-only profile. ADR-003/004 remain Proposed; this is not stable `task.sudo.dev/v1` acceptance. Moss is the semantic owner, Stack distributes exact committed source bytes, and Work consumes pinned artifacts.

## Submission and immutable decision

`POST /api/v1/tasks` accepts `SubmitTask`. The client selects a catalog entry and provides instruction, optional session, classification, capabilities and constraints. Legacy CreateExternalTask HTTP payloads return 409 TASK_CLIENT_UPGRADE_REQUIRED before creating any state; they are never silently classified as synthetic. Server-owned task/attempt IDs, requested_by, policy decision and resolved binding cannot be supplied by the caller. Unknown fields and versions fail before persistence. Identity derives from authenticated Moss context.

The server creates TaskSpec, Resolution, policy snapshot, task, session update, first event and (only for acceptance) Attempt in one database transaction before Provider I/O. The idempotency key is scoped to organization/user; the canonical full submission hash detects changed bodies. Retrying the exact request returns the original task, including rejected requests. Neither ambiguous responses nor unknown remote outcomes trigger automatic replay.

`GET /api/v1/tasks/{id}/specification` returns TaskRecord to its owner. Old compatibility tasks return null. Read validation checks the schema, owner ResourceRef validator, timestamp and spec/resolution correlation. Task history includes the immutable admission decision. A revocation after admission fails that Attempt; it does not rewrite the earlier accepted Resolution.

## Honest resolution boundaries

- AgentPrincipalRef is currently a Moss-local catalog identity (`moss.local`, `external-{catalog UUID}`). It is not a registered, portable Nexus Principal. Cross-deployment identity and registry migration remain separate work.
- Accepted resolution names `external_hosted` and `external_provider`, with `governance_org_id`. It does not invent a Nexus execution Zone or claim a Sudo local/cloud runtime is executing the remote agent.
- Source identity is explicitly `unverified`. Claimed App/Workspace IDs and the reviewed definition are not proof that the API key selects that identity. New resolutions and policy snapshots record this evidence and the claimed IDs. Tasks requiring `verified_source_identity` receive a persisted `SOURCE_IDENTITY_UNVERIFIED` rejection before credentials or Provider I/O. Historical missing evidence also never means verified.
- Version resolves an immutable approved release, explicitly or through stable/canary. Resolution records release/source digest and, for channel selection, the channel revision. Existing sessions retain their first accepted version. Dify/legacy HTTP remain `source_snapshot_only`; durable HTTP names an expected execution revision, with actual result evidence recorded separately. A release label alone never proves remote execution.
- Only synthetic, text-only requests with auto/cloud placement are accepted. Resources, workspace transfer, enforced cost budget, multi-attempt retry, unsupported capabilities and output verification produce persisted rejections. Timeout/deadline restrict dispatch and waiting; they cannot cancel an already running remote task.
- ResourceRef TypeScript and runtime validation use the existing exact-pinned `@sudo/contracts/common/v1/resource-ref` owner implementation. This Task JSON Schema only provides structural ResourceRef slots; complete conformance requires the owner validator, as the Moss ingress/read path does. Do not advertise this schema alone as a standalone ResourceRef validator.
- Execution facts use canonical Moss tasks/sessions/session_attempts/server_instances/session_events through DbDriver (SQLite/PostgreSQL); TaskSpec/Resolution is an adjunct record. This does not claim completion of Nexus Product Task APIs. There is one accepted resolution per task; native placement and multi-attempt replanning are not implemented. See the [current ownership and migration behavior](../../../docs/agent-federation-durable-provider.md).

## Compatibility and rollout

The API response uses the alpha5 ExternalTask projection, containing task_contract_version and policy_decision. Existing event cursor/raw-output behavior is unchanged. Work uses SubmitTask on its shared client; it never automatically retries with the legacy payload. Deploy the new Moss ingress before the updated Work client. Stack stable package exports are unchanged; Task artifacts remain experimental.

## Validation

Run `node --import tsx --test src/server/agentFederation/taskIngress.node-test.ts src/server/catalog/catalogSchema.node-test.ts`. PostgreSQL cases run in `src/server/externalProviders/externalProviders.pg-test.ts` with `MOSS_PG_TEST_URL`. Full server, real independent Provider and browser evidence belongs in the delivery report; controlled fault-test executors are distinguished from actual SudoRouter model calls.

New tasks carry a durable session_sequence assigned while the session row is locked. History orders by this creation sequence, not deadline or clock time. Legacy tasks remain before sequenced tasks and sort by their existing created_at and ID; their original order cannot be reconstructed for tied timestamps. Data classification is a request assertion, not DLP or an automatic sensitive-content detector.

## Internal hosted profile

`internal_hosted` / `hosted_artifact` is a separate accepted-resolution branch.
It pins catalog/asset/artifact identity, inventory metadata digest, exact artifact
specification digest, Docker image content ID, dependency lock and runner profile.
The Registry signature evidence is mandatory, and the published specification
must be the same digest as the evaluated artifact. No Provider endpoint, API key,
binding ID, provider kind or remote-version claim belongs in this branch.
`immutable_hosted_artifact` names the imported artifact, not an immutable version
of the original Dify service or proof of source-account identity.

This branch remains experimental. Its schema is a record-validation boundary;
it never grants L2 or permission to execute. Runtime admission must independently
validate current inventory acceptance, signed approval, exact artifact, user
access, IAM run grant and fresh authorization before side effects. Hosted Task
submission/dispatch and Work integration are tracked separately from this schema
preparation. Roll out controller runtime filters before enabling hosted writes.

Internal hosted executions also pin `runtime_authority_id`, the SHA-256 identity
of the Docker daemon verified by the trusted supervisor. Recovery on a different
runtime cannot confirm removal of the old worker. `HostedAgent`, `HostedSession`
and `HostedEventsPage` describe the product directory/history projections for
this runtime. Cancellation is a request until worker, IAM and Router cleanup are
confirmed; recovery cannot turn unknown output into success.

## Hosted task evidence (read only)

`GET /api/v1/tasks/{id}/evidence?cursor=0` returns `HostedTaskEvidence` to the active task owner, even if the directory entry is subsequently disabled. It does not publish, reauthorize a run, rotate credentials, reconcile, or contact Router. The fixed release comes from the persisted admission decision. Trace is paged in at most 100 entries, bounded by the response's task sequence, and labelled `worker_reported`; it is not an independent attestation. Re-fetch from cursor 0 for a fresh projection. Concurrent execution may add ledger facts after the captured task sequence; this is a read model, not a cross-authority atomic snapshot.

Usage explicitly states `sudorouter` authority and `router_quota` units, not monetary cost. Only verified ledger entries contribute to verified subtotals; they are deduplicated by Router account plus ledger ID and checked against the call's token, model, organization, task, artifact and mode. Conflicting duplicates fail closed. Pending/unknown calls or an unfinished task never imply final zero usage. No model answer, request body, raw Router credential/token, grant credential, private resource or full event task snapshot appears in this projection. Platform/department reporting remains a separate aggregation capability.
