# Experimental Product Task ingress

`task.sudo.dev/v1alpha1` implements the current external query-only profile. ADR-003/004 remain Proposed; this is not stable `task.sudo.dev/v1` acceptance. Moss is the semantic owner, Stack distributes exact committed source bytes, and Work consumes pinned artifacts.

## Submission and immutable decision

`POST /api/v1/tasks` accepts `SubmitTask`. The client selects a catalog entry and provides instruction, optional session, classification, capabilities and constraints. Server-owned task/attempt IDs, requested_by, policy decision and resolved binding cannot be supplied by the caller. Unknown fields and versions fail before persistence. Identity derives from authenticated Moss context.

The server creates TaskSpec, Resolution, policy snapshot, task, session update, first event and (only for acceptance) Attempt in one database transaction before Provider I/O. The idempotency key is scoped to organization/user; the canonical full submission hash detects changed bodies. Retrying the exact request returns the original task, including rejected requests. Neither ambiguous responses nor unknown remote outcomes trigger automatic replay.

`GET /api/v1/tasks/{id}/specification` returns TaskRecord to its owner. Old compatibility tasks return null. Read validation checks the schema, owner ResourceRef validator, timestamp and spec/resolution correlation. Task history includes the immutable admission decision. A revocation after admission fails that Attempt; it does not rewrite the earlier accepted Resolution.

## Honest resolution boundaries

- AgentPrincipalRef is currently a Moss-local catalog identity (`moss.local`, `external-{catalog UUID}`). It is not a registered, portable Nexus Principal. Cross-deployment identity and registry migration remain separate work.
- Accepted resolution names `external_hosted` and `external_provider`, with `governance_org_id`. It does not invent a Nexus execution Zone or claim a Sudo local/cloud runtime is executing the remote agent.
- Version is `snapshot-{source digest}`, with `version_evidence=source_snapshot_only`. This identifies the reviewed source; it is not proof of an immutable remote release. Explicit mismatched versions and all requested channels are rejected.
- Only synthetic, text-only requests with auto/cloud placement are accepted. Resources, workspace transfer, enforced cost budget, multi-attempt retry, unsupported capabilities and output verification produce persisted rejections. Timeout/deadline restrict dispatch and waiting; they cannot cancel an already running remote task.
- ResourceRef TypeScript and runtime validation use the existing exact-pinned `@sudo/contracts/common/v1/resource-ref` owner implementation. This Task JSON Schema only provides structural ResourceRef slots; complete conformance requires the owner validator, as the Moss ingress/read path does. Do not advertise this schema alone as a standalone ResourceRef validator.
- Storage is the current Moss DbDriver (SQLite/PostgreSQL), not completion of the proposed canonical Nexus Product Task persistence layer. There is one accepted resolution per task; native runtime placement and richer attempts/replanning are not implemented by this profile.

## Compatibility and rollout

The API response remains the additive alpha4 ExternalTask projection, containing task_contract_version and policy_decision. Existing event cursor/raw-output behavior is unchanged. Work uses SubmitTask on its shared client; it never automatically retries with the legacy payload. Deploy the new Moss ingress before the updated Work client. Stack stable package exports are unchanged; Task artifacts remain experimental.

## Validation

Run `node --import tsx --test src/server/agentFederation/taskIngress.node-test.ts src/server/catalog/catalogSchema.node-test.ts`. PostgreSQL cases run in `src/server/externalProviders/externalProviders.pg-test.ts` with `MOSS_PG_TEST_URL`. Full server and browser evidence belongs in the delivery report; local HTTP fixtures are not real second-provider acceptance.
