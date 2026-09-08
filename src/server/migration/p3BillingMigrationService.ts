import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import {
  BillingRepository,
  type BillingOrderRecord,
  type CreditApplicationRecord,
  type RefundRecord,
} from '../billing/billingRepository.js'
import type { BillingOperationStatus, BillingOrderStatus, CreditApplicationStatus } from '../billing/types.js'
import { BillingDomainError } from '../billing/types.js'
import type { WalletService } from '../billing/walletService.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import type {
  SudoworkP3CreditApplication,
  SudoworkP3Order,
  SudoworkP3Refund,
  SudoworkP3Snapshot,
} from './sudoworkP3SourceReader.js'

export interface P3BillingMigrationIssue {
  code:
    | 'BALANCE_MISMATCH'
    | 'DUPLICATE_SOURCE'
    | 'DUPLICATE_SUCCESS_RECHARGE'
    | 'IDENTITY_MAPPING_MISSING'
    | 'IN_PROGRESS'
    | 'INVALID_REFERENCE'
    | 'INVALID_STATUS'
    | 'TARGET_CONFLICT'
  sourceType: string
  sourceId: string
  message: string
}

interface ResolvedUser {
  legacyUserId: number
  userId: string
  orgId: string
}

export interface P3BillingMigrationPlan {
  status: 'ready' | 'blocked'
  source: SudoworkP3Snapshot
  sourceChecksum: string
  issues: P3BillingMigrationIssue[]
  users: Map<number, ResolvedUser>
  orderIds: Map<number, string>
  creditApplicationIds: Map<number, string>
  refundIds: Map<number, string>
}

export interface P3BillingMigrationReport {
  migrationRunId: string
  sourceChecksum: string
  users: number
  orders: number
  creditApplications: number
  refunds: number
  activities: number
  importedLedgerEntries: number
  importedOrders: number
  importedCreditApplications: number
  importedRefunds: number
  importedActivities: number
  financialDifferenceUnits: number
  deliverableExternalOutboxCount: number
}

export interface P3BillingVerificationReport {
  status: 'matched' | 'mismatch'
  sourceChecksum: string
  differenceUnits: number
  issues: string[]
}

export class P3BillingMigrationBlockedError extends Error {
  constructor(readonly plan: P3BillingMigrationPlan) {
    super(`P3 财务迁移预检失败: ${plan.issues.length} 个问题`)
    this.name = 'P3BillingMigrationBlockedError'
  }
}

export class P3BillingMigrationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly identities: IdentityRepository,
    private readonly repository: BillingRepository,
    private readonly wallet: WalletService,
    private readonly clock: () => number = Date.now,
    private readonly planning?: { isProjected(kind: 'enterprise' | 'user', resourceId: string): boolean },
  ) {}

  plan(source: SudoworkP3Snapshot): P3BillingMigrationPlan {
    const issues: P3BillingMigrationIssue[] = []
    const users = new Map<number, ResolvedUser>()
    const sourceUsers = new Map(source.users.map(user => [user.id, user]))

    this.checkDuplicates(source.users, 'user', row => row.id, issues)
    this.checkDuplicates(source.ledger, 'ledger', row => row.id, issues)
    this.checkDuplicates(source.orders, 'order', row => row.id, issues)
    this.checkDuplicates(source.orders, 'order_no', row => row.orderNo, issues)
    this.checkDuplicates(source.creditApplications, 'credit_application', row => row.id, issues)
    this.checkDuplicates(source.creditApplications, 'application_no', row => row.applicationNo, issues)
    this.checkDuplicates(source.refunds, 'refund', row => row.id, issues)
    this.checkDuplicates(source.refunds, 'refund_no', row => row.refundNo, issues)

    for (const user of source.users) {
      const mapped = this.identities.resolveNumericAliasGlobal('user', user.id)
      if (!mapped) {
        issue(issues, 'IDENTITY_MAPPING_MISSING', 'user', user.id, `旧用户 ${user.id} 尚未完成 P1 身份映射`)
        continue
      }
      if (user.enterpriseId !== null) {
        const org = this.identities.resolveNumericAliasGlobal('enterprise', user.enterpriseId)
        if (!org) {
          issue(issues, 'IDENTITY_MAPPING_MISSING', 'enterprise', user.enterpriseId, `旧企业 ${user.enterpriseId} 尚未完成 P1 身份映射`)
          continue
        }
        if (org.resourceId !== mapped.orgId) {
          issue(issues, 'INVALID_REFERENCE', 'user', user.id, '用户映射组织与旧企业映射不一致')
          continue
        }
      }
      const targetWallet = this.repository.getWallet('user', mapped.resourceId)
      if (!targetWallet && !this.planning?.isProjected('user', mapped.resourceId)) {
        issue(issues, 'TARGET_CONFLICT', 'user', user.id, 'Moss 用户缺少统一钱包')
      } else if (targetWallet && targetWallet.balanceUnits !== 0 && targetWallet.balanceUnits !== user.balanceUnits) {
        issue(issues, 'TARGET_CONFLICT', 'user', user.id, 'Moss 钱包既非空钱包也非同额 P1 快照')
      }
      users.set(user.id, { legacyUserId: user.id, userId: mapped.resourceId, orgId: mapped.orgId })
    }

    const ledgerByUser = groupBy(source.ledger, row => row.userId)
    for (const user of source.users) {
      const sum = (ledgerByUser.get(user.id) ?? []).reduce((total, row) => total + row.deltaUnits, 0)
      if (!Number.isSafeInteger(sum) || sum !== user.balanceUnits) {
        issue(issues, 'BALANCE_MISMATCH', 'user', user.id, `旧流水合计 ${sum} 与余额 ${user.balanceUnits} 不一致`)
      }
    }
    for (const entry of source.ledger) {
      if (!sourceUsers.has(entry.userId)) issue(issues, 'INVALID_REFERENCE', 'ledger', entry.id, `引用不存在的用户 ${entry.userId}`)
    }

    const sourceOrders = new Map(source.orders.map(order => [order.id, order]))
    for (const order of source.orders) {
      const user = users.get(order.userId)
      if (!sourceUsers.has(order.userId) || !user) {
        issue(issues, 'INVALID_REFERENCE', 'order', order.id, `引用未映射用户 ${order.userId}`)
      }
      if (order.enterpriseId !== null) this.assertOrgReference(order.enterpriseId, user, 'order', order.id, issues)
      if (order.status === 0 || order.status === 1) issue(issues, 'IN_PROGRESS', 'order', order.id, '订单仍处于待支付或支付中')
      else if (![2, 3, 4, 5].includes(order.status)) issue(issues, 'INVALID_STATUS', 'order', order.id, `未知订单状态 ${order.status}`)
      if (order.paymentMethod !== 'ALIPAY' && order.paymentMethod !== 'WECHAT') {
        issue(issues, 'INVALID_STATUS', 'order', order.id, `未知支付方式 ${order.paymentMethod}`)
      }
    }

    const successRecordsByOrder = groupBy(source.rechargeRecords, row => row.orderId)
    for (const record of source.rechargeRecords) {
      const order = sourceOrders.get(record.orderId)
      if (!order || order.userId !== record.userId) {
        issue(issues, 'INVALID_REFERENCE', 'recharge_record', record.id, '充值记录引用的订单或用户不一致')
      }
    }
    for (const order of source.orders.filter(row => row.status === 2 || row.status === 4)) {
      const count = successRecordsByOrder.get(order.id)?.length ?? 0
      if (count !== 1) {
        issue(issues, 'DUPLICATE_SUCCESS_RECHARGE', 'order', order.id, `成功订单对应 ${count} 条充值成功记录，要求恰好 1 条`)
      }
    }

    for (const record of source.adminRechargeRecords) {
      if (!users.has(record.userId) || !users.has(record.adminId)) {
        issue(issues, 'INVALID_REFERENCE', 'admin_recharge_record', record.id, '管理员充值记录引用未映射用户')
      }
      if (record.source === 'CREDIT_APPLICATION'
        && (record.sourceId === null || !source.creditApplications.some(item => item.id === record.sourceId))) {
        issue(issues, 'INVALID_REFERENCE', 'admin_recharge_record', record.id, '授信发放记录未引用有效申请')
      }
    }
    for (const application of source.creditApplications) {
      const user = users.get(application.userId)
      if (!user || (application.adminId !== null && !users.has(application.adminId))) {
        issue(issues, 'INVALID_REFERENCE', 'credit_application', application.id, '授信申请引用未映射用户或管理员')
      }
      if (application.enterpriseId !== null) this.assertOrgReference(application.enterpriseId, user, 'credit_application', application.id, issues)
      if (['PENDING', 'PROCESSING', 'SYNC_UNKNOWN'].includes(application.status)) {
        issue(issues, 'IN_PROGRESS', 'credit_application', application.id, `授信申请仍处于 ${application.status}`)
      } else if (!['APPROVED', 'REJECTED', 'SYNC_FAILED'].includes(application.status)) {
        issue(issues, 'INVALID_STATUS', 'credit_application', application.id, `未知授信状态 ${application.status}`)
      }
    }
    for (const refund of source.refunds) {
      const order = sourceOrders.get(refund.orderId)
      if (!order || order.orderNo !== refund.orderNo || order.userId !== refund.userId) {
        issue(issues, 'INVALID_REFERENCE', 'refund', refund.id, '退款引用的订单、订单号或用户不一致')
      }
      if (refund.status === 0) issue(issues, 'IN_PROGRESS', 'refund', refund.id, '退款仍处于处理中')
      else if (![1, 2].includes(refund.status)) issue(issues, 'INVALID_STATUS', 'refund', refund.id, `未知退款状态 ${refund.status}`)
    }

    const orderIds = this.resolveTargetIds('billing_order', source.orders, row => row.id, issues)
    const creditApplicationIds = this.resolveTargetIds('credit_application', source.creditApplications, row => row.id, issues)
    const refundIds = this.resolveTargetIds('billing_refund', source.refunds, row => row.id, issues)
    for (const order of source.orders) {
      const existing = this.repository.getOrderByLegacyId(order.id)
      const byNumber = this.repository.getOrderByOrderNo(order.orderNo)
      if ((existing && existing.orderNo !== order.orderNo) || (byNumber && byNumber.legacyId !== order.id)) {
        issue(issues, 'TARGET_CONFLICT', 'order', order.id, '目标订单 ID 或订单号已被其他记录占用')
      }
    }
    for (const application of source.creditApplications) {
      const existing = this.repository.getCreditApplicationByLegacyId(application.id)
      if (existing && existing.applicationNo !== application.applicationNo) {
        issue(issues, 'TARGET_CONFLICT', 'credit_application', application.id, '目标授信申请 ID 已被其他记录占用')
      }
    }
    for (const refund of source.refunds) {
      const existing = this.repository.getRefundByLegacyId(refund.id)
      if (existing && existing.refundNo !== refund.refundNo) {
        issue(issues, 'TARGET_CONFLICT', 'refund', refund.id, '目标退款 ID 已被其他记录占用')
      }
    }

    return {
      status: issues.length === 0 ? 'ready' : 'blocked', source, sourceChecksum: source.checksum,
      issues, users, orderIds, creditApplicationIds, refundIds,
    }
  }

  execute(plan: P3BillingMigrationPlan, context: CommandContext): P3BillingMigrationReport {
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' || context.externalEffects !== 'suppress_external' || !context.migrationRunId) {
      throw new BillingDomainError('MIGRATION_CONTEXT_REQUIRED', 'P3 财务迁移必须使用抑制外部副作用的迁移上下文')
    }
    if (plan.status === 'blocked') throw new P3BillingMigrationBlockedError(plan)
    const source = plan.source
    const before = this.counts()
    const beforeLedger = source.users.reduce((sum, user) => {
      const mapped = plan.users.get(user.id)
      return sum + (mapped ? this.repository.countOwnerLedgerEntries('user', mapped.userId) : 0)
    }, 0)

    return runInTransaction(this.db, () => {
      const ledgerByUser = groupBy(source.ledger, row => row.userId)
      for (const sourceUser of source.users) {
        const target = requiredMap(plan.users, sourceUser.id, '用户')
        this.wallet.importLegacySnapshot({
          ownerId: target.userId, legacyUserId: sourceUser.id,
          balanceUnits: sourceUser.balanceUnits, sourceChecksum: source.checksum,
          entries: (ledgerByUser.get(sourceUser.id) ?? []).map(row => ({
            legacyId: row.id, deltaUnits: row.deltaUnits, entryType: row.entryType,
            memo: row.memo, createdAt: row.createdAt,
          })),
        }, {
          ...context,
          idempotencyKey: `${context.idempotencyKey}:wallet:${sourceUser.id}`,
        })
      }

      for (const order of source.orders) this.importOrder(order, plan, context)
      for (const application of source.creditApplications) this.importCreditApplication(application, plan, context)
      for (const record of source.rechargeRecords) {
        if (this.repository.getActivityByLegacyId('CLIENT', record.id)) continue
        const order = source.orders.find(item => item.id === record.orderId)!
        const user = requiredMap(plan.users, record.userId, '充值用户')
        this.repository.insertActivityRecord({
          id: stableId('p3-client-activity', record.id), legacyId: record.id, activityType: 'CLIENT',
          userId: user.userId, orgId: user.orgId, orderId: requiredMap(plan.orderIds, record.orderId, '订单'),
          actorUserId: null, applicationId: null, pointsUnits: record.balanceDeltaUnits,
          quotaUnits: record.quotaDeltaUnits, amountCents: order.amountCents,
          paymentMethod: order.paymentMethod as 'ALIPAY' | 'WECHAT', reason: null, paymentReference: null,
          sourceType: 'CLIENT_RECHARGE', sourceId: String(record.orderId),
          details: {
            balanceBeforeUnits: record.balanceBeforeUnits, balanceAfterUnits: record.balanceAfterUnits,
            quotaBeforeUnits: record.quotaBeforeUnits, quotaAfterUnits: record.quotaAfterUnits,
            externalUserId: record.externalUserId, externalSucceeded: record.externalSucceeded,
          },
          idempotencyKey: `migration:p3:client-activity:${record.id}`,
          createdAt: order.createdAt, processedAt: record.createdAt,
        })
      }
      for (const record of source.adminRechargeRecords) {
        if (this.repository.getActivityByLegacyId('ADMIN', record.id)) continue
        const user = requiredMap(plan.users, record.userId, '充值用户')
        const admin = requiredMap(plan.users, record.adminId, '管理员')
        const applicationId = record.source === 'CREDIT_APPLICATION' && record.sourceId !== null
          ? requiredMap(plan.creditApplicationIds, record.sourceId, '授信申请') : null
        this.repository.insertActivityRecord({
          id: stableId('p3-admin-activity', record.id), legacyId: record.id, activityType: 'ADMIN',
          userId: user.userId, orgId: user.orgId, orderId: null, actorUserId: admin.userId,
          applicationId, pointsUnits: record.pointsUnits, quotaUnits: record.quotaUnits,
          amountCents: null, paymentMethod: null, reason: record.reason,
          paymentReference: record.paymentReference, sourceType: record.source,
          sourceId: record.sourceId === null ? null : String(record.sourceId),
          details: {
            externalUserId: record.externalUserId, externalSucceeded: record.externalSucceeded,
            externalError: record.externalError,
          },
          idempotencyKey: `migration:p3:admin-activity:${record.id}`,
          createdAt: record.createdAt, processedAt: record.createdAt,
        })
      }
      for (const refund of source.refunds) this.importRefund(refund, plan, context)
      for (const sourceUser of source.users) {
        if (!sourceUser.externalUserId) continue
        const user = requiredMap(plan.users, sourceUser.id, '用户')
        this.repository.upsertExternalAccount({
          provider: 'sudorouter', ownerType: 'user', ownerId: user.userId,
          externalAccountId: sourceUser.externalUserId, quotaUnits: sourceUser.quotaUnits,
          usedQuotaUnits: sourceUser.usedQuotaUnits, updatedAt: this.clock(),
        })
      }

      const verification = this.verifySnapshot(source, plan)
      const after = this.counts()
      const afterLedger = source.users.reduce((sum, user) => {
        const mapped = requiredMap(plan.users, user.id, '用户')
        return sum + this.repository.countOwnerLedgerEntries('user', mapped.userId)
      }, 0)
      const report: P3BillingMigrationReport = {
        migrationRunId: context.migrationRunId!, sourceChecksum: source.checksum,
        users: source.users.length, orders: source.orders.length,
        creditApplications: source.creditApplications.length, refunds: source.refunds.length,
        activities: source.rechargeRecords.length + source.adminRechargeRecords.length,
        importedLedgerEntries: afterLedger - beforeLedger,
        importedOrders: after.orders - before.orders,
        importedCreditApplications: after.credits - before.credits,
        importedRefunds: after.refunds - before.refunds,
        importedActivities: after.activities - before.activities,
        financialDifferenceUnits: verification.differenceUnits,
        deliverableExternalOutboxCount: this.repository.countDeliverableExternalOutbox(),
      }
      if (verification.status !== 'matched') {
        throw new BillingDomainError('MIGRATION_VERIFICATION_FAILED', verification.issues.join('; '))
      }
      const auditKey = `migration:p3:summary:${source.checksum}`
      if (this.repository.countAuditEvents(auditKey) === 0) {
        this.repository.insertAuditEvent({
          id: stableId('p3-summary-audit', source.checksum), action: 'P3_BILLING_MIGRATION_COMPLETED',
          aggregateType: 'migration', aggregateId: context.migrationRunId!, actorUserId: null, orgId: null,
          contextSource: context.source, idempotencyKey: auditKey,
          payload: { ...report, externalEffects: 'suppressed' }, createdAt: this.clock(),
        })
      }
      this.repository.saveMigrationCheckpoint({
        sourceChecksum: source.checksum, migrationRunId: context.migrationRunId!,
        report: report as unknown as Record<string, unknown>, createdAt: this.clock(), verifiedAt: this.clock(),
      })
      return report
    })
  }

  verify(source: SudoworkP3Snapshot): P3BillingVerificationReport {
    const plan = this.plan(source)
    if (plan.status === 'blocked') {
      return {
        status: 'mismatch', sourceChecksum: source.checksum, differenceUnits: 0,
        issues: plan.issues.map(item => item.message),
      }
    }
    return this.verifySnapshot(source, plan)
  }

  private verifySnapshot(source: SudoworkP3Snapshot, plan: P3BillingMigrationPlan): P3BillingVerificationReport {
    const issues: string[] = []
    let differenceUnits = 0
    for (const sourceUser of source.users) {
      const user = plan.users.get(sourceUser.id)
      if (!user) { issues.push(`用户 ${sourceUser.id} 未映射`); continue }
      const wallet = this.repository.getWallet('user', user.userId)
      const rebuilt = this.wallet.rebuild('user', user.userId)
      const walletDifference = (wallet?.balanceUnits ?? 0) - sourceUser.balanceUnits
      differenceUnits += Math.abs(walletDifference) + Math.abs(rebuilt.difference)
      if (walletDifference !== 0 || rebuilt.difference !== 0) issues.push(`用户 ${sourceUser.id} 钱包或账本存在差异`)
      if (sourceUser.externalUserId) {
        const account = this.repository.getExternalAccount('sudorouter', 'user', user.userId)
        if (!account || account.externalAccountId !== sourceUser.externalUserId
          || account.quotaUnits !== sourceUser.quotaUnits || account.usedQuotaUnits !== sourceUser.usedQuotaUnits) {
          issues.push(`用户 ${sourceUser.id} Sudorouter 快照不一致`)
        }
      }
    }
    for (const order of source.orders) {
      if (this.repository.getOrderByLegacyId(order.id)?.orderNo !== order.orderNo) issues.push(`订单 ${order.id} 未完整导入`)
    }
    for (const application of source.creditApplications) {
      if (this.repository.getCreditApplicationByLegacyId(application.id)?.applicationNo !== application.applicationNo) {
        issues.push(`授信申请 ${application.id} 未完整导入`)
      }
    }
    for (const refund of source.refunds) {
      if (this.repository.getRefundByLegacyId(refund.id)?.refundNo !== refund.refundNo) issues.push(`退款 ${refund.id} 未完整导入`)
    }
    for (const record of source.rechargeRecords) {
      if (!this.repository.getActivityByLegacyId('CLIENT', record.id)) issues.push(`客户端充值记录 ${record.id} 未导入`)
    }
    for (const record of source.adminRechargeRecords) {
      if (!this.repository.getActivityByLegacyId('ADMIN', record.id)) issues.push(`管理员充值记录 ${record.id} 未导入`)
    }
    return { status: issues.length ? 'mismatch' : 'matched', sourceChecksum: source.checksum, differenceUnits, issues }
  }

  private importOrder(order: SudoworkP3Order, plan: P3BillingMigrationPlan, context: CommandContext): void {
    if (this.repository.getOrderByLegacyId(order.id)) return
    const user = requiredMap(plan.users, order.userId, '订单用户')
    const record: BillingOrderRecord = {
      id: requiredMap(plan.orderIds, order.id, '订单'), legacyId: order.id, orderNo: order.orderNo,
      userId: user.userId, orgId: user.orgId, userPhone: order.userPhone,
      amountUsdMicros: order.amountUsdMicros, amountCents: order.amountCents,
      exchangeRateMicros: order.exchangeRateMicros, quotaUnits: order.quotaUnits,
      pointsUnits: order.pointsUnits, bonusUnits: order.bonusUnits,
      paymentMethod: order.paymentMethod as 'ALIPAY' | 'WECHAT', orderDate: order.orderDate,
      providerOrderInfo: order.providerOrderInfo, status: mapOrderStatus(order.status),
      callbackData: order.callbackData, callbackTime: order.callbackTime,
      callbackAmountCents: order.callbackAmountCents,
      idempotencyKey: `migration:p3:order:${order.id}`, createdAt: order.createdAt,
      updatedAt: order.updatedAt, expiredAt: order.expiredAt, remark: order.remark,
    }
    this.repository.insertOrder(record)
    this.assignAlias('billing_order', order.id, record.id, user.orgId, context.migrationRunId!)
  }

  private importCreditApplication(
    application: SudoworkP3CreditApplication,
    plan: P3BillingMigrationPlan,
    context: CommandContext,
  ): void {
    if (this.repository.getCreditApplicationByLegacyId(application.id)) return
    const user = requiredMap(plan.users, application.userId, '授信用户')
    const admin = application.adminId === null ? null : requiredMap(plan.users, application.adminId, '授信管理员')
    const record: CreditApplicationRecord = {
      id: requiredMap(plan.creditApplicationIds, application.id, '授信申请'), legacyId: application.id,
      applicationNo: application.applicationNo, userId: user.userId, orgId: user.orgId,
      requestedUnits: application.requestedUnits, approvedUnits: application.approvedUnits,
      quotaUnits: application.quotaUnits, reason: application.reason,
      status: application.status as CreditApplicationStatus, adminUserId: admin?.userId ?? null,
      adminComment: application.adminComment, quotaOperationId: null,
      idempotencyKey: `migration:p3:credit:${application.id}`, requestFingerprint: fingerprint(application),
      createdAt: application.createdAt, reviewedAt: application.reviewedAt, updatedAt: application.updatedAt,
    }
    this.repository.insertCreditApplication(record)
    this.assignAlias('credit_application', application.id, record.id, user.orgId, context.migrationRunId!)
  }

  private importRefund(
    refund: SudoworkP3Refund,
    plan: P3BillingMigrationPlan,
    context: CommandContext,
  ): void {
    if (this.repository.getRefundByLegacyId(refund.id)) return
    const user = requiredMap(plan.users, refund.userId, '退款用户')
    const record: RefundRecord = {
      id: requiredMap(plan.refundIds, refund.id, '退款'), legacyId: refund.id,
      refundNo: refund.refundNo, orderId: requiredMap(plan.orderIds, refund.orderId, '退款订单'),
      userId: user.userId, refundAmountCents: refund.refundAmountCents,
      refundQuotaUnits: refund.refundQuotaUnits, refundPointsUnits: refund.refundPointsUnits,
      reason: refund.reason, refundType: refund.refundType, status: mapRefundStatus(refund.status),
      providerRefundNo: refund.providerRefundNo, quotaOperationId: null,
      idempotencyKey: `migration:p3:refund:${refund.id}`, requestFingerprint: fingerprint(refund),
      createdAt: refund.createdAt, updatedAt: refund.processedAt ?? refund.createdAt,
    }
    this.repository.insertRefund(record)
    this.assignAlias('billing_refund', refund.id, record.id, user.orgId, context.migrationRunId!)
  }

  private assertOrgReference(
    enterpriseId: number,
    user: ResolvedUser | undefined,
    sourceType: string,
    sourceId: number,
    issues: P3BillingMigrationIssue[],
  ): void {
    const org = this.identities.resolveNumericAliasGlobal('enterprise', enterpriseId)
    if (!org) issue(issues, 'IDENTITY_MAPPING_MISSING', 'enterprise', enterpriseId, `旧企业 ${enterpriseId} 尚未完成 P1 身份映射`)
    else if (user && org.resourceId !== user.orgId) issue(issues, 'INVALID_REFERENCE', sourceType, sourceId, '记录企业与用户所属组织不一致')
  }

  private resolveTargetIds<T>(
    namespace: string,
    rows: T[],
    legacyId: (row: T) => number,
    issues: P3BillingMigrationIssue[],
  ): Map<number, string> {
    const result = new Map<number, string>()
    for (const row of rows) {
      const id = legacyId(row)
      const alias = this.identities.resolveNumericAliasGlobal(namespace, id)
      const resourceId = alias?.resourceId ?? stableId(namespace, id)
      if (alias) {
        const owner = namespace === 'billing_order' ? this.repository.getOrderByLegacyId(id)?.id
          : namespace === 'credit_application' ? this.repository.getCreditApplicationByLegacyId(id)?.id
            : this.repository.getRefundByLegacyId(id)?.id
        if (owner !== resourceId) issue(issues, 'TARGET_CONFLICT', namespace, id, '数字别名指向不存在或不一致的目标记录')
      }
      result.set(id, resourceId)
    }
    return result
  }

  private assignAlias(namespace: string, legacyId: number, resourceId: string, orgId: string, migrationRunId: string): void {
    if (this.identities.resolveNumericAliasGlobal(namespace, legacyId)) return
    this.identities.assignNumericAlias({ namespace, legacyId, resourceId, orgId, migrationRunId })
  }

  private checkDuplicates<T>(
    rows: T[],
    sourceType: string,
    key: (row: T) => string | number,
    issues: P3BillingMigrationIssue[],
  ): void {
    const seen = new Set<string | number>()
    for (const row of rows) {
      const value = key(row)
      if (seen.has(value)) issue(issues, 'DUPLICATE_SOURCE', sourceType, value, `${sourceType} 存在重复键 ${value}`)
      seen.add(value)
    }
  }

  private counts(): { orders: number; credits: number; refunds: number; activities: number } {
    return {
      orders: this.repository.countOrders(), credits: this.repository.countCreditApplications(),
      refunds: this.repository.countRefunds(), activities: this.repository.countActivityRecords(),
    }
  }
}

function issue(
  issues: P3BillingMigrationIssue[],
  code: P3BillingMigrationIssue['code'],
  sourceType: string,
  sourceId: string | number,
  message: string,
): void {
  issues.push({ code, sourceType, sourceId: String(sourceId), message })
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>()
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row])
  return result
}

function requiredMap<K, V>(map: Map<K, V>, key: K, label: string): V {
  const value = map.get(key)
  if (!value) throw new BillingDomainError('MIGRATION_PLAN_INVALID', `${label} ${String(key)} 未包含在迁移计划中`)
  return value
}

function stableId(namespace: string, legacyId: string | number): string {
  return `${namespace}-${createHash('sha256').update(`${namespace}:${legacyId}`).digest('hex').slice(0, 24)}`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function mapOrderStatus(status: number): BillingOrderStatus {
  return ({ 2: 'SUCCESS', 3: 'FAILED', 4: 'REFUNDED', 5: 'CANCELLED' } as Record<number, BillingOrderStatus>)[status]!
}

function mapRefundStatus(status: number): BillingOperationStatus {
  return status === 1 ? 'SUCCEEDED' : 'FAILED'
}
