import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DbDriver } from '../db/driver.js'
import type { ExecutionGrant } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { initializeAssetControls, lockAssetGate, assetControlRevision } from './assetControlStore.js'
import type { ToolDescriptor } from './toolProtocol.js'
import { toolFailure } from './toolProtocol.js'

export interface ReviewedTool extends ToolDescriptor {
  orgId: string; serverId: string; resource: string; serverDigest: string
  action: 'read' | 'write'; sensitive: boolean; outbound: boolean
  enabled: boolean; revision: string; reviewedBy: string; reviewedAt: number
}
export interface ToolCallRecord {
  id: string; callId: string; orgId: string; assetId: string; taskId: string; grantId: string
  specDigest: string; workerId: string; initiatedBy: string; ownerUserId: string; departmentId: string | null
  resource: string; serverId: string; tool: string; reviewRevision: string; descriptorDigest: string
  gateGeneration: number; requestDigest: string; status: 'preparing' | 'dispatching' | 'completed' | 'tool_error' | 'rejected' | 'unknown'
  createdAt: number; updatedAt: number; deadline: number; result?: CallToolResult; errorCode?: string
}

export class ToolGatewayStore {
  readonly ready: Promise<void>
  constructor(readonly db: DbDriver) {
    this.ready = (async () => {
      await initializeAssetControls(db)
      await db.transaction(async () => {
        if (db.kind === 'postgres') await db.get("SELECT pg_advisory_xact_lock(hashtextextended('moss-task-tool-schema-v1', 0))")
        await db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_reviews (
          org_id TEXT NOT NULL, resource TEXT NOT NULL, server_id TEXT NOT NULL, revision TEXT NOT NULL, document TEXT NOT NULL,
          PRIMARY KEY(org_id, resource)
        ); CREATE TABLE IF NOT EXISTS agent_tool_calls (
          id TEXT PRIMARY KEY, org_id TEXT NOT NULL, call_id TEXT NOT NULL, grant_id TEXT NOT NULL, task_id TEXT NOT NULL,
          asset_id TEXT NOT NULL, server_id TEXT NOT NULL, status TEXT NOT NULL, deadline BIGINT NOT NULL, document TEXT NOT NULL,
          UNIQUE(org_id, call_id)
        ); CREATE INDEX IF NOT EXISTS agent_tool_calls_task ON agent_tool_calls(org_id, task_id);
        CREATE INDEX IF NOT EXISTS agent_tool_calls_asset ON agent_tool_calls(org_id, asset_id);
        CREATE TABLE IF NOT EXISTS agent_tool_grant_limits (
          org_id TEXT NOT NULL, grant_id TEXT NOT NULL, reserved INTEGER NOT NULL, PRIMARY KEY(org_id, grant_id)
        ); CREATE TABLE IF NOT EXISTS agent_tool_review_audit (
          id TEXT PRIMARY KEY, org_id TEXT NOT NULL, resource TEXT NOT NULL, document TEXT NOT NULL
        );`)
      })
    })()
  }
  async reviews(org: string, server: string) {
    await this.ready
    return (await this.db.all('SELECT document FROM agent_tool_reviews WHERE org_id = ? AND server_id = ? ORDER BY resource', [org, server])).map(r => JSON.parse(String(r.document)) as ReviewedTool)
  }
  async review(org: string, resource: string): Promise<ReviewedTool | null> {
    await this.ready
    const r = await this.db.get('SELECT document FROM agent_tool_reviews WHERE org_id = ? AND resource = ?', [org, resource])
    return r ? JSON.parse(String(r.document)) as ReviewedTool : null
  }
  async saveReview(value: ReviewedTool, expected: string | null) {
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('INSERT INTO agent_tool_reviews(org_id, resource, server_id, revision, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, resource) DO NOTHING', [value.orgId, value.resource, value.serverId, '', '{}'])
      const changed = await this.db.run('UPDATE agent_tool_reviews SET revision = ?, document = ? WHERE org_id = ? AND resource = ? AND revision = ?', [value.revision, JSON.stringify(value), value.orgId, value.resource, expected ?? ''])
      if (!changed) toolFailure('TOOL_REVIEW_CONFLICT')
      await this.db.run('INSERT INTO agent_tool_review_audit(id, org_id, resource, document) VALUES (?, ?, ?, ?)', [value.revision, value.orgId, value.resource, JSON.stringify(value)])
      return value
    })
  }
  async reserve(org: string, callId: string, digest: string, grant: ExecutionGrant, review: ReviewedTool): Promise<{ created: boolean; call: ToolCallRecord }> {
    await this.ready
    const now = Date.now(), record: ToolCallRecord = {
      id: randomUUID(), callId, orgId: org, grantId: grant.id, assetId: grant.request.asset_id, taskId: grant.request.task_id,
      specDigest: grant.request.spec_digest, workerId: grant.worker_id, initiatedBy: grant.request.initiated_by,
      ownerUserId: grant.owner_user_id, departmentId: grant.department_id, resource: review.resource,
      serverId: review.serverId, tool: review.tool.name, reviewRevision: review.revision, descriptorDigest: review.digest,
      gateGeneration: 0, requestDigest: digest, status: 'preparing', createdAt: now, updatedAt: now, deadline: Math.min(grant.expires_at, now + 60000),
    }
    return this.db.transaction(async () => {
      await lockAssetGate(this.db, org, record.assetId)
      record.gateGeneration = await assetControlRevision(this.db, org, record.assetId)
      await this.db.run(`INSERT INTO agent_tool_calls(id, org_id, call_id, grant_id, task_id, asset_id, server_id, status, deadline, document)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, call_id) DO NOTHING`,
      [record.id, org, callId, grant.id, record.taskId, record.assetId, review.serverId, record.status, record.deadline, JSON.stringify(record)])
      const r = await this.db.get('SELECT document FROM agent_tool_calls WHERE org_id = ? AND call_id = ?', [org, callId])
      const call = JSON.parse(String(r!.document)) as ToolCallRecord
      if (call.requestDigest !== digest || call.grantId !== grant.id) toolFailure('TOOL_CALL_CONFLICT')
      const created = call.id === record.id
      if (created) {
        await this.db.run('INSERT INTO agent_tool_grant_limits(org_id, grant_id, reserved) VALUES (?, ?, 0) ON CONFLICT(org_id, grant_id) DO NOTHING', [org, grant.id])
        if (!await this.db.run('UPDATE agent_tool_grant_limits SET reserved = reserved + 1 WHERE org_id = ? AND grant_id = ? AND reserved < 32', [org, grant.id])) toolFailure('TOOL_CALL_LIMIT', 429)
      }
      return { created, call }
    })
  }
  async dispatch(call: ToolCallRecord, recheck?: () => Promise<void>) {
    await this.db.transaction(async () => {
      // MCP policy/server updates share these row locks with final dispatch admission.
      if (recheck) {
        await this.db.run('UPDATE mcp_servers SET id = id WHERE org_id = ? AND id = ?', [call.orgId, call.serverId])
        await this.db.run('UPDATE mcp_policies SET id = id WHERE org_id = ?', [call.orgId])
        await recheck()
      }
      await lockAssetGate(this.db, call.orgId, call.assetId)
      if (await assetControlRevision(this.db, call.orgId, call.assetId) !== call.gateGeneration) toolFailure('TOOL_ASSET_GENERATION_CHANGED')
      // Shared with review update. A late prepared call cannot execute after reapproval.
      await this.db.run('UPDATE agent_tool_reviews SET revision = revision WHERE org_id = ? AND resource = ?', [call.orgId, call.resource])
      const current = await this.review(call.orgId, call.resource)
      if (!current?.enabled || current.revision !== call.reviewRevision) toolFailure('TOOL_REVIEW_CHANGED')
      if (Date.now() >= call.deadline) toolFailure('TOOL_CALL_EXPIRED')
      await this.transition(call, 'preparing', { status: 'dispatching' })
    })
  }
  async transition(call: ToolCallRecord, expected: ToolCallRecord['status'], patch: Partial<ToolCallRecord>) {
    const next = { ...call, ...patch, updatedAt: Date.now() }
    if (!await this.db.run('UPDATE agent_tool_calls SET status = ?, document = ? WHERE id = ? AND org_id = ? AND status = ?', [next.status, JSON.stringify(next), call.id, call.orgId, expected])) toolFailure('TOOL_CALL_FENCED')
    Object.assign(call, next)
  }
  async calls(org: string, server?: string, task?: string): Promise<ToolCallRecord[]> {
    await this.ready
    const rows = await this.db.all(`SELECT document FROM agent_tool_calls WHERE org_id = ?${server ? ' AND server_id = ?' : ''}${task ? ' AND task_id = ?' : ''} ORDER BY deadline DESC, id DESC LIMIT 100`, [org, ...(server ? [server] : []), ...(task ? [task] : [])])
    return rows.map(r => {
      const call = JSON.parse(String(r.document)) as ToolCallRecord
      // Read-only projection. Even an expired pre-dispatch record is never replayed.
      if (['preparing', 'dispatching'].includes(call.status) && Date.now() >= call.deadline) return { ...call, status: 'unknown' as const, errorCode: 'TOOL_OUTCOME_UNCONFIRMED' }
      return call
    })
  }
}
