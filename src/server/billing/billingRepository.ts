import type { DatabaseSync } from 'node:sqlite'
import type { BillingContextSource, BillingOperationStatus, BillingOrderStatus, BillingOwnerType, CreditApplicationStatus } from './types.js'
import { fromStoredPointUnits, toStoredPointUnits } from './pointUnits.js'

type SqlRow = Record<string, unknown>

export interface WalletSnapshot {
  balanceUnits: number
  version: number
}

export interface LedgerEntryRecord {
  id: string
  legacyId: number
  ownerType: BillingOwnerType
  ownerId: string
  deltaUnits: number
  balanceBeforeUnits: number
  balanceAfterUnits: number
  entryType: string
  memo: string | null
  idempotencyKey: string
  createdAt: number
}

export interface BillingUsageRecord {
  id: string
  userId: string
  orgId: string
  model: string | null
  inputTokens: number
  outputTokens: number
  costUnits: number
  balanceAfterUnits: number
  idempotencyKey: string
  createdAt: number
}

export interface BillingOrderRecord {
  id: string
  legacyId: number | null
  orderNo: string
  userId: string
  orgId: string
  userPhone: string | null
  amountUsdMicros: number
  amountCents: number
  exchangeRateMicros: number
  quotaUnits: number
  pointsUnits: number
  bonusUnits: number
  paymentMethod: 'ALIPAY' | 'WECHAT'
  orderDate: string
  providerOrderInfo: string | null
  callbackData?: string | null
  callbackTime?: number | null
  callbackAmountCents?: number | null
  status: BillingOrderStatus
  idempotencyKey: string
  createdAt: number
  updatedAt: number
  expiredAt: number
  remark: string | null
}

export interface ExternalBillingAccount {
  provider: string
  ownerType: BillingOwnerType
  ownerId: string
  externalAccountId: string
  quotaUnits: number
  usedQuotaUnits: number
  updatedAt: number
}

export interface QuotaOperationRecord {
  id: string
  ownerType: BillingOwnerType
  ownerId: string
  externalUserId: string
  deltaUnits: number
  observedQuotaUnits: number | null
  observedUsedUnits: number | null
  status: BillingOperationStatus
  idempotencyKey: string
  sourceType: string
  sourceId: string
  orgId: string | null
  actorUserId: string | null
  reason: string | null
  requestFingerprint: string
  contextSource: BillingContextSource
}

export interface CreditApplicationRecord {
  id: string
  legacyId: number
  applicationNo: string
  userId: string
  orgId: string
  requestedUnits: number
  approvedUnits: number | null
  quotaUnits: number | null
  reason: string
  status: CreditApplicationStatus
  adminUserId: string | null
  adminComment: string | null
  quotaOperationId: string | null
  idempotencyKey: string
  requestFingerprint: string
  createdAt: number
  reviewedAt: number | null
  updatedAt: number
}

export interface RefundRecord {
  id: string
  legacyId: number
  refundNo: string
  orderId: string
  userId: string
  refundAmountCents: number
  refundQuotaUnits: number
  refundPointsUnits: number
  reason: string | null
  refundType: string
  status: BillingOperationStatus
  providerRefundNo: string | null
  quotaOperationId: string | null
  idempotencyKey: string
  requestFingerprint: string
  createdAt: number
  updatedAt: number
}

export interface BillingActivityRecord {
  id: string
  legacyId: number
  activityType: 'CLIENT' | 'ADMIN'
  userId: string
  orgId: string
  orderId: string | null
  actorUserId: string | null
  applicationId: string | null
  pointsUnits: number
  quotaUnits: number
  amountCents: number | null
  paymentMethod: 'ALIPAY' | 'WECHAT' | null
  reason: string | null
  paymentReference: string | null
  sourceType: string
  sourceId: string | null
  details: Record<string, unknown>
  idempotencyKey: string
  createdAt: number
  processedAt: number
}

function mapOrder(row: SqlRow): BillingOrderRecord {
  return {
    id: String(row.id),
    legacyId: row.legacy_id == null ? null : Number(row.legacy_id),
    orderNo: String(row.order_no),
    userId: String(row.user_id),
    orgId: String(row.org_id),
    userPhone: row.user_phone == null ? null : String(row.user_phone),
    amountUsdMicros: Number(row.amount_usd_micros),
    amountCents: Number(row.amount_cents),
    exchangeRateMicros: Number(row.exchange_rate_micros),
    quotaUnits: Number(row.quota_units),
    pointsUnits: Number(row.points_units),
    bonusUnits: Number(row.bonus_units),
    paymentMethod: String(row.payment_method) as BillingOrderRecord['paymentMethod'],
    orderDate: String(row.order_date),
    providerOrderInfo: row.provider_order_info == null ? null : String(row.provider_order_info),
    callbackData: row.callback_payload_json == null ? null : String(row.callback_payload_json),
    callbackTime: row.callback_time == null ? null : Number(row.callback_time),
    callbackAmountCents: row.callback_amount_cents == null ? null : Number(row.callback_amount_cents),
    status: String(row.status) as BillingOrderStatus,
    idempotencyKey: String(row.idempotency_key),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiredAt: Number(row.expired_at),
    remark: row.remark == null ? null : String(row.remark),
  }
}

function mapUsageRecord(row: SqlRow): BillingUsageRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    orgId: String(row.org_id),
    model: row.model == null ? null : String(row.model),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costUnits: fromStoredPointUnits(row.cost_units),
    balanceAfterUnits: fromStoredPointUnits(row.balance_after_units),
    idempotencyKey: String(row.idempotency_key),
    createdAt: Number(row.created_at),
  }
}

export class BillingRepository {
  constructor(readonly db: DatabaseSync) {}

  getWallet(ownerType: BillingOwnerType, ownerId: string): WalletSnapshot | null {
    const row = this.db.prepare(`
      SELECT balance_units, version FROM wallets
      WHERE owner_type = ? AND owner_id = ? LIMIT 1
    `).get(ownerType, ownerId) as SqlRow | undefined
    return row ? {
      balanceUnits: fromStoredPointUnits(row.balance_units),
      version: Number(row.version),
    } : null
  }

  updateWallet(input: {
    ownerType: BillingOwnerType
    ownerId: string
    expectedVersion: number
    balanceUnits: number
    updatedAt: number
  }): boolean {
    const result = this.db.prepare(`
      UPDATE wallets
      SET balance_units = ?, version = version + 1, updated_at = ?
      WHERE owner_type = ? AND owner_id = ? AND version = ?
    `).run(toStoredPointUnits(input.balanceUnits), input.updatedAt, input.ownerType, input.ownerId, input.expectedVersion)
    return Number(result.changes) === 1
  }

  countOwnerLedgerEntries(ownerType: BillingOwnerType, ownerId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_ledger_entries
      WHERE owner_type = ? AND owner_id = ?
    `).get(ownerType, ownerId) as { count: number }
    return Number(row.count)
  }

  sumOwnerLedger(ownerType: BillingOwnerType, ownerId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(delta_units), 0) AS total FROM billing_ledger_entries
      WHERE owner_type = ? AND owner_id = ?
    `).get(ownerType, ownerId) as { total: number }
    return fromStoredPointUnits(row.total)
  }

  insertLedgerEntry(input: {
    id: string
    legacyId?: number
    ownerType: BillingOwnerType
    ownerId: string
    deltaUnits: number
    balanceBeforeUnits: number
    balanceAfterUnits: number
    entryType: string
    memo?: string | null
    sourceType: string
    sourceId: string
    idempotencyKey: string
    contextSource: BillingContextSource
    actorUserId?: string | null
    createdAt: number
  }): void {
    const legacyId = input.legacyId ?? this.nextLedgerLegacyId()
    this.db.prepare(`
      INSERT INTO billing_ledger_entries (
        id, legacy_id, owner_type, owner_id, delta_units, balance_before_units, balance_after_units,
        entry_type, memo, source_type, source_id, idempotency_key, context_source,
        actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, legacyId, input.ownerType, input.ownerId, toStoredPointUnits(input.deltaUnits),
      toStoredPointUnits(input.balanceBeforeUnits), toStoredPointUnits(input.balanceAfterUnits), input.entryType,
      input.memo ?? null, input.sourceType, input.sourceId, input.idempotencyKey,
      input.contextSource, input.actorUserId ?? null, input.createdAt,
    )
  }

  getLedgerEntry(idempotencyKey: string): LedgerEntryRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_ledger_entries WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? {
      id: String(row.id),
      legacyId: Number(row.legacy_id),
      ownerType: String(row.owner_type) as BillingOwnerType,
      ownerId: String(row.owner_id),
      deltaUnits: fromStoredPointUnits(row.delta_units),
      balanceBeforeUnits: fromStoredPointUnits(row.balance_before_units),
      balanceAfterUnits: fromStoredPointUnits(row.balance_after_units),
      entryType: String(row.entry_type),
      memo: row.memo == null ? null : String(row.memo),
      idempotencyKey: String(row.idempotency_key),
      createdAt: Number(row.created_at),
    } : null
  }

  countLedgerEntries(idempotencyKey: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_ledger_entries WHERE idempotency_key = ?
    `).get(idempotencyKey) as { count: number }
    return Number(row.count)
  }

  insertUsageRecord(input: BillingUsageRecord): void {
    this.db.prepare(`
      INSERT INTO billing_usage_records (
        id, user_id, org_id, model, input_tokens, output_tokens,
        cost_units, balance_after_units, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.userId, input.orgId, input.model,
      input.inputTokens, input.outputTokens,
      toStoredPointUnits(input.costUnits), toStoredPointUnits(input.balanceAfterUnits),
      input.idempotencyKey, input.createdAt,
    )
  }

  getUsageRecord(idempotencyKey: string): BillingUsageRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_usage_records WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? mapUsageRecord(row) : null
  }

  listUsageRecords(input: {
    userId: string
    from?: number
    to?: number
    limit: number
    offset: number
  }): { list: BillingUsageRecord[]; total: number } {
    const clauses = ['user_id = ?']
    const params: Array<string | number> = [input.userId]
    if (input.from !== undefined) { clauses.push('created_at >= ?'); params.push(input.from) }
    if (input.to !== undefined) { clauses.push('created_at <= ?'); params.push(input.to) }
    const where = `WHERE ${clauses.join(' AND ')}`
    const rows = this.db.prepare(`
      SELECT * FROM billing_usage_records ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_usage_records ${where}
    `).get(...params) as { count: number }
    return { list: rows.map(mapUsageRecord), total: Number(total.count) }
  }

  insertAuditEvent(input: {
    id: string
    action: string
    aggregateType: string
    aggregateId: string
    actorUserId?: string | null
    orgId?: string | null
    contextSource: BillingContextSource
    idempotencyKey: string
    payload: Record<string, unknown>
    createdAt: number
  }): void {
    this.db.prepare(`
      INSERT INTO billing_audit_events (
        id, action, aggregate_type, aggregate_id, actor_user_id, org_id,
        context_source, idempotency_key, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.action, input.aggregateType, input.aggregateId,
      input.actorUserId ?? null, input.orgId ?? null, input.contextSource,
      input.idempotencyKey, JSON.stringify(input.payload), input.createdAt,
    )
  }

  countAuditEvents(idempotencyKey: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_audit_events WHERE idempotency_key = ?
    `).get(idempotencyKey) as { count: number }
    return Number(row.count)
  }

  insertOrder(input: BillingOrderRecord): void {
    this.db.prepare(`
      INSERT INTO billing_orders (
        id, legacy_id, order_no, user_id, org_id, user_phone,
        amount_usd_micros, amount_cents, exchange_rate_micros,
        quota_units, points_units, bonus_units, payment_method, order_date,
        provider_order_info, callback_payload_json, callback_time, callback_amount_cents,
        status, idempotency_key, created_at, updated_at, expired_at, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.legacyId, input.orderNo, input.userId, input.orgId, input.userPhone,
      input.amountUsdMicros, input.amountCents, input.exchangeRateMicros,
      input.quotaUnits, input.pointsUnits, input.bonusUnits, input.paymentMethod,
      input.orderDate, input.providerOrderInfo,
      input.callbackData ?? null, input.callbackTime ?? null, input.callbackAmountCents ?? null,
      input.status, input.idempotencyKey,
      input.createdAt, input.updatedAt, input.expiredAt, input.remark,
    )
  }

  getOrderByOrderNo(orderNo: string, userId?: string): BillingOrderRecord | null {
    const row = (userId
      ? this.db.prepare('SELECT * FROM billing_orders WHERE order_no = ? AND user_id = ? LIMIT 1').get(orderNo, userId)
      : this.db.prepare('SELECT * FROM billing_orders WHERE order_no = ? LIMIT 1').get(orderNo)) as SqlRow | undefined
    return row ? mapOrder(row) : null
  }

  getOrderByLegacyId(legacyId: number): BillingOrderRecord | null {
    const row = this.db.prepare('SELECT * FROM billing_orders WHERE legacy_id = ? LIMIT 1').get(legacyId) as SqlRow | undefined
    return row ? mapOrder(row) : null
  }

  assignOrderLegacyId(orderId: string, legacyId: number): void {
    this.db.prepare('UPDATE billing_orders SET legacy_id = ? WHERE id = ? AND legacy_id IS NULL').run(legacyId, orderId)
  }

  listOrders(input: {
    userId?: string
    orgId?: string
    status?: BillingOrderStatus
    orderNo?: string
    userPhone?: string
    startAt?: number
    endAt?: number
    limit: number
    offset: number
  }): { list: BillingOrderRecord[]; total: number } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined) return
      clauses.push(clause)
      params.push(value)
    }
    add('user_id = ?', input.userId)
    add('org_id = ?', input.orgId)
    add('status = ?', input.status)
    if (input.orderNo) add('order_no LIKE ?', `%${input.orderNo}%`)
    if (input.userPhone) add('user_phone LIKE ?', `%${input.userPhone}%`)
    add('created_at >= ?', input.startAt)
    add('created_at <= ?', input.endAt)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM billing_orders ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM billing_orders ${where}`)
      .get(...params) as { count: number }
    return { list: rows.map(mapOrder), total: Number(total.count) }
  }

  getOrderStatistics(since?: number): {
    orders: number
    amountUsdMicros: number
    amountCents: number
    pointsUnits: number
    bonusUnits: number
    successCount: number
    failedCount: number
    pendingCount: number
  } {
    const where = since === undefined ? '' : 'WHERE created_at >= ?'
    const params = since === undefined ? [] : [since]
    const row = this.db.prepare(`
      SELECT COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount_usd_micros ELSE 0 END), 0) AS amount_usd_micros,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount_cents ELSE 0 END), 0) AS amount_cents,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN points_units ELSE 0 END), 0) AS points_units,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN bonus_units ELSE 0 END), 0) AS bonus_units,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status IN ('PENDING', 'PAYING') THEN 1 ELSE 0 END), 0) AS pending_count
      FROM billing_orders ${where}
    `).get(...params) as SqlRow
    return {
      orders: Number(row.orders), amountUsdMicros: Number(row.amount_usd_micros),
      amountCents: Number(row.amount_cents), pointsUnits: Number(row.points_units),
      bonusUnits: Number(row.bonus_units), successCount: Number(row.success_count),
      failedCount: Number(row.failed_count), pendingCount: Number(row.pending_count),
    }
  }

  updateOrderStatus(input: {
    orderId: string
    status: BillingOrderStatus
    updatedAt: number
    remark?: string | null
    providerOrderInfo?: string | null
    callbackData?: string | null
    callbackTime?: number | null
    callbackAmountCents?: number | null
  }): void {
    this.db.prepare(`
      UPDATE billing_orders
      SET status = ?, updated_at = ?,
          remark = COALESCE(?, remark),
          provider_order_info = COALESCE(?, provider_order_info),
          callback_payload_json = COALESCE(?, callback_payload_json),
          callback_time = COALESCE(?, callback_time),
          callback_amount_cents = COALESCE(?, callback_amount_cents)
      WHERE id = ?
    `).run(
      input.status, input.updatedAt, input.remark ?? null, input.providerOrderInfo ?? null,
      input.callbackData ?? null, input.callbackTime ?? null, input.callbackAmountCents ?? null,
      input.orderId,
    )
  }

  countOrders(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM billing_orders').get() as { count: number }).count)
  }

  insertPaymentAttempt(input: {
    id: string
    orderId: string
    provider: string
    status: BillingOperationStatus
    idempotencyKey: string
    request: Record<string, unknown>
    createdAt: number
  }): void {
    this.db.prepare(`
      INSERT INTO billing_payment_attempts (
        id, order_id, provider, status, idempotency_key, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.orderId, input.provider, input.status, input.idempotencyKey,
      JSON.stringify(input.request), input.createdAt, input.createdAt,
    )
  }

  updatePaymentAttempt(input: {
    id: string
    status: BillingOperationStatus
    response?: Record<string, unknown> | null
    errorText?: string | null
    updatedAt: number
  }): void {
    this.db.prepare(`
      UPDATE billing_payment_attempts
      SET status = ?, response_json = ?, error_text = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      input.status, input.response ? JSON.stringify(input.response) : null,
      input.errorText ?? null, input.updatedAt,
      ['SUCCEEDED', 'FAILED', 'SUPPRESSED'].includes(input.status) ? input.updatedAt : null,
      input.id,
    )
  }

  countPaymentAttempts(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM billing_payment_attempts').get() as { count: number }).count)
  }

  getProviderEvent(provider: string, providerEventId: string): {
    id: string
    payloadHash: string
    status: BillingOperationStatus
  } | null {
    const row = this.db.prepare(`
      SELECT id, payload_hash, status FROM billing_provider_events
      WHERE provider = ? AND provider_event_id = ? LIMIT 1
    `).get(provider, providerEventId) as SqlRow | undefined
    return row ? {
      id: String(row.id),
      payloadHash: String(row.payload_hash),
      status: String(row.status) as BillingOperationStatus,
    } : null
  }

  insertProviderEvent(input: {
    id: string
    provider: string
    providerEventId: string
    eventType: string
    payloadHash: string
    payload: Record<string, unknown>
    status: BillingOperationStatus
    receivedAt: number
  }): void {
    this.db.prepare(`
      INSERT INTO billing_provider_events (
        id, provider, provider_event_id, event_type, payload_hash,
        payload_json, status, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.provider, input.providerEventId, input.eventType,
      input.payloadHash, JSON.stringify(input.payload), input.status, input.receivedAt,
    )
  }

  updateProviderEvent(input: {
    id: string
    status: BillingOperationStatus
    errorText?: string | null
    processedAt: number
  }): void {
    this.db.prepare(`
      UPDATE billing_provider_events
      SET status = ?, error_text = ?, processed_at = ? WHERE id = ?
    `).run(input.status, input.errorText ?? null, input.processedAt, input.id)
  }

  countProviderEvents(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM billing_provider_events').get() as { count: number }).count)
  }

  upsertExternalAccount(input: ExternalBillingAccount): void {
    this.db.prepare(`
      INSERT INTO billing_external_accounts (
        provider, owner_type, owner_id, external_account_id,
        quota_units, used_quota_units, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, owner_type, owner_id) DO UPDATE SET
        external_account_id = excluded.external_account_id,
        quota_units = excluded.quota_units,
        used_quota_units = excluded.used_quota_units,
        updated_at = excluded.updated_at
    `).run(
      input.provider, input.ownerType, input.ownerId, input.externalAccountId,
      input.quotaUnits, input.usedQuotaUnits, input.updatedAt,
    )
  }

  getExternalAccount(provider: string, ownerType: BillingOwnerType, ownerId: string): ExternalBillingAccount | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_external_accounts
      WHERE provider = ? AND owner_type = ? AND owner_id = ? LIMIT 1
    `).get(provider, ownerType, ownerId) as SqlRow | undefined
    return row ? {
      provider: String(row.provider), ownerType: String(row.owner_type) as BillingOwnerType,
      ownerId: String(row.owner_id), externalAccountId: String(row.external_account_id),
      quotaUnits: Number(row.quota_units), usedQuotaUnits: Number(row.used_quota_units),
      updatedAt: Number(row.updated_at),
    } : null
  }

  insertQuotaOperation(input: {
    id: string
    ownerType: BillingOwnerType
    ownerId: string
    externalUserId: string
    deltaUnits: number
    status: BillingOperationStatus
    idempotencyKey: string
    sourceType: string
    sourceId: string
    orgId?: string | null
    actorUserId?: string | null
    reason?: string | null
    requestFingerprint: string
    contextSource: BillingContextSource
    createdAt: number
  }): void {
    this.db.prepare(`
      INSERT INTO billing_quota_operations (
        id, owner_type, owner_id, external_user_id, delta_units, status,
        idempotency_key, source_type, source_id, org_id, actor_user_id,
        reason, request_fingerprint, context_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.ownerType, input.ownerId, input.externalUserId, input.deltaUnits,
      input.status, input.idempotencyKey, input.sourceType, input.sourceId,
      input.orgId ?? null, input.actorUserId ?? null, input.reason ?? null,
      input.requestFingerprint, input.contextSource, input.createdAt, input.createdAt,
    )
  }

  getQuotaOperationById(id: string): QuotaOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM billing_quota_operations WHERE id = ? LIMIT 1').get(id) as SqlRow | undefined
    return row ? this.mapQuotaOperation(row) : null
  }

  getQuotaOperationByKey(idempotencyKey: string): QuotaOperationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_quota_operations WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? this.mapQuotaOperation(row) : null
  }

  listRecoverableQuotaOperationIds(limit = 100): string[] {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 100
    const rows = this.db.prepare(`
      SELECT id FROM billing_quota_operations
      WHERE status IN ('PENDING', 'PROCESSING', 'UNKNOWN')
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(safeLimit) as Array<{ id: string }>
    return rows.map(row => String(row.id))
  }

  updateQuotaOperation(input: {
    id: string
    status: BillingOperationStatus
    observedQuotaUnits?: number | null
    observedUsedUnits?: number | null
    providerResponse?: Record<string, unknown> | null
    errorText?: string | null
    updatedAt: number
  }): void {
    this.db.prepare(`
      UPDATE billing_quota_operations SET
        status = ?,
        observed_quota_units = COALESCE(?, observed_quota_units),
        observed_used_units = COALESCE(?, observed_used_units),
        provider_response_json = ?, error_text = ?, updated_at = ?,
        completed_at = CASE WHEN ? IN ('SUCCEEDED', 'FAILED', 'SUPPRESSED') THEN ? ELSE NULL END
      WHERE id = ?
    `).run(
      input.status, input.observedQuotaUnits ?? null, input.observedUsedUnits ?? null,
      input.providerResponse ? JSON.stringify(input.providerResponse) : null,
      input.errorText ?? null, input.updatedAt, input.status, input.updatedAt, input.id,
    )
  }

  private mapQuotaOperation(row: SqlRow): QuotaOperationRecord {
    return {
      id: String(row.id), ownerType: String(row.owner_type) as BillingOwnerType,
      ownerId: String(row.owner_id), externalUserId: String(row.external_user_id),
      deltaUnits: Number(row.delta_units),
      observedQuotaUnits: row.observed_quota_units == null ? null : Number(row.observed_quota_units),
      observedUsedUnits: row.observed_used_units == null ? null : Number(row.observed_used_units),
      status: String(row.status) as BillingOperationStatus,
      idempotencyKey: String(row.idempotency_key), sourceType: String(row.source_type),
      sourceId: String(row.source_id), orgId: row.org_id == null ? null : String(row.org_id),
      actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
      reason: row.reason == null ? null : String(row.reason),
      requestFingerprint: String(row.request_fingerprint),
      contextSource: String(row.context_source) as BillingContextSource,
    }
  }

  getUserState(userId: string): { orgId: string; status: string } | null {
    const row = this.db.prepare('SELECT org_id, status FROM users WHERE id = ? LIMIT 1').get(userId) as SqlRow | undefined
    return row ? { orgId: String(row.org_id), status: String(row.status) } : null
  }

  countPendingCreditApplications(userId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_credit_applications
      WHERE user_id = ? AND status IN ('PENDING', 'PROCESSING', 'SYNC_UNKNOWN')
    `).get(userId) as { count: number }
    return Number(row.count)
  }

  insertCreditApplication(input: CreditApplicationRecord): void {
    this.db.prepare(`
      INSERT INTO billing_credit_applications (
        id, legacy_id, application_no, user_id, org_id, requested_units,
        approved_units, quota_units, reason, status, admin_user_id,
        admin_comment, quota_operation_id, idempotency_key, request_fingerprint,
        created_at, reviewed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.legacyId, input.applicationNo, input.userId, input.orgId,
      input.requestedUnits, input.approvedUnits, input.quotaUnits, input.reason,
      input.status, input.adminUserId, input.adminComment, input.quotaOperationId,
      input.idempotencyKey, input.requestFingerprint, input.createdAt,
      input.reviewedAt, input.updatedAt,
    )
  }

  getCreditApplication(id: string): CreditApplicationRecord | null {
    const row = this.db.prepare('SELECT * FROM billing_credit_applications WHERE id = ? LIMIT 1').get(id) as SqlRow | undefined
    return row ? this.mapCreditApplication(row) : null
  }

  getCreditApplicationByLegacyId(legacyId: number): CreditApplicationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_credit_applications WHERE legacy_id = ? LIMIT 1
    `).get(legacyId) as SqlRow | undefined
    return row ? this.mapCreditApplication(row) : null
  }

  countCreditApplications(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM billing_credit_applications').get() as { count: number }).count)
  }

  insertActivityRecord(input: BillingActivityRecord): void {
    this.db.prepare(`
      INSERT INTO billing_activity_records (
        id, legacy_id, activity_type, user_id, org_id, order_id, actor_user_id,
        application_id, points_units, quota_units, amount_cents, payment_method,
        reason, payment_reference, source_type, source_id, details_json,
        idempotency_key, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.legacyId, input.activityType, input.userId, input.orgId,
      input.orderId, input.actorUserId, input.applicationId, input.pointsUnits,
      input.quotaUnits, input.amountCents, input.paymentMethod, input.reason,
      input.paymentReference, input.sourceType, input.sourceId,
      JSON.stringify(input.details), input.idempotencyKey, input.createdAt, input.processedAt,
    )
  }

  getActivityByLegacyId(activityType: 'CLIENT' | 'ADMIN', legacyId: number): BillingActivityRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_activity_records WHERE activity_type = ? AND legacy_id = ? LIMIT 1
    `).get(activityType, legacyId) as SqlRow | undefined
    return row ? this.mapActivity(row) : null
  }

  getActivityByIdempotencyKey(idempotencyKey: string): BillingActivityRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_activity_records WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? this.mapActivity(row) : null
  }

  allocateActivityLegacyId(activityType: 'CLIENT' | 'ADMIN'): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(legacy_id), 0) + 1 AS next_id
      FROM billing_activity_records WHERE activity_type = ?
    `).get(activityType) as { next_id: number }
    return Math.max(Number(row.next_id), 2_000_000_000)
  }

  listRechargeActivities(input: {
    orgId?: string
    userId?: string
    activityType?: 'CLIENT' | 'ADMIN'
    keyword?: string
    paymentMethod?: 'ALIPAY' | 'WECHAT'
    limit: number
    offset: number
  }): { list: BillingActivityRecord[]; total: number } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (input.orgId) { clauses.push('ar.org_id = ?'); params.push(input.orgId) }
    if (input.userId) { clauses.push('ar.user_id = ?'); params.push(input.userId) }
    if (input.activityType) { clauses.push('ar.activity_type = ?'); params.push(input.activityType) }
    if (input.paymentMethod) { clauses.push('ar.payment_method = ?'); params.push(input.paymentMethod) }
    if (input.keyword) {
      clauses.push('(u.name LIKE ? OR COALESCE(u.display_name, \'\') LIKE ? OR COALESCE(phone.normalized_subject, \'\') LIKE ?)')
      params.push(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT ar.* FROM billing_activity_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN user_auth_identities phone
        ON phone.user_id = ar.user_id AND phone.provider = 'phone' AND phone.issuer = 'sudowork'
      ${where} ORDER BY ar.created_at DESC, ar.id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_activity_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN user_auth_identities phone
        ON phone.user_id = ar.user_id AND phone.provider = 'phone' AND phone.issuer = 'sudowork'
      ${where}
    `)
      .get(...params) as { count: number }
    return { list: rows.map(row => this.mapActivity(row)), total: Number(total.count) }
  }

  countActivityRecords(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM billing_activity_records').get() as { count: number }).count)
  }

  listCreditApplications(input: {
    userId?: string
    orgId?: string
    status?: CreditApplicationStatus
    keyword?: string
    limit: number
    offset: number
  }): { list: CreditApplicationRecord[]; total: number } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (input.userId) { clauses.push('ca.user_id = ?'); params.push(input.userId) }
    if (input.orgId) { clauses.push('ca.org_id = ?'); params.push(input.orgId) }
    if (input.status) { clauses.push('ca.status = ?'); params.push(input.status) }
    if (input.keyword) {
      clauses.push('(ca.application_no LIKE ? OR u.name LIKE ? OR COALESCE(u.display_name, \'\') LIKE ?)')
      params.push(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT ca.* FROM billing_credit_applications ca
      JOIN users u ON u.id = ca.user_id ${where}
      ORDER BY ca.created_at DESC, ca.id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_credit_applications ca
      JOIN users u ON u.id = ca.user_id ${where}
    `).get(...params) as { count: number }
    return { list: rows.map(row => this.mapCreditApplication(row)), total: Number(total.count) }
  }

  listLedgerEntries(input: {
    userId?: string
    orgId?: string
    keyword?: string
    entryType?: string
    excludeEntryType?: string
    limit: number
    offset: number
  }): { list: Array<LedgerEntryRecord & { ownerName: string | null }>; total: number } {
    const clauses = ["le.owner_type = 'user'"]
    const params: Array<string | number> = []
    if (input.userId) { clauses.push('le.owner_id = ?'); params.push(input.userId) }
    if (input.orgId) { clauses.push('u.org_id = ?'); params.push(input.orgId) }
    if (input.entryType) { clauses.push('le.entry_type = ?'); params.push(input.entryType) }
    if (input.excludeEntryType) { clauses.push('le.entry_type != ?'); params.push(input.excludeEntryType) }
    if (input.keyword) {
      clauses.push('(u.name LIKE ? OR COALESCE(u.display_name, \'\') LIKE ?)')
      params.push(`%${input.keyword}%`, `%${input.keyword}%`)
    }
    const where = `WHERE ${clauses.join(' AND ')}`
    const rows = this.db.prepare(`
      SELECT le.*, COALESCE(u.display_name, u.name) AS owner_name
      FROM billing_ledger_entries le JOIN users u ON u.id = le.owner_id
      ${where} ORDER BY le.created_at DESC, le.id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_ledger_entries le
      JOIN users u ON u.id = le.owner_id ${where}
    `).get(...params) as { count: number }
    return {
      list: rows.map(row => ({
        id: String(row.id), legacyId: Number(row.legacy_id), ownerType: String(row.owner_type) as BillingOwnerType,
        ownerId: String(row.owner_id), deltaUnits: fromStoredPointUnits(row.delta_units),
        balanceBeforeUnits: fromStoredPointUnits(row.balance_before_units),
        balanceAfterUnits: fromStoredPointUnits(row.balance_after_units),
        entryType: String(row.entry_type), memo: row.memo == null ? null : String(row.memo),
        idempotencyKey: String(row.idempotency_key),
        createdAt: Number(row.created_at), ownerName: row.owner_name == null ? null : String(row.owner_name),
      })),
      total: Number(total.count),
    }
  }

  private nextLedgerLegacyId(): number {
    const row = this.db.prepare('SELECT MAX(legacy_id) AS value FROM billing_ledger_entries').get() as {
      value: number | null
    }
    return Math.max(2_000_000_000, Number(row.value ?? 1_999_999_999) + 1)
  }

  getCreditApplicationByIdempotencyKey(idempotencyKey: string): CreditApplicationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_credit_applications WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? this.mapCreditApplication(row) : null
  }

  markCreditApplicationReview(input: {
    id: string
    status: CreditApplicationStatus
    approvedUnits?: number | null
    quotaUnits?: number | null
    adminUserId?: string | null
    adminComment?: string | null
    quotaOperationId?: string | null
    reviewedAt?: number | null
    updatedAt: number
  }): void {
    this.db.prepare(`
      UPDATE billing_credit_applications SET
        status = ?, approved_units = COALESCE(?, approved_units),
        quota_units = COALESCE(?, quota_units),
        admin_user_id = COALESCE(?, admin_user_id),
        admin_comment = COALESCE(?, admin_comment),
        quota_operation_id = COALESCE(?, quota_operation_id),
        reviewed_at = COALESCE(?, reviewed_at), updated_at = ?
      WHERE id = ?
    `).run(
      input.status, input.approvedUnits ?? null, input.quotaUnits ?? null,
      input.adminUserId ?? null, input.adminComment ?? null,
      input.quotaOperationId ?? null, input.reviewedAt ?? null,
      input.updatedAt, input.id,
    )
  }

  private mapCreditApplication(row: SqlRow): CreditApplicationRecord {
    return {
      id: String(row.id), legacyId: Number(row.legacy_id), applicationNo: String(row.application_no),
      userId: String(row.user_id), orgId: String(row.org_id), requestedUnits: Number(row.requested_units),
      approvedUnits: row.approved_units == null ? null : Number(row.approved_units),
      quotaUnits: row.quota_units == null ? null : Number(row.quota_units),
      reason: String(row.reason), status: String(row.status) as CreditApplicationStatus,
      adminUserId: row.admin_user_id == null ? null : String(row.admin_user_id),
      adminComment: row.admin_comment == null ? null : String(row.admin_comment),
      quotaOperationId: row.quota_operation_id == null ? null : String(row.quota_operation_id),
      idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint),
      createdAt: Number(row.created_at), reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
      updatedAt: Number(row.updated_at),
    }
  }

  insertRefund(input: RefundRecord): void {
    this.db.prepare(`
      INSERT INTO billing_refunds (
        id, legacy_id, refund_no, order_id, user_id, refund_amount_cents,
        refund_quota_units, refund_points_units, reason, refund_type, status,
        provider_refund_no, quota_operation_id, idempotency_key,
        request_fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.legacyId, input.refundNo, input.orderId, input.userId,
      input.refundAmountCents, input.refundQuotaUnits, input.refundPointsUnits,
      input.reason, input.refundType, input.status, input.providerRefundNo,
      input.quotaOperationId, input.idempotencyKey, input.requestFingerprint,
      input.createdAt, input.updatedAt,
    )
  }

  getRefundById(id: string): RefundRecord | null {
    const row = this.db.prepare('SELECT * FROM billing_refunds WHERE id = ? LIMIT 1').get(id) as SqlRow | undefined
    return row ? this.mapRefund(row) : null
  }

  getRefundByLegacyId(legacyId: number): RefundRecord | null {
    const row = this.db.prepare('SELECT * FROM billing_refunds WHERE legacy_id = ? LIMIT 1').get(legacyId) as SqlRow | undefined
    return row ? this.mapRefund(row) : null
  }

  countRefunds(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM billing_refunds').get() as { count: number }).count)
  }

  getRefundByIdempotencyKey(idempotencyKey: string): RefundRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_refunds WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? this.mapRefund(row) : null
  }

  getActiveRefundForOrder(orderId: string): RefundRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM billing_refunds
      WHERE order_id = ? AND status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(orderId) as SqlRow | undefined
    return row ? this.mapRefund(row) : null
  }

  updateRefund(input: {
    id: string
    status: BillingOperationStatus
    providerRefundNo?: string | null
    providerResponse?: Record<string, unknown> | null
    quotaOperationId?: string | null
    updatedAt: number
  }): void {
    this.db.prepare(`
      UPDATE billing_refunds SET
        status = ?, provider_refund_no = COALESCE(?, provider_refund_no),
        provider_response_json = COALESCE(?, provider_response_json),
        quota_operation_id = COALESCE(?, quota_operation_id), updated_at = ?,
        processed_at = CASE WHEN ? IN ('SUCCEEDED', 'FAILED', 'SUPPRESSED') THEN ? ELSE processed_at END
      WHERE id = ?
    `).run(
      input.status, input.providerRefundNo ?? null,
      input.providerResponse ? JSON.stringify(input.providerResponse) : null,
      input.quotaOperationId ?? null, input.updatedAt, input.status,
      input.updatedAt, input.id,
    )
  }

  countRefundsForOrder(orderId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM billing_refunds WHERE order_id = ?
    `).get(orderId) as { count: number }
    return Number(row.count)
  }

  insertReconciliation(input: {
    id: string
    scopeType: string
    scopeId: string
    reconciliationType: string
    expectedUnits: number
    actualUnits: number
    differenceUnits: number
    status: 'MATCHED' | 'MISMATCH' | 'RESOLVED'
    details: Record<string, unknown>
    createdAt: number
  }): void {
    this.db.prepare(`
      INSERT INTO billing_reconciliations (
        id, scope_type, scope_id, reconciliation_type, expected_units,
        actual_units, difference_units, status, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.scopeType, input.scopeId, input.reconciliationType,
      input.expectedUnits, input.actualUnits, input.differenceUnits,
      input.status, JSON.stringify(input.details), input.createdAt,
    )
  }

  countReconciliations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM billing_reconciliations').get() as { count: number }
    return Number(row.count)
  }

  countDeliverableExternalOutbox(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM outbox_events
      WHERE status = 'pending'
    `).get() as { count: number }
    return Number(row.count)
  }

  saveMigrationCheckpoint(input: {
    sourceChecksum: string
    migrationRunId: string
    report: Record<string, unknown>
    createdAt: number
    verifiedAt: number
  }): void {
    this.db.prepare(`
      INSERT INTO billing_migration_checkpoints (
        source_checksum, migration_run_id, report_json, created_at, verified_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_checksum) DO UPDATE SET
        migration_run_id = excluded.migration_run_id,
        report_json = excluded.report_json,
        verified_at = excluded.verified_at
    `).run(
      input.sourceChecksum, input.migrationRunId, JSON.stringify(input.report),
      input.createdAt, input.verifiedAt,
    )
  }

  getMigrationCheckpoint(sourceChecksum: string): { migrationRunId: string; report: Record<string, unknown> } | null {
    const row = this.db.prepare(`
      SELECT migration_run_id, report_json FROM billing_migration_checkpoints
      WHERE source_checksum = ? LIMIT 1
    `).get(sourceChecksum) as { migration_run_id: string; report_json: string } | undefined
    return row ? { migrationRunId: row.migration_run_id, report: JSON.parse(row.report_json) as Record<string, unknown> } : null
  }

  private mapActivity(row: SqlRow): BillingActivityRecord {
    return {
      id: String(row.id), legacyId: Number(row.legacy_id),
      activityType: String(row.activity_type) as BillingActivityRecord['activityType'],
      userId: String(row.user_id), orgId: String(row.org_id),
      orderId: row.order_id == null ? null : String(row.order_id),
      actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
      applicationId: row.application_id == null ? null : String(row.application_id),
      pointsUnits: Number(row.points_units), quotaUnits: Number(row.quota_units),
      amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
      paymentMethod: row.payment_method == null ? null : String(row.payment_method) as BillingActivityRecord['paymentMethod'],
      reason: row.reason == null ? null : String(row.reason),
      paymentReference: row.payment_reference == null ? null : String(row.payment_reference),
      sourceType: String(row.source_type), sourceId: row.source_id == null ? null : String(row.source_id),
      details: JSON.parse(String(row.details_json)) as Record<string, unknown>,
      idempotencyKey: String(row.idempotency_key), createdAt: Number(row.created_at),
      processedAt: Number(row.processed_at),
    }
  }

  private mapRefund(row: SqlRow): RefundRecord {
    return {
      id: String(row.id), legacyId: Number(row.legacy_id), refundNo: String(row.refund_no),
      orderId: String(row.order_id), userId: String(row.user_id),
      refundAmountCents: Number(row.refund_amount_cents),
      refundQuotaUnits: Number(row.refund_quota_units),
      refundPointsUnits: Number(row.refund_points_units),
      reason: row.reason == null ? null : String(row.reason), refundType: String(row.refund_type),
      status: String(row.status) as BillingOperationStatus,
      providerRefundNo: row.provider_refund_no == null ? null : String(row.provider_refund_no),
      quotaOperationId: row.quota_operation_id == null ? null : String(row.quota_operation_id),
      idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  getCommandResult<T>(commandType: string, idempotencyKey: string): {
    requestFingerprint: string | null
    result: T
  } | null {
    const row = this.db.prepare(`
      SELECT request_fingerprint, result_json FROM command_executions
      WHERE command_type = ? AND idempotency_key = ? LIMIT 1
    `).get(commandType, idempotencyKey) as { request_fingerprint: string | null; result_json: string } | undefined
    return row ? {
      requestFingerprint: row.request_fingerprint,
      result: JSON.parse(row.result_json) as T,
    } : null
  }

  saveCommandResult(
    commandType: string,
    idempotencyKey: string,
    requestFingerprint: string,
    contextSource: BillingContextSource,
    result: unknown,
    createdAt: number,
  ): void {
    this.db.prepare(`
      INSERT INTO command_executions (
        command_type, idempotency_key, context_source, request_fingerprint, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(commandType, idempotencyKey, contextSource, requestFingerprint, JSON.stringify(result), createdAt)
  }
}
