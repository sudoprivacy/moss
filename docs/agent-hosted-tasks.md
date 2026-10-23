# Internal hosted Task execution

This increment extends the experimental Task contract with an
`internal_hosted / hosted_artifact` resolution. It does not change the maturity
of the stable six contracts or assert complete Agent Management 1.1 acceptance.

## Product flow

Moss inventory → hosted artifacts → publication and authorization:

1. Enrol an internal hosted asset in the organization catalog. This creates a
   disabled entry and links its existing Registry identity; it grants no level.
2. Finish migration evaluation, runtime qualification and asset review. A valid
   L2 acceptance for the exact artifact spec is required by Nexus. L3 is blocked
   until native conversion and its runtime evidence are actually implemented.
3. Publish original artifact spec bytes as an immutable ResourceRef. Review the
   version, explicitly promote a channel, then choose authorized members.
4. Submit the formal Task through `/api/v1/tasks`. Global org/user/idempotency
   lookup precedes mutable catalog/runtime selection. Retries return the original
   accepted or rejected task; they cannot create a second execution.

The release UI lives alongside hosted artifacts. Directory records have
`providerType=moss_runtime` and `executionMode=internal_hosted`. Native template
listing/loading/download paths exclude these records. The Task user endpoints
are `/api/v1/hosted-agents`, `/api/v1/hosted-sessions` and the shared Task routes.
Work uses its shared desktop/WebUI conversation and history for these tasks.
The supported Dify and official LangGraph synthetic samples have passed source
versus hosted evaluation, separate L2 review, fixed publication, and actual Work
tasks with verified Router usage. This is sample-scoped integration evidence,
not qualification of arbitrary uploaded code or complete 1.1 acceptance.

## Execution facts and cleanup

Canonical tasks, sessions, attempts and events retain their existing owner.
The runtime-specific tables contain only session binding, attempt lease and
capacity facts. The resolution pins asset metadata, artifact spec, image,
source/dependency digests, signed Registry version and Docker daemon identity.
Each model dispatch rechecks the user, catalog permission and exact version.
The runtime receives no IAM/Router key and cannot choose its network/model path.

Each durable attempt reserves a container name once, then starts the immutable
container ID. Cleanup deletes that worker and creates an inert, never-started
closed marker with the same name. This prevents a delayed create from claiming
the name and prevents a delayed start of the removed ID from reaching the marker.
Merely observing an empty container list is not cleanup proof. Another Docker
daemon cannot confirm cleanup of the original execution.

Do not automatically prune closed markers while stale controllers/transports
might still hold commands. They consume container metadata, not a running worker
or a new image. Removal requires an explicit maintenance retention procedure
which proves no old command can arrive. No such automatic retention is enabled.

The coordinator checks worker removal, Router ledger/token cleanup and IAM revoke
independently. If any remains uncertain, the outcome remains `unknown`, preserving
partial output. Recovery performs cleanup only. Closing an unknown task requires
confirmed cleanup and an explanatory note; it does not mark success or permit
reuse of the uncertain session. The next task uses a new session.

## Deployment

`MOSS_AGENT_HOSTED_CONFIG_FILE` continues to select the trusted supervisor,
existing Nexus content path, Router resources and original baseline runtimes.
`MOSS_AGENT_HOSTED_TASKS_ENABLED=1` explicitly enables user Task execution.

Before enabling it, upgrade **all** Moss controllers sharing the canonical
Task database to a revision with runtime isolation. Old controllers do not
recognize hosted tasks. This flag is not a migration or L2 bypass. Existing
legacy external-Pilot destructive migration still requires its explicit backup
and maintenance procedure; ordinary startup does not run it.

The supported profile remains synthetic independent text turns. Attachments,
workspace inputs, arbitrary tools, automatic retry and cost-budget enforcement
are refused. User cancellation is a request until cleanup is confirmed.

## Initial task increment evidence

- Runtime owner unit/regression suite: 59 passed.
- Actual remote Docker: supervisor SIGKILL leaves a worker; exact-attempt cleanup
  removes it, stale start and delayed create fail, repeated cleanup preserves the
  same marker. This test made zero model calls and is not L2/model evidence.
- SQLite and independent PostgreSQL tests cover atomic submission, global
  idempotency, concurrent claim, stale lease, fixed session version, cancellation
  and unknown recovery. No standard multi-node HA claim follows from those tests.
- Separate controlled gateway tests cover run IAM, artifact mismatch, caller
  withdrawal, unconfirmed issuance, independent cleanup and durable trace.
- Publication tests cover read-only GET, disabled enrolment, separate review/
  promotion, authorization and stale metadata rejection.

Moss Node regression: 1,232 passed, 9 skipped (including optional PostgreSQL
checks); separately configured hosted PostgreSQL group: 11 passed, zero skipped.
Required server runners passed after restoring drain/quota guard compatibility;
the two pre-existing excluded runner tests remain excluded. Admin typecheck and
server type ratchet passed (104 existing baseline diagnostics, no increase).
Actual management UI enrollment retained L0, a disabled directory, zero member
grants and no versions; publish/open remained disabled.

These counts describe the initial task increment, before the subsequent model,
tool, suspension and Work integration checks. The current aggregate and exact
source pins belong in the final handoff; see [task context](agent-task-execution-context.md)
for the later four-protocol checks. The actual IM example is
explicitly deferred by the user because no test bot/session is available.
