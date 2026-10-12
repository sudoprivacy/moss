import { randomUUID, createHash } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { sessionAgentName } from '../agentIdentity.js'
import { EXTERNAL_PROVIDER_API, type CreateExternalTask, type ExternalTask, type ExternalTaskEvent, type ExternalSession, type RegisterExternalAgent } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalProviderError } from './policy.js'

export interface ExternalActor { orgId: string; userId: string }
export interface Binding extends RegisterExternalAgent { id: string; orgId: string; connectionId: string; approved: boolean; parametersDigest: string | null; reviewedBy: string | null; revision?: number; archived?: boolean; credentialUpdating?: boolean }
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
      CREATE TABLE IF NOT EXISTS external_pilot_events (
        task_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(task_id, sequence)
      );
    `)
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
        query: input.query, answer: '', raw_answer: '', output_status: 'pending', error_code: null,
        source_digest: binding.source_digest, provider: 'dify', provider_refs: {},
        cancellation: { status: 'unsupported', reason: 'Provider termination cannot be confirmed in this pilot' },
        created_at: now, updated_at: now, deadline_at: now + timeoutMs,
      }
      const inserted = await this.db.run(`INSERT INTO external_pilot_tasks
        (id, org_id, user_id, session_id, idempotency_key, request_hash, status, deadline_at, sequence, document)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(org_id, user_id, idempotency_key) DO NOTHING`,
      [id, actor.orgId, actor.userId, sessionId, input.idempotency_key, hash, task.status, task.deadline_at, JSON.stringify(task)])
      if (!inserted) {
        const existing = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE org_id = ? AND user_id = ? AND idempotency_key = ?', [actor.orgId, actor.userId, input.idempotency_key])
        if (!existing || existing.request_hash !== hash) throw new ExternalProviderError(409, 'IDEMPOTENCY_CONFLICT')
        return JSON.parse(existing.document) as ExternalTask
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
    return (await this.db.all('SELECT document FROM external_pilot_tasks WHERE session_id = ? ORDER BY deadline_at, id LIMIT 200', [sessionId])).map(row => JSON.parse(String(row.document)))
  }

  async task(actor: ExternalActor, id: string): Promise<ExternalTask> {
    await this.ready
    const row = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
    if (!row) throw new ExternalProviderError(404, 'TASK_NOT_FOUND')
    return JSON.parse(row.document) as ExternalTask
  }

  async events(actor: ExternalActor, id: string, cursor: number) {
    await this.ready
    return this.db.transaction(async () => {
      // Lock projection and event stream together so the snapshot never loses a concurrent delta.
      await this.db.run('UPDATE external_pilot_tasks SET sequence = sequence WHERE id = ? AND org_id = ? AND user_id = ?', [id, actor.orgId, actor.userId])
      const task = await this.task(actor, id)
      const rows = await this.db.all('SELECT sequence, document FROM external_pilot_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 100', [id, cursor])
      return { task, events: rows.map(row => JSON.parse(String(row.document)) as ExternalTaskEvent), next_cursor: rows.length ? Number(rows.at(-1)!.sequence) : cursor }
    })
  }

  async mutate(id: string, change: (task: ExternalTask) => ExternalTaskEvent['type'] | false): Promise<ExternalTask | null> {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('UPDATE external_pilot_tasks SET sequence = sequence WHERE id = ?', [id])
      const row = await this.db.get<TaskRow>('SELECT * FROM external_pilot_tasks WHERE id = ?', [id])
      if (!row) return null
      const task = JSON.parse(row.document) as ExternalTask
      if (isTerminal(task.status)) return null
      const type = change(task)
      if (!type) return null
      task.updated_at = Date.now()
      const sequence = Number(row.sequence) + 1
      await this.db.run('UPDATE external_pilot_tasks SET status = ?, sequence = ?, document = ? WHERE id = ?', [task.status, sequence, JSON.stringify(task), id])
      await this.db.run('INSERT INTO external_pilot_events(task_id, sequence, document) VALUES (?, ?, ?)', [id, sequence, JSON.stringify(this.event(task, sequence, type))])
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

  private event(task: ExternalTask, sequence: number, type: ExternalTaskEvent['type']): ExternalTaskEvent {
    return { task_id: task.id, sequence, type, status: task.status, ...(type === 'answer' ? { answer: task.answer } : {}), created_at: task.updated_at }
  }
}
