import { randomUUID } from 'node:crypto'
import type { AgentControlAction, AgentControlTarget, ManagedControlActor } from './contract.js'
import type { DbDriver } from '../db/driver.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { DeviceDeployEffect } from './deviceDeploy.js'

export interface ControlDelegation {
  id: string; orgId: string; userId: string; role: string; scopes: string[]
  parentJti: string; tokenJti: string; actor: ManagedControlActor
  target: AgentControlTarget; actions: AgentControlAction[]
  deploymentPlans?: { planId: string; sha256: string }[]
  createdAt: number; expiresAt: number; status: 'active' | 'revoked'; revokedAt?: number
}

export interface ControlOperation {
  id: string; operationId: string; orgId: string; delegationId: string; userId: string
  actor: ManagedControlActor; target: AgentControlTarget; action: AgentControlAction; credentialJti: string
  requestDigest: string; requestedInputSha256: string; effectiveInputSha256: string
  status: 'prepared' | 'executing' | 'completed' | 'rejected' | 'unknown'
  createdAt: number; expiresAt: number; admittedAt?: number; completedAt?: number
  result?: unknown; errorCode?: string
  deviceEffect?: DeviceDeployEffect
}

/** One receipt ledger for every native control adapter; it never replays an effect. */
export class AgentControlStore {
  readonly ready: Promise<void>
  constructor(readonly db: DbDriver) {
    this.ready = db.transaction(async () => {
      if (db.kind === 'postgres') await db.get("SELECT pg_advisory_xact_lock(hashtextextended('moss-agent-control-v1', 0))")
      await db.exec(`CREATE TABLE IF NOT EXISTS agent_control_delegations (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
        status TEXT NOT NULL, expires_at BIGINT NOT NULL, document TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS agent_control_operations (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, org_id TEXT NOT NULL,
        delegation_id TEXT NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL,
        UNIQUE(org_id, operation_id)
      );`)
    })
  }

  async create(delegation: ControlDelegation) {
    await this.ready
    await this.db.run('INSERT INTO agent_control_delegations(id, org_id, user_id, status, expires_at, document) VALUES (?, ?, ?, ?, ?, ?)',
      [delegation.id, delegation.orgId, delegation.userId, delegation.status, delegation.expiresAt, JSON.stringify(delegation)])
  }

  async delegation(orgId: string, id: string): Promise<ControlDelegation | null> {
    await this.ready
    const row = await this.db.get('SELECT document FROM agent_control_delegations WHERE org_id = ? AND id = ?', [orgId, id])
    return row ? JSON.parse(String(row.document)) as ControlDelegation : null
  }

  async revoke(orgId: string, id: string, userId: string) {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('UPDATE agent_control_delegations SET status = status WHERE org_id = ? AND id = ?', [orgId, id])
      const value = await this.delegation(orgId, id)
      if (!value || value.userId !== userId) throw new ResourceAccessError(404, 'Control delegation not available')
      if (value.status === 'active') {
        value.status = 'revoked'; value.revokedAt = Date.now()
        await this.db.run('UPDATE agent_control_delegations SET status = ?, document = ? WHERE org_id = ? AND id = ?',
          [value.status, JSON.stringify(value), orgId, id])
      }
      return value
    })
  }

  async reserve(value: Omit<ControlOperation, 'id'>): Promise<{ created: boolean; operation: ControlOperation }> {
    await this.ready
    const operation = { ...value, id: randomUUID() }
    return this.db.transaction(async () => {
      await this.db.run(`INSERT INTO agent_control_operations(id, operation_id, org_id, delegation_id, status, document)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, operation_id) DO NOTHING`,
      [operation.id, operation.operationId, operation.orgId, operation.delegationId, operation.status, JSON.stringify(operation)])
      const existing = await this.operation(operation.orgId, operation.operationId)
      if (!existing || existing.delegationId !== operation.delegationId || existing.requestDigest !== operation.requestDigest)
        throw new ResourceAccessError(409, 'Control operation ID conflicts with an existing request')
      return { created: existing.id === operation.id, operation: existing }
    })
  }

  async operation(orgId: string, operationId: string): Promise<ControlOperation | null> {
    await this.ready
    const row = await this.db.get('SELECT document FROM agent_control_operations WHERE org_id = ? AND operation_id = ?', [orgId, operationId])
    return row ? JSON.parse(String(row.document)) as ControlOperation : null
  }

  async transition(operation: ControlOperation, expected: ControlOperation['status'],
    patch: Partial<Pick<ControlOperation, 'status' | 'result' | 'errorCode' | 'admittedAt' | 'completedAt'>>) {
    await this.ready
    const next = { ...operation, ...patch }
    if (!await this.db.run('UPDATE agent_control_operations SET status = ?, document = ? WHERE org_id = ? AND id = ? AND status = ?',
      [next.status, JSON.stringify(next), operation.orgId, operation.id, expected]))
      throw new ResourceAccessError(409, 'Control operation was fenced')
    Object.assign(operation, next)
  }

  /** Grant revocation and final admission serialize on the same durable row.
   * The recheck must use local authority state; do not hold this transaction
   * through native RPC, installation, model execution or another side effect.
   */
  async admit(operation: ControlOperation, recheck: () => Promise<void>) {
    await this.ready
    await this.db.transaction(async () => {
      await this.db.run('UPDATE agent_control_delegations SET status = status WHERE org_id = ? AND id = ?', [operation.orgId, operation.delegationId])
      const delegation = await this.delegation(operation.orgId, operation.delegationId)
      if (!delegation || delegation.status !== 'active' || delegation.expiresAt <= Date.now())
        throw new ResourceAccessError(403, 'Control delegation expired or was revoked')
      await recheck()
      await this.transition(operation, 'prepared', { status: 'executing', admittedAt: Date.now() })
    })
  }
}
