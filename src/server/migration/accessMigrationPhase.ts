import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext } from '../application/commandContext.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type {
  MigrationExecutionContext,
  MigrationPhase,
  MigrationPhaseIssue,
  MigrationPhasePlan,
  MigrationPhaseVerification,
  MigrationPlanningContext,
  MigrationVerificationContext,
} from './migrationPhaseRegistry.js'

export interface AccessKeyValueStore {
  keys(pattern: string): Promise<string[]>
  get(key: string): Promise<string | null>
  ttl(key: string): Promise<number>
  setex(key: string, seconds: number, value: string): Promise<void>
}

export interface AccessRedisEntry {
  key: string
  value: string
  ttlSeconds: number
}

export interface AccessHandoff {
  id: number
  codeHash: string
  providerId: string
  userId: number
  enterpriseId: number
  account: string
  externalUserId: string
  expiresAt: number
}

export interface SudoworkAccessSourceSnapshot {
  checksum: string
  redisEntries: AccessRedisEntry[]
  handoffs: AccessHandoff[]
}

export interface AccessSourcePort {
  readSnapshot(): Promise<SudoworkAccessSourceSnapshot>
}

export interface NumericAliasPort {
  resolveNumericAliasGlobal(kind: 'user' | 'enterprise', legacyId: number): {
    resourceId: string
    orgId: string
  } | null
}

export interface AccessMigrationPlan extends MigrationPhasePlan {
  sourceChecksum: string
  jwtSecretFingerprint: string
  counts: { refreshTokens: number; registerHandoffs: number; casHandoffs: number }
}

export interface AccessMigrationPhaseOptions {
  source: AccessSourcePort
  target: AccessKeyValueStore
  identities: Pick<IdentityRepository, 'resolveNumericAliasGlobal'> | NumericAliasPort
  sourceLegacyJwtSecret: string
  targetLegacyJwtSecret: string
  nowSeconds?: () => number
}

export class SudoworkAccessSourceReader implements AccessSourcePort {
  private readonly databasePath: string
  private readonly nowSeconds: () => number

  constructor(
    snapshotDirectory: string,
    private readonly redis: Pick<AccessKeyValueStore, 'keys' | 'get' | 'ttl'>,
    options: { nowSeconds?: () => number } = {},
  ) {
    this.databasePath = resolve(snapshotDirectory, 'sudowork.sqlite')
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  }

  async readSnapshot(): Promise<SudoworkAccessSourceSnapshot> {
    const redisEntries = await this.readRedisEntries()
    const handoffs = this.readHandoffs()
    const checksumInput = {
      redisEntries: redisEntries.map(({ key, value }) => ({ key, value })),
      handoffs,
    }
    return { checksum: sha256(stableJson(checksumInput)), redisEntries, handoffs }
  }

  private async readRedisEntries(): Promise<AccessRedisEntry[]> {
    const keys = [...new Set([
      ...await this.redis.keys('refresh_token:*'),
      ...await this.redis.keys('register_token:*'),
    ])].sort()
    const result: AccessRedisEntry[] = []
    for (const key of keys) {
      const [value, ttlSeconds] = await Promise.all([this.redis.get(key), this.redis.ttl(key)])
      if (value === null || ttlSeconds <= 0) continue
      result.push({ key, value, ttlSeconds })
    }
    return result
  }

  private readHandoffs(): AccessHandoff[] {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA query_only=ON')
      if (!tableExists(db, 'third_party_auth_handoffs')) return []
      if (!tableExists(db, 'users')) throw new Error('CAS handoff 快照缺少 users 表')
      const now = this.nowSeconds()
      return (db.prepare(`
        SELECT h.id, h.code_hash, h.provider_id, h.user_id, h.external_user_id,
               h.expires_at, u.enterprise_id, u.phone
        FROM third_party_auth_handoffs h
        JOIN users u ON u.id = h.user_id
        WHERE h.used_at IS NULL AND h.expires_at > ?
        ORDER BY h.id
      `).all(now) as Array<Record<string, unknown>>).map(row => ({
        id: positiveInteger(row.id, 'third_party_auth_handoffs.id'),
        codeHash: requiredText(row.code_hash, 'third_party_auth_handoffs.code_hash'),
        providerId: requiredText(row.provider_id, 'third_party_auth_handoffs.provider_id'),
        userId: positiveInteger(row.user_id, 'third_party_auth_handoffs.user_id'),
        enterpriseId: positiveInteger(row.enterprise_id, 'users.enterprise_id'),
        account: requiredText(row.phone, 'users.phone'),
        externalUserId: requiredText(row.external_user_id, 'third_party_auth_handoffs.external_user_id'),
        expiresAt: positiveInteger(row.expires_at, 'third_party_auth_handoffs.expires_at'),
      }))
    } catch (error) {
      throw new Error(`无法只读读取 Sudowork 访问态快照: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      db?.close()
    }
  }
}

export class AccessMigrationPhase implements MigrationPhase {
  readonly name = 'access' as const
  private readonly nowSeconds: () => number

  constructor(private readonly options: AccessMigrationPhaseOptions) {
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  }

  async plan(_context: MigrationPlanningContext): Promise<AccessMigrationPlan> {
    const source = await this.options.source.readSnapshot()
    const issues = await this.validate(source, true)
    return {
      status: issues.length === 0 ? 'ready' : 'blocked',
      issues,
      sourceChecksum: source.checksum,
      jwtSecretFingerprint: secretFingerprint(this.options.sourceLegacyJwtSecret),
      counts: accessCounts(source),
    }
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    const accessPlan = requirePlan(plan)
    if (accessPlan.status !== 'ready') throw new Error('访问态迁移预检未通过，拒绝执行')
    const command = context.commandContext(`migration:phase:access:${accessPlan.sourceChecksum}`)
    assertTrustedCommandContext(command)
    if (command.source !== 'migration' || command.externalEffects !== 'suppress_external') {
      throw new Error('访问态迁移必须使用副作用抑制的 migration context')
    }
    const source = await this.options.source.readSnapshot()
    if (source.checksum !== accessPlan.sourceChecksum) throw new Error('访问态迁移源快照已变化，拒绝执行')
    const issues = await this.validate(source, true)
    if (issues.length > 0) throw new Error(`访问态迁移条件已变化: ${issues.map(item => item.message).join('; ')}`)

    let imported = 0
    let reused = 0
    let skippedExpired = 0
    for (const entry of source.redisEntries) {
      if (entry.ttlSeconds <= 0) {
        skippedExpired += 1
        continue
      }
      const outcome = await putExact(this.options.target, entry.key, entry.value, entry.ttlSeconds)
      outcome === 'imported' ? imported += 1 : reused += 1
    }
    for (const handoff of source.handoffs) {
      const ttlSeconds = handoff.expiresAt - this.nowSeconds()
      if (ttlSeconds <= 0) {
        skippedExpired += 1
        continue
      }
      const user = this.options.identities.resolveNumericAliasGlobal('user', handoff.userId)!
      const value = JSON.stringify({
        providerId: handoff.providerId,
        userId: user.resourceId,
        account: handoff.account,
      })
      const outcome = await putExact(this.options.target, `cas_handoff:${handoff.codeHash}`, value, ttlSeconds)
      outcome === 'imported' ? imported += 1 : reused += 1
    }
    return { imported, reused, skippedExpired }
  }

  async verify(_context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const source = await this.options.source.readSnapshot()
    const domainIssues = await this.validate(source, false)
    const issues = domainIssues.map(item => item.message)
    for (const entry of source.redisEntries) {
      if (await this.options.target.get(entry.key) !== entry.value) issues.push(`目标访问态不匹配: ${entry.key}`)
    }
    for (const handoff of source.handoffs) {
      if (handoff.expiresAt <= this.nowSeconds()) continue
      const alias = this.options.identities.resolveNumericAliasGlobal('user', handoff.userId)
      if (!alias) continue
      const expected = JSON.stringify({ providerId: handoff.providerId, userId: alias.resourceId, account: handoff.account })
      if (await this.options.target.get(`cas_handoff:${handoff.codeHash}`) !== expected) {
        issues.push(`目标 CAS handoff 不匹配: ${handoff.id}`)
      }
    }
    return { status: issues.length === 0 ? 'matched' : 'mismatch', issues, counts: accessCounts(source) }
  }

  private async validate(source: SudoworkAccessSourceSnapshot, checkTarget: boolean): Promise<MigrationPhaseIssue[]> {
    const issues: MigrationPhaseIssue[] = []
    if (!this.options.sourceLegacyJwtSecret.trim() || !this.options.targetLegacyJwtSecret.trim()) {
      issues.push({ code: 'LEGACY_JWT_SECRET_MISSING', message: '旧 JWT 密钥与 Moss 兼容密钥必须显式配置' })
    } else if (secretFingerprint(this.options.sourceLegacyJwtSecret) !== secretFingerprint(this.options.targetLegacyJwtSecret)) {
      issues.push({ code: 'LEGACY_JWT_SECRET_MISMATCH', message: '旧 JWT 密钥与 Moss 兼容密钥不一致' })
    }

    for (const entry of source.redisEntries) {
      if (entry.key.startsWith('refresh_token:')) this.validateRefreshToken(entry, issues)
      else if (entry.key.startsWith('register_token:')) validateRegisterHandoff(entry, issues)
      else issues.push({ code: 'UNSUPPORTED_ACCESS_KEY', resourceType: 'redis_key', resourceId: entry.key, message: `不支持的访问态 key: ${entry.key}` })
      if (checkTarget) {
        const existing = await this.options.target.get(entry.key)
        if (existing !== null && existing !== entry.value) targetConflict(entry.key, issues)
      }
    }

    for (const handoff of source.handoffs) {
      const user = this.options.identities.resolveNumericAliasGlobal('user', handoff.userId)
      const organization = this.options.identities.resolveNumericAliasGlobal('enterprise', handoff.enterpriseId)
      if (!user || !organization || user.orgId !== organization.resourceId) {
        issues.push({
          code: 'CAS_HANDOFF_IDENTITY_ORPHAN', resourceType: 'third_party_auth_handoff',
          resourceId: String(handoff.id), message: `CAS handoff ${handoff.id} 无法映射到统一用户与组织`,
        })
        continue
      }
      if (checkTarget) {
        const key = `cas_handoff:${handoff.codeHash}`
        const expected = JSON.stringify({ providerId: handoff.providerId, userId: user.resourceId, account: handoff.account })
        const existing = await this.options.target.get(key)
        if (existing !== null && existing !== expected) targetConflict(key, issues)
      }
    }
    return issues
  }

  private validateRefreshToken(entry: AccessRedisEntry, issues: MigrationPhaseIssue[]): void {
    const match = entry.key.match(/^refresh_token:(\d+):([^:]+):([^:]+)$/)
    if (!match) {
      issues.push({ code: 'INVALID_REFRESH_TOKEN', resourceType: 'redis_key', resourceId: entry.key, message: `Refresh Token key 格式非法: ${entry.key}` })
      return
    }
    const userId = Number(match[1])
    const user = this.options.identities.resolveNumericAliasGlobal('user', userId)
    if (!user) {
      issues.push({ code: 'REFRESH_TOKEN_USER_ORPHAN', resourceType: 'redis_key', resourceId: entry.key, message: `Refresh Token 引用未迁移用户: ${userId}` })
      return
    }
    try {
      const claims = JSON.parse(entry.value) as Record<string, unknown>
      if (typeof claims.phone !== 'string' || typeof claims.role !== 'string') throw new Error('claims')
      if (claims.enterprise_id !== null && (!Number.isSafeInteger(claims.enterprise_id) || Number(claims.enterprise_id) <= 0)) throw new Error('enterprise_id')
      if (typeof claims.enterprise_id === 'number') {
        const organization = this.options.identities.resolveNumericAliasGlobal('enterprise', claims.enterprise_id)
        if (!organization || organization.resourceId !== user.orgId) throw new Error('organization mapping')
      }
    } catch {
      issues.push({ code: 'INVALID_REFRESH_TOKEN', resourceType: 'redis_key', resourceId: entry.key, message: `Refresh Token 内容或组织归属非法: ${entry.key}` })
    }
  }
}

async function putExact(store: AccessKeyValueStore, key: string, value: string, ttlSeconds: number): Promise<'imported' | 'reused'> {
  const existing = await store.get(key)
  if (existing === value) return 'reused'
  if (existing !== null) throw new Error(`目标访问态 key 冲突: ${key}`)
  await store.setex(key, ttlSeconds, value)
  return 'imported'
}

function validateRegisterHandoff(entry: AccessRedisEntry, issues: MigrationPhaseIssue[]): void {
  try {
    const value = JSON.parse(entry.value) as Record<string, unknown>
    if (value.verified !== true || typeof value.phone !== 'string' || !value.phone.trim()) throw new Error('invalid')
  } catch {
    issues.push({ code: 'INVALID_REGISTER_HANDOFF', resourceType: 'redis_key', resourceId: entry.key, message: `注册 handoff 内容非法: ${entry.key}` })
  }
}

function targetConflict(key: string, issues: MigrationPhaseIssue[]): void {
  issues.push({ code: 'ACCESS_TARGET_CONFLICT', resourceType: 'redis_key', resourceId: key, message: `目标访问态 key 已存在不同内容: ${key}` })
}

function accessCounts(source: SudoworkAccessSourceSnapshot) {
  return {
    refreshTokens: source.redisEntries.filter(item => item.key.startsWith('refresh_token:')).length,
    registerHandoffs: source.redisEntries.filter(item => item.key.startsWith('register_token:')).length,
    casHandoffs: source.handoffs.length,
  }
}

function requirePlan(plan: MigrationPhasePlan): AccessMigrationPlan {
  if (typeof plan.sourceChecksum !== 'string' || !plan.counts) throw new Error('访问态迁移阶段缺少预检结果')
  return plan as AccessMigrationPlan
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function positiveInteger(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${field} 必须是正整数`)
  return result
}

function requiredText(value: unknown, field: string): string {
  const result = value == null ? '' : String(value).trim()
  if (!result) throw new Error(`${field} 不能为空`)
  return result
}

function secretFingerprint(secret: string): string {
  return secret.trim() ? sha256(`sudowork-legacy-jwt:${secret}`) : ''
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stableJson(item))))
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, JSON.parse(stableJson(item))])))
  }
  return JSON.stringify(value)
}
