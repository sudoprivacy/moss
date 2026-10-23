# Experimental Nexus product Registry consumption

Moss can use Nexus `agent-registry.sudo.dev/v1alpha1` as the sole publication authority for an external Agent. The Nexus Python product service owns Principals, signed immutable Versions, current approval/revocation decisions and CAS Channels. This is distinct from the nexus-vfs process registry. Existing ResourceRef validation is reused; no stable contract activation is implied.

## Infrastructure setup

Initialize the Nexus primary RecordStore explicitly and configure its signing key and domain-to-Zone map as documented by the Nexus owner. Normal service startup must not migrate existing publications. The Python HTTP control-plane and its real `/api/v2/files` service are required; a Rust daemon by itself does not provide this Registry API.

Set `MOSS_AGENT_REGISTRY_CONFIG_FILE` to an operator-owned JSON file:

```json
{
  "endpoint": "https://nexus.example.com",
  "tokenFile": "/run/secrets/nexus-registry-token",
  "publicKeys": ["-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"],
  "organizations": {
    "moss-organization-id": {"trustDomain": "agents.example.com", "zoneId": "organization-zone"}
  }
}
```

The token file must be owner-only (0600). The credential is a privileged Nexus service credential, never a browser token. Nexus currently implements global administrator credentials; organization administrators act through Moss's existing role and organization checks. Moss stores the actual operator with the durable command intent, independently of the Nexus service actor. A user cannot supply an endpoint, Zone, public key or service credential through Task input. Remote plaintext HTTP is refused; loopback HTTP is available for isolated development.

A new Agent registered through the existing Moss management flow is explicitly enrolled. Interrupted enrollment cannot fall back to local publication. Existing Agents keep their current local authority until the explicit maintenance procedure below. Once a Registry link exists, missing or changed infrastructure configuration fails closed; it never falls back to the local release store.

## Administrator flow and partial failures

Use 智能体管理 → 专属智能体 → 外部托管 → 接入外部智能体. Continue testing the Provider, authorizing members and reviewing its definition through the existing interface. 版本与频道 shows Registry status, signed registration evidence and stable/canary controls. Version-list GETs do not publish, approve or promote.

Publishing writes canonical execution snapshot bytes to a Zone-scoped Nexus file with create-only semantics, verifies the readback digest, and registers its ResourceRef. Nexus signs registration metadata; Moss verifies the configured public key, exact signed payload, projection, Principal/Version and resource scope. Local snapshots are immutable caches. Missing caches are restored from Nexus and digest checked; corrupt content fails closed.

Governance and remote publication are not a distributed transaction. Moss commits a durable command intent before remote mutation, uses deterministic idempotency and saves the result afterward. Network writes never occur inside a Moss database transaction. If local review succeeds but remote publication/promotion fails, the UI explicitly reports an incomplete publication. Refresh 版本与频道, then retry publication or promotion. Do not assume a failed response rolled back local review or cleared an existing Channel.

Every admission and dispatch resolves current Registry approval. Saved command acknowledgements and UI projections are not authorization caches. A revocation blocks new admission/dispatch; it does not claim to cancel an already running remote model call. Existing conversations retain the first accepted Version; changing Version requires a new conversation.

## Explicit legacy publication migration

1. Back up the Moss database and Nexus primary RecordStore using the deployment's normal backup procedure. Keep the immutable artifact data and trust configuration recoverable.
2. Inspect 版本与频道 → 检查迁移条件. Unfinished tasks and unreconciled unknown results prevent cutover. Handle existing runs before entering maintenance mode.
3. Stop **all** old publication/Task writers. Start only the new maintenance instance with `MOSS_AGENT_REGISTRY_MAINTENANCE=1` and `MOSS_AGENT_REGISTRY_BACKUP_DIR` set to a private persistent directory. The checkbox records operator confirmation; it cannot prove another process has actually stopped.
4. Recheck the plan and choose 备份记录并迁移. The exact plan digest is required. The export retains all Version snapshots, approval history and Channel events, with a 10,000-record bound per audit family. A changed plan or different existing backup aborts.
5. Cutover marks the Agent preparing, installs database fences, imports immutable snapshots/Versions and effective decisions, verifies the complete remote set, then marks the link active. Interrupted imports stay fenced and can resume with the same immutable plan. Originals are retained, never deleted.
6. Inspect the active Registry status and Channels, then stop the maintenance process and start normal new instances. Do not start an old writer or restore an old backup after new traffic has been accepted. Preserve and reconcile all newer Task/provider-run facts before designing recovery.

Legacy Version labels and snapshot digests remain identical. The publication Principal becomes the configured domain plus `external-<catalog-id>`. Historical Task evidence remains unchanged. Imported enabled Channels start a **new Registry revision sequence**, independent of legacy revisions; the export preserves the old revision/history mapping. Disabled or expired legacy Channels are not silently re-enabled. This publication migration is separate from the earlier external-Pilot Task-table migration.

## Evidence and limits

The Registry signature proves `signed_registration_only`, not Provider identity, artifact publisher authenticity, Dify immutable execution, model-weight pinning or DLP. SudoWork shows registration and remote execution evidence separately. Task policy snapshots and accepted resolutions must agree on registration evidence. Native Task execution, workspace/Skills delivery, internal customer-data admission and production HA remain separate work packages.

Source verification:

```sh
node scripts/contracts/registry-source.mjs --stack /path/to/sudostack --owner /path/to/nexus
node scripts/run-node-tests.js agentFederation externalProviders contracts
MOSS_REGISTRY_TEST_DATABASE_URL=postgresql://... node --import tsx --test src/server/agentFederation/registryReleases.node-test.ts
```

The consumer checks exact Nexus → Stack → Moss source bytes. Gateway fault tests use an explicitly labelled HTTP double; PostgreSQL tests use isolated schemas. Real Nexus HTTP/artifact/model/UI evidence must be recorded separately from these tests.
