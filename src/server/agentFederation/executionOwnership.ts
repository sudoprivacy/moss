import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { ExternalTaskStore, ExternalActor } from '../externalProviders/store.js'
import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'

export interface ExecutionFence { attemptId: string; ownerId: string; token: string }
export interface OwnedExternalTask { actor: ExternalActor; task: ExternalTask; fence: ExecutionFence; recovery: boolean }
export const EXTERNAL_EXECUTION_LEASE_MS = 30_000

/** Unique process lifetime identity and per-attempt tokens fence results across Moss controllers. */
export class ExternalExecutionOwnership {
  readonly ownerId = randomUUID()
  readonly ready: Promise<void>
  constructor(readonly store: ExternalTaskStore) {
    this.ready = store.ready.then(async () => {
      const now = await store.databaseNow()
      await store.db.run(`INSERT INTO server_instances(instance_id, host, pid, started_at, heartbeat_at, status)
        VALUES (?, ?, ?, ?, ?, 'running')`, [this.ownerId, hostname(), process.pid, now, now])
    })
  }
  async heartbeat() {
    await this.ready
    await this.store.db.run("UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ? AND status = 'running'", [await this.store.databaseNow(), this.ownerId])
  }
  async candidates(): Promise<string[]> {
    await this.ready
    return (await this.store.db.all(`SELECT t.id FROM tasks t LEFT JOIN external_attempt_leases l ON l.attempt_id = t.attempt_id
      WHERE t.status IN ('accepted', 'dispatching', 'running') AND t.deadline_at > ? AND (l.attempt_id IS NULL OR l.lease_until <= ?)
      ORDER BY t.deadline_at, t.id LIMIT 32`, [await this.store.databaseNow(), await this.store.databaseNow()])).map(row => String(row.id))
  }
  async claim(id: string): Promise<OwnedExternalTask | null> {
    await this.ready
    return this.store.db.transaction(async () => {
      await this.store.db.run('UPDATE tasks SET sequence = sequence WHERE id = ?', [id])
      const row = await this.store.db.get('SELECT org_id, user_id FROM tasks WHERE id = ?', [id])
      if (!row) return null
      const actor = { orgId: String(row.org_id), userId: String(row.user_id) }
      let task = await this.store.task(actor, id)
      const now = await this.store.databaseNow()
      if (!['accepted', 'dispatching', 'running'].includes(task.status)) return null
      if (task.deadline_at <= now) {
        await this.store.mutate(id, current => {
          current.status = current.status === 'accepted' ? current.task_contract_version ? 'failed' : 'rejected' : 'unknown'
          current.error_code = current.status === 'unknown' ? 'EXECUTION_UNCONFIRMED' : 'DISPATCH_DEADLINE'
          return 'status'
        })
        return null
      }
      const recovery = task.status !== 'accepted'
      const current = task.attempt_id ? await this.store.db.get('SELECT lease_until FROM external_attempt_leases WHERE attempt_id = ?', [task.attempt_id]) : undefined
      if (current && Number(current.lease_until) > now) return null
      if (!task.attempt_id) {
        const initialized = await this.store.mutate(id, value => { value.attempt_id = randomUUID(); return 'status' })
        if (!initialized?.attempt_id) return null
        task = initialized
      }
      const fence: ExecutionFence = { attemptId: task.attempt_id!, ownerId: this.ownerId, token: randomUUID() }
      const session = await this.store.db.get('SELECT current_attempt_id FROM sessions WHERE session_id = ?', [task.session_id])
      if (session?.current_attempt_id !== task.attempt_id) return null
      await this.store.db.run('UPDATE session_attempts SET server_instance_id = ?, last_heartbeat_at = ? WHERE attempt_id = ? AND backend_type = ?', [this.ownerId, now, task.attempt_id, 'external'])
      await this.store.db.run('UPDATE external_attempt_leases SET token = ?, lease_until = ? WHERE attempt_id = ?', [fence.token, now + EXTERNAL_EXECUTION_LEASE_MS, task.attempt_id])
      if (task.status === 'accepted') {
        const dispatched = await this.store.mutate(id, value => { value.status = 'dispatching'; return 'status' }, fence)
        if (!dispatched) return null
        task = dispatched
      }
      return { actor, task, fence, recovery }
    })
  }
  async renew(fence: ExecutionFence): Promise<boolean> {
    await this.ready
    const now = await this.store.databaseNow()
    return Boolean(await this.store.db.run(`UPDATE external_attempt_leases SET lease_until = ?
      WHERE attempt_id = ? AND token = ? AND lease_until > ? AND EXISTS
      (SELECT 1 FROM session_attempts a JOIN sessions s ON s.current_attempt_id = a.attempt_id
        JOIN tasks t ON t.attempt_id = a.attempt_id WHERE a.attempt_id = external_attempt_leases.attempt_id
        AND a.server_instance_id = ? AND t.status IN ('dispatching', 'running') AND t.deadline_at > ?)`,
    [now + EXTERNAL_EXECUTION_LEASE_MS, fence.attemptId, fence.token, now, fence.ownerId, now]))
  }
  async stop(): Promise<void> {
    await this.ready
    await this.store.db.transaction(async () => {
      await this.store.db.run("UPDATE server_instances SET status = 'stopped', stopped_at = ? WHERE instance_id = ?", [await this.store.databaseNow(), this.ownerId])
      await this.store.db.run('UPDATE external_attempt_leases SET lease_until = 0 WHERE attempt_id IN (SELECT attempt_id FROM session_attempts WHERE server_instance_id = ?)', [this.ownerId])
    })
  }
}
