import { initializeExternalTaskPersistence, attemptState } from '../agentFederation/taskPersistence.js'
import type { ExecutionFence } from '../agentFederation/executionOwnership.js'
import { AgentReleaseStore } from '../agentFederation/releases.js'
import { randomUUID, createHash } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { sessionAgentName } from '../agentIdentity.js'
import { EXTERNAL_PROVIDER_API, type ExternalEventsPage, type CreateExternalTask, type ExternalTask, type ExternalTaskEvent, type ExternalSession, type RegisterExternalAgent } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalProviderError } from './policy.js'
import type { ExternalRunBinding } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { parseExternalRunBinding } from '../agentFederation/manifest.js'
import { canonicalTaskJson, parseTaskRecord } from '../agentFederation/taskContract.js'
import type { TaskRecord } from '../../../contracts/task/v1alpha1/contract.js'

export interface TaskAdmission {
  requestHash: string
  deadlineAt?: number
  reason: ExternalTask['policy_decision'] & {}
  record: (task: ExternalTask) => TaskRecord
  policySnapshot: unknown
}

export interface ExternalActor { orgId: string; userId: string }
export interface Binding extends RegisterExternalAgent { registryRequired?: boolean; sourceManifest?: import('../../../contracts/agent-federation/v1alpha1/contract.js').CustomAgentManifest; id: string; orgId: string; connectionId: string; approved: boolean; parametersDigest: string | null; reviewedBy: string | null; reviewedAt?: number | null; revision?: number; definitionProfileVersion?: number; archived?: boolean; credentialUpdating?: boolean; credentialVersion?: number; credentialRecoveryRequired?: boolean; credentialOperationId?: string; registrationMode?: 'onboarding' | 'reference_compat' }
type Checkpoint = ExternalTask & { _checkpoint_sequence?: number }
type TaskRow = SqlRow & { document: string; sequence: number; request_hash: string }
type SessionRow = SqlRow & { id: string; agent_id: string; agent_name: string; title: string; active_task_id: string | null; conversation_id: string | null; created_at: number; updated_at: number }
export const isTerminal = (status: ExternalTask['status']): boolean => ['succeeded', 'failed', 'rejected', 'unknown'].includes(status)
export const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`

export const MAX_PILOT_TASKS_PER_ORG = 10_000

export class ExternalTaskStore {
  readonly ready: Promise<void>
  readonly releases: AgentReleaseStore
  constructor(readonly db: DbDriver) {
    this.releases = new AgentReleaseStore(db)
    this.ready = initializeExternalTaskPersistence(db).then(() => db.exec(`
      CREATE TABLE IF NOT EXISTS external_pilot_maintenance (name TEXT PRIMARY KEY, next_run_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_pilot_capacity (org_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS external_pilot_retention (task_id TEXT PRIMARY KEY, compacted_at BIGINT NOT NULL, retired_at BIGINT, audit_document TEXT);
      CREATE INDEX IF NOT EXISTS external_pilot_retention_retired ON external_pilot_retention(retired_at);
      CREATE TABLE IF NOT EXISTS external_pilot_policy (org_id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_pilot_admin_operations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_pilot_operations (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, status TEXT NOT NULL, lease_until BIGINT NOT NULL, document TEXT NOT NULL,
        UNIQUE(org_id, kind, request_id)
      );
      CREATE INDEX IF NOT EXISTS external_pilot_operations_pending ON external_pilot_operations(status, lease_until);
      CREATE TABLE IF NOT EXISTS external_pilot_admin_audit (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS external_pilot_admin_audit_created ON external_pilot_admin_audit(created_at, id);
      CREATE TABLE IF NOT EXISTS external_pilot_bindings (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS external_pilot_bindings_org ON external_pilot_bindings(org_id, id);
      CREATE TABLE IF NOT EXISTS external_pilot_sessions (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL, title TEXT NOT NULL, active_task_id TEXT, conversation_id TEXT,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS external_pilot_sessions_owner ON external_pilot_sessions(org_id, user_id, updated_at);
      CREATE TABLE IF NOT EXISTS external_pilot_tasks (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
        deadline_at BIGINT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL,
        UNIQUE(org_id, user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS external_pilot_tasks_deadline ON external_pilot_tasks(status, deadline_at);
      CREATE INDEX IF NOT EXISTS external_pilot_tasks_session ON external_pilot_tasks(session_id);
      CREATE TABLE IF NOT EXISTS external_pilot_attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, started_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_pilot_run_bindings (
        task_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_task_records (
        task_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
        document TEXT NOT NULL, policy_snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_pilot_reconciliations (
        task_id TEXT PRIMARY KEY, attempt_id TEXT, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_pilot_events (
        task_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(task_id, sequence)
      );
    `)).then(async () => {
      await this.releases.ready
      // Preserve old request IDs while moving uniqueness to the organization scope.
      await db.transaction(async () => {
        const rows = await db.all("SELECT * FROM external_pilot_admin_operations WHERE status != 'migrated'")
        for (const row of rows) {
          const actor = { orgId: String(row.org_id), userId: 'system' }
          const old = await db.get('SELECT document FROM external_pilot_bindings WHERE id = ? AND org_id = ?', [String(row.id), actor.orgId])
          const binding = old ? JSON.parse(String(old.document)) : { id: String(row.id) }
          const operation = { id: randomUUID(), actor, kind: 'onboard', binding, legacy: true, targetRef: `nexus://org:${actor.orgId}:external:${row.id}/app-key` }
          const complete = row.status === 'complete' && Boolean(old)
          await db.run(`INSERT INTO external_pilot_operations (id, org_id, kind, request_id, request_hash, status, lease_until, document)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(org_id, kind, request_id) DO NOTHING`,
          [operation.id, actor.orgId, complete ? 'onboard' : 'cleanup', String(row.id), String(row.request_hash), complete ? 'complete' : 'cleanup', JSON.stringify(operation)])
          await db.run("UPDATE external_pilot_admin_operations SET status = 'migrated' WHERE id = ?", [String(row.id)])
        }
        const closed = await db.all("SELECT id, document FROM external_pilot_tasks WHERE status = 'unknown' AND document LIKE '%\"reconciliation\"%'")
        for (const row of closed) {
          const task = JSON.parse(String(row.document)) as ExternalTask
          if (task.reconciliation) await db.run('INSERT INTO external_pilot_reconciliations(task_id, attempt_id, document) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING', [task.id, task.attempt_id, JSON.stringify(task.reconciliation)])
        }
        const bindings = await db.all('SELECT document FROM external_pilot_bindings')
        for (const row of bindings) {
          const binding = JSON.parse(String(row.document)) as Binding
          await this.releases.registerPrincipal(binding)
          if (binding.approved && (binding.credentialVersion === undefined || binding.definitionProfileVersion !== 1)) {
            binding.approved = false; binding.parametersDigest = null; binding.revision = (binding.revision ?? 1) + 1
            await db.run('UPDATE external_pilot_bindings SET document = ? WHERE id = ?', [JSON.stringify(binding), binding.id])
          }
        }
      })
    })
  }

  async binding(actor: ExternalActor, id: string): Promise<Binding> {
    await this.ready
    const row = await this.db.get('SELECT document FROM external_pilot_bindings WHERE id = ? AND org_id = ?', [id, actor.orgId])
    if (!row) throw new ExternalProviderError(404, 'AGENT_NOT_FOUND')
    return JSON.parse(String(row.document)) as Binding
  }

  async saveRunBinding(actor: ExternalActor, binding: ExternalRunBinding): Promise<void> {
    parseExternalRunBinding(binding)
    const task = await this.task(actor, binding.task_id)
    if (task.attempt_id !== binding.attempt_id || task.session_id !== binding.session_id || task.agent_id !== binding.binding_id || task.source_digest !== binding.source_digest || task.provider !== binding.provider_kind) throw new ExternalProviderError(409, 'RUN_BINDING_MISMATCH')
    const document = JSON.stringify(binding)
    await this.db.run('INSERT INTO external_pilot_run_bindings(task_id, attempt_id, document) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING', [binding.task_id, binding.attempt_id, document])
    const row = await this.db.get('SELECT document FROM external_pilot_run_bindings WHERE task_id = ?', [binding.task_id])
    if (row?.document !== document) throw new ExternalProviderError(409, 'RUN_BINDING_CONFLICT')
  }

  async runBinding(actor: ExternalActor, taskId: string): Promise<ExternalRunBinding | null> {
    await this.task(actor, taskId)
    const row = await this.db.get('SELECT document FROM external_pilot_run_bindings WHERE task_id = ?', [taskId])
    return row ? parseExternalRunBinding(JSON.parse(String(row.document))) : null
  }

  async bindings(actor: ExternalActor, after = '', limit = 100): Promise<Binding[]> {
    await this.ready
    return (await this.db.all('SELECT document FROM external_pilot_bindings WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?', [actor.orgId, after, limit])).map(row => JSON.parse(String(row.document)))
  }

  async saveBinding(binding: Binding): Promise<void> {
    await this.ready
    await this.db.transaction(async () => {
      const saved = await this.db.run(`INSERT INTO external_pilot_bindings(id, org_id, document) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET document = excluded.document WHERE external_pilot_bindings.org_id = excluded.org_id`, [binding.id, binding.orgId, JSON.stringify(binding)])
      if (!saved) throw new ExternalProviderError(404, 'AGENT_NOT_FOUND')
      await this.releases.registerPrincipal(binding)
    })
  }

  async existingRequest(actor: ExternalActor, key: string, requestHash: string): Promise<ExternalTask | null> {
    await this.ready
    const row = await this.db.get<TaskRow>(`SELECT t.*, s.runtime_type AS task_runtime FROM tasks t JOIN sessions s ON s.session_id = t.session_id WHERE t.org_id = ? AND t.user_id = ? AND t.idempotency_key = ?`, [actor.orgId, actor.userId, key])
    if (!row) return null
    if (row.request_hash !== requestHash) throw new ExternalProviderError(409, 'IDEMPOTENCY_CONFLICT')
    return this.project(row)
  }

  async taskRecord(actor: ExternalActor, taskId: string): Promise<TaskRecord | null> {
    const task = await this.task(actor, taskId)
    const row = await this.db.get('SELECT document, policy_snapshot FROM product_task_records WHERE task_id = ? AND org_id = ? AND user_id = ?', [taskId, actor.orgId, actor.userId])
    if (!row) return null
    const record = parseTaskRecord(JSON.parse(String(row.document))), resolution = record.resolution
    const policySnapshot = JSON.parse(String(row.policy_snapshot))
    if (record.spec.task_id !== task.id || record.spec.session_id !== task.session_id || record.spec.requested_by.subject_id !== actor.userId
      || resolution.policy_snapshot_digest !== digest(canonicalTaskJson(policySnapshot))
      || (resolution.status === 'accepted' && (resolution.execution_mode !== 'external_hosted' || resolution.attempt_id !== task.attempt_id || resolution.governance_org_id !== actor.orgId
        || resolution.binding_id !== task.agent_id || resolution.agent.source_digest !== task.source_digest
        || canonicalTaskJson(resolution.agent.registry ?? null) !== canonicalTaskJson(policySnapshot.registry ?? null)))) throw new ExternalProviderError(500, 'TASK_RECORD_MISMATCH')
    return record
  }

  async create(actor: ExternalActor, input: CreateExternalTask, binding: Binding, timeoutMs: number, admission?: TaskAdmission): Promise<ExternalTask> {
    await this.ready
    const hash = admission?.requestHash ?? digest(JSON.stringify([input.agent_id, input.session_id ?? null, input.query]))
    return this.db.transaction(async () => {
      // A bounded Pilot retains idempotency tombstones, so capacity includes retired tasks.
      await this.db.run('INSERT INTO external_pilot_capacity(org_id) VALUES (?) ON CONFLICT(org_id) DO NOTHING', [actor.orgId])
      await this.db.run('UPDATE external_pilot_capacity SET org_id = org_id WHERE org_id = ?', [actor.orgId])
      const existing = await this.existingRequest(actor, input.idempotency_key, hash)
      if (existing) return existing
      const capacity = await this.db.get('SELECT COUNT(*) AS total FROM external_tasks WHERE org_id = ?', [actor.orgId])
      if (Number(capacity?.total) >= MAX_PILOT_TASKS_PER_ORG) throw new ExternalProviderError(429, 'PILOT_TASK_CAPACITY_REACHED')
      // Reserve the idempotency key before touching a session. ON CONFLICT also serializes concurrent retries on PG.
      const id = randomUUID(), sessionId = input.session_id ?? randomUUID(), now = Date.now()
      const task: ExternalTask = {
        api_version: EXTERNAL_PROVIDER_API, id, session_id: sessionId, agent_id: binding.id,
        agent_name: sessionAgentName(actor.userId, binding.id), attempt_id: null, status: 'accepted',
        configuration_revision: binding.revision ?? 1, query: input.query, answer: '', raw_answer: '', raw_answer_freshness: 'current', output_status: 'pending', error_code: null,
        source_identity_evidence: 'unverified', source_digest: binding.source_digest, provider: binding.source_digest === 'unresolved' ? 'unresolved' : binding.provider_kind ?? 'dify', provider_refs: {},
        cancellation: { status: 'unsupported', reason: 'Provider termination cannot be confirmed in this pilot' },
        created_at: now, updated_at: now, deadline_at: Math.min(now + timeoutMs, admission?.deadlineAt ?? Infinity),
      }
      if (admission) {
        task.task_contract_version = 'task.sudo.dev/v1alpha1'
        task.policy_decision = admission.reason
        task.status = admission.reason.status
        task.attempt_id = task.status === 'accepted' ? randomUUID() : null
        task.error_code = task.status === 'rejected' ? admission.reason.reason_code : null
      }
      const inserted = await this.db.run(`INSERT INTO tasks
        (id, org_id, user_id, session_id, idempotency_key, request_hash, status, deadline_at, sequence, document)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(org_id, user_id, idempotency_key) DO NOTHING`,
      [id, actor.orgId, actor.userId, sessionId, input.idempotency_key, hash, task.status, task.deadline_at, JSON.stringify({ ...task, _checkpoint_sequence: 1 })])
      if (!inserted) {
        const existing = await this.db.get<TaskRow>(`SELECT t.*, s.runtime_type AS task_runtime FROM tasks t JOIN sessions s ON s.session_id = t.session_id WHERE t.org_id = ? AND t.user_id = ? AND t.idempotency_key = ?`, [actor.orgId, actor.userId, input.idempotency_key])
        if (!existing || existing.request_hash !== hash) throw new ExternalProviderError(409, 'IDEMPOTENCY_CONFLICT')
        return this.project(existing)
      }
      if (!input.session_id) {
        await this.db.run(`INSERT INTO sessions(session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd,
          runtime_type, status, desired_state, transcript_path, title, assistant_name, source, client_metadata, created_at, last_active_at)
          VALUES (?, ?, ?, ?, 'user', '[]', '', 'external', 'detached', 'active', '', ?, ?, 'external_provider', ?, ?, ?)`,
        [sessionId, sessionId, actor.orgId, actor.userId, input.query.slice(0, 100), task.agent_name, JSON.stringify({ task_contract: 'task.sudo.dev/v1alpha1' }), now, now])
        await this.db.run('INSERT INTO external_session_bindings(id, agent_id, agent_name) VALUES (?, ?, ?)', [sessionId, binding.id, task.agent_name])
      }
      const locked = task.status === 'rejected'
        ? await this.db.run(`UPDATE sessions SET last_active_at = ? WHERE session_id = ? AND org_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM external_session_bindings x WHERE x.id = sessions.session_id AND x.agent_id = ?)`, [now, sessionId, actor.orgId, actor.userId, binding.id])
        : await this.db.run(`UPDATE external_session_bindings SET active_task_id = ?
        WHERE id = ? AND agent_id = ? AND active_task_id IS NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = external_session_bindings.id AND s.org_id = ? AND s.user_id = ?)`,
      [id, sessionId, binding.id, actor.orgId, actor.userId])
      if (!locked) {
        await this.session(actor, sessionId)
        throw new ExternalProviderError(409, 'SESSION_BUSY_OR_AGENT_MISMATCH')
      }
      const count = await this.db.get('SELECT COUNT(*) AS total FROM external_tasks WHERE session_id = ?', [sessionId])
      if (Number(count?.total) > 200) throw new ExternalProviderError(409, 'SESSION_TASK_LIMIT')
      // The session row is locked above. Creation order is independent of deadlines and wall-clock changes.
      task.session_sequence = Number(count?.total)
      await this.db.run('UPDATE tasks SET document = ? WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [JSON.stringify({ ...task, _checkpoint_sequence: 1 }), id])
      if (admission) {
        const record = parseTaskRecord(admission.record(task))
        await this.db.run('INSERT INTO product_task_records(task_id, org_id, user_id, document, policy_snapshot) VALUES (?, ?, ?, ?, ?)', [id, actor.orgId, actor.userId, JSON.stringify(record), JSON.stringify(admission.policySnapshot)])
        await this.syncAttempt(task)
      }
      await this.appendEvent(task, 1, this.event(task, 1, 'status'))
      return task
    })
  }

  async session(actor: ExternalActor, id: string): Promise<SessionRow> {
    await this.ready
    const row = await this.db.get<SessionRow>('SELECT * FROM external_sessions WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'SESSION_NOT_FOUND')
    return row
  }

  async sessionVersion(actor: ExternalActor, sessionId: string): Promise<string | undefined> {
    await this.session(actor, sessionId)
    const first = await this.db.get(`SELECT t.id FROM external_tasks t JOIN session_attempts a ON a.attempt_id = t.attempt_id
      JOIN product_task_records r ON r.task_id = t.id WHERE t.session_id = ? ORDER BY a.generation LIMIT 1`, [sessionId])
    if (!first) return undefined
    const record = await this.taskRecord(actor, String(first.id))
    return record?.resolution.status === 'accepted' && record.resolution.agent.release_digest ? record.resolution.agent.version : undefined
  }

  async sessions(actor: ExternalActor): Promise<ExternalSession[]> {
    await this.ready
    const rows = await this.db.all<SessionRow>("SELECT * FROM external_sessions s WHERE org_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM external_tasks t WHERE t.session_id = s.id AND NOT EXISTS (SELECT 1 FROM external_pilot_retention r WHERE r.task_id = t.id AND r.retired_at IS NOT NULL)) ORDER BY updated_at DESC, id LIMIT 100", [actor.orgId, actor.userId])
    return rows.map(row => ({ id: row.id, agent_id: row.agent_id, agent_name: row.agent_name, title: row.title, active_task_id: row.active_task_id, created_at: Number(row.created_at), updated_at: Number(row.updated_at) }))
  }

  async history(actor: ExternalActor, sessionId: string): Promise<ExternalTask[]> {
    await this.session(actor, sessionId)
    const rows = await this.db.all<TaskRow>('SELECT * FROM external_tasks t WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM external_pilot_retention r WHERE r.task_id = t.id AND r.retired_at IS NOT NULL) LIMIT 200', [sessionId])
    const tasks = await this.projectMany(rows)
    return tasks.sort((a, b) => {
      if (a.session_sequence !== undefined && b.session_sequence !== undefined) return a.session_sequence - b.session_sequence
      // Historical records predate sequenced creation. Their original timestamps remain unchanged.
      if (a.session_sequence !== undefined) return 1
      if (b.session_sequence !== undefined) return -1
      return a.created_at - b.created_at || a.id.localeCompare(b.id)
    })
  }

  async task(actor: ExternalActor, id: string): Promise<ExternalTask> {
    await this.ready
    const row = await this.db.get<TaskRow>('SELECT * FROM external_tasks WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
    return this.project(row)
  }

  async events(actor: ExternalActor, id: string, cursor: number): Promise<ExternalEventsPage> {
    await this.ready
    // The row fixes a committed sequence horizon. Later appends are excluded from
    // both the snapshot projection and the page; ordinary reads acquire no write lock.
    const row = await this.db.get<TaskRow>('SELECT * FROM external_tasks WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
    const horizon = Number(row.sequence)
    if (JSON.parse(row.document)._retired) throw new ExternalProviderError(410, 'TASK_HISTORY_EXPIRED')
    const envelope = { api_version: EXTERNAL_PROVIDER_API, kind: 'ExternalEventsPage' as const }
    const snapshot = async () => ({ ...envelope, task: await this.project(row), snapshot_sequence: horizon, events: [], next_cursor: horizon, has_more: false })
    if (cursor === 0 || cursor > horizon) return snapshot()
    const rows = await this.db.all('SELECT document FROM task_events WHERE task_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 100', [id, cursor, horizon])
    const events = rows.map(item => JSON.parse(String(item.document)) as ExternalTaskEvent)
    // Pre-upgrade events use cumulative answers. Explicitly resync old streams.
    if ((cursor < horizon && events[0]?.sequence !== cursor + 1) || events.some(event => !event.state || event.api_version !== EXTERNAL_PROVIDER_API || event.kind !== 'ExternalTaskEvent')) return snapshot()
    const next = events.at(-1)?.sequence ?? cursor
    if (next === horizon && next > cursor && isTerminal(String(row.status) as ExternalTask['status'])) return { ...await snapshot(), events }
    return { ...envelope, events, next_cursor: next, has_more: next < horizon }
  }

  private async projectMany(rows: TaskRow[]): Promise<ExternalTask[]> {
    const pending = rows.map(row => ({ row, checkpoint: (JSON.parse(row.document) as Checkpoint)._checkpoint_sequence ?? Number(row.sequence) }))
      .filter(({ row, checkpoint }) => checkpoint < Number(row.sequence))
    const grouped = new Map<string, SqlRow[]>()
    if (pending.length) {
      const events = await this.db.all(`SELECT task_id, document FROM task_events WHERE ${pending.map(() => '(task_id = ? AND sequence > ? AND sequence <= ?)').join(' OR ')} ORDER BY task_id, sequence`, pending.flatMap(({ row, checkpoint }) => [String(row.id), checkpoint, Number(row.sequence)]))
      for (const event of events) {
        const id = String(event.task_id), list = grouped.get(id) ?? []
        list.push(event); grouped.set(id, list)
      }
    }
    return Promise.all(rows.map(row => this.project(row, grouped.get(String(row.id)) ?? [])))
  }

  private async project(row: TaskRow, loaded?: SqlRow[]): Promise<ExternalTask> {
    if (row.task_runtime !== 'external') throw new ExternalProviderError(409, 'TASK_RUNTIME_MISMATCH')
    if (JSON.parse(row.document)._retired) throw new ExternalProviderError(410, 'TASK_HISTORY_EXPIRED')
    const { _checkpoint_sequence: checkpoint = Number(row.sequence), ...task } = JSON.parse(row.document) as Checkpoint
    if (![EXTERNAL_PROVIDER_API, 'external-provider.sudo.dev/v1alpha4', 'external-provider.sudo.dev/v1alpha3'].includes(task.api_version)) task.raw_answer_freshness = 'legacy_checkpoint'
    task.api_version = EXTERNAL_PROVIDER_API
    if (checkpoint >= Number(row.sequence)) return task
    const events = loaded ?? await this.db.all('SELECT document FROM task_events WHERE task_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence', [task.id, checkpoint, Number(row.sequence)])
    for (const row of events) {
      const event = JSON.parse(String(row.document)) as ExternalTaskEvent
      if (event.delta) task.answer = task.answer.slice(0, event.delta.offset) + event.delta.text
      if (event.raw_delta) task.raw_answer = 'from_answer' in event.raw_delta ? task.answer : task.raw_answer.slice(0, event.raw_delta.offset) + event.raw_delta.text
      Object.assign(task, event.state)
    }
    return task
  }

  async unresolved(orgId: string): Promise<ExternalTask[]> {
    await this.ready
    const rows = await this.db.all<TaskRow>("SELECT * FROM external_tasks t WHERE org_id = ? AND status = 'unknown' AND NOT EXISTS (SELECT 1 FROM external_pilot_reconciliations r WHERE r.task_id = t.id) ORDER BY deadline_at DESC LIMIT 100", [orgId])
    return (await this.projectMany(rows)).filter(task => !task.reconciliation)
  }

  async reconcileUnknown(actor: ExternalActor, id: string, note: string): Promise<ExternalTask> {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('UPDATE tasks SET sequence = sequence WHERE id = ? AND id IN (SELECT id FROM external_tasks) AND org_id = ?', [id, actor.orgId])
      const row = await this.db.get<TaskRow>('SELECT * FROM external_tasks WHERE id = ? AND org_id = ?', [id, actor.orgId])
      if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
      const task = await this.project(row)
      if (task.status !== 'unknown') throw new ExternalProviderError(409, 'TASK_NOT_UNKNOWN')
      if (task.reconciliation) return task
      task.reconciliation = { action: 'closed', note, user_id: actor.userId, created_at: Date.now() }
      await this.db.run('INSERT INTO external_pilot_reconciliations(task_id, attempt_id, document) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING', [task.id, task.attempt_id, JSON.stringify(task.reconciliation)])
      if (task.attempt_id) await this.db.run("UPDATE session_attempts SET runtime_state = 'lost', last_heartbeat_at = ? WHERE attempt_id = ?", [task.reconciliation.created_at, task.attempt_id])
      task.updated_at = Date.now()
      const sequence = Number(row.sequence) + 1
      await this.db.run('UPDATE tasks SET sequence = ?, document = ? WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [sequence, JSON.stringify({ ...task, _checkpoint_sequence: sequence }), id])
      await this.appendEvent(task, sequence, this.event(task, sequence, 'status'))
      await this.db.run('INSERT INTO external_pilot_admin_audit(id, org_id, user_id, action, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), actor.orgId, actor.userId, 'task.unknown_closed', id, Date.now()])
      // Closing records human verification, never success/cancellation. Keep the old
      // session fenced; the user must explicitly start a new provider conversation.
      return task
    })
  }

  async mutate(id: string, change: (task: ExternalTask) => ExternalTaskEvent['type'] | false, fence?: ExecutionFence): Promise<ExternalTask | null> {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('UPDATE tasks SET sequence = sequence WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [id])
      const row = await this.db.get<TaskRow>('SELECT * FROM external_tasks WHERE id = ?', [id])
      if (!row) return null
      const task = await this.project(row)
      if (fence && !await this.owns(task, fence)) return null
      if (!fence && task.attempt_id && task.deadline_at > await this.databaseNow()) {
        const lease = await this.db.get('SELECT token, lease_until FROM external_attempt_leases WHERE attempt_id = ?', [task.attempt_id])
        if (lease?.token && Number(lease.lease_until) > await this.databaseNow()) return null
      }
      const before = task.answer, rawBefore = task.raw_answer
      if (isTerminal(task.status)) return null
      const type = change(task)
      if (!type) return null
      task.updated_at = Date.now()
      const sequence = Number(row.sequence) + 1
      const previous = JSON.parse(row.document) as Checkpoint
      const checkpoint = previous._checkpoint_sequence ?? Number(row.sequence)
      const saveCheckpoint = isTerminal(task.status) || sequence - checkpoint >= 64 || Math.abs(task.answer.length - previous.answer.length) >= 8192 || Math.abs(task.raw_answer.length - previous.raw_answer.length) >= 8192
      if (saveCheckpoint) await this.db.run('UPDATE tasks SET status = ?, sequence = ?, document = ? WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [task.status, sequence, JSON.stringify({ ...task, _checkpoint_sequence: sequence }), id])
      else await this.db.run('UPDATE tasks SET status = ?, sequence = ? WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [task.status, sequence, id])
      await this.syncAttempt(task)
      await this.appendEvent(task, sequence, this.event(task, sequence, type, before, rawBefore))
      if (task.provider_refs.conversation_id) await this.db.run('UPDATE external_session_bindings SET conversation_id = ? WHERE id = ? AND active_task_id = ?', [task.provider_refs.conversation_id, task.session_id, id])
      if (isTerminal(task.status) && task.status !== 'unknown') await this.db.run('UPDATE external_session_bindings SET active_task_id = NULL WHERE id = ? AND active_task_id = ?', [task.session_id, id])
      return task
    })
  }

  async databaseNow(): Promise<number> {
    const row = await this.db.get(this.db.kind === 'postgres'
      ? 'SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT) AS now'
      : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now")
    return Number(row!.now)
  }

  async owns(task: ExternalTask, fence: ExecutionFence): Promise<boolean> {
    if (task.attempt_id !== fence.attemptId) return false
    return Boolean(await this.db.get(`SELECT a.attempt_id FROM session_attempts a
      JOIN sessions s ON s.current_attempt_id = a.attempt_id JOIN external_attempt_leases l ON l.attempt_id = a.attempt_id
      WHERE s.runtime_type = 'external' AND a.backend_type = 'external' AND a.attempt_id = ? AND a.server_instance_id = ? AND l.token = ? AND l.lease_until > ? AND s.session_id = ?`,
    [fence.attemptId, fence.ownerId, fence.token, await this.databaseNow(), task.session_id]))
  }

  async invocationContext(task: ExternalTask, fence: ExecutionFence, initial: { provider_session_id: string | null; end_user: string }) {
    return this.db.transaction(async () => {
      await this.db.run('UPDATE tasks SET sequence = sequence WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [task.id])
      if (!await this.owns(task, fence)) throw new ExternalProviderError(409, 'EXECUTION_OWNERSHIP_LOST')
      const row = await this.db.get('SELECT invocation_context FROM external_attempt_leases WHERE attempt_id = ?', [fence.attemptId])
      if (row?.invocation_context) return JSON.parse(String(row.invocation_context)) as typeof initial
      if (task.dispatch_authorized_at) throw new ExternalProviderError(409, 'INVOCATION_CONTEXT_MISSING')
      await this.db.run('UPDATE external_attempt_leases SET invocation_context = ? WHERE attempt_id = ? AND token = ?', [JSON.stringify(initial), fence.attemptId, fence.token])
      return initial
    })
  }

  private async syncAttempt(task: ExternalTask): Promise<void> {
    if (!task.attempt_id) return
    await this.db.run('UPDATE sessions SET last_active_at = ? WHERE session_id = ?', [task.updated_at, task.session_id])
    const generation = await this.db.get('SELECT COALESCE(MAX(generation), 0) AS generation FROM session_attempts WHERE session_id = ?', [task.session_id])
    await this.db.run(`INSERT INTO session_attempts(attempt_id, session_id, generation, backend_type, runtime_state, resume_transcript_session_id, started_at)
      VALUES (?, ?, ?, 'external', ?, ?, ?) ON CONFLICT(attempt_id) DO NOTHING`, [task.attempt_id, task.session_id, Number(generation?.generation) + 1, attemptState(task.status), task.session_id, task.created_at])
    await this.db.run('UPDATE session_attempts SET runtime_state = ?, last_heartbeat_at = ?, stopped_at = ? WHERE attempt_id = ?', [attemptState(task.status), task.updated_at, isTerminal(task.status) ? task.updated_at : null, task.attempt_id])
    await this.db.run('UPDATE tasks SET attempt_id = ? WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [task.attempt_id, task.id])
    await this.db.run("INSERT INTO external_attempt_leases(attempt_id, token, lease_until) VALUES (?, '', 0) ON CONFLICT(attempt_id) DO NOTHING", [task.attempt_id])
    await this.db.run(`UPDATE sessions SET current_attempt_id = ?, status = ? WHERE session_id = ? AND EXISTS
      (SELECT 1 FROM external_session_bindings x WHERE x.id = sessions.session_id AND x.active_task_id = ?)`,
    [task.attempt_id, task.status === 'unknown' ? 'lost' : isTerminal(task.status) ? 'detached' : 'active', task.session_id, task.id])
  }

  private async appendEvent(task: ExternalTask, sequence: number, event: ExternalTaskEvent): Promise<void> {
    await this.db.run(`INSERT INTO session_events(event_id, session_id, attempt_id, event_type, payload_json, created_at, task_id, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [`task:${task.id}:${sequence}`, task.session_id, task.attempt_id, `task.${event.type}`, JSON.stringify(event), event.created_at, task.id, sequence])
  }

  async scheduled(name: string, intervalMs: number, action: () => Promise<void>, now = Date.now()): Promise<boolean> {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('INSERT INTO external_pilot_maintenance(name, next_run_at) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', [name])
      const claimed = await this.db.run('UPDATE external_pilot_maintenance SET next_run_at = ? WHERE name = ? AND next_run_at <= ?', [now + intervalMs, name, now])
      if (!claimed) return false
      // Hold the row lock through the batch; rollback also releases a failed claim.
      await action()
      return true
    })
  }

  async expire(now = Date.now()): Promise<void> {
    await this.ready
    const rows = await this.db.all('SELECT id FROM external_tasks WHERE status IN (?, ?, ?) AND deadline_at <= ? LIMIT 100', ['accepted', 'dispatching', 'running', now])
    for (const row of rows) await this.mutate(String(row.id), task => {
      if (task.deadline_at > now || !['accepted', 'dispatching', 'running'].includes(task.status)) return false
      task.status = task.status === 'accepted' ? task.task_contract_version ? 'failed' : 'rejected' : 'unknown'
      task.error_code = ['rejected', 'failed'].includes(task.status) ? 'DISPATCH_DEADLINE' : 'EXECUTION_UNCONFIRMED'
      return 'status'
    })
  }

  private event(task: ExternalTask, sequence: number, type: ExternalTaskEvent['type'], before = '', rawBefore = ''): ExternalTaskEvent {
    let offset = 0
    while (offset < before.length && offset < task.answer.length && before[offset] === task.answer[offset]) offset++
    let rawOffset = 0
    while (rawOffset < rawBefore.length && rawOffset < task.raw_answer.length && rawBefore[rawOffset] === task.raw_answer[rawOffset]) rawOffset++
    return { api_version: EXTERNAL_PROVIDER_API, kind: 'ExternalTaskEvent', task_id: task.id, sequence, type, status: task.status,
      ...(rawBefore !== task.raw_answer ? { raw_delta: task.raw_answer === task.answer ? { from_answer: true as const } : { offset: rawOffset, text: task.raw_answer.slice(rawOffset) } } : {}),
      ...(before !== task.answer ? { delta: { offset, text: task.answer.slice(offset) } } : {}),
      state: { status: task.status, attempt_id: task.attempt_id, output_status: task.output_status, error_code: task.error_code, provider_refs: task.provider_refs, updated_at: task.updated_at, dispatch_authorized_at: task.dispatch_authorized_at, reconciliation: task.reconciliation },
      created_at: task.updated_at }
  }
}
