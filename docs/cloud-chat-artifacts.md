# Cloud chat artifacts and startup failures

## Scope

The artifact manifest and declaration tool in this change support the host scode backend. Docker/Kubernetes retain directory-based workspace access; the host must not inspect an independent container filesystem as though it held its outputs. This change does not migrate historical files or change billing.

## Artifact contract

A host runner snapshots regular workspace files at turn start/end, excluding symlinks, runtime metadata, dependencies and environment files. Its version1 manifest lives beside the transcript, outside the agent workspace, and is replaced atomically. Records include sessionId, turnId, relativePath, intent (final/draft/unknown), origin, SHA256 revision, size and updatedAt.

The bundled stdio MCP tool `moss_declare_artifacts` accepts `{files:[{path,intent,release?}]}`. It validates paths, existence and final JSON syntax. A declaration supplies intent; the runtime independently validates provenance and content. Existing inputs and externally replaced revisions cannot be promoted merely by a declaration. Unknown files remain accessible in the workspace.

Temporary content should be written directly into `.drafts/`. File contents do not require intent comments; JSON/CSV/binary formats must not receive them. Existing legal comments remain compatibility hints. A generated root draft stays at its original location and is projected into the draft box while later steps need it. `release:true` permits end-of-turn archival, preserving relative directories and renaming collisions. Cancellation keeps files and the manifest. Filesystem snapshots do not overwrite user files.

After finalization, a version1 `artifacts` frame is persisted in the transcript and sent before the result frame. Sudowork uses it for validated final-file cards, including history restoration. `GET /api/v1/sessions/:id/artifacts` returns the manifest under existing session authorization.

## Startup contract

Resource preflight and startup failures return a legacy-compatible `error` string plus `startup:{sessionId?,attemptId,code,isRetryable,message}`. Resource failures are actionable and nonretryable until configuration changes; runtime failures return a safe generic message. Failures for existing sessions are durable events. The read-only authorized `GET /api/v1/sessions/:id/startup` returns the latest unresolved failure; it never starts a runner. A subsequent successful attempt clears the reported failure.

## Validation (2026-09-28)

- Full `bun run test` passed: server tests plus all node groups (197+132+647 passed;7 existing skips).
- `bun run typecheck` passed the repository ratchet:104 server errors versus the existing105 baseline. This repository is not globally type-clean.
- `CI=1 bun run build:node` and changed-file ESLint passed.
- Real Sudowork desktop to host/scode0.2.11 with claude-sonnet-4-6: three independent business sessions reported the configured application role and underlying model and applied the7.5% skill fee (90.30 total). Cross-turn draft reuse produced107.50.
- JSON/CSV/PNG downloads matched server bytes. Uploaded temp_data.json was unchanged; explicitly requested generated temp_data.json was final.
- Actual cancellation preserved resume=43; next turn read it and produced a valid JSON deliverable. Released root draft was archived with a collision suffix; the historical draft remained unchanged.
- Disabled bound skill returned one actionable desktop error. Restoring it allowed a fresh attempt in the same desktop task. Failed resume persisted the same attemptId in the startup endpoint; successful resume cleared it. A principal from another organization received403 for both metadata endpoints.

No claim is made for every model's instruction compatibility, Docker/Kubernetes artifact tracking, or automatic repair of arbitrary historical formats.
