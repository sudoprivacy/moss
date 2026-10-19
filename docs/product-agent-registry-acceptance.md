# Product Agent Registry: local acceptance and deployment boundary

The experimental Registry is owned by the Nexus Python product service. Moss is its governance client and SudoWork consumes Moss's authorized version and task projections. These changes do not activate the stable `agent.sudo.dev/v1` contract or migrate native tasks.

## Required configuration

1. Build the exact Nexus, Moss, SudoStack and SudoWork source revisions recorded in the acceptance manifest. Validate the Nexus → Stack → Moss Registry artifact chain and the Moss → Stack → Work task/federation projections.
2. Initialize the Nexus Registry schema explicitly before starting the API. Configure an Ed25519 signing key, trusted public keys, authenticated service credential and operator-owned trust-domain/Zone mapping. See the Nexus owner document and [Moss integration](product-agent-registry.md).
3. Give every Moss instance a unique `MOSS_INSTANCE_ID`, including recovery processes. Configure `MOSS_AGENT_REGISTRY_CONFIG_FILE`, the Secret service and database independently. A local loopback test is not a remote production TLS configuration.
4. Retain all HTTP Provider definitions needed by existing sessions. Updating the current manifest does not retire a historical execution revision. Provider artifact/configuration digests do not freeze upstream model weights.
5. Use isolated accounts, databases and runtime directories for acceptance. Electron `app.setPath('home')` alone does not isolate modules that call Node `os.homedir()`; use an isolated OS account for release validation. A test bootstrap override is only a local harness.

## Required runtime scenarios

| Scenario | Expected result |
| --- | --- |
| Organization admin connects HTTP Provider and uploads Manifest | Connection check, grant selection and explicit review publish succeed in the existing external-hosting UI |
| Ordinary user opens catalog | Authorized organization Agent appears under exclusive/external Agents and not personal Agents |
| Real model conversation from WebUI and Electron | Replies and task evidence are visible in the shared conversation UI |
| Publish two distinct immutable versions | Different execution revisions and source digests; overwriting the first label fails |
| Canary, stable promotion and rollback | UI operations work; two concurrent commands with one revision yield one success and one CAS conflict |
| Follow-up in an old session | Original version remains pinned; a forced version switch yields a rejected task with no Attempt |
| Revoke a version | New admission is rejected before Provider invocation; historical evidence remains readable |
| Foreign organization and forged identity headers | Catalog, version and task queries remain scoped to the authenticated actor |
| Registry outage or invalid signature | Fail closed without fallback to Moss-local publication |
| Delete the local release snapshot cache | Verified Nexus ResourceRef content restores the same digest; revocation remains effective |
| Kill Moss after Provider dispatch | Recover the same invocation/run when the Provider supports querying it; do not create another model invocation |
| Kill Provider after model dispatch | Preserve unknown when no upstream result-query contract exists; idempotent retry returns the original unknown task |
| Dify baseline | Fresh published graph/features reviewed, real model response; UI states source-snapshot-only execution assurance |

The 2026-10-19 local run exercised these paths against actual services with synthetic inputs. The evidence package separately records source commits, build digests, authenticated roles, screenshots and runtime task/run correlations. Mock-based unit tests are labeled separately.

## Maintenance and recovery

Ordinary startup and version GETs never bootstrap publication or perform destructive legacy migration. Legacy enrollment requires an explicit maintenance window, a readonly plan, stopped old writers, a protected backup, source revalidation, fencing, import verification and activation. Interrupted imports remain fenced and resume idempotently. Old source/audit rows are retained; imported Channel revisions start a new Registry sequence. Historical Task evidence is not rewritten into newly signed evidence.

Never restore an old database backup over new accepted tasks without preserving Version, Channel, Task, Attempt, Provider run and idempotency facts. Revocation does not claim remote cancellation. An unknown result must be reconciled explicitly and must not be changed to success merely to close the local session.

## What this run does not establish

This is not production HA, an Internet deployment, a signed/notarized desktop installer, a multi-architecture release, content-level DLP, verified Dify app/key identity, native exact-version execution or stable contract activation. Nexus schema/store tests include SQLite and PostgreSQL; that is not database failover evidence. The local full-stack runtime used SQLite for Nexus/Moss/Provider and PostgreSQL for WebUI sessions. Production packaging, network enforcement, business data scope and operational SLOs remain separate V2 work packages.
