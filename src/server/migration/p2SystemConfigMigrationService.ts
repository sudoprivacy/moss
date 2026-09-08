import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { migrationCommandContext } from '../application/commandContext.js'
import type { SudoworkSystemConfigService } from '../api/compat/sudowork/systemConfigService.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

type Json = Record<string, unknown>

const LEGACY_LOG_REPORT_KEY = Buffer.from(
  'L7CbnQlwVrzWlaehCWSIiKuwBxFDh9i1AFaifYv7UXE=',
  'base64',
)
const P2_KEYS = new Set([
  'login_method',
  'third_party_auth',
  'log_report',
  'version_update',
  'product_improvement',
  'scode_auto_model',
])

interface P2SystemConfigSource {
  readSystemConfig(): Record<string, string>
}

export interface P2SystemConfigMigrationPlan {
  status: 'ready' | 'blocked'
  migratedKeys: string[]
  deferredKeys: string[]
  conflicts: string[]
}

export interface P2SystemConfigMigrationExecution {
  migrationRunId: string
  imported: boolean
  reused: boolean
}

export class P2SystemConfigMigrationBlockedError extends Error {
  constructor(readonly report: P2SystemConfigMigrationPlan) {
    super(`P2 系统配置迁移预检失败: ${report.conflicts.length} 个冲突`)
    this.name = 'P2SystemConfigMigrationBlockedError'
  }
}

export class P2SystemConfigMigrationService {
  constructor(private readonly options: {
    db: DatabaseSync
    identities: IdentityRepository
    service: Pick<SudoworkSystemConfigService, 'update' | 'validateUpdate'>
    source: P2SystemConfigSource
    platformOrgId: string
  }) {}

  async plan(): Promise<P2SystemConfigMigrationPlan> {
    return this.buildPlan(this.options.source.readSystemConfig())
  }

  async execute(migrationRunId: string): Promise<P2SystemConfigMigrationExecution> {
    const raw = this.options.source.readSystemConfig()
    const plan = await this.buildPlan(raw)
    if (plan.status === 'blocked') throw new P2SystemConfigMigrationBlockedError(plan)
    const idempotencyKey = `system-config:${snapshotDigest(raw)}`
    const previous = this.options.identities.getCommandResult<P2SystemConfigMigrationExecution>(
      'configuration.import_system', idempotencyKey,
    )
    if (previous) return { ...previous, migrationRunId, imported: false, reused: true }

    const body = await parseMigratedBody(raw)
    await this.options.service.update(this.actor(), body)
    const result = { migrationRunId, imported: true, reused: false }
    const context = migrationCommandContext(migrationRunId, idempotencyKey)
    runInTransaction(this.options.db, () => {
      this.options.identities.recordCommandResult(
        'configuration.import_system', context.idempotencyKey, context.source, result,
      )
    })
    return result
  }

  private async buildPlan(raw: Record<string, string>): Promise<P2SystemConfigMigrationPlan> {
    const migratedKeys = Object.keys(raw).filter(key => P2_KEYS.has(key)).sort()
    const deferredKeys = Object.keys(raw).filter(key => !P2_KEYS.has(key)).sort()
    const conflicts: string[] = []
    let body: Json = {}
    try {
      body = await parseMigratedBody(raw)
    } catch (error) {
      conflicts.push(errorMessage(error))
    }

    if (body.login_method !== undefined && ![0, 1, 2].includes(Number(body.login_method))) {
      conflicts.push(`login_method 无效: ${String(body.login_method)}`)
    }
    const thirdParty = object(body.third_party_auth)
    const providers = Array.isArray(thirdParty.providers) ? thirdParty.providers : []
    for (const rawProvider of providers) {
      const provider = object(rawProvider)
      const enterpriseCode = string(provider.enterprise_code)
      if (!enterpriseCode || !this.options.identities.getOrganizationProfileByCode(enterpriseCode)) {
        conflicts.push(`CAS Provider ${string(provider.id, '(unknown)')} 的企业码 ${enterpriseCode || '(empty)'} 未映射`)
      }
    }
    const logReport = object(body.log_report)
    if (flag(logReport.enabled) === 1) {
      if (!['http', 'https'].includes(string(logReport.protocol))) conflicts.push('log_report.protocol 无效')
      if (!string(logReport.domain)) conflicts.push('log_report.domain 不能为空')
      if (!string(logReport.key)) conflicts.push('log_report 密钥缺失或无法解密')
    }
    const versionUpdate = object(body.version_update)
    if (flag(versionUpdate.enabled) === 1 && !string(versionUpdate.cos_domain)) {
      conflicts.push('version_update.cos_domain 不能为空')
    }
    try {
      this.options.service.validateUpdate(this.actor(), body)
    } catch (error) {
      const message = errorMessage(error)
      if (!conflicts.includes(message)) conflicts.push(message)
    }

    return {
      status: conflicts.length > 0 ? 'blocked' : 'ready',
      migratedKeys,
      deferredKeys,
      conflicts,
    }
  }

  private actor(): IdentityActor {
    return { userId: 'migration-system', orgId: this.options.platformOrgId, role: 'super_admin' }
  }
}

async function parseMigratedBody(raw: Record<string, string>): Promise<Json> {
  const body: Json = {}
  if ('login_method' in raw) body.login_method = strictInteger(raw.login_method!, 'login_method')
  if ('third_party_auth' in raw) body.third_party_auth = parseObject(raw.third_party_auth!, 'third_party_auth')
  if ('version_update' in raw) body.version_update = parseObject(raw.version_update!, 'version_update')
  if ('product_improvement' in raw) body.product_improvement = parseObject(raw.product_improvement!, 'product_improvement')
  if ('scode_auto_model' in raw) body.scode_auto_model = raw.scode_auto_model
  if ('log_report' in raw) {
    const logReport = parseObject(raw.log_report!, 'log_report')
    const cipher = string(logReport.key_cipher)
    const nonce = string(logReport.key_nonce)
    if ((cipher && !nonce) || (!cipher && nonce)) throw new Error('log_report 的 key_cipher/key_nonce 必须同时存在')
    const plaintext = cipher && nonce ? await decryptLegacyLogReportKey(nonce, cipher) : ''
    body.log_report = {
      enabled: flag(logReport.enabled),
      protocol: string(logReport.protocol),
      domain: string(logReport.domain),
      ...(plaintext ? { key: plaintext } : {}),
    }
  }
  return body
}

async function decryptLegacyLogReportKey(nonceBase64: string, ciphertextBase64: string): Promise<string> {
  try {
    const key = await crypto.subtle.importKey('raw', LEGACY_LOG_REPORT_KEY, { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(nonceBase64, 'base64') },
      key,
      Buffer.from(ciphertextBase64, 'base64'),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new Error('log_report 密钥无法使用旧密钥解密')
  }
}

function parseObject(value: string, key: string): Json {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Json
  } catch {
    throw new Error(`${key} 不是有效 JSON 对象`)
  }
}

function strictInteger(value: string, key: string): number {
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`${key} 不是有效整数`)
  return Number(value)
}

function snapshotDigest(raw: Record<string, string>): string {
  const canonical = Object.entries(raw).sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function flag(value: unknown): 0 | 1 {
  return value === true || value === 1 || value === '1' ? 1 : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
