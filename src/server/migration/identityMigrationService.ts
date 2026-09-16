import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, migrationCommandContext, type CommandContext } from '../application/commandContext.js'
import type { AuthCenterDb, AuthCenterUser } from '../authCenter/db.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import {
  type IdentityMergePlan,
  type IdentityMergePlanner,
  type LegacyIdentitySnapshot,
  type LegacyOrganizationIdentity,
  type LegacyUserIdentity,
  type ManualResolution,
} from './identityMergePlanner.js'
import type { MigrationRunStore } from './migrationRunStore.js'

interface IdentityMigrationSource {
  readSnapshot(): LegacyIdentitySnapshot
}

export interface IdentityMigrationPlan extends IdentityMergePlan {
  sourceChecksum: string
  source: LegacyIdentitySnapshot
}

export interface IdentityMigrationReport {
  migrationRunId: string
  sourceChecksum: string
  organizationsCreated: number
  organizationsReused: number
  usersCreated: number
  usersReused: number
  suppressedExternalEffects: number
  deliverableExternalOutboxCount: number
}

export interface OrganizationMigrationReport {
  migrationRunId: string
  sourceChecksum: string
  organizationsCreated: number
  organizationsReused: number
  organizationIds: string[]
}

export interface UserIdentityMigrationReport {
  migrationRunId: string
  sourceChecksum: string
  usersCreated: number
  usersReused: number
  suppressedExternalEffects: number
  deliverableExternalOutboxCount: number
}

export interface IdentityMigrationVerification {
  status: 'matched' | 'mismatch'
  issues: string[]
}

export class IdentityMigrationBlockedError extends Error {
  constructor(readonly plan: IdentityMigrationPlan) {
    super(`身份迁移预检失败: ${plan.issues.length} 个未解决冲突`)
    this.name = 'IdentityMigrationBlockedError'
  }
}

export class IdentityMigrationService {
  constructor(private readonly options: {
    db: DatabaseSync
    auth: AuthCenterDb
    identities: IdentityRepository
    unified: UnifiedIdentityService
    runs: MigrationRunStore
    source: IdentityMigrationSource
    planner: IdentityMergePlanner
    createPlanner?: () => IdentityMergePlanner
  }) {}

  plan(resolutions: readonly ManualResolution[]): IdentityMigrationPlan {
    const source = this.options.source.readSnapshot()
    const planner = this.options.createPlanner?.() ?? this.options.planner
    return {
      ...planner.plan(source, resolutions),
      sourceChecksum: checksum(source),
      source,
    }
  }

  execute(plan: IdentityMigrationPlan, context: CommandContext): IdentityMigrationReport {
    const organizations = this.executeOrganizations(plan, context)
    const users = this.executeUsers(plan, context)
    return {
      migrationRunId: organizations.migrationRunId,
      sourceChecksum: plan.sourceChecksum,
      organizationsCreated: organizations.organizationsCreated,
      organizationsReused: organizations.organizationsReused,
      usersCreated: users.usersCreated,
      usersReused: users.usersReused,
      suppressedExternalEffects: users.suppressedExternalEffects,
      deliverableExternalOutboxCount: users.deliverableExternalOutboxCount,
    }
  }

  executeOrganizations(plan: IdentityMigrationPlan, context: CommandContext): OrganizationMigrationReport {
    const runId = this.assertExecutable(plan, context)
    const organizationIds: string[] = []
    for (const decision of plan.organizations) {
      const source = requiredById(plan.source.organizations, decision.legacyId, 'Organization')
      const targetId = runInTransaction(this.options.db, () => {
        const id = decision.action === 'reuse'
          ? this.assertReusableAlias('enterprise', source.legacyId, decision.targetId!)
          : this.options.unified.createOrganization({
              id: decision.targetId!,
              name: source.name,
              code: source.code?.trim() || undefined,
              legacyEnterpriseId: source.legacyId,
            }, migrationCommandContext(runId, `migration:identity:organization:${source.legacyId}`)).organizationId
        this.options.runs.putMapping({
          runId,
          namespace: 'enterprise',
          sourceId: String(source.legacyId),
          targetId: id,
          metadata: { matchedBy: decision.matchedBy },
        })
        return id
      })
      organizationIds.push(targetId)
    }
    return {
      migrationRunId: runId,
      sourceChecksum: plan.sourceChecksum,
      organizationsCreated: plan.organizations.filter(item => item.action === 'create').length,
      organizationsReused: plan.organizations.filter(item => item.action === 'reuse').length,
      organizationIds,
    }
  }

  executeUsers(plan: IdentityMigrationPlan, context: CommandContext): UserIdentityMigrationReport {
    const runId = this.assertExecutable(plan, context)
    let suppressedExternalEffects = 0
    for (const decision of plan.users) {
      const source = requiredById(plan.source.users, decision.legacyId, 'User')
      const orgId = this.options.identities.resolveNumericAliasGlobal('enterprise', source.enterpriseId)?.resourceId
      if (!orgId) throw new Error(`旧用户 ${source.legacyId} 缺少 Organization 映射`)
      runInTransaction(this.options.db, () => {
        const targetId = decision.action === 'reuse'
          ? this.assertReusableAlias('user', source.legacyId, decision.targetId!, orgId)
          : this.createUser(source, orgId, runId, decision.targetId!)
        this.ensureProviderIdentities(source, targetId, orgId)
        this.options.runs.putMapping({
          runId,
          namespace: 'user',
          sourceId: String(source.legacyId),
          targetId,
          metadata: { matchedBy: decision.matchedBy, organizationId: orgId },
        })
        if (decision.action === 'create') {
          const idempotencyKey = `welcome:migration:identity:user:${source.legacyId}`
          const outbox = this.options.identities.getOutboxEvent(idempotencyKey)
          if (!outbox || outbox.status !== 'suppressed' || outbox.contextSource !== 'migration') {
            throw new Error(`迁移用户 ${source.legacyId} 的欢迎事件未被正确抑制`)
          }
          this.options.runs.recordSuppressedEffect(runId, {
            runId,
            effectType: 'user.welcome',
            resourceType: 'user',
            resourceId: targetId,
            idempotencyKey,
            reason: outbox.suppressReason ?? 'migration context suppresses external effects',
          })
          suppressedExternalEffects += 1
        }
      })
    }

    return {
      migrationRunId: runId,
      sourceChecksum: plan.sourceChecksum,
      usersCreated: plan.users.filter(item => item.action === 'create').length,
      usersReused: plan.users.filter(item => item.action === 'reuse').length,
      suppressedExternalEffects,
      deliverableExternalOutboxCount: this.pendingMigrationOutboxCount(),
    }
  }

  verify(plan: IdentityMigrationPlan): IdentityMigrationVerification {
    const issues: string[] = []
    for (const organization of plan.source.organizations) {
      const mapped = this.options.identities.resolveNumericAliasGlobal('enterprise', organization.legacyId)
      if (!mapped) issues.push(`旧企业 ${organization.legacyId} 未映射`)
    }
    for (const user of plan.source.users) {
      const mapped = this.options.identities.resolveNumericAliasGlobal('user', user.legacyId)
      const organization = this.options.identities.resolveNumericAliasGlobal('enterprise', user.enterpriseId)
      if (!mapped) issues.push(`旧用户 ${user.legacyId} 未映射`)
      else if (!organization || mapped.orgId !== organization.resourceId) {
        issues.push(`旧用户 ${user.legacyId} 的 Organization 映射不一致`)
      }
    }
    if (this.pendingMigrationOutboxCount() > 0) issues.push('存在 migration 来源的待投递 Outbox')
    return { status: issues.length === 0 ? 'matched' : 'mismatch', issues }
  }

  private createUser(source: LegacyUserIdentity, orgId: string, runId: string, targetId: string): string {
    const providers = source.providerIdentities ?? (source.providerIdentity ? [source.providerIdentity] : [])
    if (!source.passwordHash && providers.length === 0) {
      throw new Error(`旧用户 ${source.legacyId} 缺少可迁移的认证凭据`)
    }
    return this.options.unified.createUser({
      id: targetId,
      orgId,
      username: source.username,
      displayName: source.displayName,
      email: source.emailVerified ? source.email ?? undefined : undefined,
      phone: source.phoneVerified ? source.phone ?? undefined : undefined,
      passwordHash: source.passwordHash ?? undefined,
      role: legacyRole(source.role),
      status: legacyStatus(source.status),
      legacyUserId: source.legacyId,
      authIdentity: providers[0] ? {
        ...providers[0],
        metadata: { source: 'sudowork-migration', verified: true },
      } : undefined,
    }, migrationCommandContext(runId, `migration:identity:user:${source.legacyId}`)).userId
  }

  private assertExecutable(plan: IdentityMigrationPlan, context: CommandContext): string {
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' || context.externalEffects !== 'suppress_external' || !context.migrationRunId) {
      throw new Error('身份迁移必须使用抑制外部副作用的 migration 上下文')
    }
    if (plan.status === 'blocked') throw new IdentityMigrationBlockedError(plan)
    if (checksum(this.options.source.readSnapshot()) !== plan.sourceChecksum) {
      throw new Error('身份迁移源快照在预检后发生变化')
    }
    return context.migrationRunId
  }

  private ensureProviderIdentities(source: LegacyUserIdentity, userId: string, orgId: string): void {
    const providers = source.providerIdentities ?? (source.providerIdentity ? [source.providerIdentity] : [])
    for (const provider of providers) {
      const existing = this.options.identities.findAuthIdentity(provider.provider, provider.issuer, provider.subject)
      if (existing) {
        if (existing.userId !== userId || existing.orgId !== orgId) {
          throw new Error(`三方身份 ${provider.issuer}:${provider.subject} 已绑定其他用户`)
        }
        continue
      }
      this.options.identities.createAuthIdentity({
        id: randomUUID(),
        orgId,
        userId,
        provider: provider.provider,
        issuer: provider.issuer,
        normalizedSubject: provider.subject,
        metadata: { source: 'sudowork-migration', verified: true },
      })
    }
  }

  private assertReusableAlias(
    namespace: 'enterprise' | 'user',
    legacyId: number,
    targetId: string,
    expectedOrgId?: string,
  ): string {
    const byLegacy = this.options.identities.resolveNumericAliasGlobal(namespace, legacyId)
    if (byLegacy && byLegacy.resourceId !== targetId) {
      throw new Error(`${namespace} 旧 ID ${legacyId} 已映射到其他资源`)
    }
    const existingAlias = this.options.identities.getNumericAlias(namespace, targetId)
    if (existingAlias !== null && existingAlias !== legacyId) {
      throw new Error(`${namespace} 目标资源已有不同数字别名 ${existingAlias}`)
    }
    if (namespace === 'enterprise') {
      if (!this.options.auth.getOrganization(targetId)) throw new Error(`Organization 不存在: ${targetId}`)
    } else {
      const user = this.options.auth.getUserById(targetId)
      if (!user) throw new Error(`User 不存在: ${targetId}`)
      if (expectedOrgId && user.orgId !== expectedOrgId) throw new Error(`User ${targetId} 不属于目标 Organization`)
    }
    if (!byLegacy) {
      this.options.identities.assignNumericAlias({
        namespace,
        legacyId,
        resourceId: targetId,
        orgId: expectedOrgId ?? targetId,
      })
    }
    return targetId
  }

  private pendingMigrationOutboxCount(): number {
    const exists = this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox_events'").get()
    if (!exists) return 0
    return Number((this.options.db.prepare(`
      SELECT COUNT(*) AS count FROM outbox_events
      WHERE context_source = 'migration' AND status = 'pending'
    `).get() as { count: number }).count)
  }
}

function requiredById<T extends { legacyId: number }>(rows: T[], id: number, label: string): T {
  const row = rows.find(item => item.legacyId === id)
  if (!row) throw new Error(`${label} 源记录不存在: ${id}`)
  return row
}

function legacyRole(role: string): 'super_admin' | 'admin' | 'dept_admin' | 'user' {
  if (role === 'SUPER_ADMIN') return 'super_admin'
  if (role === 'ENTERPRISE_ADMIN' || role === 'ADMIN') return 'admin'
  if (role === 'DEPT_ADMIN') return 'dept_admin'
  if (role === 'USER') return 'user'
  throw new Error(`不支持的旧用户角色: ${role}`)
}

function legacyStatus(status: string): AuthCenterUser['status'] {
  if (status === 'ACTIVE' || status === 'APPROVED') return 'active'
  if (status === 'PENDING') return 'pending'
  if (status === 'LOCKED') return 'locked'
  if (status === 'DISABLED' || status === 'REJECTED') return 'disabled'
  throw new Error(`不支持的旧用户状态: ${status}`)
}

function checksum(snapshot: LegacyIdentitySnapshot): string {
  const normalized = {
    organizations: [...snapshot.organizations].sort((left, right) => left.legacyId - right.legacyId),
    users: [...snapshot.users].sort((left, right) => left.legacyId - right.legacyId),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
