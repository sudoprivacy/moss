# Agent federation adapter baseline

Status: experimental implementation baseline. ADR-003 and ADR-004 remain Proposed. Moss owns the editable JSON Schema and TypeScript boundary; SudoStack distributes exact pinned artifacts. This family does not claim `agent.sudo.dev/v1` or `task.sudo.dev/v1` stability.

## Implemented boundary

- `CustomAgentManifest` is inert source metadata. It contains no executable source, endpoint, credential or owner/Zone override. Import is bounded to 64 KiB of JSON and rejects unknown fields. Its normalized digest includes all accepted fields, is insensitive to object key ordering, and does not attest to the remote executed version.
- `ProviderCapabilities` states adapter capabilities. The HTTP query-only profile requires every flag to be false; Dify additionally supports streaming. An uploaded manifest cannot enable cancellation, replay, strong version pinning, tool observation or approval callbacks.
- `InvokeHttpAgent` / `HttpAgentResult` are a distinct self-hosted HTTP protocol. They are not LangGraph, Coze, OpenOcta, OpenAI Chat Completions or an arbitrary configurable URL. Only implemented adapter kinds can be resolved.
- `ProviderObservation` preserves Sudo task/attempt/session correlation, adapter version, local observation time and a monotonic sequence per invocation. `output_snapshot` is a replaceable partial answer, not an append delta; HTTP emits a single terminal observation and does not synthesize streaming.
- `ExternalRunBinding` records the actual remote run handle separately from Sudo IDs. `version_evidence=source_snapshot_only`, partial observability and unsupported resume/replay are explicit. Dify uses `workflow_run_id` with a `task_id` fallback; supplemental provider IDs retain their original names through the compatibility adapter.

## HTTP service profile

The administrator-selected endpoint is separate from the manifest. The initial synthetic profile retains the existing fixed-IP `/v1` allowlist and forbids redirects. It does not enable production domain routing or assert downstream egress control.

1. `GET {endpoint}/agents/{external_agent_id}/manifest` with bearer authentication returns the full JSON manifest. Its digest must match the approved snapshot before dispatch.
2. The caller durably reserves dispatch and rechecks governance through `authorize_dispatch`. An exception or expired deadline prevents invocation.
3. `POST {endpoint}/invoke` sends `InvokeHttpAgent`. `invocation_id` is the Sudo Attempt ID for correlation; the adapter does **not** interpret this as a remote idempotency guarantee.
4. Return JSON `HttpAgentResult`, echoing the invocation ID and including an actual remote run ID. Continued conversations must preserve the previously supplied remote session ID. A source change creates a review requirement; a remote response cannot change local Sudo identity.

One total deadline spans metadata and invocation. Responses are bounded to 2 MiB of raw bytes and 128,000 output characters. Failed HTTP dispatch, invalid body or missing/mismatched handles cannot establish successful completion. The caller must persist uncertainty after dispatch and must not automatically retry.

## Product integration and remaining work

The existing Dify Pilot executes through `DifyGatewayAdapter`. Successful terminal results and their canonical run binding are committed atomically in the existing Pilot store; `GET /api/v1/tasks/{task_id}/external-run` requires the same authenticated task ownership as task reads. Legacy tasks and unknown runs without a confirmed binding return `null`; historical evidence is not fabricated.

POST `/api/v1/tasks` now accepts the experimental `SubmitTask` envelope and persists an immutable `TaskSpec` / `TaskExecutionResolution` before execution. The earlier `CreateExternalTask` remains an explicit compatibility ingress; historical tasks have no invented specification. See [Task contract](../../task/v1alpha1/README.md).

Moss administrators can choose Custom HTTP, upload the Manifest, validate the remote source, grant users and review publication under 专属智能体 → 外部托管. Changed definitions or credentials revoke publication. SudoWork desktop/WebUI use the same directory and conversation components and the new submission envelope.

The HTTP integration is tested with a local protocol fixture; no second real Agent platform is available. Canonical Principal Registry, immutable remote version/channel governance, Nexus canonical Task storage and production/deployment acceptance remain pending.

## Validation

`node --import tsx --test src/server/agentFederation/agentFederation.node-test.ts src/server/externalProviders/externalProviders.node-test.ts`

Tests validate the same schema used by the adapter and cover profile escalation, endpoint and identity checks, dispatch revocation, changed manifests, result correlation, bounded reads, uncertainty/no retries and common Dify/HTTP event/run schemas. The local HTTP service is a protocol fixture, not a second real Agent platform.
