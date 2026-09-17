import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { migrationCommandContext, onlineCommandContext, replayCommandContext, type CommandContext } from '../application/commandContext.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import { BillingCoordinator } from './billingCoordinator.js'
import { BillingRepository, type CreditApplicationRecord } from './billingRepository.js'
import { pointsToQuota } from './sudorouterAdapter.js'
import { BillingDomainError } from './types.js'

export interface CreditApplicationPolicy {
  rechargeMode: 'payment' | 'approve' | 'disabled'
  minPoints: number
  maxPoints: number
  allowDuplicatePending: boolean
}

interface CreditPolicyProvider {
  getPolicy(orgId: string): CreditApplicationPolicy
}

interface CreditServiceOptions {
  clock?: () => number
  idGenerator?: () => string
  suffixGenerator?: () => string
}

export class CreditApplicationService {
  private readonly clock: () => number
  private readonly idGenerator: () => string
  private readonly suffixGenerator: () => string

  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: BillingRepository,
    private readonly identities: IdentityRepository,
    private readonly coordinator: BillingCoordinator,
    private readonly policies: CreditPolicyProvider,
    options: CreditServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.idGenerator = options.idGenerator ?? randomUUID
    this.suffixGenerator = options.suffixGenerator ?? (() => Math.random().toString(36).slice(2, 8).toUpperCase())
  }

  createApplication(
    input: { requestedPoints: number; reason: string },
    actor: IdentityActor,
    context: CommandContext,
  ): CreditApplicationRecord {
    const policy = this.policies.getPolicy(actor.orgId)
    this.requireApproveMode(policy)
    this.validatePoints(input.requestedPoints, policy, '申请')
    const reason = this.validateReason(input.reason, '申请原因')
    const fingerprint = createHash('sha256').update(JSON.stringify([
      actor.userId, actor.orgId, input.requestedPoints, reason,
    ])).digest('hex')

    return runInTransaction(this.db, () => {
      const previous = this.repository.getCreditApplicationByIdempotencyKey(context.idempotencyKey)
      if (previous) {
        if (previous.requestFingerprint !== fingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的积分申请')
        }
        return previous
      }
      const user = this.repository.getUserState(actor.userId)
      if (!user) throw new BillingDomainError('USER_NOT_FOUND', '用户不存在')
      if (user.status !== 'active') throw new BillingDomainError('USER_STATUS_INVALID', '用户状态不可申请积分')
      if (user.orgId !== actor.orgId) throw new BillingDomainError('CREDIT_FORBIDDEN', '无权为其他组织申请积分')
      if (!policy.allowDuplicatePending && this.repository.countPendingCreditApplications(actor.userId) > 0) {
        throw new BillingDomainError('DUPLICATE_PENDING_APPLICATION', '已有待审批申请，请勿重复提交')
      }
      const now = this.clock()
      const id = this.idGenerator()
      const legacyId = this.identities.allocateNumericAlias('credit_application', id, actor.orgId)
      const application: CreditApplicationRecord = {
        id, legacyId, applicationNo: `CA${now}${this.suffixGenerator()}`,
        userId: actor.userId, orgId: actor.orgId, requestedUnits: input.requestedPoints,
        approvedUnits: null, quotaUnits: null, reason, status: 'PENDING',
        adminUserId: null, adminComment: null, quotaOperationId: null,
        idempotencyKey: context.idempotencyKey, requestFingerprint: fingerprint,
        createdAt: now, reviewedAt: null, updatedAt: now,
      }
      this.repository.insertCreditApplication(application)
      return application
    })
  }

  async approveApplication(
    input: { applicationId: string; approvedPoints?: number; adminComment?: string },
    actor: IdentityActor,
    context: CommandContext,
  ): Promise<CreditApplicationRecord> {
    const application = this.requireApplication(input.applicationId)
    this.requireReviewer(application, actor)
    if (application.status === 'APPROVED') return application
    if (application.status !== 'PENDING' && application.status !== 'SYNC_FAILED') {
      throw new BillingDomainError('CREDIT_STATUS_INVALID', '当前状态不可审批通过')
    }
    const policy = this.policies.getPolicy(application.orgId)
    this.requireApproveMode(policy)
    const approvedPoints = input.approvedPoints ?? application.requestedUnits
    this.validatePoints(approvedPoints, policy, '审批')
    const external = this.repository.getExternalAccount('sudorouter', 'user', application.userId)
    if (!external) throw new BillingDomainError('SUDOROUTER_NOT_BOUND', '用户未绑定 sudorouter 账号')
    const now = this.clock()
    runInTransaction(this.db, () => this.repository.markCreditApplicationReview({
      id: application.id, status: 'PROCESSING', approvedUnits: approvedPoints,
      quotaUnits: pointsToQuota(approvedPoints), adminUserId: actor.userId,
      adminComment: input.adminComment ?? null, reviewedAt: now, updatedAt: now,
    }))

    const childContext = this.childContext(context, `credit:${application.id}`)
    const finalizeLocal = () => this.finalizeApprovedApplication(
      application.id, actor.userId, approvedPoints, childContext.idempotencyKey,
    )
    const result = await this.coordinator.adjustPoints({
      ownerType: 'user', ownerId: application.userId, orgId: application.orgId,
      externalUserId: external.externalAccountId, pointsDelta: approvedPoints,
      reason: `积分申请审批发放: ${application.applicationNo}`,
      sourceType: 'credit_application', sourceId: application.id, actorUserId: actor.userId,
    }, childContext, finalizeLocal)
    const status = result.status === 'SUCCEEDED' || result.status === 'SUPPRESSED'
      ? 'APPROVED'
      : result.status === 'UNKNOWN' ? 'SYNC_UNKNOWN' : 'SYNC_FAILED'
    runInTransaction(this.db, () => {
      if (status !== 'APPROVED') this.repository.markCreditApplicationReview({
        id: application.id, status, quotaOperationId: result.operationId, updatedAt: this.clock(),
      })
    })
    return this.requireApplication(application.id)
  }

  async retryApplication(applicationId: string, actor: IdentityActor): Promise<CreditApplicationRecord> {
    const application = this.requireApplication(applicationId)
    this.requireReviewer(application, actor)
    if (application.status !== 'SYNC_FAILED' && application.status !== 'SYNC_UNKNOWN') {
      throw new BillingDomainError('CREDIT_STATUS_INVALID', '只有同步失败的申请可以重试')
    }
    if (!application.quotaOperationId) throw new BillingDomainError('QUOTA_OPERATION_NOT_FOUND', '额度操作不存在')
    const result = await this.coordinator.retry(application.quotaOperationId, () => {
      this.finalizeApprovedApplication(
        application.id, application.adminUserId ?? actor.userId,
        application.approvedUnits ?? application.requestedUnits,
        this.repository.getQuotaOperationById(application.quotaOperationId!)?.idempotencyKey
          ?? `credit:${application.id}`,
      )
    })
    const status = result.status === 'SUCCEEDED' ? 'APPROVED'
      : result.status === 'UNKNOWN' ? 'SYNC_UNKNOWN' : 'SYNC_FAILED'
    runInTransaction(this.db, () => {
      if (status !== 'APPROVED') this.repository.markCreditApplicationReview({
        id: application.id, status, updatedAt: this.clock(),
      })
    })
    return this.requireApplication(application.id)
  }

  rejectApplication(applicationId: string, comment: string, actor: IdentityActor): CreditApplicationRecord {
    const application = this.requireApplication(applicationId)
    this.requireReviewer(application, actor)
    const reason = this.validateReason(comment, '拒绝原因')
    if (application.status !== 'PENDING') {
      throw new BillingDomainError('CREDIT_STATUS_INVALID', '当前状态不可拒绝')
    }
    runInTransaction(this.db, () => this.repository.markCreditApplicationReview({
      id: application.id, status: 'REJECTED', adminUserId: actor.userId,
      adminComment: reason, reviewedAt: this.clock(), updatedAt: this.clock(),
    }))
    return this.requireApplication(application.id)
  }

  private requireApplication(id: string): CreditApplicationRecord {
    const application = this.repository.getCreditApplication(id)
    if (!application) throw new BillingDomainError('CREDIT_NOT_FOUND', '申请记录不存在')
    return application
  }

  private finalizeApprovedApplication(
    applicationId: string,
    actorUserId: string,
    approvedPoints: number,
    operationKey: string,
  ): void {
    const application = this.requireApplication(applicationId)
    const operation = this.repository.getQuotaOperationByKey(operationKey)
    this.repository.markCreditApplicationReview({
      id: application.id, status: 'APPROVED', approvedUnits: approvedPoints,
      quotaUnits: pointsToQuota(approvedPoints), adminUserId: actorUserId,
      quotaOperationId: operation?.id ?? application.quotaOperationId,
      reviewedAt: application.reviewedAt ?? this.clock(), updatedAt: this.clock(),
    })
    const idempotencyKey = `billing:activity:credit:${application.id}`
    if (this.repository.getActivityByIdempotencyKey(idempotencyKey)) return
    const timestamp = this.clock()
    this.repository.insertActivityRecord({
      id: this.idGenerator(), legacyId: this.repository.allocateActivityLegacyId('ADMIN'),
      activityType: 'ADMIN', userId: application.userId, orgId: application.orgId,
      orderId: null, actorUserId, applicationId: application.id,
      pointsUnits: approvedPoints, quotaUnits: pointsToQuota(approvedPoints),
      amountCents: null, paymentMethod: null,
      reason: `积分申请审批发放: ${application.applicationNo}`, paymentReference: null,
      sourceType: 'CREDIT_APPLICATION', sourceId: application.id,
      details: {}, idempotencyKey, createdAt: timestamp, processedAt: timestamp,
    })
  }

  private requireReviewer(application: CreditApplicationRecord, actor: IdentityActor): void {
    if (actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new BillingDomainError('CREDIT_FORBIDDEN', '无权审批积分申请')
    }
    if (actor.role !== 'super_admin' && actor.orgId !== application.orgId) {
      throw new BillingDomainError('CREDIT_FORBIDDEN', '无权审批该企业的申请')
    }
  }

  private requireApproveMode(policy: CreditApplicationPolicy): void {
    if (policy.rechargeMode !== 'approve') {
      throw new BillingDomainError('CREDIT_MODE_DISABLED', '当前未启用积分申请模式')
    }
  }

  private validatePoints(points: number, policy: CreditApplicationPolicy, label: string): void {
    if (!Number.isSafeInteger(points) || points <= 0) {
      throw new BillingDomainError('INVALID_CREDIT_POINTS', `${label}积分必须为正整数`)
    }
    if (points < policy.minPoints && label === '申请') {
      throw new BillingDomainError('INVALID_CREDIT_POINTS', `申请积分不能小于 ${policy.minPoints}`)
    }
    if (points > policy.maxPoints) {
      throw new BillingDomainError('INVALID_CREDIT_POINTS', `${label}积分不能大于 ${policy.maxPoints}`)
    }
  }

  private validateReason(value: string, label: string): string {
    const reason = typeof value === 'string' ? value.trim() : ''
    if (!reason) throw new BillingDomainError('CREDIT_REASON_REQUIRED', `${label}不能为空`)
    if (reason.length > 500) throw new BillingDomainError('CREDIT_REASON_TOO_LONG', `${label}不能超过 500 个字符`)
    return reason
  }

  private childContext(context: CommandContext, key: string): CommandContext {
    if (context.source === 'migration') return migrationCommandContext(context.migrationRunId!, key)
    if (context.source === 'replay') return replayCommandContext(context.originalEventId!, key)
    return onlineCommandContext(key)
  }
}
