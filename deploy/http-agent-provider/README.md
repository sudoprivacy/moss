# Independent HTTP agent test deployment

This process owns its database and calls a configured SudoRouter model directly. It does not execute through Dify or a Moss process. The current admission boundary remains synthetic text, with no tools, attachments or customer data.

## Build and configure

From the Moss repository root, run `bun run scripts/build-http-agent-provider.ts`, hash the generated `.mjs`, and build with `docker build -f deploy/http-agent-provider/Dockerfile -t sudo-http-agent:<artifact-tag> .`. Record the image ID, executable SHA-256, source commit, configuration definition and manifest revision in the deployment evidence.

Copy `compose.yaml` and `provider.example.json` to a deployment directory; rename the latter to `provider.json`. Create `data` and `secrets` owned by UID/GID 10001, mode 0700. Supply a unique random client token (at least 32 characters) in `secrets/client.token` and only the authorized SudoRouter credential in `secrets/router.json`, mode 0600. Router JSON uses the existing configuration shape `auth_modes.proxy.sudorouter` with `baseUrl` and `apiKey`. Do not copy other personal configuration or commit these files. Set `PROVIDER_IMAGE` to the artifact-specific image tag before `docker compose up -d`.

The private test endpoint is port 8093. A production deployment needs its own TLS ingress and network policy. The process has no tool runtime; its only model endpoint is the configured SudoRouter allowlist. This is not a general DLP or downstream model compliance guarantee.

## Register and use

Retrieve the authenticated `GET /v1/agents/review-assistant/manifest`. In Moss, open 智能体库 → 专属智能体 → 外部托管 → 接入外部智能体, select Custom HTTP, upload that manifest, use the `/v1` endpoint and the **client token**, authorize users, then test and approve. The SudoRouter model key remains only at the provider.

Moss creates an immutable release from the approved candidate. Publish an explicit version label, point stable/canary at it, and roll a channel back by selecting a previous non-revoked version. The user chooses a version/channel when creating a conversation in SudoWork. Existing conversations retain their selected version. Task evidence distinguishes the accepted selection from the actual provider execution revision.

## Upgrade, retention and restore

An execution revision hashes the actual executable bytes and its immutable definition, including prompt, model identifier and endpoint. It does not freeze upstream model weights. Changing executable bytes creates new revisions even for the same prompt. Keep old provider instances and definitions available while their releases remain authorized or conversations still require them; an unavailable revision is refused rather than silently replaced. Multiple configuration revisions can coexist in one process only when they share the same executable artifact. A newer executable cannot run an older artifact revision; retain the old immutable image at its recorded endpoint (or use a revision-aware gateway). This example deployment does not include that gateway or an automatic artifact upgrade controller.

SQLite deployments have one writable database volume and are not a multi-host HA configuration. Back up only after stopping the provider (include database and WAL files), along with its immutable artifact/configuration and separately protected credentials. Restore into an isolated deployment and verify retained run IDs/idempotency before reopening traffic. Never run old and restored copies concurrently. For multiple provider replicas, replace `database_file` with `database_url_file` pointing to a PostgreSQL connection string secret; replicas share the same database and independently claim runs. PostgreSQL failover/backups remain the operator's infrastructure responsibility.

Completed run payloads expire after 30 days; retained idempotency tombstones prevent reruns. Unknown outcomes are retained for reconciliation and remain locked. A capacity ceiling bounds stored rows; reaching it rejects new runs without deleting unknown evidence. No cancelled or lost observation is represented as confirmed model cancellation.

## Moss Pilot migration

This change transactionally adopts `external_pilot_sessions/tasks/attempts/events` into canonical `sessions/tasks/session_attempts/session_events`, verifies task and event bytes, clears copied payloads, and seals old tables against inserted/changed rows. Provider context and attempt leases are adjuncts; they are not duplicate identities. Native runtime recovery excludes external sessions.

Stop all old Moss writers and take a database backup before first startup with this schema. Use a maintenance window: the migration takes write locks and is not an old/new binary rolling upgrade. On failure, its transaction rolls back and the old facts remain. After a successful cutover, rollback requires restoring the pre-cutover backup with all new writers stopped; starting the old binary against the migrated database is unsupported.

Moss owner loss waits for the 30-second database lease before another controller takes over. Durable HTTP resumes observation of the same invocation. Dify and legacy HTTP have no query/replay guarantee and remain unknown when prior execution is uncertain. Do not automatically resend them.
