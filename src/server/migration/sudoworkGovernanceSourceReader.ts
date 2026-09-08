import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type SqlRow = Record<string, unknown>

export interface SudoworkInvitationSourceRecord {
  id: number
  code: string
  enterpriseId: number
  status: 'pending' | 'used'
  initialQuotaUsd: number | null
  usedByUserId: number | null
  createdAt: number
  usedAt: number | null
}

export interface SudoworkOperationLogSourceRecord {
  id: number
  userId: number | null
  userPhone: string | null
  action: string
  resource: string
  resourceId: number | null
  method: string | null
  path: string | null
  paramsRaw: string | null
  requestDataRaw: string | null
  responseDataRaw: string | null
  responseStatus: number | null
  ipAddress: string | null
  userAgent: string | null
  durationMs: number | null
  errorMessage: string | null
  createdAt: number
}

export interface SudoworkGovernanceSnapshot {
  invitations: SudoworkInvitationSourceRecord[]
  operationLogs: SudoworkOperationLogSourceRecord[]
  checksum: string
}

export class SudoworkGovernanceSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SudoworkGovernanceSourceError'
  }
}

export class SudoworkGovernanceSourceReader {
  private readonly databasePath: string

  constructor(snapshotDirectory: string) {
    this.databasePath = resolve(snapshotDirectory, 'sudowork.sqlite')
  }

  readSnapshot(): SudoworkGovernanceSnapshot {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA query_only=ON')
      for (const table of ['invitation_codes', 'operation_logs']) {
        if (!tableExists(db, table)) throw new SudoworkGovernanceSourceError(`治理快照缺少 ${table} 表`)
      }
      const invitations = (db.prepare('SELECT * FROM invitation_codes ORDER BY id').all() as SqlRow[])
        .map(readInvitation)
      const operationLogs = (db.prepare('SELECT * FROM operation_logs ORDER BY id').all() as SqlRow[])
        .map(readOperationLog)
      const content = { invitations, operationLogs }
      return {
        ...content,
        checksum: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
      }
    } catch (error) {
      if (error instanceof SudoworkGovernanceSourceError) throw error
      throw new SudoworkGovernanceSourceError(
        `无法只读读取 Sudowork 治理快照: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      db?.close()
    }
  }
}

function readInvitation(row: SqlRow): SudoworkInvitationSourceRecord {
  const id = positiveInteger(row.id, 'invitation_codes.id')
  const status = invitationStatus(row.status)
  const usedByUserId = nullablePositiveInteger(row.used_by_user_id, 'invitation_codes.used_by_user_id')
  const usedAt = nullableTimestamp(row.used_at, 'invitation_codes.used_at')
  if (status === 'used' && (usedByUserId === null || usedAt === null)) {
    throw new SudoworkGovernanceSourceError(
      `invitation_codes ${id} 已使用但缺少 used_by_user_id 或 used_at`,
    )
  }
  if (status === 'pending' && (usedByUserId !== null || usedAt !== null)) {
    throw new SudoworkGovernanceSourceError(
      `invitation_codes ${id} 待使用但包含 used_by_user_id 或 used_at`,
    )
  }
  return {
    id,
    code: requiredText(row.code, 'invitation_codes.code'),
    enterpriseId: positiveInteger(row.enterprise_id, 'invitation_codes.enterprise_id'),
    status,
    initialQuotaUsd: nullableNonNegativeNumber(row.initial_quota_usd, 'invitation_codes.initial_quota_usd'),
    usedByUserId,
    createdAt: timestamp(row.created_at, 'invitation_codes.created_at'),
    usedAt,
  }
}

function readOperationLog(row: SqlRow): SudoworkOperationLogSourceRecord {
  return {
    id: positiveInteger(row.id, 'operation_logs.id'),
    userId: nullableInteger(row.user_id, 'operation_logs.user_id'),
    userPhone: nullableText(row.user_phone),
    action: requiredText(row.action, 'operation_logs.action'),
    resource: requiredText(row.resource, 'operation_logs.resource'),
    resourceId: nullableInteger(row.resource_id, 'operation_logs.resource_id'),
    method: nullableText(row.method),
    path: nullableText(row.path),
    paramsRaw: rawText(row.params),
    requestDataRaw: rawText(row.request_data),
    responseDataRaw: rawText(row.response_data),
    responseStatus: nullableInteger(row.response_status, 'operation_logs.response_status'),
    ipAddress: nullableText(row.ip_address),
    userAgent: nullableText(row.user_agent),
    durationMs: nullableInteger(row.duration_ms, 'operation_logs.duration_ms'),
    errorMessage: nullableText(row.error_message),
    createdAt: timestamp(row.created_at, 'operation_logs.created_at'),
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function invitationStatus(value: unknown): 'pending' | 'used' {
  const status = Number(value)
  if (status === 0) return 'pending'
  if (status === 1) return 'used'
  throw new SudoworkGovernanceSourceError(`invitation_codes.status 非法: ${String(value)}`)
}

function positiveInteger(value: unknown, field: string): number {
  const result = integer(value, field)
  if (result <= 0) throw new SudoworkGovernanceSourceError(`${field} 必须是正整数`)
  return result
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value == null || value === '') return null
  return positiveInteger(value, field)
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value == null || value === '') return null
  return integer(value, field)
}

function integer(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new SudoworkGovernanceSourceError(`${field} 必须是安全整数`)
  return result
}

function nullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value == null || value === '') return null
  const result = Number(value)
  if (!Number.isFinite(result) || result < 0) {
    throw new SudoworkGovernanceSourceError(`${field} 必须是非负数`)
  }
  return result
}

function requiredText(value: unknown, field: string): string {
  const result = nullableText(value)
  if (result === null) throw new SudoworkGovernanceSourceError(`${field} 不能为空`)
  return result
}

function nullableText(value: unknown): string | null {
  if (value == null) return null
  const result = String(value)
  return result.length > 0 ? result : null
}

function rawText(value: unknown): string | null {
  return value == null ? null : String(value)
}

function nullableTimestamp(value: unknown, field: string): number | null {
  if (value == null || value === '') return null
  return timestamp(value, field)
}

function timestamp(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) {
    throw new SudoworkGovernanceSourceError(`${field} 不能为空`)
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const result = Date.parse(normalized)
  if (!Number.isFinite(result)) throw new SudoworkGovernanceSourceError(`${field} 时间格式无效`)
  return result
}
