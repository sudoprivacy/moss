import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

export interface PostCutoverChangeInput {
  eventId: string
  domain: string
  commandType: string
  aggregateType: string
  aggregateId: string
  payload: Record<string, unknown>
}

export interface PostCutoverChange extends PostCutoverChangeInput {
  payloadSha256: string
  replayStatus: 'pending' | 'running' | 'succeeded' | 'failed'
  replayResult: Record<string, unknown> | null
  createdAt: number
}

export interface ReplayApproval {
  approvedBy: string
  approvedAt: number
  reason: string
}

export interface RedeliveryRequest {
  originalIdempotencyKey: string
  effectType: string
  target: string
  resourceType: string
  resourceId: string
  payloadRef: string
}

export interface RedeliveryRecord extends RedeliveryRequest {
  requestSha256: string
  status: 'running' | 'succeeded' | 'failed'
  approval: ReplayApproval
  result: Record<string, unknown> | null
}

export type PostCutoverChangeLogErrorCode = 'CHANGE_CONFLICT' | 'SECRET_MATERIAL' | 'CHANGE_NOT_FOUND' | 'REPLAY_IN_PROGRESS'

export class PostCutoverChangeLogError extends Error {
  constructor(readonly code: PostCutoverChangeLogErrorCode, message: string) {
    super(message)
    this.name = 'PostCutoverChangeLogError'
  }
}

type SqlRow = Record<string, unknown>

export class PostCutoverChangeLog {
  private readonly clock: () => number

  constructor(private readonly db: DatabaseSync, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now
    this.ensureSchema()
  }

  append(input: PostCutoverChangeInput): PostCutoverChange {
    assertNoSecretMaterial(input.payload)
    const payloadJson = stableJson(input.payload)
    const payloadSha256 = sha256(payloadJson)
    const existing = this.get(input.eventId)
    if (existing) {
      if (
        existing.domain === input.domain
        && existing.commandType === input.commandType
        && existing.aggregateType === input.aggregateType
        && existing.aggregateId === input.aggregateId
        && existing.payloadSha256 === payloadSha256
      ) return existing
      throw new PostCutoverChangeLogError('CHANGE_CONFLICT', `切换后事件 ID 被不同命令复用: ${input.eventId}`)
    }
    this.db.prepare(`
      INSERT INTO post_cutover_changes (
        event_id, domain, command_type, aggregate_type, aggregate_id,
        payload_json, payload_sha256, replay_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      input.eventId, input.domain, input.commandType, input.aggregateType,
      input.aggregateId, payloadJson, payloadSha256, this.clock(),
    )
    return this.get(input.eventId)!
  }

  get(eventId: string): PostCutoverChange | null {
    const row = this.db.prepare('SELECT * FROM post_cutover_changes WHERE event_id = ?').get(eventId) as SqlRow | undefined
    return row ? mapChange(row) : null
  }

  list(): PostCutoverChange[] {
    return (this.db.prepare('SELECT * FROM post_cutover_changes ORDER BY created_at, event_id').all() as SqlRow[]).map(mapChange)
  }

  beginReplay(eventId: string, approval: ReplayApproval): { execute: boolean; change: PostCutoverChange } {
    return runInTransaction(this.db, () => {
      const change = this.get(eventId)
      if (!change) throw new PostCutoverChangeLogError('CHANGE_NOT_FOUND', `切换后事件不存在: ${eventId}`)
      if (change.replayStatus === 'succeeded') return { execute: false, change }
      if (change.replayStatus === 'running') {
        throw new PostCutoverChangeLogError('REPLAY_IN_PROGRESS', `切换后事件正在回放: ${eventId}`)
      }
      this.db.prepare(`
        UPDATE post_cutover_changes
        SET replay_status = 'running', replay_approved_by = ?, replay_approved_at = ?, replay_reason = ?, replay_error = NULL
        WHERE event_id = ?
      `).run(approval.approvedBy, approval.approvedAt, approval.reason, eventId)
      return { execute: true, change: this.get(eventId)! }
    })
  }

  completeReplay(eventId: string, result: Record<string, unknown>): PostCutoverChange {
    this.db.prepare(`
      UPDATE post_cutover_changes SET replay_status = 'succeeded', replay_result_json = ?, replayed_at = ?
      WHERE event_id = ? AND replay_status = 'running'
    `).run(stableJson(result), this.clock(), eventId)
    return this.get(eventId)!
  }

  failReplay(eventId: string, error: unknown): void {
    this.db.prepare(`
      UPDATE post_cutover_changes SET replay_status = 'failed', replay_error = ?, replayed_at = ?
      WHERE event_id = ? AND replay_status = 'running'
    `).run(error instanceof Error ? error.message : String(error), this.clock(), eventId)
  }

  beginRedelivery(request: RedeliveryRequest, approval: ReplayApproval): { execute: boolean; record: RedeliveryRecord } {
    return runInTransaction(this.db, () => {
      assertNoSecretMaterial(request)
      const requestSha256 = sha256(stableJson(request))
      const existing = this.getRedelivery(request.originalIdempotencyKey)
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          throw new PostCutoverChangeLogError('CHANGE_CONFLICT', `补发幂等键被不同请求复用: ${request.originalIdempotencyKey}`)
        }
        if (existing.status === 'succeeded') return { execute: false, record: existing }
        if (existing.status === 'running') {
          throw new PostCutoverChangeLogError('REPLAY_IN_PROGRESS', `外部动作正在补发: ${request.originalIdempotencyKey}`)
        }
        this.db.prepare(`
          UPDATE migration_redeliveries SET status = 'running', approved_by = ?, approved_at = ?, approval_reason = ?, error = NULL
          WHERE original_idempotency_key = ?
        `).run(approval.approvedBy, approval.approvedAt, approval.reason, request.originalIdempotencyKey)
        return { execute: true, record: this.getRedelivery(request.originalIdempotencyKey)! }
      }
      this.db.prepare(`
        INSERT INTO migration_redeliveries (
          original_idempotency_key, effect_type, target, resource_type, resource_id,
          payload_ref, request_sha256, status, approved_by, approved_at, approval_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(
        request.originalIdempotencyKey, request.effectType, request.target, request.resourceType,
        request.resourceId, request.payloadRef, requestSha256,
        approval.approvedBy, approval.approvedAt, approval.reason, this.clock(),
      )
      return { execute: true, record: this.getRedelivery(request.originalIdempotencyKey)! }
    })
  }

  completeRedelivery(idempotencyKey: string, result: Record<string, unknown>): RedeliveryRecord {
    this.db.prepare(`
      UPDATE migration_redeliveries SET status = 'succeeded', result_json = ?, delivered_at = ?
      WHERE original_idempotency_key = ? AND status = 'running'
    `).run(stableJson(result), this.clock(), idempotencyKey)
    return this.getRedelivery(idempotencyKey)!
  }

  failRedelivery(idempotencyKey: string, error: unknown): void {
    this.db.prepare(`
      UPDATE migration_redeliveries SET status = 'failed', error = ?
      WHERE original_idempotency_key = ? AND status = 'running'
    `).run(error instanceof Error ? error.message : String(error), idempotencyKey)
  }

  getRedelivery(idempotencyKey: string): RedeliveryRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM migration_redeliveries WHERE original_idempotency_key = ?
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? mapRedelivery(row) : null
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_cutover_changes (
        event_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        command_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        replay_status TEXT NOT NULL CHECK (replay_status IN ('pending', 'running', 'succeeded', 'failed')),
        replay_result_json TEXT,
        replay_error TEXT,
        replay_approved_by TEXT,
        replay_approved_at INTEGER,
        replay_reason TEXT,
        created_at INTEGER NOT NULL,
        replayed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS migration_redeliveries (
        original_idempotency_key TEXT PRIMARY KEY,
        effect_type TEXT NOT NULL,
        target TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload_ref TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        approved_by TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        approval_reason TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
    `)
  }
}

function mapChange(row: SqlRow): PostCutoverChange {
  return {
    eventId: String(row.event_id),
    domain: String(row.domain),
    commandType: String(row.command_type),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    payloadSha256: String(row.payload_sha256),
    replayStatus: String(row.replay_status) as PostCutoverChange['replayStatus'],
    replayResult: row.replay_result_json == null ? null : JSON.parse(String(row.replay_result_json)) as Record<string, unknown>,
    createdAt: Number(row.created_at),
  }
}

function mapRedelivery(row: SqlRow): RedeliveryRecord {
  return {
    originalIdempotencyKey: String(row.original_idempotency_key),
    effectType: String(row.effect_type),
    target: String(row.target),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    payloadRef: String(row.payload_ref),
    requestSha256: String(row.request_sha256),
    status: String(row.status) as RedeliveryRecord['status'],
    approval: {
      approvedBy: String(row.approved_by),
      approvedAt: Number(row.approved_at),
      reason: String(row.approval_reason),
    },
    result: row.result_json == null ? null : JSON.parse(String(row.result_json)) as Record<string, unknown>,
  }
}

function assertNoSecretMaterial(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase()
    const isReference = /(?:ref|hash|digest)$/.test(normalized)
    if (!isReference && /password|secret|token|apikey|privatekey/.test(normalized)) {
      throw new PostCutoverChangeLogError('SECRET_MATERIAL', `回滚记录不得包含秘密字段: ${path}.${key}`)
    }
    assertNoSecretMaterial(item, `${path}.${key}`)
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
