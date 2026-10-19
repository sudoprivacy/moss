# Independent HTTP agent test deployment

This process owns its database and calls a configured SudoRouter model directly. It does not execute through Dify or a Moss process. The current admission boundary remains synthetic text, with no tools, attachments or customer data.

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

## Register and use

Retrieve the authenticated `GET /v1/agents/review-assistant/manifest`. In Moss, open 智能体管理 → 专属智能体 → 外部托管 → 接入外部智能体, select Custom HTTP, upload that manifest, use the `/v1` endpoint and the **client token**, authorize users, then test and approve. The SudoRouter model key remains only at the provider.

Moss creates an immutable release from the approved candidate. Publish an explicit version label, point stable/canary at it, and roll a channel back by selecting a previous non-revoked version. The user chooses a version/channel when creating a conversation in SudoWork. Existing conversations retain their selected version. Task evidence distinguishes the accepted selection from the actual provider execution revision.

## Upgrade, retention and restore

An execution revision hashes the actual executable bytes and its immutable definition, including prompt, model identifier and endpoint. It does not freeze upstream model weights. Changing executable bytes creates new revisions even for the same prompt. Keep old provider instances and definitions available while their releases remain authorized or conversations still require them; an unavailable revision is refused rather than silently replaced. Multiple configuration revisions can coexist in one process only when they share the same executable artifact. A newer executable cannot run an older artifact revision; retain the old immutable image at its recorded endpoint (or use a revision-aware gateway). This example deployment does not include that gateway or an automatic artifact upgrade controller.

SQLite deployments have one writable database volume and are not a multi-host HA configuration. Back up only after stopping the provider (include database and WAL files), along with its immutable artifact/configuration and separately protected credentials. Restore into an isolated deployment and verify retained run IDs/idempotency before reopening traffic. Never run old and restored copies concurrently. A restore returns to the backup point and does not preserve runs accepted afterward. Keep admission closed while preserving and reconciling any post-backup Moss Tasks, provider runs and idempotency reservations; a missing restored row is not proof that the original remote execution never happened. Do not reopen an old snapshot as an automatic recovery mechanism. For multiple provider replicas, replace `database_file` with `database_url_file` pointing to a PostgreSQL connection string secret; replicas share the same database and independently claim runs. PostgreSQL failover/backups remain the operator's infrastructure responsibility.

Completed run payloads expire after 30 days; retained idempotency tombstones prevent reruns. Unknown outcomes are retained for reconciliation and remain locked. A capacity ceiling bounds stored rows; reaching it rejects new runs without deleting unknown evidence. No cancelled or lost observation is represented as confirmed model cancellation.

## Moss Pilot migration

Ordinary Moss startup never migrates legacy Pilot tasks. If legacy task tables exist without the canonical migration marker, startup refuses with `EXTERNAL_TASK_MIGRATION_REQUIRED`, including when those tables are empty. Use the [explicit task migration command](../../docs/external-task-migration.md): stop all old and new writers, isolate database access, take and verify a protected backup, execute the command once, then inspect its receipt and the database before starting the new service.

Only that maintenance command transactionally copies and verifies `external_pilot_sessions/tasks/attempts/events`, clears copied payloads, and fences legacy writers. It is not an old/new binary rolling upgrade. On failure, its transaction rolls back and the old facts remain. Before admitting any new traffic after cutover, rollback can restore the pre-cutover backup with all new writers stopped. This returns to the backup point. If new Tasks have already been accepted, first preserve and reconcile their Task/Attempt/provider-run and idempotency facts and design a separate recovery procedure; blindly restoring the old snapshot would lose those facts while the independent provider may have continued executing. Starting the old binary against the migrated database is unsupported. Registry enrollment is a separate, additive [publication migration](../../docs/product-agent-registry.md); it does not replace the canonical task migration.

Moss owner loss waits for the 30-second database lease before another controller takes over. Durable HTTP resumes observation of the same invocation. Dify and legacy HTTP have no query/replay guarantee and remain unknown when prior execution is uncertain. Do not automatically resend them.
