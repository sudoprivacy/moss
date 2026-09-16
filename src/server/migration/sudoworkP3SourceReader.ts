import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type SqlRow = Record<string, unknown>

export interface SudoworkP3User {
  id: number
  phone: string | null
  enterpriseId: number | null
  balanceUnits: number
  quotaUnits: number
  usedQuotaUnits: number
  externalUserId: string | null
  sudorouterToken?: string | null
}

export interface SudoworkP3LedgerEntry {
  id: number
  userId: number
  deltaUnits: number
  entryType: string
  memo: string | null
  createdAt: number
}

export interface SudoworkP3Order {
  id: number
  orderNo: string
  userId: number
  userPhone: string | null
  enterpriseId: number | null
  amountUsdMicros: number
  amountCents: number
  exchangeRateMicros: number
  quotaUnits: number
  pointsUnits: number
  bonusUnits: number
  paymentMethod: string
  orderDate: string
  providerOrderInfo: string | null
  status: number
  callbackData: string | null
  callbackTime: number | null
  callbackAmountCents: number | null
  createdAt: number
  updatedAt: number
  expiredAt: number
  remark: string | null
}

export interface SudoworkP3RechargeRecord {
  id: number
  orderId: number
  userId: number
  quotaBeforeUnits: number | null
  quotaAfterUnits: number | null
  quotaDeltaUnits: number
  balanceBeforeUnits: number | null
  balanceAfterUnits: number | null
  balanceDeltaUnits: number
  externalUserId: string | null
  externalSucceeded: boolean | null
  createdAt: number
}

export interface SudoworkP3AdminRechargeRecord {
  id: number
  userId: number
  adminId: number
  pointsUnits: number
  quotaUnits: number
  reason: string | null
  paymentReference: string | null
  externalUserId: string | null
  externalSucceeded: boolean
  externalError: string | null
  source: string
  sourceId: number | null
  createdAt: number
}

export interface SudoworkP3CreditApplication {
  id: number
  applicationNo: string
  userId: number
  enterpriseId: number | null
  requestedUnits: number
  approvedUnits: number | null
  quotaUnits: number | null
  reason: string
  status: string
  adminId: number | null
  adminComment: string | null
  externalUserId: string | null
  externalSucceeded: boolean
  externalError: string | null
  createdAt: number
  reviewedAt: number | null
  updatedAt: number
}

export interface SudoworkP3Refund {
  id: number
  refundNo: string
  orderId: number
  orderNo: string
  userId: number
  refundAmountCents: number
  refundQuotaUnits: number
  refundPointsUnits: number
  reason: string | null
  refundType: string
  status: number
  providerRefundNo: string | null
  providerResponse: string | null
  createdAt: number
  processedAt: number | null
}

export interface SudoworkP3Snapshot {
  users: SudoworkP3User[]
  ledger: SudoworkP3LedgerEntry[]
  orders: SudoworkP3Order[]
  rechargeRecords: SudoworkP3RechargeRecord[]
  adminRechargeRecords: SudoworkP3AdminRechargeRecord[]
  creditApplications: SudoworkP3CreditApplication[]
  refunds: SudoworkP3Refund[]
  checksum: string
}

export class SudoworkP3SourceError extends Error {
  constructor(readonly code: 'INVALID_SOURCE' | 'LOSSY_NUMBER', message: string) {
    super(message)
    this.name = 'SudoworkP3SourceError'
  }
}

export class SudoworkP3SourceReader {
  private readonly databasePath: string

  constructor(snapshotDir: string) {
    this.databasePath = resolve(snapshotDir, 'sudowork.sqlite')
  }

  readSnapshot(): SudoworkP3Snapshot {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA query_only=ON')
    } catch (error) {
      throw new SudoworkP3SourceError('INVALID_SOURCE', `无法只读打开 Sudowork 财务快照: ${message(error)}`)
    }
    try {
      if (!tableExists(db, 'users')) throw new SudoworkP3SourceError('INVALID_SOURCE', '财务快照缺少 users 表')
      const users = rows(db, 'users').map(row => ({
        id: positiveInteger(row.id, 'users.id'), phone: nullableText(row.phone),
        enterpriseId: nullablePositiveInteger(row.enterprise_id, 'users.enterprise_id'),
        balanceUnits: pointAmount(row.balance ?? 0, 'users.balance'),
        quotaUnits: integerAmount(row.quota ?? 0, 'users.quota'),
        usedQuotaUnits: integerAmount(row.used_quota ?? 0, 'users.used_quota'),
        externalUserId: row.sudorouter_user_id == null ? null : String(row.sudorouter_user_id),
        sudorouterToken: nullableText(row.sudorouter_key),
      }))
      const ledger = rows(db, 'ledger').map(row => ({
        id: positiveInteger(row.id, 'ledger.id'), userId: positiveInteger(row.user_id, 'ledger.user_id'),
        deltaUnits: pointAmount(row.amount, 'ledger.amount'),
        entryType: requiredText(row.type, 'ledger.type'), memo: nullableText(row.memo),
        createdAt: timestamp(row.timestamp),
      }))
      const orders = rows(db, 'recharge_orders').map(row => {
        const amountCents = integerAmount(row.amount_cents, 'recharge_orders.amount_cents')
        const amountYuanCents = scaledAmount(row.amount_yuan, 100, 'recharge_orders.amount_yuan')
        if (amountCents !== amountYuanCents) {
          throw lossy('recharge_orders.amount_yuan', row.amount_yuan, '与 amount_cents 不一致')
        }
        return {
          id: positiveInteger(row.id, 'recharge_orders.id'), orderNo: requiredText(row.order_no, 'recharge_orders.order_no'),
          userId: positiveInteger(row.user_id, 'recharge_orders.user_id'), userPhone: nullableText(row.user_phone),
          enterpriseId: nullablePositiveInteger(row.enterprise_id, 'recharge_orders.enterprise_id'),
          amountUsdMicros: scaledAmount(row.amount_usd, 1_000_000, 'recharge_orders.amount_usd'), amountCents,
          exchangeRateMicros: scaledAmount(row.exchange_rate ?? 7.3, 1_000_000, 'recharge_orders.exchange_rate'),
          quotaUnits: integerAmount(row.quota_amount, 'recharge_orders.quota_amount'),
          pointsUnits: integerAmount(row.points_amount, 'recharge_orders.points_amount'),
          bonusUnits: integerAmount(row.bonus_points ?? 0, 'recharge_orders.bonus_points'),
          paymentMethod: requiredText(row.payment_method, 'recharge_orders.payment_method'),
          orderDate: requiredText(row.order_date ?? '', 'recharge_orders.order_date'),
          providerOrderInfo: nullableText(row.fuiou_order_info), status: integerAmount(row.status, 'recharge_orders.status'),
          callbackData: nullableText(row.callback_data), callbackTime: nullableTimestamp(row.callback_time),
          callbackAmountCents: nullableIntegerAmount(row.callback_amount_cents, 'recharge_orders.callback_amount_cents'),
          createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
          expiredAt: timestamp(row.expired_at), remark: nullableText(row.remark),
        }
      })
      const rechargeRecords = rows(db, 'recharge_records').map(row => ({
        id: positiveInteger(row.id, 'recharge_records.id'),
        orderId: positiveInteger(row.order_id, 'recharge_records.order_id'),
        userId: positiveInteger(row.user_id, 'recharge_records.user_id'),
        quotaBeforeUnits: nullableIntegerAmount(row.quota_before, 'recharge_records.quota_before'),
        quotaAfterUnits: nullableIntegerAmount(row.quota_after, 'recharge_records.quota_after'),
        quotaDeltaUnits: integerAmount(row.quota_delta, 'recharge_records.quota_delta'),
        balanceBeforeUnits: nullablePointAmount(row.balance_before, 'recharge_records.balance_before'),
        balanceAfterUnits: nullablePointAmount(row.balance_after, 'recharge_records.balance_after'),
        balanceDeltaUnits: pointAmount(row.balance_delta, 'recharge_records.balance_delta'),
        externalUserId: row.sudorouter_user_id == null ? null : String(row.sudorouter_user_id),
        externalSucceeded: nullableBoolean(row.sudorouter_success), createdAt: timestamp(row.created_at),
      }))
      const adminRechargeRecords = rows(db, 'admin_recharge_records').map(row => ({
        id: positiveInteger(row.id, 'admin_recharge_records.id'),
        userId: positiveInteger(row.user_id, 'admin_recharge_records.user_id'),
        adminId: positiveInteger(row.admin_id, 'admin_recharge_records.admin_id'),
        pointsUnits: integerAmount(row.points, 'admin_recharge_records.points'),
        quotaUnits: integerAmount(row.quota, 'admin_recharge_records.quota'),
        reason: nullableText(row.reason), paymentReference: nullableText(row.payment_reference),
        externalUserId: row.sudorouter_user_id == null ? null : String(row.sudorouter_user_id),
        externalSucceeded: Boolean(row.sudorouter_success), externalError: nullableText(row.sudorouter_error),
        source: nullableText(row.source) ?? 'ADMIN_MANUAL',
        sourceId: nullablePositiveInteger(row.source_id, 'admin_recharge_records.source_id'),
        createdAt: timestamp(row.created_at),
      }))
      const creditApplications = rows(db, 'credit_applications').map(row => ({
        id: positiveInteger(row.id, 'credit_applications.id'),
        applicationNo: requiredText(row.application_no, 'credit_applications.application_no'),
        userId: positiveInteger(row.user_id, 'credit_applications.user_id'),
        enterpriseId: nullablePositiveInteger(row.enterprise_id, 'credit_applications.enterprise_id'),
        requestedUnits: integerAmount(row.requested_points, 'credit_applications.requested_points'),
        approvedUnits: nullableIntegerAmount(row.approved_points, 'credit_applications.approved_points'),
        quotaUnits: nullableIntegerAmount(row.quota_amount, 'credit_applications.quota_amount'),
        reason: nullableText(row.reason) ?? '', status: requiredText(row.status, 'credit_applications.status'),
        adminId: nullablePositiveInteger(row.admin_id, 'credit_applications.admin_id'),
        adminComment: nullableText(row.admin_comment),
        externalUserId: row.sudorouter_user_id == null ? null : String(row.sudorouter_user_id),
        externalSucceeded: Boolean(row.sudorouter_success), externalError: nullableText(row.sudorouter_error),
        createdAt: timestamp(row.created_at), reviewedAt: nullableTimestamp(row.reviewed_at),
        updatedAt: timestamp(row.updated_at),
      }))
      const refunds = rows(db, 'refund_records').map(row => ({
        id: positiveInteger(row.id, 'refund_records.id'), refundNo: requiredText(row.refund_no, 'refund_records.refund_no'),
        orderId: positiveInteger(row.order_id, 'refund_records.order_id'),
        orderNo: requiredText(row.order_no, 'refund_records.order_no'),
        userId: positiveInteger(row.user_id, 'refund_records.user_id'),
        refundAmountCents: scaledAmount(row.refund_amount_yuan, 100, 'refund_records.refund_amount_yuan'),
        refundQuotaUnits: integerAmount(row.refund_quota, 'refund_records.refund_quota'),
        refundPointsUnits: integerAmount(row.refund_points, 'refund_records.refund_points'),
        reason: nullableText(row.refund_reason), refundType: nullableText(row.refund_type) ?? 'FUIOU',
        status: integerAmount(row.status, 'refund_records.status'),
        providerRefundNo: nullableText(row.fuiou_refund_no), providerResponse: nullableText(row.fuiou_response),
        createdAt: timestamp(row.created_at), processedAt: nullableTimestamp(row.processed_at),
      }))
      const withoutChecksum = { users, ledger, orders, rechargeRecords, adminRechargeRecords, creditApplications, refunds }
      return {
        ...withoutChecksum,
        checksum: createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex'),
      }
    } finally {
      db.close()
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function rows(db: DatabaseSync, table: string): SqlRow[] {
  if (!tableExists(db, table)) return []
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as SqlRow[]
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SudoworkP3SourceError('INVALID_SOURCE', `${field} 不能为空`)
  return value
}

function nullableText(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function integerAmount(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw lossy(field, value, '必须是安全整数')
  return parsed
}

function nullableIntegerAmount(value: unknown, field: string): number | null {
  return value == null || value === '' ? null : integerAmount(value, field)
}

function pointAmount(value: unknown, field: string): number {
  return scaledAmount(value, 100, field) / 100
}

function nullablePointAmount(value: unknown, field: string): number | null {
  return value == null || value === '' ? null : pointAmount(value, field)
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = integerAmount(value, field)
  if (parsed <= 0) throw new SudoworkP3SourceError('INVALID_SOURCE', `${field} 必须为正整数`)
  return parsed
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value == null || value === '' ? null : positiveInteger(value, field)
}

function scaledAmount(value: unknown, scale: number, field: string): number {
  const parsed = Number(value)
  const scaled = parsed * scale
  const rounded = Math.round(scaled)
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    throw lossy(field, value, `无法无损转换为 1/${scale} 单位`)
  }
  return rounded
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value !== 'string' || !value.trim()) return 0
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new SudoworkP3SourceError('INVALID_SOURCE', `时间格式无效: ${value}`)
  return parsed
}

function nullableTimestamp(value: unknown): number | null {
  return value == null || value === '' ? null : timestamp(value)
}

function nullableBoolean(value: unknown): boolean | null {
  return value == null ? null : Boolean(value)
}

function lossy(field: string, value: unknown, reason: string): SudoworkP3SourceError {
  return new SudoworkP3SourceError('LOSSY_NUMBER', `${field}=${String(value)} ${reason}`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
