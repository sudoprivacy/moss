# Independent HTTP agent test deployment

This process owns its database and uses either a configured SudoRouter endpoint or an existing Nexus model mount. It does not execute through Dify or a Moss process. The current admission boundary remains synthetic text, with no tools, attachments or customer data.

## Build and configure

From a committed Moss checkout, install the locked dependencies, then run:

```sh
bun run scripts/build-http-agent-provider.ts
node scripts/http-agent-artifact.mjs --directory dist/http-agent-provider --revision <full-source-sha>
docker build -f deploy/http-agent-provider/Dockerfile --build-arg SOURCE_REVISION=<full-source-sha> -t sudo-http-agent:<artifact-tag> .
```

Select the full source SHA from the candidate release lock. The build refuses tracked edits and records the source commit/tree, dependency lock digest, Bun build environment and executable digest/size in `dist/http-agent-provider/artifact-manifest.json`. Docker checks the manifest and actual executable against the supplied SHA before producing an image and records the revision in OCI labels. A missing manifest, stale source selection or modified executable fails the build. Keep the manifest and record the resulting image ID, configuration definition and runtime manifest revision in deployment evidence. The build record provides local integrity checks; it is not a signature, remote provenance attestation, reproducible-build proof or a published release. Runtime execution revisions continue to hash the actual executable bytes and immutable definition.

Copy `compose.yaml` and `provider.example.json` to a deployment directory; rename the latter to `provider.json`. Create `data` and `secrets` owned by UID/GID 10001, mode 0700. Supply a unique random client token (at least 32 characters) in `secrets/client.token` and only the authorized SudoRouter credential in `secrets/router.json`, mode 0600. Router JSON uses the existing configuration shape `auth_modes.proxy.sudorouter` with `baseUrl` and `apiKey`. Do not copy other personal configuration or commit these files. Set `PROVIDER_IMAGE` to the artifact-specific image tag before `docker compose up -d`.

The private test endpoint is port 8093. A production deployment needs its own TLS ingress and network policy. The process has no tool runtime; its only model endpoint is the configured SudoRouter allowlist. This is not a general DLP or downstream model compliance guarantee.

### Model request network boundary

The provider's default executor uses a native HTTP transport bound to its configured Router `/chat/completions` URL. It does not use environment proxies, reuse connections or follow redirects. HTTPS verifies the certificate chain and original hostname with TLS 1.2 or later. Each model request resolves the hostname again, checks **all** returned addresses, and pins the actual connection to one checked address without a second OS lookup.

Without `router_allowed_addresses`, DNS names require HTTPS and public unicast IPs. A private HTTPS Router requires an operator-reviewed exact-IP list in `provider.json`, for example `"router_allowed_addresses": ["10.0.1.158"]`; this list applies to the one Router endpoint whose credentials and definitions were already matched at startup. An optional list also pins a public Router to specific addresses. CIDRs, hostnames, empty lists, metadata/link-local, multicast and IPv4-mapped/translation addresses are rejected. Every DNS answer must match the list. Changes to DNS outside it fail closed until the operator reviews the deployment policy. Invocation input cannot change these pins.

Explicit literal-IP HTTP endpoints remain supported for the existing synthetic LAN test profile, without a TLS claim. They cannot target metadata/link-local, unspecified or multicast ranges. This does not expand Moss's existing fixed-IP `/v1` registration policy or enable Internal data. TLS/domain support described here is for **Provider → Router**, not a new Moss → Dify endpoint profile.

DNS/policy refusal before HTTP dispatch persists `MODEL_EGRESS_DENIED` or `MODEL_EGRESS_UNAVAILABLE` as a failed run. Repeating the invocation returns that same run without retrying. A redirect or transport interruption after the POST may have reached the Router stays unknown; no automatic follow-up request is made. Errors omit upstream response bodies, credentials and raw DNS/TLS diagnostics. Response size remains bounded at 2 MiB.

This is the network part of G04. Nexus content classification/redaction, invocation-bound delegation, durable policy/audit evidence and G03 network enforcement against a compromised provider are still pending. Do not interpret these network checks as completed content governance or bypass prevention. Current data admission remains synthetic-only.

## Execute through an existing Nexus model mount

Use `provider.nexus.example.json` instead of the direct-Router example. A deployment chooses exactly one transport. Nexus mode refuses `router_config_file`, `allowed_router_endpoints` and `router_allowed_addresses`; the Provider neither reads a Router key nor falls back to direct HTTP. The model mount's sending daemon owns the upstream endpoint, credentials, content hook and network policy. The direct transport's DNS/IP protections are not automatically protections on that daemon.

The immutable definition includes `nexus_endpoint` and `model_mount` in place of `router_endpoint`. Endpoint/mount, model, prompt and artifact bytes participate in the execution revision. A mutable mount or upstream model remains an operational dependency: this does not freeze mount configuration or model weights. HTTPS endpoint spelling and mTLS CA/client certificate/key are required. TLS material is read at startup; credential rotation currently requires a controlled restart. Supply a deployment identity authorized only for the intended model paths. A node administrator certificate used by a local test is not a production delegation solution.

Execution uses the existing Nexus `llm_mount` HTTP exchange v1: one `.prompt` write containing `nexus_http.path=chat/completions`, followed by offset reads from its `.reply`. Response bodies have Nexus's zero-byte tag and cannot impersonate `done`/`error` control frames. Every run has a path derived from its durable client/run IDs, bounded request/reply sizes and its own cancellable channel. Rewriting the same prompt would call the model again, so the Provider never retries a write or reclaims an uncertain run. Missing replies are polled; expired/lost/invalid observations remain unknown.

Current Nexus in-band failures and error frames do not provide a stable pre-dispatch policy receipt. This consumer deliberately does not classify free-text diagnostics as proof of no execution. Even an observed gate rejection therefore remains `MODEL_EXECUTION_UNCONFIRMED`/unknown locally; the operator uses existing reconciliation. A structured refusal receipt and per-user delegation belong to the remaining G01/G02 work. Raw kernel errors and upstream response bodies are not returned or persisted as error text.

An allowlisted mount name is **not** evidence that the content gate is enabled. The sending daemon must include `driver-ai,egress-gate-presidio`, select this mount in `NEXUS_EGRESS_GATE_MODEL_MOUNTS`, and run the shared policy/analyzer with deny-on-failure. `observe` is not a confidentiality guarantee. Reuse [the shared composition](https://github.com/sudoprivacy/sudostack/blob/261c228188ad4eb8f84e4931dfa84b8d98ddfcda/security/egress-gate/COMPOSITION.md) and the [owner's detection matrix](https://s.shareone.vip/md/egress-gate).

This increment governs **Provider → Nexus → model** only. The earlier **Moss → Provider/Dify** hop, caller-bound authorization/policy receipts, end-user billing identity, network restrictions against a compromised process, and general A2A/artifact inspection remain separate work. Existing synthetic-only admission is unchanged; no capability or production readiness flag is promoted by selecting this transport.

### Reproduce the isolated acceptance

After building the Provider, run from the Moss repository:

```sh
NEXUS_MODEL_TEST_BIN=/absolute/path/to/nexusd-cohost \
HTTP_AGENT_TEST_ARTIFACT=/absolute/path/to/http-agent-provider.mjs \
node scripts/e2e/http-agent-nexus-live.mjs
```

The runner starts only owned loopback processes with isolated data/identities, mTLS, a real Kernel hook and a countable synthetic HTTP model. It mounts the connector in the daemon's existing Zone; it does not create a parallel Zone/delegation model. It checks clean/deny/redact/analyzer-outage, original Provider request retention, and restart/idempotent replay without additional model writes. It stops its processes and removes lab TLS keys/tokens, retaining synthetic diagnostics and executable digests. The node credential is fixture setup, not evidence of a user-scoped grant. A daemon without `openai` support must fail acceptance, not skip the test.

The observed wire is from `nexus-vfs` v0.8.22 (`c7489d3b772602d91106e8d6f65c8758e9479040`), `rust/llm_mount/src/lib.rs`, `rust/backends/src/transports/api/ai/http_exchange.rs`, and `rust/transport/src/grpc.rs`, consumed through the existing official Node SDK 0.7.4. This uses owner implementation contracts; it introduces no new purportedly stable cross-repository contract family. Changes to that wire require the acceptance above.

## Register and use

Retrieve the authenticated `GET /v1/agents/review-assistant/manifest`. In Moss, open 智能体管理 → 专属智能体 → 外部托管 → 接入外部智能体, select Custom HTTP, upload that manifest, use the `/v1` endpoint and the **client token**, authorize users, then test and approve. The SudoRouter model key stays at the selected execution boundary: the Provider in direct mode, or the Nexus mount in Nexus mode.

Moss creates an immutable release from the approved candidate. Publish an explicit version label, point stable/canary at it, and roll a channel back by selecting a previous non-revoked version. The user chooses a version/channel when creating a conversation in SudoWork. Existing conversations retain their selected version. Task evidence distinguishes the accepted selection from the actual provider execution revision.

## Upgrade, retention and restore

An execution revision hashes the actual executable bytes and its immutable definition, including prompt, model identifier and endpoint. It does not freeze upstream model weights. Changing executable bytes creates new revisions even for the same prompt. Keep old provider instances and definitions available while their releases remain authorized or conversations still require them; an unavailable revision is refused rather than silently replaced. Multiple configuration revisions can coexist in one process only when they share the same executable artifact. A newer executable cannot run an older artifact revision; retain the old immutable image at its recorded endpoint (or use a revision-aware gateway). This example deployment does not include that gateway or an automatic artifact upgrade controller.

SQLite deployments have one writable database volume and are not a multi-host HA configuration. Back up only after stopping the provider (include database and WAL files), along with its immutable artifact/configuration and separately protected credentials. Restore into an isolated deployment and verify retained run IDs/idempotency before reopening traffic. Never run old and restored copies concurrently. A restore returns to the backup point and does not preserve runs accepted afterward. Keep admission closed while preserving and reconciling any post-backup Moss Tasks, provider runs and idempotency reservations; a missing restored row is not proof that the original remote execution never happened. Do not reopen an old snapshot as an automatic recovery mechanism. For multiple provider replicas, replace `database_file` with `database_url_file` pointing to a PostgreSQL connection string secret; replicas share the same database and independently claim runs. PostgreSQL failover/backups remain the operator's infrastructure responsibility.

Completed run payloads expire after 30 days; retained idempotency tombstones prevent reruns. Unknown outcomes are retained for reconciliation and remain locked. A capacity ceiling bounds stored rows; reaching it rejects new runs without deleting unknown evidence. No cancelled or lost observation is represented as confirmed model cancellation.

## Moss Pilot migration

Ordinary Moss startup never migrates legacy Pilot tasks. If legacy task tables exist without the canonical migration marker, startup refuses with `EXTERNAL_TASK_MIGRATION_REQUIRED`, including when those tables are empty. Use the [explicit task migration command](../../docs/external-task-migration.md): stop all old and new writers, isolate database access, take and verify a protected backup, execute the command once, then inspect its receipt and the database before starting the new service.

Only that maintenance command transactionally copies and verifies `external_pilot_sessions/tasks/attempts/events`, clears copied payloads, and fences legacy writers. It is not an old/new binary rolling upgrade. On failure, its transaction rolls back and the old facts remain. Before admitting any new traffic after cutover, rollback can restore the pre-cutover backup with all new writers stopped. This returns to the backup point. If new Tasks have already been accepted, first preserve and reconcile their Task/Attempt/provider-run and idempotency facts and design a separate recovery procedure; blindly restoring the old snapshot would lose those facts while the independent provider may have continued executing. Starting the old binary against the migrated database is unsupported. Registry enrollment is a separate, additive [publication migration](../../docs/product-agent-registry.md); it does not replace the canonical task migration.

Moss owner loss waits for the 30-second database lease before another controller takes over. Durable HTTP resumes observation of the same invocation. Dify and legacy HTTP have no query/replay guarantee and remain unknown when prior execution is uncertain. Do not automatically resend them.
