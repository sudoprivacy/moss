import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import { type IdentityRepository, type InvitationRecord, type OperationAuditRecord } from '../identity/identityRepository.js'
import { sudoworkQuotaToCreditUnits, sudoworkUsdToCreditUnits } from '../identity/sudoworkCreditConversion.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import type { MigrationRunStore } from './migrationRunStore.js'
import type {
  SudoworkGovernanceSnapshot,
  SudoworkInvitationSourceRecord,
  SudoworkOperationLogSourceRecord,
} from './sudoworkGovernanceSourceReader.js'

interface GovernanceSource {
  readSnapshot(): SudoworkGovernanceSnapshot
}

export type GovernanceMigrationIssueCode =
  | 'DUPLICATE_SOURCE'
  | 'IDENTITY_MAPPING_MISSING'
  | 'INVALID_REFERENCE'
  | 'OPERATION_ORGANIZATION_REQUIRED'
  | 'TARGET_CONFLICT'

export interface GovernanceMigrationIssue {
  code: GovernanceMigrationIssueCode
  sourceType: 'invitation' | 'operation_log'
  sourceId: string
  message: string
}

export interface GovernanceMigrationResolutions {
  operationLogEnterpriseIds?: Record<number, number>
}

interface PlannedInvitation {
  action: 'import' | 'reuse'
  source: SudoworkInvitationSourceRecord
  targetId: string
  orgId: string
  usedByUserId: string | null
  initialCreditUnits: number
}

interface PlannedOperationLog {
  action: 'import' | 'reuse'
  source: SudoworkOperationLogSourceRecord
  targetId: string
  orgId: string
  actorUserId: string | null
}

export interface GovernanceMigrationPlan {
  status: 'ready' | 'blocked'
  source: SudoworkGovernanceSnapshot
  sourceChecksum: string
  issues: GovernanceMigrationIssue[]
  invitations: PlannedInvitation[]
  operationLogs: PlannedOperationLog[]
}

export interface GovernanceMigrationReport {
  migrationRunId: string
  sourceChecksum: string
  invitationsImported: number
  operationLogsImported: number
  deliverableExternalOutboxCount: number
}

export interface GovernanceMigrationVerification {
  status: 'matched' | 'mismatch'
  sourceChecksum: string
  issues: string[]
}

export class GovernanceMigrationBlockedError extends Error {
  constructor(readonly plan: GovernanceMigrationPlan) {
    super(`治理迁移预检失败: ${plan.issues.length} 个问题`)
    this.name = 'GovernanceMigrationBlockedError'
  }
}

export class GovernanceMigrationService {
  constructor(private readonly options: {
    db: DatabaseSync
    identities: IdentityRepository
    runs: MigrationRunStore
    source: GovernanceSource
    defaultInitialQuota: number
  }) {}

  plan(resolutions: GovernanceMigrationResolutions = {}): GovernanceMigrationPlan {
    const source = this.options.source.readSnapshot()
    const issues: GovernanceMigrationIssue[] = []
    const invitations: PlannedInvitation[] = []
    const operationLogs: PlannedOperationLog[] = []
    this.assertUniqueSource(source, issues)

    for (const invitation of source.invitations) {
      const org = this.options.identities.resolveNumericAliasGlobal('enterprise', invitation.enterpriseId)
      if (!org) {
        addIssue(issues, 'IDENTITY_MAPPING_MISSING', 'invitation', invitation.id, `旧企业 ${invitation.enterpriseId} 尚未映射`)
        continue
      }
      let usedByUserId: string | null = null
      if (invitation.usedByUserId !== null) {
        const user = this.options.identities.resolveNumericAliasGlobal('user', invitation.usedByUserId)
        if (!user) {
          addIssue(issues, 'IDENTITY_MAPPING_MISSING', 'invitation', invitation.id, `旧用户 ${invitation.usedByUserId} 尚未映射`)
          continue
        }
        if (user.orgId !== org.resourceId) {
          addIssue(issues, 'INVALID_REFERENCE', 'invitation', invitation.id, '邀请码使用者与邀请码不属于同一组织')
          continue
        }
        usedByUserId = user.resourceId
      }
      const initialCreditUnits = invitation.initialQuotaUsd === null
        ? sudoworkQuotaToCreditUnits(this.options.defaultInitialQuota)
        : sudoworkUsdToCreditUnits(invitation.initialQuotaUsd)
      const alias = this.options.identities.resolveNumericAliasGlobal('invitation', invitation.id)
      const targetId = alias?.resourceId ?? invitationTargetId(invitation.id)
      if (alias && alias.orgId !== org.resourceId) {
        addIssue(issues, 'TARGET_CONFLICT', 'invitation', invitation.id, '邀请码数字别名已指向其他组织')
        continue
      }
      const expected = invitationRecord(invitation, targetId, org.resourceId, usedByUserId, initialCreditUnits)
      const existingById = this.options.identities.getInvitationById(targetId)
      const existingByCode = this.options.identities.getInvitationByCode(invitation.code)
      const existing = existingById ?? existingByCode
      if (existing && (!alias || !sameInvitation(existing, expected))) {
        addIssue(issues, 'TARGET_CONFLICT', 'invitation', invitation.id, `目标邀请码 ${invitation.code} 与源数据不一致`)
        continue
      }
      if (alias && !existing) {
        addIssue(issues, 'TARGET_CONFLICT', 'invitation', invitation.id, '邀请码数字别名指向不存在的目标')
        continue
      }
      invitations.push({
        action: existing ? 'reuse' : 'import',
        source: invitation,
        targetId,
        orgId: org.resourceId,
        usedByUserId,
        initialCreditUnits,
      })
    }

    for (const operation of source.operationLogs) {
      const actor = this.resolveOperationActor(operation, issues)
      let orgId = actor?.orgId ?? null
      if (!orgId) {
        const legacyEnterpriseId = resolutions.operationLogEnterpriseIds?.[operation.id]
        const org = legacyEnterpriseId === undefined
          ? null
          : this.options.identities.resolveNumericAliasGlobal('enterprise', legacyEnterpriseId)
        if (!org) {
          addIssue(
            issues,
            'OPERATION_ORGANIZATION_REQUIRED',
            'operation_log',
            operation.id,
            legacyEnterpriseId === undefined
              ? '历史日志无法推导组织，必须显式指定旧企业 ID'
              : `显式旧企业 ${legacyEnterpriseId} 尚未映射`,
          )
          continue
        }
        orgId = org.resourceId
      }
      const targetId = operationTargetId(operation.id)
      const expected = operationRecord(operation, targetId, orgId, actor?.userId ?? null)
      const existing = this.options.identities.getOperationAuditByLegacyId(operation.id)
        ?? this.options.identities.getOperationAuditById(targetId)
        ?? this.options.identities.getOperationAuditByIdempotencyKey(expected.idempotencyKey)
      if (existing && !sameOperation(existing, expected)) {
        addIssue(issues, 'TARGET_CONFLICT', 'operation_log', operation.id, '目标审计记录与源数据不一致')
        continue
      }
      operationLogs.push({
        action: existing ? 'reuse' : 'import',
        source: operation,
        targetId,
        orgId,
        actorUserId: actor?.userId ?? null,
      })
    }

    return {
      status: issues.length > 0 ? 'blocked' : 'ready',
      source,
      sourceChecksum: source.checksum,
      issues,
      invitations,
      operationLogs,
    }
  }

  execute(plan: GovernanceMigrationPlan, context: CommandContext): GovernanceMigrationReport {
    assertMigrationContext(context)
    if (plan.status === 'blocked') throw new GovernanceMigrationBlockedError(plan)
    const current = this.options.source.readSnapshot()
    if (current.checksum !== plan.sourceChecksum) throw new Error('治理迁移源指纹已变化')
    const previous = this.options.identities.getCommandResult<GovernanceMigrationReport>(
      'governance.import', context.idempotencyKey,
    )
    if (previous) {
      if (previous.sourceChecksum !== plan.sourceChecksum) throw new Error('治理迁移幂等键对应不同源快照')
      return previous
    }
    const runId = context.migrationRunId!
    return runInTransaction(this.options.db, () => {
      const repeated = this.options.identities.getCommandResult<GovernanceMigrationReport>(
        'governance.import', context.idempotencyKey,
      )
      if (repeated) return repeated
      for (const item of plan.invitations) {
        this.options.identities.importInvitation(invitationRecord(
          item.source, item.targetId, item.orgId, item.usedByUserId, item.initialCreditUnits,
        ))
        const existingAlias = this.options.identities.resolveNumericAliasGlobal('invitation', item.source.id)
        if (!existingAlias) {
          this.options.identities.assignNumericAlias({
            namespace: 'invitation', legacyId: item.source.id, resourceId: item.targetId,
            orgId: item.orgId, migrationRunId: runId,
          })
        }
        this.options.runs.putMapping({
          runId,
          namespace: 'invitation',
          sourceId: String(item.source.id),
          targetId: item.targetId,
          metadata: { orgId: item.orgId, code: item.source.code },
        })
      }
      for (const item of plan.operationLogs) {
        const inserted = this.options.identities.insertOperationAudit(operationRecord(
          item.source, item.targetId, item.orgId, item.actorUserId,
        ))
        if (!inserted) {
          const existing = this.options.identities.getOperationAuditByLegacyId(item.source.id)
          if (!existing || !sameOperation(existing, operationRecord(
            item.source, item.targetId, item.orgId, item.actorUserId,
          ))) throw new Error(`历史操作日志 ${item.source.id} 导入冲突`)
        }
        this.options.runs.putMapping({
          runId,
          namespace: 'operation_audit',
          sourceId: String(item.source.id),
          targetId: item.targetId,
          metadata: { orgId: item.orgId },
        })
      }
      const report: GovernanceMigrationReport = {
        migrationRunId: runId,
        sourceChecksum: plan.sourceChecksum,
        invitationsImported: plan.invitations.length,
        operationLogsImported: plan.operationLogs.length,
        deliverableExternalOutboxCount: this.options.runs.countDeliverableMigrationEffects(runId),
      }
      this.options.identities.recordCommandResult(
        'governance.import', context.idempotencyKey, context.source, report,
      )
      return report
    })
  }

  verify(plan: GovernanceMigrationPlan): GovernanceMigrationVerification {
    const issues: string[] = []
    const current = this.options.source.readSnapshot()
    if (current.checksum !== plan.sourceChecksum) issues.push('治理迁移源指纹已变化')
    for (const item of plan.invitations) {
      const actual = this.options.identities.getInvitationById(item.targetId)
      const expected = invitationRecord(item.source, item.targetId, item.orgId, item.usedByUserId, item.initialCreditUnits)
      if (!actual || !sameInvitation(actual, expected)) issues.push(`邀请码 ${item.source.id} 不一致`)
    }
    for (const item of plan.operationLogs) {
      const actual = this.options.identities.getOperationAuditByLegacyId(item.source.id)
      const expected = operationRecord(item.source, item.targetId, item.orgId, item.actorUserId)
      if (!actual || !sameOperation(actual, expected)) issues.push(`操作日志 ${item.source.id} 不一致`)
    }
    return { status: issues.length > 0 ? 'mismatch' : 'matched', sourceChecksum: plan.sourceChecksum, issues }
  }

  private resolveOperationActor(
    operation: SudoworkOperationLogSourceRecord,
    issues: GovernanceMigrationIssue[],
  ): { userId: string; orgId: string } | null {
    if (operation.userId !== null && operation.userId > 0) {
      const user = this.options.identities.resolveNumericAliasGlobal('user', operation.userId)
      if (!user) {
        addIssue(issues, 'IDENTITY_MAPPING_MISSING', 'operation_log', operation.id, `旧用户 ${operation.userId} 尚未映射`)
        return null
      }
      return { userId: user.resourceId, orgId: user.orgId }
    }
    if (operation.userPhone) {
      const identity = this.options.identities.findAuthIdentity('phone', 'sudowork', operation.userPhone)
      if (identity) return { userId: identity.userId, orgId: identity.orgId }
    }
    return null
  }

  private assertUniqueSource(source: SudoworkGovernanceSnapshot, issues: GovernanceMigrationIssue[]): void {
    duplicateIssues(source.invitations, row => row.id, 'invitation', 'ID', issues)
    duplicateIssues(source.invitations, row => row.code, 'invitation', 'code', issues)
    duplicateIssues(source.operationLogs, row => row.id, 'operation_log', 'ID', issues)
  }
}

function invitationTargetId(legacyId: number): string {
  return `sudowork-invitation:${legacyId}`
}

function operationTargetId(legacyId: number): string {
  return `sudowork-operation:${legacyId}`
}

function invitationRecord(
  source: SudoworkInvitationSourceRecord,
  targetId: string,
  orgId: string,
  usedByUserId: string | null,
  initialCreditUnits: number,
): InvitationRecord {
  return {
    id: targetId,
    orgId,
    code: source.code,
    status: source.status,
    initialCreditUnits,
    legacyInitialQuotaUsd: source.initialQuotaUsd,
    usedByUserId,
    createdAt: source.createdAt,
    usedAt: source.usedAt,
  }
}

function operationRecord(
  source: SudoworkOperationLogSourceRecord,
  targetId: string,
  orgId: string,
  actorUserId: string | null,
): Parameters<IdentityRepository['insertOperationAudit']>[0] & OperationAuditRecord {
  return {
    id: targetId,
    legacyId: source.id,
    orgId,
    actorUserId,
    actorLegacyId: source.userId,
    actorName: source.userPhone,
    action: source.action,
    resource: source.resource,
    resourceId: source.resourceId === null ? null : String(source.resourceId),
    method: source.method,
    path: source.path,
    legacyParamsRaw: source.paramsRaw,
    legacyRequestDataRaw: source.requestDataRaw,
    legacyResponseDataRaw: source.responseDataRaw,
    requestData: null,
    responseData: null,
    responseStatus: source.responseStatus,
    ipAddress: source.ipAddress,
    userAgent: source.userAgent,
    durationMs: source.durationMs,
    errorMessage: source.errorMessage,
    idempotencyKey: `migration:sudowork:operation:${source.id}`,
    createdAt: source.createdAt,
  }
}

function sameInvitation(left: InvitationRecord, right: InvitationRecord): boolean {
  return stable(left) === stable(right)
}

function sameOperation(left: OperationAuditRecord, right: OperationAuditRecord): boolean {
  return stable(left) === stable(right)
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

function addIssue(
  issues: GovernanceMigrationIssue[],
  code: GovernanceMigrationIssueCode,
  sourceType: GovernanceMigrationIssue['sourceType'],
  sourceId: string | number,
  message: string,
): void {
  issues.push({ code, sourceType, sourceId: String(sourceId), message })
}

function duplicateIssues<T>(
  items: T[],
  key: (item: T) => string | number,
  sourceType: GovernanceMigrationIssue['sourceType'],
  label: string,
  issues: GovernanceMigrationIssue[],
): void {
  const seen = new Set<string>()
  for (const item of items) {
    const value = String(key(item))
    if (seen.has(value)) addIssue(issues, 'DUPLICATE_SOURCE', sourceType, value, `源 ${sourceType} ${label} 重复: ${value}`)
    seen.add(value)
  }
}

function assertMigrationContext(context: CommandContext): void {
  assertTrustedCommandContext(context)
  if (context.source !== 'migration' || context.externalEffects !== 'suppress_external' || !context.migrationRunId) {
    throw new Error('Governance import requires a trusted migration context')
  }
}
