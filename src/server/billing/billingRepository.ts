import type { DbDriver, SqlRow } from '../db/driver.js'
import type { BillingContextSource, BillingOperationStatus, BillingOrderStatus, BillingOwnerType, CreditApplicationStatus } from './types.js'
import { fromStoredPointUnits, toStoredPointUnits } from './pointUnits.js'

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
  tokenSecretRef?: string | null
  updatedAt: number
}

export type SudorouterProvisioningStatus =
  | 'PENDING' | 'PROCESSING' | 'ACCOUNT_READY' | 'QUOTA_READY' | 'TOKEN_READY'
  | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'SUPPRESSED'

export interface SudorouterProvisioningRecord {
  id: string
  ownerId: string
  orgId: string
  username: string
  displayName: string
  initialQuotaUnits: number
  externalAccountId: string | null
  quotaUnits: number | null
  usedQuotaUnits: number | null
  tokenSecretRef: string | null
  status: SudorouterProvisioningStatus
  idempotencyKey: string
  requestFingerprint: string
  contextSource: BillingContextSource
  errorText: string | null
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
  constructor(readonly driver: DbDriver) {}

  async getWallet(ownerType: BillingOwnerType, ownerId: string): Promise<WalletSnapshot | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT balance_units, version FROM wallets
      WHERE owner_type = ? AND owner_id = ? LIMIT 1
    `, [ownerType, ownerId])
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
  }): Promise<boolean> {
    return this.updateWalletAsync(input)
  }

  private async updateWalletAsync(input: Parameters<BillingRepository['updateWallet']>[0]): Promise<boolean> {
    const changes = await this.driver.run(`
      UPDATE wallets
      SET balance_units = ?, version = version + 1, updated_at = ?
      WHERE owner_type = ? AND owner_id = ? AND version = ?
    `, [toStoredPointUnits(input.balanceUnits), input.updatedAt, input.ownerType, input.ownerId, input.expectedVersion])
    return changes === 1
  }

  async countOwnerLedgerEntries(ownerType: BillingOwnerType, ownerId: string): Promise<number> {
    const row = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_ledger_entries
      WHERE owner_type = ? AND owner_id = ?
    `, [ownerType, ownerId])
    return Number(row?.count ?? 0)
  }

  async sumOwnerLedger(ownerType: BillingOwnerType, ownerId: string): Promise<number> {
    const row = await this.driver.get<{ total: number }>(`
      SELECT COALESCE(SUM(delta_units), 0) AS total FROM billing_ledger_entries
      WHERE owner_type = ? AND owner_id = ?
    `, [ownerType, ownerId])
    return fromStoredPointUnits(row?.total ?? 0)
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
  }): Promise<void> {
    return this.insertLedgerEntryAsync(input)
  }

  private async insertLedgerEntryAsync(input: Parameters<BillingRepository['insertLedgerEntry']>[0]): Promise<void> {
    await this.driver.transaction(async () => {
      const legacyId = input.legacyId ?? await this.nextLedgerLegacyId()
      await this.driver.run(`
        INSERT INTO billing_ledger_entries (
          id, legacy_id, owner_type, owner_id, delta_units, balance_before_units, balance_after_units,
          entry_type, memo, source_type, source_id, idempotency_key, context_source,
          actor_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.id, legacyId, input.ownerType, input.ownerId, toStoredPointUnits(input.deltaUnits),
        toStoredPointUnits(input.balanceBeforeUnits), toStoredPointUnits(input.balanceAfterUnits), input.entryType,
        input.memo ?? null, input.sourceType, input.sourceId, input.idempotencyKey,
        input.contextSource, input.actorUserId ?? null, input.createdAt,
      ])
      await this.advanceCounter('billing_ledger_entries', legacyId)
    })
  }

  async getLedgerEntry(idempotencyKey: string): Promise<LedgerEntryRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_ledger_entries WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
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

  async countLedgerEntries(idempotencyKey: string): Promise<number> {
    const row = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_ledger_entries WHERE idempotency_key = ?
    `, [idempotencyKey])
    return Number(row?.count ?? 0)
  }

  async insertUsageRecord(input: BillingUsageRecord): Promise<void> {
    await this.driver.run(`
      INSERT INTO billing_usage_records (
        id, user_id, org_id, model, input_tokens, output_tokens,
        cost_units, balance_after_units, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.userId, input.orgId, input.model,
      input.inputTokens, input.outputTokens,
      toStoredPointUnits(input.costUnits), toStoredPointUnits(input.balanceAfterUnits),
      input.idempotencyKey, input.createdAt,
    ])
  }

  async getUsageRecord(idempotencyKey: string): Promise<BillingUsageRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_usage_records WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
    return row ? mapUsageRecord(row) : null
  }

  listUsageRecords(input: {
    userId: string
    from?: number
    to?: number
    limit: number
    offset: number
  }): Promise<{ list: BillingUsageRecord[]; total: number }> {
    return this.listUsageRecordsAsync(input)
  }

  private async listUsageRecordsAsync(input: Parameters<BillingRepository['listUsageRecords']>[0]): Promise<{ list: BillingUsageRecord[]; total: number }> {
    const clauses = ['user_id = ?']
    const params: Array<string | number> = [input.userId]
    if (input.from !== undefined) { clauses.push('created_at >= ?'); params.push(input.from) }
    if (input.to !== undefined) { clauses.push('created_at <= ?'); params.push(input.to) }
    const where = `WHERE ${clauses.join(' AND ')}`
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM billing_usage_records ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `, [...params, input.limit, input.offset])
    const total = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_usage_records ${where}
    `, params)
    return { list: rows.map(mapUsageRecord), total: Number(total?.count ?? 0) }
  }

  async sumUserUsageCost(userId: string): Promise<number> {
    const row = await this.driver.get<{ total: number }>(`
      SELECT COALESCE(SUM(cost_units), 0) AS total
      FROM billing_usage_records WHERE user_id = ?
    `, [userId])
    return fromStoredPointUnits(row?.total ?? 0)
  }

  async sumUserLedgerByEntryType(userId: string, entryType: string): Promise<number> {
    const row = await this.driver.get<{ total: number }>(`
      SELECT COALESCE(SUM(delta_units), 0) AS total
      FROM billing_ledger_entries
      WHERE owner_type = 'user' AND owner_id = ? AND entry_type = ?
    `, [userId, entryType])
    return fromStoredPointUnits(row?.total ?? 0)
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
  }): Promise<boolean> {
    return this.driver.run(`
      INSERT INTO billing_audit_events (
        id, action, aggregate_type, aggregate_id, actor_user_id, org_id,
        context_source, idempotency_key, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.action, input.aggregateType, input.aggregateId,
      input.actorUserId ?? null, input.orgId ?? null, input.contextSource,
      input.idempotencyKey, JSON.stringify(input.payload), input.createdAt,
    ]).then(() => undefined)
  }

  async countAuditEvents(idempotencyKey: string): Promise<number> {
    const row = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_audit_events WHERE idempotency_key = ?
    `, [idempotencyKey])
    return Number(row?.count ?? 0)
  }

  async insertOrder(input: BillingOrderRecord): Promise<void> {
    await this.driver.run(`
      INSERT INTO billing_orders (
        id, legacy_id, order_no, user_id, org_id, user_phone,
        amount_usd_micros, amount_cents, exchange_rate_micros,
        quota_units, points_units, bonus_units, payment_method, order_date,
        provider_order_info, callback_payload_json, callback_time, callback_amount_cents,
        status, idempotency_key, created_at, updated_at, expired_at, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.legacyId, input.orderNo, input.userId, input.orgId, input.userPhone,
      input.amountUsdMicros, input.amountCents, input.exchangeRateMicros,
      input.quotaUnits, input.pointsUnits, input.bonusUnits, input.paymentMethod,
      input.orderDate, input.providerOrderInfo,
      input.callbackData ?? null, input.callbackTime ?? null, input.callbackAmountCents ?? null,
      input.status, input.idempotencyKey,
      input.createdAt, input.updatedAt, input.expiredAt, input.remark,
    ])
  }

  async getOrderByOrderNo(orderNo: string, userId?: string): Promise<BillingOrderRecord | null> {
    const row = (userId
      ? await this.driver.get<SqlRow>('SELECT * FROM billing_orders WHERE order_no = ? AND user_id = ? LIMIT 1', [orderNo, userId])
      : await this.driver.get<SqlRow>('SELECT * FROM billing_orders WHERE order_no = ? LIMIT 1', [orderNo]))
    return row ? mapOrder(row) : null
  }

  async getOrderByLegacyId(legacyId: number): Promise<BillingOrderRecord | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM billing_orders WHERE legacy_id = ? LIMIT 1', [legacyId])
    return row ? mapOrder(row) : null
  }

  async assignOrderLegacyId(orderId: string, legacyId: number): Promise<void> {
    await this.driver.run('UPDATE billing_orders SET legacy_id = ? WHERE id = ? AND legacy_id IS NULL', [legacyId, orderId])
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
  }): Promise<{ list: BillingOrderRecord[]; total: number }> {
    return this.listOrdersAsync(input)
  }

  private async listOrdersAsync(input: Parameters<BillingRepository['listOrders']>[0]): Promise<{ list: BillingOrderRecord[]; total: number }> {
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
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM billing_orders ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `, [...params, input.limit, input.offset])
    const total = await this.driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM billing_orders ${where}`, params)
    return { list: rows.map(mapOrder), total: Number(total?.count ?? 0) }
  }

  async getOrderStatistics(since?: number): Promise<{
    orders: number
    amountUsdMicros: number
    amountCents: number
    pointsUnits: number
    bonusUnits: number
    successCount: number
    failedCount: number
    pendingCount: number
  }> {
    const where = since === undefined ? '' : 'WHERE created_at >= ?'
    const params = since === undefined ? [] : [since]
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount_usd_micros ELSE 0 END), 0) AS amount_usd_micros,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount_cents ELSE 0 END), 0) AS amount_cents,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN points_units ELSE 0 END), 0) AS points_units,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN bonus_units ELSE 0 END), 0) AS bonus_units,
        COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status IN ('PENDING', 'PAYING') THEN 1 ELSE 0 END), 0) AS pending_count
      FROM billing_orders ${where}
    `, params)
    return {
      orders: Number(row?.orders ?? 0), amountUsdMicros: Number(row?.amount_usd_micros ?? 0),
      amountCents: Number(row?.amount_cents ?? 0), pointsUnits: Number(row?.points_units ?? 0),
      bonusUnits: Number(row?.bonus_units ?? 0), successCount: Number(row?.success_count ?? 0),
      failedCount: Number(row?.failed_count ?? 0), pendingCount: Number(row?.pending_count ?? 0),
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
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_orders
      SET status = ?, updated_at = ?,
          remark = COALESCE(?, remark),
          provider_order_info = COALESCE(?, provider_order_info),
          callback_payload_json = COALESCE(?, callback_payload_json),
          callback_time = COALESCE(?, callback_time),
          callback_amount_cents = COALESCE(?, callback_amount_cents)
      WHERE id = ?
    `, [
      input.status, input.updatedAt, input.remark ?? null, input.providerOrderInfo ?? null,
      input.callbackData ?? null, input.callbackTime ?? null, input.callbackAmountCents ?? null,
      input.orderId,
    ]).then(() => undefined)
  }

  async countOrders(): Promise<number> {
    return Number((await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_orders'))?.count ?? 0)
  }

  insertPaymentAttempt(input: {
    id: string
    orderId: string
    provider: string
    status: BillingOperationStatus
    idempotencyKey: string
    request: Record<string, unknown>
    createdAt: number
  }): Promise<void> {
    return this.driver.run(`
      INSERT INTO billing_payment_attempts (
        id, order_id, provider, status, idempotency_key, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.orderId, input.provider, input.status, input.idempotencyKey,
      JSON.stringify(input.request), input.createdAt, input.createdAt,
    ]).then(() => undefined)
  }

  updatePaymentAttempt(input: {
    id: string
    status: BillingOperationStatus
    response?: Record<string, unknown> | null
    errorText?: string | null
    updatedAt: number
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_payment_attempts
      SET status = ?, response_json = ?, error_text = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `, [
      input.status, input.response ? JSON.stringify(input.response) : null,
      input.errorText ?? null, input.updatedAt,
      ['SUCCEEDED', 'FAILED', 'SUPPRESSED'].includes(input.status) ? input.updatedAt : null,
      input.id,
    ]).then(() => undefined)
  }

  async countPaymentAttempts(): Promise<number> {
    return Number((await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_payment_attempts'))?.count ?? 0)
  }

  getProviderEvent(provider: string, providerEventId: string): Promise<{
    id: string
    payloadHash: string
    status: BillingOperationStatus
  } | null> {
    return this.getProviderEventAsync(provider, providerEventId)
  }

  private async getProviderEventAsync(provider: string, providerEventId: string): Promise<{
    id: string
    payloadHash: string
    status: BillingOperationStatus
  } | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT id, payload_hash, status FROM billing_provider_events
      WHERE provider = ? AND provider_event_id = ? LIMIT 1
    `, [provider, providerEventId])
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
  }): Promise<void> {
    return this.driver.run(`
      INSERT INTO billing_provider_events (
        id, provider, provider_event_id, event_type, payload_hash,
        payload_json, status, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.provider, input.providerEventId, input.eventType,
      input.payloadHash, JSON.stringify(input.payload), input.status, input.receivedAt,
    ]).then(() => undefined)
  }

  updateProviderEvent(input: {
    id: string
    status: BillingOperationStatus
    errorText?: string | null
    processedAt: number
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_provider_events
      SET status = ?, error_text = ?, processed_at = ? WHERE id = ?
    `, [input.status, input.errorText ?? null, input.processedAt, input.id]).then(() => undefined)
  }

  async countProviderEvents(): Promise<number> {
    return Number((await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_provider_events'))?.count ?? 0)
  }

  async upsertExternalAccount(input: ExternalBillingAccount): Promise<void> {
    await this.driver.run(`
      INSERT INTO billing_external_accounts (
        provider, owner_type, owner_id, external_account_id,
        quota_units, used_quota_units, token_secret_ref, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, owner_type, owner_id) DO UPDATE SET
        external_account_id = excluded.external_account_id,
        quota_units = excluded.quota_units,
        used_quota_units = excluded.used_quota_units,
        token_secret_ref = COALESCE(excluded.token_secret_ref, billing_external_accounts.token_secret_ref),
        updated_at = excluded.updated_at
    `, [
      input.provider, input.ownerType, input.ownerId, input.externalAccountId,
      input.quotaUnits, input.usedQuotaUnits, input.tokenSecretRef ?? null, input.updatedAt,
    ])
  }

  async getExternalAccount(provider: string, ownerType: BillingOwnerType, ownerId: string): Promise<ExternalBillingAccount | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_external_accounts
      WHERE provider = ? AND owner_type = ? AND owner_id = ? LIMIT 1
    `, [provider, ownerType, ownerId])
    return row ? {
      provider: String(row.provider), ownerType: String(row.owner_type) as BillingOwnerType,
      ownerId: String(row.owner_id), externalAccountId: String(row.external_account_id),
      quotaUnits: Number(row.quota_units), usedQuotaUnits: Number(row.used_quota_units),
      ...(row.token_secret_ref == null ? {} : { tokenSecretRef: String(row.token_secret_ref) }),
      updatedAt: Number(row.updated_at),
    } : null
  }

  insertSudorouterProvisioning(input: {
    id: string
    ownerId: string
    orgId: string
    username: string
    displayName: string
    initialQuotaUnits: number
    status: SudorouterProvisioningStatus
    idempotencyKey: string
    requestFingerprint: string
    contextSource: BillingContextSource
    createdAt: number
  }): Promise<boolean> {
    return this.driver.run(`
      INSERT INTO billing_sudorouter_provisioning (
        id, owner_id, org_id, username, display_name, initial_quota_units,
        status, idempotency_key, request_fingerprint, context_source,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `, [
      input.id, input.ownerId, input.orgId, input.username, input.displayName,
      input.initialQuotaUnits, input.status, input.idempotencyKey,
      input.requestFingerprint, input.contextSource, input.createdAt, input.createdAt,
    ]).then(changes => changes === 1)
  }

  async getSudorouterProvisioningByKey(idempotencyKey: string): Promise<SudorouterProvisioningRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_sudorouter_provisioning WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
    return row ? this.mapSudorouterProvisioning(row) : null
  }

  async getSudorouterProvisioningByOwner(ownerId: string): Promise<SudorouterProvisioningRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_sudorouter_provisioning WHERE owner_id = ? LIMIT 1
    `, [ownerId])
    return row ? this.mapSudorouterProvisioning(row) : null
  }

  updateSudorouterProvisioning(input: {
    id: string
    status: SudorouterProvisioningStatus
    externalAccountId?: string | null
    quotaUnits?: number | null
    usedQuotaUnits?: number | null
    tokenSecretRef?: string | null
    errorText?: string | null
    updatedAt: number
    completedAt?: number | null
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_sudorouter_provisioning SET
        status = ?,
        external_account_id = COALESCE(?, external_account_id),
        quota_units = COALESCE(?, quota_units),
        used_quota_units = COALESCE(?, used_quota_units),
        token_secret_ref = COALESCE(?, token_secret_ref),
        error_text = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `, [
      input.status, input.externalAccountId ?? null, input.quotaUnits ?? null,
      input.usedQuotaUnits ?? null, input.tokenSecretRef ?? null,
      input.errorText ?? null, input.updatedAt, input.completedAt ?? null, input.id,
    ]).then(() => undefined)
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
  }): Promise<boolean> {
    return this.driver.run(`
      INSERT INTO billing_quota_operations (
        id, owner_type, owner_id, external_user_id, delta_units, status,
        idempotency_key, source_type, source_id, org_id, actor_user_id,
        reason, request_fingerprint, context_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [
      input.id, input.ownerType, input.ownerId, input.externalUserId, input.deltaUnits,
      input.status, input.idempotencyKey, input.sourceType, input.sourceId,
      input.orgId ?? null, input.actorUserId ?? null, input.reason ?? null,
      input.requestFingerprint, input.contextSource, input.createdAt, input.createdAt,
    ]).then(changes => changes === 1)
  }

  async claimSudorouterProvisioning(id: string, updatedAt: number): Promise<SudorouterProvisioningRecord | null> {
    const changed = await this.driver.run(`
      UPDATE billing_sudorouter_provisioning
      SET status = 'PROCESSING', error_text = NULL, updated_at = ?
      WHERE id = ? AND status IN ('PENDING', 'ACCOUNT_READY', 'QUOTA_READY', 'TOKEN_READY', 'FAILED', 'UNKNOWN')
    `, [updatedAt, id])
    return changed === 1 ? this.getSudorouterProvisioningById(id) : null
  }

  private async getSudorouterProvisioningById(id: string): Promise<SudorouterProvisioningRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_sudorouter_provisioning WHERE id = ? LIMIT 1
    `, [id])
    return row ? this.mapSudorouterProvisioning(row) : null
  }

  async getQuotaOperationById(id: string): Promise<QuotaOperationRecord | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM billing_quota_operations WHERE id = ? LIMIT 1', [id])
    return row ? this.mapQuotaOperation(row) : null
  }

  async getQuotaOperationByKey(idempotencyKey: string): Promise<QuotaOperationRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_quota_operations WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
    return row ? this.mapQuotaOperation(row) : null
  }

  async listRecoverableQuotaOperationIds(limit = 100): Promise<string[]> {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 100
    const rows = await this.driver.all<{ id: string }>(`
      SELECT id FROM billing_quota_operations
      WHERE status IN ('PENDING', 'PROCESSING', 'UNKNOWN')
      ORDER BY created_at ASC, id ASC LIMIT ?
    `, [safeLimit])
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
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_quota_operations SET
        status = ?,
        observed_quota_units = COALESCE(?, observed_quota_units),
        observed_used_units = COALESCE(?, observed_used_units),
        provider_response_json = ?, error_text = ?, updated_at = ?,
        completed_at = ?
      WHERE id = ?
    `, [
      input.status, input.observedQuotaUnits ?? null, input.observedUsedUnits ?? null,
      input.providerResponse ? JSON.stringify(input.providerResponse) : null,
      input.errorText ?? null, input.updatedAt,
      ['SUCCEEDED', 'FAILED', 'SUPPRESSED'].includes(input.status) ? input.updatedAt : null,
      input.id,
    ]).then(() => undefined)
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

  async getUserState(userId: string): Promise<{ orgId: string; status: string } | null> {
    const row = await this.driver.get<SqlRow>('SELECT org_id, status FROM users WHERE id = ? LIMIT 1', [userId])
    return row ? { orgId: String(row.org_id), status: String(row.status) } : null
  }

  async countPendingCreditApplications(userId: string): Promise<number> {
    const row = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_credit_applications
      WHERE user_id = ? AND status IN ('PENDING', 'PROCESSING', 'SYNC_UNKNOWN')
    `, [userId])
    return Number(row?.count ?? 0)
  }

  async claimQuotaOperation(id: string): Promise<QuotaOperationRecord | null> {
    const changed = await this.driver.run(`
      UPDATE billing_quota_operations
      SET status = 'PROCESSING', error_text = NULL, updated_at = ?
      WHERE id = ? AND status IN ('PENDING', 'FAILED', 'UNKNOWN')
    `, [Date.now(), id])
    return changed === 1 ? this.getQuotaOperationById(id) : null
  }

  async insertCreditApplication(input: CreditApplicationRecord): Promise<void> {
    await this.driver.run(`
      INSERT INTO billing_credit_applications (
        id, legacy_id, application_no, user_id, org_id, requested_units,
        approved_units, quota_units, reason, status, admin_user_id,
        admin_comment, quota_operation_id, idempotency_key, request_fingerprint,
        created_at, reviewed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.legacyId, input.applicationNo, input.userId, input.orgId,
      input.requestedUnits, input.approvedUnits, input.quotaUnits, input.reason,
      input.status, input.adminUserId, input.adminComment, input.quotaOperationId,
      input.idempotencyKey, input.requestFingerprint, input.createdAt,
      input.reviewedAt, input.updatedAt,
    ])
  }

  async getCreditApplication(id: string): Promise<CreditApplicationRecord | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM billing_credit_applications WHERE id = ? LIMIT 1', [id])
    return row ? this.mapCreditApplication(row) : null
  }

  async getCreditApplicationByLegacyId(legacyId: number): Promise<CreditApplicationRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_credit_applications WHERE legacy_id = ? LIMIT 1
    `, [legacyId])
    return row ? this.mapCreditApplication(row) : null
  }

  async countCreditApplications(): Promise<number> {
    return Number((await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_credit_applications'))?.count ?? 0)
  }

  async insertActivityRecord(input: BillingActivityRecord): Promise<void> {
    await this.driver.transaction(async () => {
      await this.driver.run(`
        INSERT INTO billing_activity_records (
          id, legacy_id, activity_type, user_id, org_id, order_id, actor_user_id,
          application_id, points_units, quota_units, amount_cents, payment_method,
          reason, payment_reference, source_type, source_id, details_json,
          idempotency_key, created_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.id, input.legacyId, input.activityType, input.userId, input.orgId,
        input.orderId, input.actorUserId, input.applicationId, input.pointsUnits,
        input.quotaUnits, input.amountCents, input.paymentMethod, input.reason,
        input.paymentReference, input.sourceType, input.sourceId,
        JSON.stringify(input.details), input.idempotencyKey, input.createdAt, input.processedAt,
      ])
      await this.advanceCounter(`billing_activity_records:${input.activityType}`, input.legacyId)
    })
  }

  async getActivityByLegacyId(activityType: 'CLIENT' | 'ADMIN', legacyId: number): Promise<BillingActivityRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_activity_records WHERE activity_type = ? AND legacy_id = ? LIMIT 1
    `, [activityType, legacyId])
    return row ? this.mapActivity(row) : null
  }

  async getActivityByIdempotencyKey(idempotencyKey: string): Promise<BillingActivityRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_activity_records WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
    return row ? this.mapActivity(row) : null
  }

  async allocateActivityLegacyId(activityType: 'CLIENT' | 'ADMIN'): Promise<number> {
    return this.allocateCounter(`billing_activity_records:${activityType}`)
  }

  listRechargeActivities(input: {
    orgId?: string
    userId?: string
    activityType?: 'CLIENT' | 'ADMIN'
    keyword?: string
    paymentMethod?: 'ALIPAY' | 'WECHAT'
    limit: number
    offset: number
  }): Promise<{ list: BillingActivityRecord[]; total: number }> {
    return this.listRechargeActivitiesAsync(input)
  }

  private async listRechargeActivitiesAsync(input: Parameters<BillingRepository['listRechargeActivities']>[0]): Promise<{ list: BillingActivityRecord[]; total: number }> {
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
    const rows = await this.driver.all<SqlRow>(`
      SELECT ar.* FROM billing_activity_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN user_auth_identities phone
        ON phone.user_id = ar.user_id AND phone.provider = 'phone' AND phone.issuer = 'sudowork'
      ${where} ORDER BY ar.created_at DESC, ar.id DESC LIMIT ? OFFSET ?
    `, [...params, input.limit, input.offset])
    const total = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_activity_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN user_auth_identities phone
        ON phone.user_id = ar.user_id AND phone.provider = 'phone' AND phone.issuer = 'sudowork'
      ${where}
    `, params)
    return { list: rows.map(row => this.mapActivity(row)), total: Number(total?.count ?? 0) }
  }

  async countActivityRecords(): Promise<number> {
    return Number((await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_activity_records'))?.count ?? 0)
  }

  listCreditApplications(input: {
    userId?: string
    orgId?: string
    status?: CreditApplicationStatus
    keyword?: string
    limit: number
    offset: number
  }): Promise<{ list: CreditApplicationRecord[]; total: number }> {
    return this.listCreditApplicationsAsync(input)
  }

  private async listCreditApplicationsAsync(input: Parameters<BillingRepository['listCreditApplications']>[0]): Promise<{ list: CreditApplicationRecord[]; total: number }> {
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
    const rows = await this.driver.all<SqlRow>(`
      SELECT ca.* FROM billing_credit_applications ca
      JOIN users u ON u.id = ca.user_id ${where}
      ORDER BY ca.created_at DESC, ca.id DESC LIMIT ? OFFSET ?
    `, [...params, input.limit, input.offset])
    const total = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_credit_applications ca
      JOIN users u ON u.id = ca.user_id ${where}
    `, params)
    return { list: rows.map(row => this.mapCreditApplication(row)), total: Number(total?.count ?? 0) }
  }

  listLedgerEntries(input: {
    userId?: string
    orgId?: string
    keyword?: string
    entryType?: string
    excludeEntryType?: string
    limit: number
    offset: number
  }): Promise<{ list: Array<LedgerEntryRecord & { ownerName: string | null }>; total: number }> {
    return this.listLedgerEntriesAsync(input)
  }

  private async listLedgerEntriesAsync(input: Parameters<BillingRepository['listLedgerEntries']>[0]): Promise<{ list: Array<LedgerEntryRecord & { ownerName: string | null }>; total: number }> {
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
    const rows = await this.driver.all<SqlRow>(`
      SELECT le.*, COALESCE(u.display_name, u.name) AS owner_name
      FROM billing_ledger_entries le JOIN users u ON u.id = le.owner_id
      ${where} ORDER BY le.created_at DESC, le.id DESC LIMIT ? OFFSET ?
    `, [...params, input.limit, input.offset])
    const total = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_ledger_entries le
      JOIN users u ON u.id = le.owner_id ${where}
    `, params)
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
      total: Number(total?.count ?? 0),
    }
  }

  private async nextLedgerLegacyId(): Promise<number> {
    return this.allocateCounter('billing_ledger_entries')
  }

  private async allocateCounter(counterKey: string): Promise<number> {
    const row = await this.driver.get<{ last_value: number }>(`
      INSERT INTO compatibility_id_counters (counter_key, last_value)
      VALUES (?, 2000000000)
      ON CONFLICT(counter_key) DO UPDATE SET last_value = compatibility_id_counters.last_value + 1
      RETURNING last_value
    `, [counterKey])
    if (!row) throw new Error(`Failed to allocate compatibility ID: ${counterKey}`)
    return Number(row.last_value)
  }

  private async advanceCounter(counterKey: string, value: number): Promise<void> {
    await this.driver.run(`
      INSERT INTO compatibility_id_counters (counter_key, last_value)
      VALUES (?, ?)
      ON CONFLICT(counter_key) DO UPDATE SET
        last_value = CASE
          WHEN compatibility_id_counters.last_value < excluded.last_value THEN excluded.last_value
          ELSE compatibility_id_counters.last_value
        END
    `, [counterKey, value])
  }

  async getCreditApplicationByIdempotencyKey(idempotencyKey: string): Promise<CreditApplicationRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_credit_applications WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
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
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_credit_applications SET
        status = ?, approved_units = COALESCE(?, approved_units),
        quota_units = COALESCE(?, quota_units),
        admin_user_id = COALESCE(?, admin_user_id),
        admin_comment = COALESCE(?, admin_comment),
        quota_operation_id = COALESCE(?, quota_operation_id),
        reviewed_at = COALESCE(?, reviewed_at), updated_at = ?
      WHERE id = ?
    `, [
      input.status, input.approvedUnits ?? null, input.quotaUnits ?? null,
      input.adminUserId ?? null, input.adminComment ?? null,
      input.quotaOperationId ?? null, input.reviewedAt ?? null,
      input.updatedAt, input.id,
    ]).then(() => undefined)
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

  async insertRefund(input: RefundRecord): Promise<void> {
    await this.driver.run(`
      INSERT INTO billing_refunds (
        id, legacy_id, refund_no, order_id, user_id, refund_amount_cents,
        refund_quota_units, refund_points_units, reason, refund_type, status,
        provider_refund_no, quota_operation_id, idempotency_key,
        request_fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.legacyId, input.refundNo, input.orderId, input.userId,
      input.refundAmountCents, input.refundQuotaUnits, input.refundPointsUnits,
      input.reason, input.refundType, input.status, input.providerRefundNo,
      input.quotaOperationId, input.idempotencyKey, input.requestFingerprint,
      input.createdAt, input.updatedAt,
    ])
  }

  async getRefundById(id: string): Promise<RefundRecord | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM billing_refunds WHERE id = ? LIMIT 1', [id])
    return row ? this.mapRefund(row) : null
  }

  async getRefundByLegacyId(legacyId: number): Promise<RefundRecord | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM billing_refunds WHERE legacy_id = ? LIMIT 1', [legacyId])
    return row ? this.mapRefund(row) : null
  }

  async countRefunds(): Promise<number> {
    return Number((await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_refunds'))?.count ?? 0)
  }

  async getRefundByIdempotencyKey(idempotencyKey: string): Promise<RefundRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_refunds WHERE idempotency_key = ? LIMIT 1
    `, [idempotencyKey])
    return row ? this.mapRefund(row) : null
  }

  async getActiveRefundForOrder(orderId: string): Promise<RefundRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM billing_refunds
      WHERE order_id = ? AND status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `, [orderId])
    return row ? this.mapRefund(row) : null
  }

  updateRefund(input: {
    id: string
    status: BillingOperationStatus
    providerRefundNo?: string | null
    providerResponse?: Record<string, unknown> | null
    quotaOperationId?: string | null
    updatedAt: number
  }): Promise<void> {
    return this.driver.run(`
      UPDATE billing_refunds SET
        status = ?, provider_refund_no = COALESCE(?, provider_refund_no),
        provider_response_json = COALESCE(?, provider_response_json),
        quota_operation_id = COALESCE(?, quota_operation_id), updated_at = ?,
        processed_at = CASE WHEN ? IN ('SUCCEEDED', 'FAILED', 'SUPPRESSED') THEN ? ELSE processed_at END
      WHERE id = ?
    `, [
      input.status, input.providerRefundNo ?? null,
      input.providerResponse ? JSON.stringify(input.providerResponse) : null,
      input.quotaOperationId ?? null, input.updatedAt, input.status,
      input.updatedAt, input.id,
    ]).then(() => undefined)
  }

  async countRefundsForOrder(orderId: string): Promise<number> {
    const row = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM billing_refunds WHERE order_id = ?
    `, [orderId])
    return Number(row?.count ?? 0)
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
  }): Promise<void> {
    return this.driver.run(`
      INSERT INTO billing_reconciliations (
        id, scope_type, scope_id, reconciliation_type, expected_units,
        actual_units, difference_units, status, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id, input.scopeType, input.scopeId, input.reconciliationType,
      input.expectedUnits, input.actualUnits, input.differenceUnits,
      input.status, JSON.stringify(input.details), input.createdAt,
    ]).then(() => undefined)
  }

  async countReconciliations(): Promise<number> {
    const row = await this.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM billing_reconciliations')
    return Number(row?.count ?? 0)
  }

  async countDeliverableExternalOutbox(): Promise<number> {
    const row = await this.driver.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM outbox_events
      WHERE status = 'pending'
    `)
    return Number(row?.count ?? 0)
  }

  saveMigrationCheckpoint(input: {
    sourceChecksum: string
    migrationRunId: string
    report: Record<string, unknown>
    createdAt: number
    verifiedAt: number
  }): Promise<void> {
    return this.driver.run(`
      INSERT INTO billing_migration_checkpoints (
        source_checksum, migration_run_id, report_json, created_at, verified_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_checksum) DO UPDATE SET
        migration_run_id = excluded.migration_run_id,
        report_json = excluded.report_json,
        verified_at = excluded.verified_at
    `, [
      input.sourceChecksum, input.migrationRunId, JSON.stringify(input.report),
      input.createdAt, input.verifiedAt,
    ]).then(() => undefined)
  }

  async getMigrationCheckpoint(sourceChecksum: string): Promise<{ migrationRunId: string; report: Record<string, unknown> } | null> {
    const row = await this.driver.get<{ migration_run_id: string; report_json: string }>(`
      SELECT migration_run_id, report_json FROM billing_migration_checkpoints
      WHERE source_checksum = ? LIMIT 1
    `, [sourceChecksum])
    return row ? { migrationRunId: row.migration_run_id, report: JSON.parse(row.report_json) as Record<string, unknown> } : null
  }

  private mapSudorouterProvisioning(row: SqlRow): SudorouterProvisioningRecord {
    return {
      id: String(row.id), ownerId: String(row.owner_id), orgId: String(row.org_id),
      username: String(row.username), displayName: String(row.display_name),
      initialQuotaUnits: Number(row.initial_quota_units),
      externalAccountId: row.external_account_id == null ? null : String(row.external_account_id),
      quotaUnits: row.quota_units == null ? null : Number(row.quota_units),
      usedQuotaUnits: row.used_quota_units == null ? null : Number(row.used_quota_units),
      tokenSecretRef: row.token_secret_ref == null ? null : String(row.token_secret_ref),
      status: String(row.status) as SudorouterProvisioningStatus,
      idempotencyKey: String(row.idempotency_key),
      requestFingerprint: String(row.request_fingerprint),
      contextSource: String(row.context_source) as BillingContextSource,
      errorText: row.error_text == null ? null : String(row.error_text),
    }
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

  async getCommandResult<T>(commandType: string, idempotencyKey: string): Promise<{
    requestFingerprint: string | null
    result: T
  } | null> {
    const row = await this.driver.get<{ request_fingerprint: string | null; result_json: string }>(`
      SELECT request_fingerprint, result_json FROM command_executions
      WHERE command_type = ? AND idempotency_key = ? LIMIT 1
    `, [commandType, idempotencyKey])
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
  ): Promise<void> {
    return this.driver.run(`
      INSERT INTO command_executions (
        command_type, idempotency_key, context_source, request_fingerprint, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [commandType, idempotencyKey, contextSource, requestFingerprint, JSON.stringify(result), createdAt]).then(() => undefined)
  }
}
