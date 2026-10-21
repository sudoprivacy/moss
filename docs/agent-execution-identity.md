# Agent task identity and Router integration

This increment connects Nexus's experimental task IAM binding to Moss and a real SudoRouter instance. It is an implementation foundation, not completion of Agent Management 1.1.

## Ownership and identity

Nexus owns the contract, Registry/asset admission, real Agent registration and IAM delegation. SudoStack distributes exact owner artifacts. Moss verifies the generated schema, zone, task, spec digest, expiry and response identity. Browser values never grant issuer authority or specify model credentials.

Task identity has a 1–300 second lifetime and an explicit maximum model call count (default 8, hard maximum 32, further bounded by zone policy). It has no VFS grants and cannot sub-delegate. Human `initiated_by` is gateway provenance, not a claim of user IAM delegation. Reads never publish or migrate anything.

The API key is returned once and never stored in the Registry binding table. A replay cannot recover it; interrupted issuance is listed for inspection and revocation. Revocation first disables local authorization, then performs retryable IAM credential cleanup. Terminal delegation cleanup preserves completed/expired outcomes.

## Model calls and cost attribution

`ExecutionModelGateway` accepts only a configured resource, exact task/spec, a real delegated key and bounded plain-text model input. A persistent `(org, call_id)` reservation prevents a second model dispatch on retries. A primary-database counter enforces the grant's model-call cap across gateway instances sharing that database. Rejected/preparation-unknown reservations still consume the cap; it is not refunded automatically.

For each reserved call, `AgentRouterClient` issues a **real SudoRouter token** with a short expiry, one allowed model, a finite quota and no automatic group retry. It uses a dedicated console account's token API, never an arbitrary user's model key as an admin credential. The model key remains inside the gateway. It is disabled after the call. An ambiguous issuance response is recovered by the server-generated token name; no second create request or model invocation is sent.

Stored call provenance comes from the verified Nexus grant: organization, asset, task, owner, department and spec. Router's admin ledger supplies log ID, account ID, Token ID, model and quota/tokens. Every identity and time bound is checked. Missing or mismatched ledger data stays `pending`; it is not reported as zero cost. These are consumption records in Router quota units, not an invented balance or a complete refund-accounting report.

The user-facing Router `/api/log/query` response has no Token ID/log ID. Discovery and reconciliation therefore use `/api/log/` with explicit identity checks. Discovery first verifies `/api/user/self` and still labels Token callers as candidates, not verified Agent identities.

## Current scope boundary

The new direct model gateway **permits isolated evaluation mode only**. Production `run` grants are rejected with `MODEL_CONTENT_PATH_NOT_CONFIGURED` until this path is composed with the existing Nexus content-enforced model route. Existing provider→Nexus content enforcement remains unchanged. Passing IAM checks does not prove that sensitive content may leave the node.

The gateway modules are not yet registered as a user-facing production Moss task/runtime flow. Frontend controls, real Dify/LangGraph hosted execution, tool/IM paths, controlled legacy-key rotation, production cost views and full release acceptance remain work in progress. A synthetically reviewed L0 asset used by the evaluation runner is still L0 after successful execution.

## Evidence

- Nexus Registry/IAM/HTTP/inventory regression: 101 tests passed before the additional call-cap change; the call-cap/API/contract subset subsequently passed 22 tests.
- Moss transport/model gateway/discovery checks: 17 tests passed. Includes concurrent call limits, no redispatch, revocation between token issue and dispatch, ambiguous create recovery, cleanup outage, attribution tampering and rejection of production direct calls.
- Moss server type-error baseline remains 104; no baseline increase.
- Real isolated integration used Nexus Registry + AgentRegistrationService + DelegationService + DatabaseAPIKeyAuth, Moss gateway/SQLite, actual new-api `dacf5b036f0f8e366d1fe82ea1296749de07f50c`, and a real `gpt-4o-mini` upstream. The task returned `42`; a corresponding Router ledger row recorded account/Token ID and usage. The raw model key was not stored in the call record. Replay reused the call; revocation denied the next call.
- The new-api lab was built from the original feature-named worktree, with a minimal ignored dashboard placeholder. This verifies backend behavior, not a dashboard/release build. No tracked new-api source was changed.

Live evidence is kept in a protected local lab directory and is not committed with credentials. PostgreSQL/HA and full hosted-runtime acceptance have not been qualified by these SQLite and model-call checks.
