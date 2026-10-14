import { randomUUID, createHash } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { sessionAgentName } from '../agentIdentity.js'
import { EXTERNAL_PROVIDER_API, type ExternalEventsPage, type CreateExternalTask, type ExternalTask, type ExternalTaskEvent, type ExternalSession, type RegisterExternalAgent } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalProviderError } from './policy.js'

export interface ExternalActor { orgId: string; userId: string }
export interface Binding extends RegisterExternalAgent { id: string; orgId: string; connectionId: string; approved: boolean; parametersDigest: string | null; reviewedBy: string | null; revision?: number; definitionProfileVersion?: number; archived?: boolean; credentialUpdating?: boolean; credentialVersion?: number; credentialRecoveryRequired?: boolean; credentialOperationId?: string; registrationMode?: 'onboarding' | 'reference_compat' }
type Checkpoint = ExternalTask & { _checkpoint_sequence?: number }
type TaskRow = SqlRow & { document: string; sequence: number; request_hash: string }
type SessionRow = SqlRow & { id: string; agent_id: string; agent_name: string; title: string; active_task_id: string | null; conversation_id: string | null; created_at: number; updated_at: number }
export const isTerminal = (status: ExternalTask['status']): boolean => ['succeeded', 'failed', 'rejected', 'unknown'].includes(status)
export const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`

export class ExternalTaskStore {
  readonly ready: Promise<void>
  constructor(readonly db: DbDriver) {
    this.ready = db.exec(`
      CREATE TABLE IF NOT EXISTS external_pilot_policy (org_id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_pilot_admin_operations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_pilot_operations (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, status TEXT NOT NULL, lease_until BIGINT NOT NULL, document TEXT NOT NULL,
        UNIQUE(org_id, kind, request_id)
      );
      CREATE INDEX IF NOT EXISTS external_pilot_operations_pending ON external_pilot_operations(status, lease_until);
      CREATE TABLE IF NOT EXISTS external_pilot_admin_audit (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_pilot_bindings (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, document TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS external_pilot_reconciliations (
        task_id TEXT PRIMARY KEY, attempt_id TEXT, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_pilot_events (
        task_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(task_id, sequence)
      );
    `).then(async () => {
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

  async bindings(actor: ExternalActor): Promise<Binding[]> {
    await this.ready
    return (await this.db.all('SELECT document FROM external_pilot_bindings WHERE org_id = ? ORDER BY id LIMIT 100', [actor.orgId])).map(row => JSON.parse(String(row.document)))
  }

  async saveBinding(binding: Binding): Promise<void> {
    await this.ready
    await this.db.run('INSERT INTO external_pilot_bindings(id, org_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document', [binding.id, binding.orgId, JSON.stringify(binding)])
  }

  async create(actor: ExternalActor, input: CreateExternalTask, binding: Binding, timeoutMs: number): Promise<ExternalTask> {
    await this.ready
    const hash = digest(JSON.stringify([input.agent_id, input.session_id ?? null, input.query]))
    return this.db.transaction(async () => {
      // Reserve the idempotency key before touching a session. ON CONFLICT also serializes concurrent retries on PG.
      const id = randomUUID(), sessionId = input.session_id ?? randomUUID(), now = Date.now()
      const task: ExternalTask = {
        api_version: EXTERNAL_PROVIDER_API, id, session_id: sessionId, agent_id: binding.id,
        agent_name: sessionAgentName(actor.userId, binding.id), attempt_id: null, status: 'accepted',
        configuration_revision: binding.revision ?? 1, query: input.query, answer: '', raw_answer: '', raw_answer_freshness: 'current', output_status: 'pending', error_code: null,
        source_digest: binding.source_digest, provider: 'dify', provider_refs: {},
        cancellation: { status: 'unsupported', reason: 'Provider termination cannot be confirmed in this pilot' },
        created_at: now, updated_at: now, deadline_at: now + timeoutMs,
      }
      const inserted = await this.db.run(`INSERT INTO external_pilot_tasks
        (id, org_id, user_id, session_id, idempotency_key, request_hash, status, deadline_at, sequence, document)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(org_id, user_id, idempotency_key) DO NOTHING`,
      [id, actor.orgId, actor.userId, sessionId, input.idempotency_key, hash, task.status, task.deadline_at, JSON.stringify({ ...task, _checkpoint_sequence: 1 })])
      if (!inserted) {
        const existing = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE org_id = ? AND user_id = ? AND idempotency_key = ?', [actor.orgId, actor.userId, input.idempotency_key])
        if (!existing || existing.request_hash !== hash) throw new ExternalProviderError(409, 'IDEMPOTENCY_CONFLICT')
        return this.project(existing)
      }
      if (!input.session_id) {
        await this.db.run(`INSERT INTO external_pilot_sessions
          (id, org_id, user_id, agent_id, agent_name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, actor.orgId, actor.userId, binding.id, task.agent_name, input.query.slice(0, 100), now, now])
      }
      const locked = await this.db.run(`UPDATE external_pilot_sessions SET active_task_id = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND user_id = ? AND agent_id = ? AND active_task_id IS NULL`,
      [id, now, sessionId, actor.orgId, actor.userId, binding.id])
      if (!locked) {
        await this.session(actor, sessionId)
        throw new ExternalProviderError(409, 'SESSION_BUSY_OR_AGENT_MISMATCH')
      }
      const count = await this.db.get('SELECT COUNT(*) AS total FROM external_pilot_tasks WHERE session_id = ?', [sessionId])
      if (Number(count?.total) > 200) throw new ExternalProviderError(409, 'SESSION_TASK_LIMIT')
      await this.db.run('INSERT INTO external_pilot_events(task_id, sequence, document) VALUES (?, 1, ?)', [id, JSON.stringify(this.event(task, 1, 'status'))])
      return task
    })
  }

  async session(actor: ExternalActor, id: string): Promise<SessionRow> {
    await this.ready
    const row = await this.db.get<SessionRow>('SELECT * FROM external_pilot_sessions WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'SESSION_NOT_FOUND')
    return row
  }

  async sessions(actor: ExternalActor): Promise<ExternalSession[]> {
    await this.ready
    const rows = await this.db.all<SessionRow>('SELECT * FROM external_pilot_sessions WHERE org_id = ? AND user_id = ? ORDER BY updated_at DESC, id LIMIT 100', [actor.orgId, actor.userId])
    return rows.map(row => ({ id: row.id, agent_id: row.agent_id, agent_name: row.agent_name, title: row.title, active_task_id: row.active_task_id, created_at: Number(row.created_at), updated_at: Number(row.updated_at) }))
  }

  async history(actor: ExternalActor, sessionId: string): Promise<ExternalTask[]> {
    await this.session(actor, sessionId)
    const rows = await this.db.all<TaskRow>('SELECT * FROM external_pilot_tasks WHERE session_id = ? ORDER BY deadline_at, id LIMIT 200', [sessionId])
    return this.projectMany(rows)
  }

  async task(actor: ExternalActor, id: string): Promise<ExternalTask> {
    await this.ready
    const row = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
    return this.project(row)
  }

  async events(actor: ExternalActor, id: string, cursor: number): Promise<ExternalEventsPage> {
    await this.ready
    // The row fixes a committed sequence horizon. Later appends are excluded from
    // both the snapshot projection and the page; ordinary reads acquire no write lock.
    const row = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
    const horizon = Number(row.sequence)
    const envelope = { api_version: EXTERNAL_PROVIDER_API, kind: 'ExternalEventsPage' as const }
    const snapshot = async () => ({ ...envelope, task: await this.project(row), snapshot_sequence: horizon, events: [], next_cursor: horizon, has_more: false })
    if (cursor === 0 || cursor > horizon) return snapshot()
    const rows = await this.db.all('SELECT document FROM external_pilot_events WHERE task_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 100', [id, cursor, horizon])
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
      const events = await this.db.all(`SELECT task_id, document FROM external_pilot_events WHERE ${pending.map(() => '(task_id = ? AND sequence > ? AND sequence <= ?)').join(' OR ')} ORDER BY task_id, sequence`, pending.flatMap(({ row, checkpoint }) => [String(row.id), checkpoint, Number(row.sequence)]))
      for (const event of events) {
        const id = String(event.task_id), list = grouped.get(id) ?? []
        list.push(event); grouped.set(id, list)
      }
    }
    return Promise.all(rows.map(row => this.project(row, grouped.get(String(row.id)) ?? [])))
  }

  private async project(row: TaskRow, loaded?: SqlRow[]): Promise<ExternalTask> {
    const { _checkpoint_sequence: checkpoint = Number(row.sequence), ...task } = JSON.parse(row.document) as Checkpoint
    if (![EXTERNAL_PROVIDER_API, 'external-provider.sudo.dev/v1alpha3'].includes(task.api_version)) task.raw_answer_freshness = 'legacy_checkpoint'
    task.api_version = EXTERNAL_PROVIDER_API
    if (checkpoint >= Number(row.sequence)) return task
    const events = loaded ?? await this.db.all('SELECT document FROM external_pilot_events WHERE task_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence', [task.id, checkpoint, Number(row.sequence)])
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
    const rows = await this.db.all<TaskRow>("SELECT * FROM external_pilot_tasks t WHERE org_id = ? AND status = 'unknown' AND NOT EXISTS (SELECT 1 FROM external_pilot_reconciliations r WHERE r.task_id = t.id) ORDER BY deadline_at DESC LIMIT 100", [orgId])
    return (await this.projectMany(rows)).filter(task => !task.reconciliation)
  }

  async reconcileUnknown(actor: ExternalActor, id: string, note: string): Promise<ExternalTask> {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('UPDATE external_pilot_tasks SET sequence = sequence WHERE id = ? AND org_id = ?', [id, actor.orgId])
      const row = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE id = ? AND org_id = ?', [id, actor.orgId])
      if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
      const task = await this.project(row)
      if (task.status !== 'unknown') throw new ExternalProviderError(409, 'TASK_NOT_UNKNOWN')
      if (task.reconciliation) return task
      task.reconciliation = { action: 'closed', note, user_id: actor.userId, created_at: Date.now() }
      await this.db.run('INSERT INTO external_pilot_reconciliations(task_id, attempt_id, document) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING', [task.id, task.attempt_id, JSON.stringify(task.reconciliation)])
      if (task.attempt_id) await this.db.run("UPDATE external_pilot_attempts SET status = 'unknown', updated_at = ? WHERE task_id = ?", [task.reconciliation.created_at, task.id])
      task.updated_at = Date.now()
      const sequence = Number(row.sequence) + 1
      await this.db.run('UPDATE external_pilot_tasks SET sequence = ?, document = ? WHERE id = ?', [sequence, JSON.stringify({ ...task, _checkpoint_sequence: sequence }), id])
      await this.db.run('INSERT INTO external_pilot_events(task_id, sequence, document) VALUES (?, ?, ?)', [id, sequence, JSON.stringify(this.event(task, sequence, 'status'))])
      await this.db.run('INSERT INTO external_pilot_admin_audit(id, org_id, user_id, action, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), actor.orgId, actor.userId, 'task.unknown_closed', id, Date.now()])
      // Closing records human verification, never success/cancellation. Keep the old
      // session fenced; the user must explicitly start a new provider conversation.
      return task
    })
  }

  async mutate(id: string, change: (task: ExternalTask) => ExternalTaskEvent['type'] | false): Promise<ExternalTask | null> {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('UPDATE external_pilot_tasks SET sequence = sequence WHERE id = ?', [id])
      const row = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE id = ?', [id])
      if (!row) return null
      const task = await this.project(row)
      const before = task.answer, rawBefore = task.raw_answer
      if (isTerminal(task.status)) return null
      const type = change(task)
      if (!type) return null
      task.updated_at = Date.now()
      const sequence = Number(row.sequence) + 1
      const previous = JSON.parse(row.document) as Checkpoint
      const checkpoint = previous._checkpoint_sequence ?? Number(row.sequence)
      const saveCheckpoint = isTerminal(task.status) || sequence - checkpoint >= 64 || Math.abs(task.answer.length - previous.answer.length) >= 8192 || Math.abs(task.raw_answer.length - previous.raw_answer.length) >= 8192
      if (saveCheckpoint) await this.db.run('UPDATE external_pilot_tasks SET status = ?, sequence = ?, document = ? WHERE id = ?', [task.status, sequence, JSON.stringify({ ...task, _checkpoint_sequence: sequence }), id])
      else await this.db.run('UPDATE external_pilot_tasks SET status = ?, sequence = ? WHERE id = ?', [task.status, sequence, id])
      await this.db.run('INSERT INTO external_pilot_events(task_id, sequence, document) VALUES (?, ?, ?)', [id, sequence, JSON.stringify(this.event(task, sequence, type, before, rawBefore))])
      if (task.attempt_id) await this.db.run(`INSERT INTO external_pilot_attempts(id, task_id, status, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      [task.attempt_id, id, task.status, task.updated_at, task.updated_at])
      if (task.provider_refs.conversation_id) await this.db.run('UPDATE external_pilot_sessions SET conversation_id = ? WHERE id = ? AND active_task_id = ?', [task.provider_refs.conversation_id, task.session_id, id])
      if (isTerminal(task.status) && task.status !== 'unknown') await this.db.run('UPDATE external_pilot_sessions SET active_task_id = NULL, updated_at = ? WHERE id = ? AND active_task_id = ?', [task.updated_at, task.session_id, id])
      return task
    })
  }

  async expire(now = Date.now()): Promise<void> {
    await this.ready
    const rows = await this.db.all('SELECT id FROM external_pilot_tasks WHERE status IN (?, ?, ?) AND deadline_at <= ? LIMIT 100', ['accepted', 'dispatching', 'running', now])
    for (const row of rows) await this.mutate(String(row.id), task => {
      task.status = task.status === 'accepted' ? 'rejected' : 'unknown'
      task.error_code = task.status === 'rejected' ? 'DISPATCH_DEADLINE' : 'EXECUTION_UNCONFIRMED'
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
