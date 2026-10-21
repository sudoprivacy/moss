import { initializeAssetControls, lockAssetGate, assetControlRevision } from './assetControlStore.js'
import type { HostedUnknownPage } from './inventoryViews.js'
import { randomUUID } from 'node:crypto'
import type { HostedEventsPage, HostedSession, HostedTask, HostedTaskEvent, TaskRecord, SubmitTask, TaskExecutionResolution } from '../../../contracts/task/v1alpha1/contract.js'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { digest, type ExternalActor } from '../externalProviders/store.js'
import { initializeExternalTaskPersistence } from './taskPersistence.js'
import { canonicalTaskJson, parseHostedTask, parseHostedTaskEvent, parseTaskRecord, parseTaskSubmission, TASK_API } from './taskContract.js'

function fail(code: string, status = 409): never { throw new ExternalProviderError(status, code) }
const terminal = (status: HostedTask['status']) => ['succeeded', 'failed', 'rejected', 'unknown', 'cancelled'].includes(status)
export interface HostedTaskFence { attemptId: string; ownerId: string; token: string }
export interface HostedTaskUpdate {
  native_verification?: HostedTask['native_verification']
  status?: 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
  answer?: string
  error_code?: string | null
  cleanup?: 'pending' | 'confirmed' | 'unknown'
}
export interface HostedTaskAdmission {
  controlRevision?: number
  assetId: string
  policySnapshot: unknown
  resolution: (task: HostedTask) => TaskExecutionResolution
  principal: TaskRecord['spec']['agent']['principal']
  timeoutMs: number
}

/** Canonical Task facts with a runtime-specific lease, never an alternate task authority. */
export class HostedTaskStore {
  readonly ready: Promise<void>
  constructor(readonly db: DbDriver) {
    this.ready = initializeExternalTaskPersistence(db).then(() => initializeAssetControls(db)).then(() => db.transaction(async () => {
      if (db.kind === 'postgres') await db.get("SELECT pg_advisory_xact_lock(hashtextextended('moss-hosted-task-schema-v1', 0))")
      await db.exec(`
      CREATE TABLE IF NOT EXISTS product_task_records (
        task_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
        document TEXT NOT NULL, policy_snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosted_task_capacity (org_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS hosted_session_bindings (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id), catalog_id TEXT NOT NULL,
        active_task_id TEXT
      );
      CREATE TABLE IF NOT EXISTS hosted_attempt_leases (
        attempt_id TEXT PRIMARY KEY REFERENCES session_attempts(attempt_id), token TEXT NOT NULL,
        lease_until BIGINT NOT NULL, grant_id TEXT
      );
    `)
    }))
  }
  async now(): Promise<number> {
    const row = await this.db.get(this.db.kind === 'postgres'
      ? 'SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT) AS now'
      : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now")
    return Number(row!.now)
  }
  private project(row: SqlRow): HostedTask {
    const task = parseHostedTask(JSON.parse(String(row.document)))
    if (task.api_version !== TASK_API || task.kind !== 'HostedTask' || task.id !== row.id
      || task.session_id !== row.session_id || task.status !== row.status || task.sequence !== Number(row.sequence)) fail('HOSTED_TASK_RECORD_INVALID', 500)
    return task
  }
  /** Must run before consulting current catalog/admission state on an idempotent retry. */
  async existing(actor: ExternalActor, input: SubmitTask): Promise<HostedTask | null> {
    await this.ready
    const row = await this.db.get(`SELECT t.*, s.runtime_type FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      WHERE t.org_id = ? AND t.user_id = ? AND t.idempotency_key = ?`, [actor.orgId, actor.userId, input.constraints.idempotency_key])
    if (!row) return null
    if (row.request_hash !== digest(canonicalTaskJson(input))) fail('IDEMPOTENCY_CONFLICT')
    if (row.runtime_type !== 'hosted') fail('TASK_RUNTIME_MISMATCH')
    return this.project(row)
  }
  async get(actor: ExternalActor, id: string): Promise<HostedTask> {
    await this.ready
    const row = await this.db.get(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      WHERE t.id = ? AND t.org_id = ? AND t.user_id = ? AND s.runtime_type = 'hosted'
      AND s.org_id = t.org_id AND s.user_id = t.user_id`, [id, actor.orgId, actor.userId])
    if (!row) fail('TASK_NOT_FOUND', 404)
    return this.project(row!)
  }
  async record(actor: ExternalActor, id: string): Promise<TaskRecord> {
    const task = await this.get(actor, id)
    const row = await this.db.get('SELECT document, policy_snapshot FROM product_task_records WHERE task_id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) fail('HOSTED_TASK_RECORD_INVALID', 500)
    const record = parseTaskRecord(JSON.parse(String(row!.document))), r = record.resolution
    if (record.spec.task_id !== id || record.spec.session_id !== task.session_id || record.spec.requested_by.subject_id !== actor.userId
      || r.policy_snapshot_digest !== digest(canonicalTaskJson(JSON.parse(String(row!.policy_snapshot))))
      || (r.status === 'accepted' && (r.execution_mode !== 'internal_hosted' || r.governance_org_id !== actor.orgId
        || r.attempt_id !== task.attempt_id || r.asset_id !== task.asset_id || r.catalog_id !== task.catalog_id))) fail('HOSTED_TASK_RECORD_INVALID', 500)
    if (r.status === 'accepted' && r.execution_mode === 'internal_hosted' && r.resolved_runtime === 'native_sudocode') {
      if (task.native_verification && (task.native_verification.profile_digest !== r.native_profile_digest
        || task.native_verification.output_digest !== digest(task.answer))) fail('HOSTED_TASK_RECORD_INVALID', 500)
      if (task.status === 'succeeded' && task.native_verification?.verdict !== 'passed') fail('HOSTED_TASK_RECORD_INVALID', 500)
    }
    return record
  }
  async create(actor: ExternalActor, value: unknown, admission: HostedTaskAdmission): Promise<HostedTask> {
    const input = parseTaskSubmission(value)
    await this.ready
    return this.db.transaction(async () => {
      const existing = await this.existing(actor, input)
      if (existing) return existing
      if (admission.controlRevision !== undefined) {
        await lockAssetGate(this.db, actor.orgId, admission.assetId)
        if (await assetControlRevision(this.db, actor.orgId, admission.assetId) !== admission.controlRevision) fail('AGENT_SUSPENSION_CHANGED')
      }
      if (!Number.isSafeInteger(admission.timeoutMs) || admission.timeoutMs < 100 || admission.timeoutMs > 300_000) fail('HOSTED_TASK_ADMISSION_INVALID', 500)
      await this.db.run('INSERT INTO hosted_task_capacity(org_id) VALUES (?) ON CONFLICT(org_id) DO NOTHING', [actor.orgId])
      await this.db.run('UPDATE hosted_task_capacity SET org_id = org_id WHERE org_id = ?', [actor.orgId])
      const replay = await this.existing(actor, input)
      if (replay) return replay
      const total = await this.db.get(`SELECT COUNT(*) AS total FROM tasks t JOIN sessions s ON s.session_id = t.session_id WHERE t.org_id = ? AND s.runtime_type = 'hosted'`, [actor.orgId])
      if (Number(total?.total) >= 10_000) fail('HOSTED_TASK_CAPACITY_REACHED', 429)
      for (const related of [input.parent_task_id, input.supersedes_task_id]) if (related) await this.get(actor, related)
      const now = await this.now(), id = randomUUID(), sessionId = input.session_id ?? randomUUID()
      const task: HostedTask = { api_version: TASK_API, kind: 'HostedTask', id, session_id: sessionId,
        catalog_id: input.agent.catalog_id, asset_id: admission.assetId, attempt_id: randomUUID(), status: 'accepted',
        query: input.input.instruction, answer: '', error_code: null, created_at: now, updated_at: now,
        deadline_at: Math.min(now + Math.min(admission.timeoutMs, input.constraints.timeout_ms ?? admission.timeoutMs), input.constraints.deadline ? Date.parse(input.constraints.deadline) : Infinity),
        sequence: 1, session_sequence: 1, cleanup: 'not_started', cancel_requested_at: null }
      const resolution = admission.resolution(structuredClone(task))
      if (resolution.status === 'accepted' && (task.deadline_at <= now || resolution.execution_mode !== 'internal_hosted' || resolution.limits.timeout_ms !== admission.timeoutMs)) fail('HOSTED_TASK_ADMISSION_INVALID', 500)
      if (resolution.status === 'rejected') { task.status = 'rejected'; task.attempt_id = null; task.error_code = resolution.reason_code }
      const { kind: _kind, agent, session_id: _session, ...rest } = input
      const record = parseTaskRecord({ api_version: TASK_API, kind: 'TaskRecord', spec: { ...rest, kind: 'TaskSpec', task_id: id, session_id: sessionId,
        created_at: new Date(now).toISOString(), requested_by: { subject_type: 'user', subject_id: actor.userId },
        agent: { principal: admission.principal, ...(agent.requested_version ? { requested_version: agent.requested_version } : {}),
          ...(agent.requested_channel ? { requested_channel: agent.requested_channel } : {}) } }, resolution })
      if (resolution.policy_snapshot_digest !== digest(canonicalTaskJson(admission.policySnapshot))
        || (resolution.status === 'accepted' && (resolution.execution_mode !== 'internal_hosted' || resolution.attempt_id !== task.attempt_id
          || resolution.governance_org_id !== actor.orgId || resolution.catalog_id !== task.catalog_id || resolution.asset_id !== task.asset_id))) fail('HOSTED_TASK_ADMISSION_INVALID', 500)
      // Unique key is shared with every task runtime and reserved before changing a session.
      const saved = await this.db.run(`INSERT INTO tasks(id, org_id, user_id, session_id, idempotency_key, request_hash, status, deadline_at, sequence, document)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(org_id, user_id, idempotency_key) DO NOTHING`,
      [id, actor.orgId, actor.userId, sessionId, input.constraints.idempotency_key, digest(canonicalTaskJson(input)), task.status, task.deadline_at, JSON.stringify(task)])
      if (!saved) return (await this.existing(actor, input)) ?? fail('IDEMPOTENCY_CONFLICT')
      if (!input.session_id) {
        await this.db.run(`INSERT INTO sessions(session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd, runtime_type,
          status, desired_state, transcript_path, title, source, created_at, last_active_at)
          VALUES (?, ?, ?, ?, 'user', '[]', '', 'hosted', 'detached', 'active', '', ?, 'hosted_artifact', ?, ?)`,
        [sessionId, sessionId, actor.orgId, actor.userId, task.query.slice(0, 100), now, now])
        await this.db.run('INSERT INTO hosted_session_bindings(session_id, catalog_id) VALUES (?, ?)', [sessionId, task.catalog_id])
      }
      const session = await this.db.run(`UPDATE sessions SET last_active_at = ? WHERE session_id = ? AND org_id = ? AND user_id = ? AND runtime_type = 'hosted'
        AND desired_state = 'active'
        AND EXISTS (SELECT 1 FROM hosted_session_bindings b WHERE b.session_id = sessions.session_id AND b.catalog_id = ? AND b.active_task_id IS NULL)`,
      [now, sessionId, actor.orgId, actor.userId, task.catalog_id])
      if (!session) fail('SESSION_BUSY_OR_AGENT_MISMATCH')
      if (resolution.status === 'accepted') {
        const first = await this.db.get(`SELECT t.id FROM tasks t JOIN session_attempts a ON a.attempt_id = t.attempt_id
          WHERE t.session_id = ? AND t.id <> ? ORDER BY a.generation LIMIT 1`, [sessionId, id])
        if (first) {
          const previous = (await this.record(actor, String(first.id))).resolution
          if (previous.status !== 'accepted' || previous.agent.version !== resolution.agent.version
            || previous.agent.release_digest !== resolution.agent.release_digest) fail('VERSION_CHANGE_REQUIRES_NEW_SESSION')
        }
      }
      const count = Number((await this.db.get('SELECT COUNT(*) AS total FROM tasks WHERE session_id = ?', [sessionId]))?.total)
      if (count > 200) fail('SESSION_TASK_LIMIT')
      task.session_sequence = count
      if (task.attempt_id) {
        await this.db.run('UPDATE hosted_session_bindings SET active_task_id = ? WHERE session_id = ?', [id, sessionId])
        const generation = Number((await this.db.get('SELECT COALESCE(MAX(generation), 0) AS total FROM session_attempts WHERE session_id = ?', [sessionId]))?.total) + 1
        await this.db.run(`INSERT INTO session_attempts(attempt_id, session_id, generation, backend_type, runtime_state, resume_transcript_session_id, started_at)
          VALUES (?, ?, ?, 'hosted', 'starting', ?, ?)`, [task.attempt_id, sessionId, generation, sessionId, now])
        await this.db.run("INSERT INTO hosted_attempt_leases(attempt_id, token, lease_until) VALUES (?, '', 0)", [task.attempt_id])
        await this.db.run("UPDATE sessions SET current_attempt_id = ?, status = 'active' WHERE session_id = ?", [task.attempt_id, sessionId])
      }
      parseHostedTask(task)
      await this.db.run('UPDATE tasks SET document = ?, attempt_id = ? WHERE id = ?', [JSON.stringify(task), task.attempt_id, id])
      await this.db.run('INSERT INTO product_task_records(task_id, org_id, user_id, document, policy_snapshot) VALUES (?, ?, ?, ?, ?)',
        [id, actor.orgId, actor.userId, JSON.stringify(record), canonicalTaskJson(admission.policySnapshot)])
      await this.append(task, 'status')
      return task
    })
  }
  private async lock(actor: ExternalActor, id: string): Promise<HostedTask> {
    await this.db.run(`UPDATE tasks SET sequence = sequence WHERE id = ? AND org_id = ? AND user_id = ?
      AND session_id IN (SELECT session_id FROM sessions WHERE runtime_type = 'hosted')`, [id, actor.orgId, actor.userId])
    return this.get(actor, id)
  }
  async claim(actor: ExternalActor, id: string, ownerId: string): Promise<{ task: HostedTask; fence: HostedTaskFence } | null> {
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id), now = await this.now()
      const owner = await this.db.get("SELECT instance_id FROM server_instances WHERE instance_id = ? AND status = 'running' AND pid = ? AND heartbeat_at > ?", [ownerId, process.pid, now - 30_000])
      if (!owner) fail('EXECUTION_OWNER_UNAVAILABLE')
      if (task.status !== 'accepted' || !task.attempt_id || task.deadline_at <= now) return null
      const fence = { attemptId: task.attempt_id, ownerId, token: randomUUID() }
      await this.db.run('UPDATE hosted_attempt_leases SET token = ?, lease_until = ? WHERE attempt_id = ?', [fence.token, Math.min(now + 30_000, task.deadline_at), task.attempt_id])
      await this.db.run('UPDATE session_attempts SET server_instance_id = ? WHERE attempt_id = ?', [ownerId, task.attempt_id])
      task.status = 'dispatching'; task.cleanup = 'pending'
      await this.save(task)
      return { task, fence }
    })
  }
  private async owned(task: HostedTask, fence: HostedTaskFence): Promise<boolean> {
    if (task.attempt_id !== fence.attemptId) return false
    return Boolean(await this.db.get(`SELECT a.attempt_id FROM session_attempts a JOIN hosted_attempt_leases l ON l.attempt_id = a.attempt_id
      JOIN sessions s ON s.current_attempt_id = a.attempt_id JOIN server_instances c ON c.instance_id = a.server_instance_id
      WHERE s.session_id = ? AND s.runtime_type = 'hosted' AND a.backend_type = 'hosted' AND a.server_instance_id = ?
      AND c.status = 'running' AND c.heartbeat_at > ? AND a.attempt_id = ? AND l.token = ? AND l.lease_until > ?`,
    [task.session_id, fence.ownerId, await this.now() - 30_000, fence.attemptId, fence.token, await this.now()]))
  }
  async update(actor: ExternalActor, id: string, fence: HostedTaskFence, patch: HostedTaskUpdate): Promise<HostedTask | null> {
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (terminal(task.status) || task.deadline_at <= await this.now() || !await this.owned(task, fence)) return null
      if (Object.keys(patch).some(key => !['status', 'answer', 'error_code', 'cleanup', 'native_verification'].includes(key))
        || (patch.status !== undefined && !['running', 'succeeded', 'failed', 'unknown', 'cancelled'].includes(patch.status))
        || (patch.cleanup !== undefined && !['pending', 'confirmed', 'unknown'].includes(patch.cleanup))
        || (patch.error_code != null && !/^[A-Z][A-Z0-9_]{0,127}$/.test(patch.error_code))
        || (patch.answer !== undefined && typeof patch.answer !== 'string')) fail('INVALID_HOSTED_TASK_UPDATE', 500)
      const { resolution } = await this.record(actor, id)
      Object.assign(task, patch)
      if (resolution.status === 'accepted' && resolution.execution_mode === 'internal_hosted' && resolution.resolved_runtime === 'native_sudocode') {
        const verified = task.native_verification
        if (verified && (verified.profile_digest !== resolution.native_profile_digest || verified.output_digest !== digest(task.answer)
          || (verified.verdict === 'passed') !== (verified.failures.length === 0))) fail('HOSTED_TASK_VERIFICATION_INVALID')
        if (task.status === 'succeeded' && verified?.verdict !== 'passed') fail('HOSTED_TASK_COMPLETION_UNCONFIRMED')
      } else if (task.native_verification) fail('HOSTED_TASK_VERIFICATION_INVALID')
      if (Buffer.byteLength(task.answer) > 128_000) fail('HOSTED_OUTPUT_LIMIT')
      if (task.status === 'succeeded' && (task.cancel_requested_at !== null || task.cleanup !== 'confirmed')) fail('HOSTED_TASK_COMPLETION_UNCONFIRMED')
      if (task.status === 'cancelled' && (task.cancel_requested_at === null || task.cleanup !== 'confirmed')) fail('HOSTED_TASK_CANCELLATION_UNCONFIRMED')
      await this.save(task)
      return task
    })
  }
  async renew(actor: ExternalActor, id: string, fence: HostedTaskFence): Promise<boolean> {
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id), now = await this.now()
      if (terminal(task.status) || task.cancel_requested_at !== null || task.deadline_at <= now || !await this.owned(task, fence)) return false
      await this.db.run('UPDATE hosted_attempt_leases SET lease_until = ? WHERE attempt_id = ? AND token = ?', [Math.min(now + 30_000, task.deadline_at), fence.attemptId, fence.token])
      await this.db.run('UPDATE session_attempts SET last_heartbeat_at = ? WHERE attempt_id = ?', [now, fence.attemptId])
      return true
    })
  }
  async assertActive(actor: ExternalActor, id: string, fence: HostedTaskFence): Promise<void> {
    const task = await this.get(actor, id)
    if (terminal(task.status) || task.cancel_requested_at !== null || task.deadline_at <= await this.now() || !await this.owned(task, fence)) fail('EXECUTION_OWNERSHIP_LOST')
  }
  async trace(actor: ExternalActor, id: string, fence: HostedTaskFence, trace: NonNullable<HostedTaskEvent['trace']>): Promise<boolean> {
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (terminal(task.status) || task.cancel_requested_at !== null || !await this.owned(task, fence)) return false
      if (task.sequence >= 1024) fail('HOSTED_TRACE_LIMIT')
      await this.save(task, trace)
      return true
    })
  }
  async cancel(actor: ExternalActor, id: string): Promise<HostedTask> {
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (terminal(task.status) || task.cancel_requested_at !== null) return task
      task.cancel_requested_at = await this.now()
      if (task.status === 'accepted') { task.status = 'cancelled'; task.error_code = 'CANCELLED_BEFORE_DISPATCH' }
      await this.save(task)
      return task
    })
  }
  /** Conservatively stop ambiguous executions. Never reclaim a started task for dispatch. */
  async recoverExpired(): Promise<number> {
    await this.ready
    const now = await this.now()
    const rows = await this.db.all(`SELECT t.id, t.org_id, t.user_id FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      LEFT JOIN hosted_attempt_leases l ON l.attempt_id = t.attempt_id
      WHERE s.runtime_type = 'hosted' AND t.status IN ('accepted', 'dispatching', 'running')
        AND (t.deadline_at <= ? OR (t.status <> 'accepted' AND (l.attempt_id IS NULL OR l.lease_until <= ?)))
      ORDER BY t.deadline_at, t.id LIMIT 100`, [now, now])
    let changed = 0
    for (const row of rows) await this.db.transaction(async () => {
      const task = await this.lock({ orgId: String(row.org_id), userId: String(row.user_id) }, String(row.id))
      if (terminal(task.status)) return
      const lease = await this.db.get('SELECT lease_until FROM hosted_attempt_leases WHERE attempt_id = ?', [task.attempt_id])
      const expired = task.deadline_at <= await this.now()
      if (!expired && (task.status === 'accepted' || (lease && Number(lease.lease_until) > await this.now()))) return
      if (task.status === 'accepted') { task.status = 'failed'; task.error_code = 'DISPATCH_DEADLINE' }
      else { task.status = 'unknown'; task.error_code = 'HOSTED_EXECUTION_UNCONFIRMED'; task.cleanup = 'unknown' }
      await this.save(task); changed++
    })
    return changed
  }
  async bindGrant(actor: ExternalActor, id: string, fence: HostedTaskFence, grantId: string): Promise<boolean> {
    await this.ready
    if (!/^[A-Za-z0-9_.:@-]{1,150}$/.test(grantId)) fail('INVALID_EXECUTION_GRANT')
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (terminal(task.status) || task.cancel_requested_at !== null || !await this.owned(task, fence)) return false
      const changed = await this.db.run('UPDATE hosted_attempt_leases SET grant_id = ? WHERE attempt_id = ? AND (grant_id IS NULL OR grant_id = ?)', [grantId, fence.attemptId, grantId])
      if (!changed) fail('EXECUTION_GRANT_CONFLICT')
      return true
    })
  }
  async failUndispatched(actor: ExternalActor, id: string, code: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) fail('INVALID_HOSTED_TASK_UPDATE', 500)
    await this.ready
    await this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (task.status !== 'accepted') return
      task.status = 'failed'; task.error_code = code
      await this.save(task)
    })
  }
  async pending(limit = 100): Promise<{ actor: ExternalActor; task: HostedTask }[]> {
    await this.ready
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT', 400)
    const rows = await this.db.all(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      WHERE s.runtime_type = 'hosted' AND s.org_id = t.org_id AND s.user_id = t.user_id
      AND t.status = 'accepted' AND t.deadline_at > ? ORDER BY t.deadline_at, t.id LIMIT ?`, [await this.now(), limit])
    return rows.map(row => ({ actor: { orgId: String(row.org_id), userId: String(row.user_id) }, task: this.project(row) }))
  }
  async sessions(actor: ExternalActor): Promise<HostedSession[]> {
    await this.ready
    const rows = await this.db.all(`SELECT s.session_id, s.title, s.last_active_at, s.status, s.desired_state, b.catalog_id
      FROM sessions s JOIN hosted_session_bindings b ON b.session_id = s.session_id
      WHERE s.org_id = ? AND s.user_id = ? AND s.runtime_type = 'hosted' ORDER BY s.last_active_at DESC, s.session_id LIMIT 200`, [actor.orgId, actor.userId])
    return rows.map(row => ({ id: String(row.session_id), agent_id: String(row.catalog_id), title: String(row.title ?? ''),
      updated_at: Number(row.last_active_at), status: String(row.status), closed: row.desired_state === 'stopped' }))
  }
  async history(actor: ExternalActor, sessionId: string) {
    await this.ready
    const session = await this.db.get("SELECT session_id FROM sessions WHERE session_id = ? AND org_id = ? AND user_id = ? AND runtime_type = 'hosted'", [sessionId, actor.orgId, actor.userId])
    if (!session) fail('SESSION_NOT_FOUND', 404)
    const rows = await this.db.all('SELECT * FROM tasks WHERE session_id = ? AND org_id = ? AND user_id = ? ORDER BY id', [sessionId, actor.orgId, actor.userId])
    return rows.map(row => this.project(row)).sort((a, b) => a.session_sequence - b.session_sequence)
  }
  async grant(actor: ExternalActor, id: string): Promise<string | null> {
    const task = await this.get(actor, id)
    const row = await this.db.get('SELECT grant_id FROM hosted_attempt_leases WHERE attempt_id = ?', [task.attempt_id])
    return row?.grant_id == null ? null : String(row.grant_id)
  }
  async confirmCleanup(actor: ExternalActor, id: string, attemptId: string): Promise<HostedTask> {
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (task.status !== 'unknown' || task.attempt_id !== attemptId) fail('HOSTED_RECONCILIATION_CONFLICT')
      if (task.cleanup !== 'confirmed') { task.cleanup = 'confirmed'; await this.save(task) }
      return task
    })
  }
  /** Closing acknowledges uncertainty. It never changes the outcome or enables this session again. */
  async unknowns(orgId: string, after = ''): Promise<HostedUnknownPage> {
    await this.ready
    if (after && !/^[A-Za-z0-9_-]{1,100}$/.test(after)) fail('INVALID_CURSOR', 400)
    const rows = await this.db.all(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      WHERE t.org_id = ? AND s.org_id = t.org_id AND s.user_id = t.user_id AND s.runtime_type = 'hosted'
        AND t.status = 'unknown' AND s.desired_state <> 'stopped' AND t.id > ? ORDER BY t.id LIMIT 51`, [orgId, after])
    return { items: rows.slice(0, 50).map(row => {
      const task = this.project(row)
      return { task_id: task.id, session_id: task.session_id, catalog_id: task.catalog_id, asset_id: task.asset_id,
        user_id: String(row.user_id), updated_at: task.updated_at, cleanup: task.cleanup, error_code: task.error_code }
    }), next_cursor: rows.length > 50 ? String(rows[49].id) : null }
  }
  /** Called only after current organization-admin authorization; owner is read from durable state. */
  async forAsset(orgId: string, assetId: string) {
    await this.ready
    const extract = this.db.kind === 'postgres' ? "t.document::jsonb ->> 'asset_id'" : "json_extract(t.document, '$.asset_id')"
    const rows = await this.db.all(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      WHERE t.org_id = ? AND s.org_id = t.org_id AND s.user_id = t.user_id AND s.runtime_type = 'hosted'
      AND (${extract}) = ? ORDER BY t.id LIMIT 10001`, [orgId, assetId])
    if (rows.length > 10000) fail('HOSTED_TASK_SCAN_INCOMPLETE', 503)
    return rows.map(row => ({ actor: { orgId, userId: String(row.user_id) }, task: this.project(row) }))
  }
  async managementOwner(orgId: string, id: string): Promise<ExternalActor> {
    await this.ready
    const row = await this.db.get(`SELECT t.user_id FROM tasks t JOIN sessions s ON s.session_id = t.session_id
      WHERE t.org_id = ? AND t.id = ? AND s.org_id = t.org_id AND s.user_id = t.user_id AND s.runtime_type = 'hosted'`, [orgId, id])
    if (!row) fail('TASK_NOT_FOUND', 404)
    return { orgId, userId: String(row.user_id) }
  }
  async auditManagement(operator: ExternalActor, owner: ExternalActor, id: string, action: 'reconcile' | 'close' | 'suspend') {
    if (operator.orgId !== owner.orgId) fail('TASK_NOT_FOUND', 404)
    const task = await this.get(owner, id)
    await this.db.run(`INSERT INTO session_events(event_id, session_id, attempt_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'hosted.management_requested', ?, ?)`, [randomUUID(), task.session_id, task.attempt_id,
      JSON.stringify({ task_id: id, operator_user_id: operator.userId, task_user_id: owner.userId, org_id: operator.orgId, action }), await this.now()])
  }
  async closeUnknown(actor: ExternalActor, id: string, note: string, operator?: ExternalActor): Promise<HostedTask> {
    if (operator && operator.orgId !== actor.orgId) fail('TASK_NOT_FOUND', 404)
    if (typeof note !== 'string' || note.trim().length < 10 || note.length > 2000) fail('INVALID_RECONCILIATION', 400)
    await this.ready
    return this.db.transaction(async () => {
      const task = await this.lock(actor, id)
      if (task.status !== 'unknown' || task.cleanup !== 'confirmed') fail('HOSTED_CLEANUP_UNCONFIRMED')
      const eventId = `hosted-reconciliation:${id}`
      await this.db.run(`INSERT INTO session_events(event_id, session_id, attempt_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, 'hosted.reconciled', ?, ?) ON CONFLICT(event_id) DO NOTHING`, [eventId, task.session_id, task.attempt_id,
        JSON.stringify({ task_id: id, user_id: operator?.userId ?? actor.userId, task_user_id: actor.userId, performed_as: operator ? 'org_admin' : 'task_owner', note: note.trim(), outcome: 'unknown' }), await this.now()])
      await this.db.run("UPDATE sessions SET desired_state = 'stopped', status = 'detached' WHERE session_id = ?", [task.session_id])
      return task
    })
  }
  async tracePage(actor: ExternalActor, id: string, cursor: number, horizon: number) {
    await this.get(actor, id)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > horizon) fail('INVALID_CURSOR', 400)
    const rows = await this.db.all(`SELECT payload_json FROM session_events WHERE task_id = ? AND event_type = 'task.trace'
      AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 101`, [id, cursor, horizon])
    const events = rows.slice(0, 100).map(row => parseHostedTaskEvent(JSON.parse(String(row.payload_json))))
    if (events.some(event => event.task_id !== id || !event.trace)) fail('HOSTED_TASK_EVENT_INVALID', 500)
    const hasMore = rows.length > 100
    return { trace: events.map(event => ({ sequence: event.sequence, created_at: event.created_at, ...event.trace! })),
      trace_next_cursor: hasMore ? events.at(-1)!.sequence : horizon, trace_has_more: hasMore }
  }
  async events(actor: ExternalActor, id: string, cursor: number): Promise<HostedEventsPage> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail('INVALID_CURSOR', 400)
    const task = await this.get(actor, id), horizon = task.sequence
    if (cursor === 0 || cursor > horizon) return { api_version: TASK_API, kind: 'HostedEventsPage', task, snapshot_sequence: horizon, events: [], next_cursor: horizon, has_more: false }
    const rows = await this.db.all('SELECT payload_json FROM session_events WHERE task_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 100', [id, cursor, horizon])
    const events = rows.map(row => parseHostedTaskEvent(JSON.parse(String(row.payload_json))))
    if (cursor < horizon && events[0]?.sequence !== cursor + 1) return { api_version: TASK_API, kind: 'HostedEventsPage', task, snapshot_sequence: horizon, events: [], next_cursor: horizon, has_more: false }
    const next = events.at(-1)?.sequence ?? cursor
    return { api_version: TASK_API, kind: 'HostedEventsPage', events, next_cursor: next, has_more: next < horizon }
  }
  private async save(task: HostedTask, trace?: HostedTaskEvent['trace']): Promise<void> {
    task.sequence++; task.updated_at = await this.now()
    parseHostedTask(task)
    await this.db.run('UPDATE tasks SET status = ?, sequence = ?, document = ? WHERE id = ?', [task.status, task.sequence, JSON.stringify(task), task.id])
    if (task.attempt_id) await this.db.run('UPDATE session_attempts SET runtime_state = ?, last_heartbeat_at = ?, stopped_at = ? WHERE attempt_id = ?',
      [task.status === 'unknown' ? 'lost' : terminal(task.status) ? task.status === 'succeeded' || task.status === 'cancelled' ? 'stopped' : 'failed' : task.status === 'running' ? 'running' : 'starting', task.updated_at, terminal(task.status) ? task.updated_at : null, task.attempt_id])
    // Unknown/unclean tasks retain the session fence; a new task cannot overlap a surviving container.
    if (terminal(task.status) && task.status !== 'unknown' && ['not_started', 'confirmed'].includes(task.cleanup)) {
      await this.db.run('UPDATE hosted_session_bindings SET active_task_id = NULL WHERE session_id = ? AND active_task_id = ?', [task.session_id, task.id])
    }
    await this.db.run('UPDATE sessions SET status = ?, last_active_at = ? WHERE session_id = ?', [task.status === 'unknown' ? 'lost' : terminal(task.status) ? 'detached' : 'active', task.updated_at, task.session_id])
    await this.append(task, trace ? 'trace' : 'status', trace)
  }
  private async append(task: HostedTask, type: HostedTaskEvent['type'], trace?: HostedTaskEvent['trace']): Promise<void> {
    const event: HostedTaskEvent = { api_version: TASK_API, kind: 'HostedTaskEvent', task_id: task.id, sequence: task.sequence, created_at: task.updated_at, type, task, ...(trace ? { trace } : {}) }
    parseHostedTaskEvent(event)
    await this.db.run(`INSERT INTO session_events(event_id, session_id, attempt_id, event_type, payload_json, created_at, task_id, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [`task:${task.id}:${task.sequence}`, task.session_id, task.attempt_id, `task.${type}`, JSON.stringify(event), task.updated_at, task.id, task.sequence])
  }
}
