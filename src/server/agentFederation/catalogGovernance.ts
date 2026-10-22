import { randomUUID } from 'node:crypto'
import type { AgentVersionManifest } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type {
  ExternalTask,
  ExternalTaskProvenance,
} from '../../../contracts/external-provider/v1/contract.js'
import type { ProviderAdapter } from './adapter.js'
import {
  describeCapabilities,
  createRuntimeRegistry,
} from './runtimeRegistry.js'
import { isStandardProtocol } from './standardHttpAdapter.js'
import {
  AGENT_CATALOG_API,
  type CatalogSource,
  type CatalogSnapshot,
  type ImportCandidate,
  type SourceSyncResult,
  type CatalogChange,
  type CatalogRun,
  type CatalogPage,
} from '../../../contracts/agent-catalog/v1alpha1/contract.js'
import type { ExternalProviderService } from '../externalProviders/service.js'
import type { Binding, ExternalActor } from '../externalProviders/store.js'
import { parseNexusSecretRef } from '../dify/difyConnectionService.js'
import { validateCatalogDocument } from './catalogContract.js'
import { object } from '../externalProviders/administration.js'
import {
  assertPilot,
  canonicalEndpoint,
  ExternalProviderError,
} from '../externalProviders/policy.js'
import { providerDefinition } from '../externalProviders/providerDefinition.js'
import { contentDigest } from './provider/protocol.js'
import {
  ConfiguredAgentProviderAdapter,
  CATALOG_RULE_VERSION,
} from './catalogAdapter.js'
import {
  CatalogGovernanceStore,
  type CandidateRecord,
  type SourceRecord,
} from './catalogStore.js'

function fail(code: string, status = 409): never {
  throw new ExternalProviderError(status, code)
}
function note(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000)
    return fail('REVIEW_NOTE_REQUIRED', 400)
  return value.trim()
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    return fail('INVALID_REVISION', 400)
  return Number(value)
}
const errorCode = (error: unknown) =>
  error instanceof ExternalProviderError
    ? error.code
    : 'PROVIDER_PREFLIGHT_FAILED'
function differences(
  before: CatalogSnapshot | null,
  after: CatalogSnapshot,
): CatalogChange[] {
  return (Object.keys(after) as (keyof CatalogSnapshot)[])
    .filter(
      (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]),
    )
    .map((key) => ({
      field: key,
      before: before ? JSON.stringify(before[key]) : null,
      after: JSON.stringify(after[key]),
    }))
}

/** Candidate mutations lock the existing binding: the same dispatch governance linearization point. */
export class AgentCatalogGovernance {
  readonly data: CatalogGovernanceStore
  constructor(readonly service: ExternalProviderService) {
    this.data = new CatalogGovernanceStore(
      service.store.db,
      service.store.ready,
    )
  }
  get admin() {
    return this.service.administration
  }
  get db() {
    return this.data.db
  }
  async recordProvenance(
    actor: ExternalActor,
    task: ExternalTask,
    binding: Binding,
    adapter: ProviderAdapter,
    version?: string,
  ) {
    const source = await this.data.managed(actor, binding.id)
    const selected = version
      ? await this.data.version(actor, binding.id, version)
      : undefined
    const declared =
      binding.sourceManifest && !isStandardProtocol(binding.sourceManifest)
    const facts: Omit<ExternalTaskProvenance, 'recorded_at'> = {
      stage: 'dispatch_authorized',
      protocol: binding.sourceManifest?.protocol ?? 'dify/chat-messages',
      adapter_version: adapter.version,
      source_revision: declared
        ? binding.sourceManifest!.source_revision
        : null,
      revision_basis: declared ? 'provider_declared' : 'content_digest',
      source_id: source?.view.id ?? null,
      candidate_id: selected?.candidate_id ?? null,
      capabilities: describeCapabilities(binding),
      observability: 'partial',
      source_digest: binding.source_digest,
    }
    const provenance: ExternalTaskProvenance = {
      ...facts,
      recorded_at: Date.now(),
    }
    await this.db.run(
      'INSERT INTO agent_task_provenance(task_id, document) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING',
      [task.id, JSON.stringify(provenance)],
    )
    const row = await this.db.get(
      'SELECT document FROM agent_task_provenance WHERE task_id = ?',
      [task.id],
    )
    const { recorded_at: _at, ...saved } = JSON.parse(String(row?.document))
    if (contentDigest(saved) !== contentDigest(facts))
      fail('TASK_PROVENANCE_CONFLICT')
    await this.data.audit(
      actor,
      'run.dispatch_authorized',
      binding.id,
      {
        source_id: provenance.source_id,
        candidate_id: provenance.candidate_id,
        version: version ?? null,
        task_id: task.id,
      },
      `dispatch-${task.id}`,
    )
  }
  async provenance(
    actor: ExternalActor,
    taskId: string,
  ): Promise<ExternalTaskProvenance | undefined> {
    await this.service.store.task(actor, taskId)
    const row = await this.db.get(
      'SELECT document FROM agent_task_provenance WHERE task_id = ?',
      [taskId],
    )
    return row ? JSON.parse(String(row.document)) : undefined
  }
  async assertUnmanaged(actor: ExternalActor, id: string) {
    if (await this.data.managed(actor, id)) fail('CANDIDATE_WORKFLOW_REQUIRED')
  }
  async assertEnabled(actor: ExternalActor, id: string) {
    const source = await this.data.managed(actor, id)
    if (source && !source.view.enabled) fail('CATALOG_SOURCE_DISABLED')
  }
  async assertVersion(actor: ExternalActor, id: string, version: string) {
    const source = await this.data.managed(actor, id)
    if (!source) return
    if (!source.view.enabled) fail('CATALOG_SOURCE_DISABLED')
    const record = await this.data.version(actor, id, version)
    if (!record || record.lifecycle !== 'published')
      fail('CATALOG_VERSION_NOT_ACTIVE')
  }
  async attach(actor: ExternalActor, input: unknown): Promise<CatalogSource> {
    const body = object(input, ['catalog_id', 'revision', 'source_definition'])
    if (typeof body.catalog_id !== 'string')
      return fail('INVALID_CATALOG_ID', 400)
    await this.service.authorize(actor)
    const binding = await this.service.store.binding(actor, body.catalog_id)
    if ((binding.revision ?? 1) !== revision(body.revision) || binding.archived)
      fail('CONFIGURATION_CHANGED')
    const existing = await this.data.managed(actor, binding.id)
    if (existing) return existing.view
    const definition =
      body.source_definition === undefined
        ? binding.sourceManifest
          ? JSON.stringify(binding.sourceManifest)
          : null
        : String(body.source_definition)
    if (definition !== null)
      providerDefinition(binding.provider_kind, definition, binding.app_id)
    // Explicit adoption preserves existing release IDs, even when their old provenance is incomplete.
    const versions: AgentVersionManifest[] = []
    let after = ''
    for (let i = 0; i < 200; i++) {
      const page = await this.service.releases.list(actor, binding.id, after)
      versions.push(...page.items)
      if (!page.next_cursor) break
      after = page.next_cursor
      if (i === 199) fail('CATALOG_ADOPTION_TOO_LARGE')
    }
    return this.db.transaction(async () => {
      await this.data.lock(actor, binding.id)
      if (
        JSON.stringify(await this.service.store.binding(actor, binding.id)) !==
        JSON.stringify(binding)
      )
        fail('CONFIGURATION_CHANGED')
      const duplicate = await this.data.managed(actor, binding.id)
      if (duplicate) return duplicate.view
      const at = Date.now(),
        id = randomUUID()
      const view: CatalogSource = {
        api_version: AGENT_CATALOG_API,
        id,
        catalog_id: binding.id,
        org_id: actor.orgId,
        zone_id: null,
        owner_id: actor.userId,
        allowed_user_ids: binding.allowed_user_ids,
        review_note: binding.review_note,
        name: binding.name,
        provider: binding.provider_kind ?? 'dify',
        protocol: binding.sourceManifest?.protocol ?? 'dify/chat-messages',
        external_agent_id: binding.app_id,
        endpoint: binding.endpoint,
        connection_id: binding.connectionId,
        credential_reference: binding.credential_ref,
        revision: 1,
        enabled: true,
        availability: 'unknown',
        adapter_version: 'unverified',
        definition_available: definition !== null,
        last_sync_at: null,
        last_sync_status: 'never',
        last_error: null,
        warning_count: 0,
        created_at: at,
        updated_at: at,
      }
      const record: SourceRecord = {
        view,
        definition,
        proposed: {
          name: binding.name,
          endpoint: binding.endpoint,
          allowed_user_ids: binding.allowed_user_ids,
          review_note: binding.review_note,
        },
      }
      validateCatalogDocument('CatalogSource', view)
      await this.db.run(
        'INSERT INTO agent_catalog_sources(id, org_id, catalog_id, document) VALUES (?, ?, ?, ?)',
        [id, actor.orgId, binding.id, JSON.stringify(record)],
      )
      for (const version of versions)
        await this.data.saveVersion(actor, {
          catalog_id: binding.id,
          source_id: id,
          version: version.version,
          candidate_id: null,
          spec_digest: version.spec_digest,
          source_digest: version.snapshot.source_digest,
          lifecycle: 'published',
          provenance: 'legacy_adopted',
        })
      await this.data.audit(actor, 'source.created', binding.id, {
        source_id: id,
      })
      return view
    })
  }
  async updateSource(
    actor: ExternalActor,
    id: string,
    input: unknown,
  ): Promise<CatalogSource> {
    const body = object(input, [
      'revision',
      'name',
      'endpoint',
      'enabled',
      'source_definition',
      'allowed_user_ids',
      'review_note',
    ])
    const initial = await this.data.source(actor, id)
    const proposed = { ...initial.proposed }
    if (body.name !== undefined) {
      if (
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.length > 200
      )
        return fail('INVALID_SOURCE_NAME', 400)
      proposed.name = body.name.trim()
    }
    if (body.endpoint !== undefined)
      proposed.endpoint = canonicalEndpoint(String(body.endpoint))
    if (body.review_note !== undefined)
      proposed.review_note = note(body.review_note)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
      return fail('INVALID_SOURCE_ENABLED', 400)
    if (body.allowed_user_ids !== undefined) {
      if (
        !Array.isArray(body.allowed_user_ids) ||
        !body.allowed_user_ids.length ||
        body.allowed_user_ids.length > 100 ||
        body.allowed_user_ids.some((v) => typeof v !== 'string')
      )
        return fail('INVALID_MEMBER', 400)
      proposed.allowed_user_ids = [
        ...new Set(body.allowed_user_ids as string[]),
      ]
      for (const userId of proposed.allowed_user_ids)
        if (
          !(await this.admin.options.isMemberActive({
            orgId: actor.orgId,
            userId,
          }))
        )
          return fail('INVALID_MEMBER', 400)
    }
    const binding = await this.service.store.binding(
      actor,
      initial.view.catalog_id,
    )
    const definition =
      body.source_definition === undefined
        ? initial.definition
        : String(body.source_definition)
    if (definition !== null)
      providerDefinition(binding.provider_kind, definition, binding.app_id)
    const policy = await this.admin.effectivePolicy(actor)
    if (body.enabled !== false)
      assertPilot(policy, actor.orgId, proposed.endpoint)
    // Enabling an explicitly disabled source always proves current connectivity again.
    if (body.enabled === true && !initial.view.enabled)
      await new ConfiguredAgentProviderAdapter(
        this.admin,
        actor,
        { ...initial, proposed, definition },
        binding,
      ).fetchAgent(AbortSignal.timeout(10000))
    return this.db.transaction(async () => {
      await this.data.lock(actor, binding.id)
      await this.admin.lockPolicy(actor)
      const current = await this.data.source(actor, id)
      if (current.view.revision !== revision(body.revision))
        fail('CONFIGURATION_CHANGED')
      if (body.enabled !== false)
        assertPilot(
          await this.admin.effectivePolicy(actor),
          actor.orgId,
          proposed.endpoint,
        )
      current.proposed = proposed
      current.definition = definition
      current.view.name = proposed.name
      current.view.endpoint = proposed.endpoint
      current.view.allowed_user_ids = proposed.allowed_user_ids
      current.view.review_note = proposed.review_note
      current.view.definition_available = definition !== null
      current.view.revision++
      if (typeof body.enabled === 'boolean') current.view.enabled = body.enabled
      current.view.availability = 'unknown'
      await this.data.saveSource(current)
      await this.data.audit(
        actor,
        body.enabled === false
          ? 'source.disabled'
          : body.enabled === true
            ? 'source.enabled'
            : 'source.updated',
        binding.id,
        { source_id: id },
      )
      return current.view
    })
  }
  async sync(
    actor: ExternalActor,
    id: string,
    input: unknown,
  ): Promise<SourceSyncResult> {
    const body = object(input, ['revision', 'renew', 'note'])
    if (body.renew !== undefined && typeof body.renew !== 'boolean')
      fail('INVALID_ADMIN_INPUT', 400)
    if (body.renew) {
      note(body.note)
      await this.db.transaction(async () => {
        const before = await this.data.source(actor, id)
        await this.data.lock(actor, before.view.catalog_id)
        const source = await this.data.source(actor, id)
        if (
          !source.view.enabled ||
          source.view.revision !== revision(body.revision)
        )
          fail('CONFIGURATION_CHANGED')
        source.view.revision++
        await this.data.saveSource(source)
        await this.data.audit(
          actor,
          'source.review_renewed',
          source.view.catalog_id,
          { source_id: id },
        )
        body.revision = source.view.revision
      })
    }
    const original = await this.data.source(actor, id),
      sourceRevision = revision(body.revision)
    if (!original.view.enabled) fail('CATALOG_SOURCE_DISABLED')
    if (original.view.revision !== sourceRevision) fail('CONFIGURATION_CHANGED')
    const result: SourceSyncResult = {
      api_version: AGENT_CATALOG_API,
      id: randomUUID(),
      source_id: id,
      org_id: actor.orgId,
      started_at: Date.now(),
      completed_at: null,
      status: 'running',
      candidate_id: null,
      reused: false,
      error: null,
    }
    await this.db.transaction(async () => {
      await this.data.lock(actor, original.view.catalog_id)
      const current = await this.data.source(actor, id)
      if (current.view.revision !== sourceRevision || !current.view.enabled)
        fail('CONFIGURATION_CHANGED')
      current.view.last_sync_status = 'running'
      await this.data.saveSource(current)
      await this.data.saveSync(result)
      await this.data.audit(
        actor,
        'source.sync_started',
        current.view.catalog_id,
        { source_id: id },
      )
    })
    try {
      const binding = await this.service.store.binding(
        actor,
        original.view.catalog_id,
      )
      const policyDigest = contentDigest(await this.admin.policy(actor))
      const adapter = new ConfiguredAgentProviderAdapter(
        this.admin,
        actor,
        original,
        binding,
      )
      adapter.discoverSources()
      const fetched = await adapter.fetchAgent(AbortSignal.timeout(10000))
      const checks = adapter.validate(fetched.snapshot)
      await this.db.transaction(async () => {
        await this.data.lock(actor, binding.id)
        await this.admin.lockPolicy(actor)
        const current = await this.data.source(actor, id)
        if (
          current.view.revision !== sourceRevision ||
          !current.view.enabled ||
          contentDigest(await this.admin.policy(actor)) !== policyDigest ||
          JSON.stringify(
            await this.service.store.binding(actor, binding.id),
          ) !== JSON.stringify(binding)
        )
          fail('CONFIGURATION_CHANGED')
        const snapshot = fetched.snapshot,
          snapshotDigest = contentDigest(snapshot)
        const key = contentDigest({
          snapshotDigest,
          sourceRevision,
          rule: CATALOG_RULE_VERSION,
          policyDigest,
          credentialRef: binding.credential_ref,
          credentialVersion: fetched.binding.credentialVersion,
          decoder: binding.decoder,
        })
        const duplicate = await this.db.get(
          'SELECT document FROM agent_import_candidates WHERE source_id = ? AND candidate_key = ?',
          [id, key],
        )
        let candidate: CandidateRecord
        if (duplicate) {
          candidate = JSON.parse(String(duplicate.document))
          result.reused = true
        } else {
          const previousRows = await this.db.all(
            'SELECT document FROM agent_import_candidates WHERE source_id = ? ORDER BY id LIMIT 10001',
            [id],
          )
          if (previousRows.length > 10000) fail('CATALOG_CANDIDATE_LIMIT')
          const previous = previousRows.map(
            (row) => JSON.parse(String(row.document)) as CandidateRecord,
          )
          if (
            snapshot.source_revision &&
            previous.some(
              (c) =>
                c.view.snapshot.source_revision === snapshot.source_revision &&
                c.view.snapshot.source_digest !== snapshot.source_digest,
            )
          )
            fail('SOURCE_REVISION_CONFLICT')
          const prior = previous.sort(
            (a, b) => b.view.created_at - a.view.created_at,
          )[0]
          const candidateId = randomUUID(),
            at = Date.now()
          candidate = {
            key,
            binding: fetched.binding,
            approved_until: null,
            view: {
              api_version: AGENT_CATALOG_API,
              id: candidateId,
              source_id: id,
              catalog_id: binding.id,
              org_id: actor.orgId,
              revision: 1,
              status: 'draft',
              snapshot,
              validation: {
                id: randomUUID(),
                rule_version: CATALOG_RULE_VERSION,
                source_revision: sourceRevision,
                binding_revision: binding.revision ?? 1,
                policy_digest: policyDigest,
                snapshot_digest: snapshotDigest,
                validated_at: at,
                status: 'valid',
                ...checks,
              },
              changes: differences(prior?.view.snapshot ?? null, snapshot),
              decisions: [],
              created_at: at,
              published_version: null,
              publication_error: null,
              publication_started_at: null,
            },
          }
          validateCatalogDocument('ImportCandidate', candidate.view)
          await this.db.run(
            'INSERT INTO agent_import_candidates(id, org_id, source_id, candidate_key, status, document) VALUES (?, ?, ?, ?, ?, ?)',
            [
              candidateId,
              actor.orgId,
              id,
              key,
              'draft',
              JSON.stringify(candidate),
            ],
          )
          await this.data.audit(actor, 'candidate.validated', binding.id, {
            source_id: id,
            candidate_id: candidateId,
          })
        }
        result.status = 'succeeded'
        result.completed_at = Date.now()
        result.candidate_id = candidate.view.id
        current.view.availability = 'available'
        current.view.adapter_version = snapshot.adapter_version
        current.view.last_sync_status = 'succeeded'
        current.view.last_sync_at = result.completed_at
        current.view.last_error = null
        current.view.warning_count = checks.warnings.length
        await this.data.saveSource(current)
        await this.data.saveSync(result)
        await this.data.audit(actor, 'source.sync_completed', binding.id, {
          source_id: id,
          candidate_id: candidate.view.id,
        })
      })
    } catch (error) {
      result.status = 'failed'
      result.completed_at = Date.now()
      result.error = errorCode(error)
      await this.db.transaction(async () => {
        await this.data.lock(actor, original.view.catalog_id)
        const current = await this.data.source(actor, id)
        if (current.view.revision === sourceRevision) {
          current.view.availability = 'unavailable'
          current.view.last_sync_status = 'failed'
          current.view.last_sync_at = result.completed_at
          current.view.last_error = result.error
          await this.data.saveSource(current)
        }
        await this.data.saveSync(result)
        await this.data.audit(
          actor,
          'source.sync_failed',
          current.view.catalog_id,
          { source_id: id, result: 'failed', reason: result.error },
        )
      })
    }
    return result
  }
  private async assertCandidateCurrent(
    actor: ExternalActor,
    candidate: CandidateRecord,
  ) {
    const source = await this.data.source(actor, candidate.view.source_id),
      current = await this.service.store.binding(
        actor,
        candidate.view.catalog_id,
      )
    const report = candidate.view.validation
    if (!source.view.enabled) fail('CATALOG_SOURCE_DISABLED')
    if (
      source.view.revision !== report.source_revision ||
      (current.revision ?? 1) !== report.binding_revision ||
      report.rule_version !== CATALOG_RULE_VERSION ||
      contentDigest(await this.admin.policy(actor)) !== report.policy_digest ||
      contentDigest(candidate.view.snapshot) !== report.snapshot_digest
    )
      fail('CANDIDATE_VALIDATION_STALE')
    const adapter = new ConfiguredAgentProviderAdapter(
      this.admin,
      actor,
      source,
      current,
    )
    const runtime = createRuntimeRegistry(this.admin.options)
      .get(candidate.binding.provider_kind ?? 'dify')
      .create(candidate.binding)
    if (
      contentDigest(adapter.normalize(candidate.binding, runtime)) !==
      report.snapshot_digest
    )
      fail('CANDIDATE_VALIDATION_STALE')
    await this.admin.assertCredentialUsable(actor, current, true)
    const ref = parseNexusSecretRef(current.credential_ref)
    const secret = await this.admin.options.secrets.getSecret(
      ref.namespace,
      ref.key,
      `org:${actor.orgId}`,
    )
    if (
      !secret?.value ||
      secret.status !== 'enabled' ||
      secret.version !== candidate.binding.credentialVersion
    )
      fail('CANDIDATE_VALIDATION_STALE')
    if (
      current.archived ||
      current.credentialUpdating ||
      current.credentialRecoveryRequired
    )
      fail('CREDENTIAL_UPDATE_IN_PROGRESS')
    assertPilot(
      await this.admin.effectivePolicy(actor),
      actor.orgId,
      candidate.binding.endpoint,
    )
    for (const userId of candidate.binding.allowed_user_ids)
      if (
        !(await this.admin.options.isMemberActive({
          orgId: actor.orgId,
          userId,
        }))
      )
        fail('INVALID_MEMBER', 400)
    return current
  }
  async decide(
    actor: ExternalActor,
    id: string,
    input: unknown,
  ): Promise<ImportCandidate> {
    const body = object(input, ['revision', 'action', 'note', 'review_days'])
    const action = String(body.action),
      reason = note(body.note),
      initial = await this.data.candidate(actor, id)
    if (!['submit', 'approve', 'reject', 'archive', 'abandon'].includes(action))
      return fail('INVALID_CANDIDATE_ACTION', 400)
    return this.db.transaction(async () => {
      await this.data.lock(actor, initial.view.catalog_id)
      await this.admin.lockPolicy(actor)
      const candidate = await this.data.candidate(actor, id),
        view = candidate.view
      if (view.revision !== revision(body.revision))
        fail('CONFIGURATION_CHANGED')
      if (action === 'abandon') {
        if (!['publishing', 'publication_unknown'].includes(view.status))
          fail('CANDIDATE_STATE_CONFLICT')
        // Local quarantine only: no retry, no remote success or cancellation assertion.
        // Even a late remote response cannot make this version runnable without a mapping.
        view.status = 'archived'
        view.revision++
        view.decisions.push({
          action: 'archived',
          actor_id: actor.userId,
          note: reason,
          at: Date.now(),
        })
        await this.data.saveCandidate(candidate)
        await this.data.audit(
          actor,
          'candidate.publication_abandoned',
          view.catalog_id,
          {
            source_id: view.source_id,
            candidate_id: id,
            version: view.published_version,
            result: 'unknown',
            reason: 'REMOTE_PUBLICATION_UNCONFIRMED',
          },
        )
        return view
      }
      if (
        ['published', 'publishing', 'publication_unknown', 'archived'].includes(
          view.status,
        )
      )
        fail('CANDIDATE_STATE_CONFLICT')
      if (
        (action === 'submit' && view.status !== 'draft') ||
        (action === 'approve' && view.status !== 'pending_approval') ||
        (action === 'reject' && view.status !== 'pending_approval')
      )
        fail('CANDIDATE_STATE_CONFLICT')
      if (action === 'submit' || action === 'approve')
        await this.assertCandidateCurrent(actor, candidate)
      if (action === 'approve') {
        if (![1, 3, 7].includes(Number(body.review_days)))
          return fail('INVALID_REVIEW_DAYS', 400)
        candidate.approved_until =
          Date.now() + Number(body.review_days) * 86400_000
      }
      view.status =
        action === 'submit'
          ? 'pending_approval'
          : action === 'approve'
            ? 'approved'
            : action === 'reject'
              ? 'rejected'
              : 'archived'
      view.decisions.push({
        action:
          action === 'submit'
            ? 'submitted'
            : action === 'approve'
              ? 'approved'
              : action === 'reject'
                ? 'rejected'
                : 'archived',
        actor_id: actor.userId,
        note: reason,
        at: Date.now(),
      })
      view.revision++
      await this.data.saveCandidate(candidate)
      await this.data.audit(actor, `candidate.${action}`, view.catalog_id, {
        source_id: view.source_id,
        candidate_id: id,
      })
      return view
    })
  }
  async publish(
    actor: ExternalActor,
    id: string,
    input: unknown,
  ): Promise<ImportCandidate> {
    const body = object(input, ['revision']),
      initial = await this.data.candidate(actor, id)
    await this.service.authorize(actor)
    if (initial.view.status === 'published') return initial.view
    if (['publishing', 'publication_unknown'].includes(initial.view.status))
      return this.reconcile(actor, id)
    if (
      initial.view.status !== 'approved' ||
      !initial.approved_until ||
      initial.approved_until <= Date.now()
    )
      fail('CANDIDATE_APPROVAL_REQUIRED')
    // Re-read provider metadata without invoking it, before reserving a publication.
    await this.assertCandidateCurrent(actor, initial)
    const source = await this.data.source(actor, initial.view.source_id),
      current = await this.service.store.binding(actor, initial.view.catalog_id)
    const fresh = await new ConfiguredAgentProviderAdapter(
      this.admin,
      actor,
      source,
      current,
    ).fetchAgent(AbortSignal.timeout(10000))
    if (
      contentDigest(fresh.snapshot) !==
        initial.view.validation.snapshot_digest ||
      fresh.binding.credentialVersion !== initial.binding.credentialVersion
    )
      fail('CANDIDATE_VALIDATION_STALE')
    const reserved = await this.db.transaction(async () => {
      await this.data.lock(actor, initial.view.catalog_id)
      await this.admin.lockPolicy(actor)
      const candidate = await this.data.candidate(actor, id)
      if (
        candidate.view.revision !== revision(body.revision) ||
        candidate.view.status !== 'approved'
      )
        fail('CONFIGURATION_CHANGED')
      await this.assertCandidateCurrent(actor, candidate)
      const pending = await this.db.get(
        "SELECT id FROM agent_import_candidates WHERE source_id = ? AND status IN ('publishing', 'publication_unknown')",
        [candidate.view.source_id],
      )
      if (pending) fail('PUBLICATION_RECONCILIATION_REQUIRED')
      candidate.view.status = 'publishing'
      candidate.view.publication_started_at = Date.now()
      candidate.view.revision++
      candidate.view.published_version = `candidate-${candidate.view.id}`
      candidate.binding.approved = true
      candidate.binding.review_expires_at = candidate.approved_until!
      candidate.binding.reviewedBy = actor.userId
      candidate.binding.reviewedAt = Date.now()
      await this.data.saveCandidate(candidate)
      await this.data.audit(
        actor,
        'candidate.publish_started',
        candidate.view.catalog_id,
        {
          source_id: candidate.view.source_id,
          candidate_id: id,
          version: candidate.view.published_version,
        },
      )
      return candidate
    })
    try {
      const version = await this.service.releases.publish(
        actor,
        reserved.binding,
        reserved.view.published_version!,
        reserved.binding.review_note,
      )
      if (
        version.spec_digest !==
        contentDigest(this.service.store.releases.snapshot(reserved.binding))
      )
        fail('IMMUTABLE_VERSION_CONFLICT')
      return await this.finishPublication(actor, id)
    } catch (error) {
      return this.db.transaction(async () => {
        await this.data.lock(actor, reserved.view.catalog_id)
        const candidate = await this.data.candidate(actor, id)
        if (['published', 'archived'].includes(candidate.view.status))
          return candidate.view
        candidate.view.status = 'publication_unknown'
        candidate.view.publication_error = errorCode(error)
        candidate.view.revision++
        await this.data.saveCandidate(candidate)
        await this.data.audit(
          actor,
          'candidate.publication_unknown',
          candidate.view.catalog_id,
          {
            source_id: candidate.view.source_id,
            candidate_id: id,
            version: candidate.view.published_version,
            result: 'unknown',
            reason: candidate.view.publication_error,
          },
        )
        return candidate.view
      })
    }
  }
  async reconcile(actor: ExternalActor, id: string): Promise<ImportCandidate> {
    const candidate = await this.data.candidate(actor, id)
    if (candidate.view.status === 'published') return candidate.view
    if (
      !['publishing', 'publication_unknown'].includes(candidate.view.status) ||
      !candidate.view.published_version
    )
      return fail('CANDIDATE_STATE_CONFLICT')
    // Query the exact approved version. Never submit another publish command on an ambiguous result.
    const version = await this.service.releases.version(
      actor,
      candidate.view.catalog_id,
      candidate.view.published_version,
    )
    if (
      version.spec_digest !==
      contentDigest(this.service.store.releases.snapshot(candidate.binding))
    )
      fail('IMMUTABLE_VERSION_CONFLICT')
    return this.finishPublication(actor, id)
  }
  private async finishPublication(
    actor: ExternalActor,
    id: string,
  ): Promise<ImportCandidate> {
    const initial = await this.data.candidate(actor, id)
    return this.db.transaction(async () => {
      await this.data.lock(actor, initial.view.catalog_id)
      await this.admin.lockPolicy(actor)
      const candidate = await this.data.candidate(actor, id)
      if (candidate.view.status === 'published') return candidate.view
      if (
        !['publishing', 'publication_unknown'].includes(candidate.view.status)
      )
        fail('CANDIDATE_STATE_CONFLICT')
      const before = await this.assertCandidateCurrent(actor, candidate)
      if (!candidate.approved_until || candidate.approved_until <= Date.now())
        fail('CANDIDATE_APPROVAL_REQUIRED')
      const next: Binding = {
        ...before,
        ...candidate.binding,
        revision: (before.revision ?? 1) + 1,
      }
      const connection =
        await this.admin.options.identities.getIntegrationConnection(
          before.connectionId,
        )
      if (
        !connection?.enabled ||
        connection.secretRef !== before.credential_ref
      )
        fail('CONNECTION_DISABLED_OR_CHANGED')
      await this.admin.options.identities.putIntegrationConnection({
        ...connection,
        name: next.name,
        config: { ...connection.config, baseUrl: next.endpoint },
      })
      await this.service.store.saveBinding(next)
      await this.admin.options.catalog.updateAgentConfiguration(
        next.id,
        actor.orgId,
        {
          name: next.name,
          visibleTo: { user_ids: next.allowed_user_ids },
          status: 'approved',
          enabled: true,
          providerBinding: {
            executionMode: 'external_hosted',
            bindingId: next.id,
            connectionId: next.connectionId,
            appId: next.app_id,
            sourceDigest: next.source_digest,
          },
        },
      )
      const version = candidate.view.published_version!
      await this.data.saveVersion(actor, {
        catalog_id: next.id,
        source_id: candidate.view.source_id,
        candidate_id: id,
        version,
        source_digest: next.source_digest,
        spec_digest: contentDigest(this.service.store.releases.snapshot(next)),
        lifecycle: 'published',
        provenance: 'candidate',
      })
      candidate.view.status = 'published'
      candidate.view.publication_error = null
      candidate.view.revision++
      await this.data.saveCandidate(candidate)
      await this.data.audit(actor, 'version.published', next.id, {
        source_id: candidate.view.source_id,
        candidate_id: id,
        version,
      })
      return candidate.view
    })
  }
  async runs(
    actor: ExternalActor,
    catalogId: string,
    after = '',
  ): Promise<CatalogPage<CatalogRun>> {
    await this.service.store.binding(actor, catalogId)
    if (!/^[a-zA-Z0-9_-]{0,200}$/.test(after)) fail('INVALID_CURSOR', 400)
    const rows = await this.db.all(
      `SELECT t.id, t.user_id FROM external_tasks t JOIN external_session_bindings s ON s.id = t.session_id
      WHERE t.org_id = ? AND s.agent_id = ? AND t.id > ? AND NOT EXISTS (SELECT 1 FROM external_pilot_retention r WHERE r.task_id = t.id AND r.retired_at IS NOT NULL) ORDER BY t.id LIMIT 51`,
      [actor.orgId, catalogId, after],
    )
    const items = await Promise.all(
      rows.slice(0, 50).map(async (row) => {
        // The administrator route authorizes this organization. Ownership-scoped stores
        // still verify every task record; only explicit metadata fields leave this view.
        const owner = { orgId: actor.orgId, userId: String(row.user_id) },
          id = String(row.id)
        const task = await this.service.store.task(owner, id),
          record = await this.service.store.taskRecord(owner, id)
        const provenance = await this.provenance(owner, id),
          run = await this.service.store.runBinding(owner, id)
        const selection =
          record?.resolution.status === 'accepted'
            ? record.resolution.agent
            : undefined
        return {
          task_id: id,
          session_id: task.session_id,
          attempt_id: task.attempt_id,
          user_id: owner.userId,
          status: task.status,
          output_status: task.output_status,
          error_code: task.error_code,
          created_at: task.created_at,
          updated_at: task.updated_at,
          version: selection?.version ?? null,
          source_digest: task.source_digest,
          source_revision: provenance?.source_revision ?? null,
          adapter_version:
            provenance?.adapter_version ?? run?.adapter_version ?? null,
          protocol: provenance?.protocol ?? run?.provider_protocol ?? null,
          capabilities: provenance
            ? {
                ...provenance.capabilities,
                idempotency: provenance.capabilities.idempotency ?? 'unknown',
                human_approval:
                  provenance.capabilities.human_approval ?? 'unknown',
                trace_export: provenance.capabilities.trace_export ?? 'unknown',
              }
            : null,
          provider_run_id: run?.provider_run_id ?? null,
          provider_response_id: run?.provider_response_id ?? null,
          observability: run?.observability ?? null,
          version_evidence: run?.version_evidence ?? null,
        } satisfies CatalogRun
      }),
    )
    return {
      api_version: AGENT_CATALOG_API,
      items,
      next_cursor: rows.length > 50 ? String(rows[49].id) : null,
    }
  }
  async lifecycle(actor: ExternalActor, catalogId: string, input: unknown) {
    const body = object(input, ['version', 'lifecycle', 'note'])
    if (
      typeof body.version !== 'string' ||
      !['deprecated', 'archived'].includes(String(body.lifecycle))
    )
      return fail('INVALID_VERSION_LIFECYCLE', 400)
    note(body.note)
    return this.db.transaction(async () => {
      await this.data.lock(actor, catalogId)
      const item = await this.data.version(
        actor,
        catalogId,
        String(body.version),
      )
      if (!item) return fail('CATALOG_VERSION_NOT_FOUND', 404)
      if (item.lifecycle === 'archived' && body.lifecycle !== 'archived')
        fail('CATALOG_VERSION_NOT_ACTIVE')
      item.lifecycle = body.lifecycle as 'deprecated' | 'archived'
      await this.db.run(
        'UPDATE agent_catalog_versions SET document = ? WHERE org_id = ? AND catalog_id = ? AND version = ?',
        [JSON.stringify(item), actor.orgId, catalogId, item.version],
      )
      await this.data.audit(actor, `version.${item.lifecycle}`, catalogId, {
        source_id: item.source_id,
        candidate_id: item.candidate_id,
        version: item.version,
      })
      return item
    })
  }
}
