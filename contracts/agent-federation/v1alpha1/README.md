# Agent federation adapter baseline

Status: experimental implementation baseline. ADR-003 and ADR-004 remain Proposed. Moss owns the editable JSON Schema and TypeScript boundary; SudoStack distributes exact pinned artifacts. This family does not claim `agent.sudo.dev/v1` or `task.sudo.dev/v1` stability.

## Implemented boundary

- `CustomAgentManifest` is inert source metadata. It contains no executable source, endpoint, credential or owner/Zone override. Import is bounded to 64 KiB of JSON and rejects unknown fields. Its normalized digest includes all accepted fields, is insensitive to object key ordering, and does not attest to the remote executed version.
- `ProviderCapabilities` states adapter capabilities. The legacy HTTP v1alpha1 profile requires every flag to be false; Dify additionally supports streaming. Durable HTTP v1alpha2 has a fixed profile enabling idempotency, query-only resume and version pinning. An uploaded manifest cannot invent capabilities outside its implemented profile.
- `InvokeHttpAgent` / `HttpAgentResult` are a distinct self-hosted HTTP protocol. They are not LangGraph, Coze, OpenOcta, OpenAI Chat Completions or an arbitrary configurable URL. Only implemented adapter kinds can be resolved.
- `ProviderObservation` preserves Sudo task/attempt/session correlation, adapter version, local observation time and a monotonic sequence per invocation. `output_snapshot` is a replaceable partial answer, not an append delta; HTTP emits a single terminal observation and does not synthesize streaming.
- `ExternalRunBinding` records the actual remote run handle separately from Sudo IDs. Its external_agent_id is a claimed application identity, with source_identity_evidence=unverified on new rows; neither it nor missing evidence on historical rows proves the API key belongs to that App/Workspace. Dify/legacy HTTP use `version_evidence=source_snapshot_only`; durable HTTP results use `provider_revision_fenced` and query-only resume. Partial observability remains explicit. Dify uses `workflow_run_id` with a `task_id` fallback; supplemental provider IDs retain their original names through the compatibility adapter.

## Legacy HTTP service profile

The administrator-selected endpoint is separate from the manifest. The initial synthetic profile retains the existing fixed-IP `/v1` allowlist and forbids redirects. It does not enable production domain routing or assert downstream egress control.

1. `GET {endpoint}/agents/{external_agent_id}/manifest` with bearer authentication returns the full JSON manifest. Its digest must match the approved snapshot before dispatch.
2. The caller durably reserves dispatch and rechecks governance through `authorize_dispatch`. An exception or expired deadline prevents invocation.
3. `POST {endpoint}/invoke` sends `InvokeHttpAgent`. `invocation_id` is the Sudo Attempt ID for correlation; the adapter does **not** interpret this as a remote idempotency guarantee.
4. Return JSON `HttpAgentResult`, echoing the invocation ID and including an actual remote run ID. Continued conversations must preserve the previously supplied remote session ID. A source change creates a review requirement; a remote response cannot change local Sudo identity.

One total deadline spans metadata and invocation. Responses are bounded to 2 MiB of raw bytes and 128,000 output characters. Failed HTTP dispatch, invalid body or missing/mismatched handles cannot establish successful completion. The caller must persist uncertainty after dispatch and must not automatically retry.

## Product integration and remaining work

The existing Dify Pilot executes through `DifyGatewayAdapter`. Successful terminal results and their canonical run binding are committed atomically in the canonical Moss Task/Session/Attempt store; `GET /api/v1/tasks/{task_id}/external-run` requires the same authenticated task ownership as task reads. Legacy tasks and unknown runs without a confirmed binding return `null`; historical evidence is not fabricated.

POST `/api/v1/tasks` now accepts the experimental `SubmitTask` envelope and persists an immutable `TaskSpec` / `TaskExecutionResolution` before execution. Legacy `CreateExternalTask` HTTP submissions now fail with `TASK_CLIENT_UPGRADE_REQUIRED`; all new execution enters the same admission. Historical tasks remain readable and have no invented specification. See [Task contract](../../task/v1alpha1/README.md).

Moss administrators can choose Custom HTTP, upload the Manifest, validate the remote source, grant users and review publication under 专属智能体 → 外部托管. Changed definitions or credentials revoke publication. SudoWork desktop/WebUI use the same directory and conversation components and the new submission envelope.

The durable HTTP provider is an independent service that calls SudoRouter and supports immutable artifact/configuration revisions. Moss persists a catalog-local Agent Principal, immutable AgentVersionManifest, approval decisions and stable/canary channels. It does not yet provide portable Nexus principal issuance or complete production governance. See the [current implementation and capability matrix](../../../docs/agent-federation-durable-provider.md) and [deployment guide](../../../deploy/http-agent-provider/README.md).

## Validation

`node --import tsx --test src/server/agentFederation/agentFederation.node-test.ts src/server/externalProviders/externalProviders.node-test.ts`

Tests validate the same schema used by the adapter and cover profile escalation, endpoint and identity checks, dispatch revocation, changed manifests, result correlation, bounded reads, uncertainty/no retries and common Dify/HTTP event/run schemas. Legacy HTTP tests use a protocol fixture. Durable provider, canonical migration, release and actual-process recovery tests are in this directory and its provider subdirectory. Real service evidence is separate from controlled executor fault tests.

## Standard HTTP profiles (2026-10-21)

The experimental manifest now also selects OpenAI Chat Completions, MCP 2025-06-18 and A2A 0.3.0 through the existing `custom_http` category. See [the supported profiles, evidence distinctions and local reference runbook](../../../docs/agent-protocol-standard.md). Earlier HTTP-only descriptions above refer to the legacy/durable HTTP profiles, not these new adapters.
