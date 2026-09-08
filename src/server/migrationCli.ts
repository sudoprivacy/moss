import { realpathSync } from 'node:fs'
import { lstat, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GovernanceMigrationResolutions } from './migration/governanceMigrationService.js'
import type { ManualResolution } from './migration/identityMergePlanner.js'
import type { SudoworkMigrationCoordinator } from './migration/sudoworkMigrationCoordinator.js'

export type MigrationCliMode = 'dry-run' | 'execute' | 'resume' | 'verify'

export interface MigrationCliArgs {
  configPath: string
  mode: MigrationCliMode
  runId?: string
}

export interface MigrationCliConfig {
  source: {
    snapshotDir: string
    redisUrl: string
    qmsPostgresUrl: string
    fileAllowlist: string[]
  }
  target: {
    mossDbPath: string
    runtimeDir: string
    publicBaseUrl: string
    redisUrl: string
    qmsPostgresUrl: string
    nexusEndpoint: string
    nexusAuthToken: string
    loginMethod: 'sms' | 'password' | 'cas'
    skillhubBaseUrl: string
    sudorouterBaseUrl?: string
    smsConfigured: boolean
  }
  migration: {
    platformCatalogOrgId: string
    platformConfigOrgId: string
    qmsBatchSize: number
    defaultInitialQuota: number
    identityResolutions: ManualResolution[]
    governanceResolutions: GovernanceMigrationResolutions
  }
  reportsDir: string
  secrets: {
    sourceLegacyJwtSecret: string
    targetLegacyJwtSecret: string
  }
}

interface MigrationCoordinatorPort {
  dryRun(): Promise<{ status: 'ready' | 'blocked'; [key: string]: unknown }>
  execute(): Promise<Record<string, unknown>>
  resume(runId: string): Promise<Record<string, unknown>>
  verify(runId: string): Promise<{ status: 'matched' | 'mismatch'; [key: string]: unknown }>
}

export interface MigrationCliDependencies<TConfig = MigrationCliConfig> {
  loadConfig(path: string): Promise<TConfig>
  createCoordinator(config: TConfig): Promise<{
    coordinator: MigrationCoordinatorPort | SudoworkMigrationCoordinator
    writeReport?(mode: MigrationCliMode, result: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
  }>
  output(value: unknown): void
}

const DEVELOPMENT_DEFAULT_SECRETS = new Set([
  'sudowork-secret-key',
  'change-me',
  'changeme',
  'development-secret',
  'dev-secret',
])

export function parseMigrationCliArgs(argv: readonly string[]): MigrationCliArgs {
  let configPath = ''
  const modes: Array<{ mode: MigrationCliMode; runId?: string }> = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--config') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('--config 缺少路径')
      if (configPath) throw new Error('--config 参数重复')
      configPath = value
      continue
    }
    if (arg === '--dry-run' || arg === '--execute') {
      modes.push({ mode: arg.slice(2) as MigrationCliMode })
      continue
    }
    if (arg === '--resume' || arg === '--verify') {
      const runId = argv[++index]
      if (!runId || runId.startsWith('--')) throw new Error(`${arg} 缺少批次 ID`)
      modes.push({ mode: arg.slice(2) as MigrationCliMode, runId })
      continue
    }
    throw new Error(`未知参数: ${arg}`)
  }
  if (!configPath) throw new Error('缺少 --config')
  if (!isAbsolute(configPath)) throw new Error('--config 必须是绝对路径')
  if (modes.length !== 1) throw new Error('必须且只能选择一种迁移模式')
  return { configPath, ...modes[0]! }
}

export async function loadMigrationCliConfig(
  configPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MigrationCliConfig> {
  if (!isAbsolute(configPath)) throw new Error('迁移配置路径必须是绝对路径')
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  if (parsed.version !== 1) throw new Error('迁移配置 version 必须为 1')
  const source = object(parsed.source, 'source')
  const target = object(parsed.target, 'target')
  const migration = object(parsed.migration, 'migration')
  const snapshotDir = absoluteString(source.snapshotDir, 'source.snapshotDir')
  const sourceInfo = await lstat(snapshotDir)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('source.snapshotDir 必须是非符号链接目录')
  if ((sourceInfo.mode & 0o222) !== 0) throw new Error('source.snapshotDir 必须冻结为只读目录')
  const sqliteInfo = await stat(resolve(snapshotDir, 'sudowork.sqlite'))
  if (!sqliteInfo.isFile()) throw new Error('source.snapshotDir 缺少 sudowork.sqlite')

  const sourceLegacyJwtSecret = envSecret(env, source.legacyJwtSecretEnv, 'source.legacyJwtSecretEnv')
  const targetLegacyJwtSecret = envSecret(env, target.legacyJwtSecretEnv, 'target.legacyJwtSecretEnv')
  rejectDevelopmentSecret(sourceLegacyJwtSecret)
  rejectDevelopmentSecret(targetLegacyJwtSecret)
  if (sourceLegacyJwtSecret !== targetLegacyJwtSecret) throw new Error('源与目标旧 JWT 密钥必须一致')

  const sourceRedisUrl = envSecret(env, source.redisUrlEnv, 'source.redisUrlEnv')
  const targetRedisUrl = envSecret(env, target.redisUrlEnv, 'target.redisUrlEnv')
  if (sourceRedisUrl === targetRedisUrl) throw new Error('源与目标 Redis 地址必须不同')
  const sourceQmsPostgresUrl = envSecret(env, source.qmsPostgresUrlEnv, 'source.qmsPostgresUrlEnv')
  const targetQmsPostgresUrl = envSecret(env, target.qmsPostgresUrlEnv, 'target.qmsPostgresUrlEnv')
  if (sourceQmsPostgresUrl === targetQmsPostgresUrl) throw new Error('源与目标 QMS PostgreSQL 地址必须不同')

  const qmsBatchSize = Number(migration.qmsBatchSize ?? 500)
  if (!Number.isSafeInteger(qmsBatchSize) || qmsBatchSize < 1 || qmsBatchSize > 10_000) {
    throw new Error('migration.qmsBatchSize 必须是 1 到 10000 的整数')
  }
  const fileAllowlist = stringArray(source.fileAllowlist, 'source.fileAllowlist')
  if (fileAllowlist.length === 0) throw new Error('source.fileAllowlist 不能为空')
  const defaultInitialQuota = Number(envSecret(env, migration.defaultInitialQuotaEnv, 'migration.defaultInitialQuotaEnv'))
  if (!Number.isSafeInteger(defaultInitialQuota) || defaultInitialQuota < 0) {
    throw new Error('migration.defaultInitialQuotaEnv 指向的值必须是非负整数')
  }

  const mossDbPath = absoluteString(target.mossDbPath, 'target.mossDbPath')
  const runtimeDir = absoluteString(target.runtimeDir, 'target.runtimeDir')
  const reportsDir = absoluteString(parsed.reportsDir, 'reportsDir')
  for (const [field, path] of [
    ['target.mossDbPath', mossDbPath],
    ['target.runtimeDir', runtimeDir],
    ['reportsDir', reportsDir],
  ] as const) {
    if (isWithin(snapshotDir, path)) throw new Error(`${field} 目标路径不得位于冻结源目录`)
  }

  return {
    source: {
      snapshotDir,
      redisUrl: sourceRedisUrl,
      qmsPostgresUrl: sourceQmsPostgresUrl,
      fileAllowlist,
    },
    target: {
      mossDbPath,
      runtimeDir,
      publicBaseUrl: requiredString(target.publicBaseUrl, 'target.publicBaseUrl').replace(/\/+$/, ''),
      redisUrl: targetRedisUrl,
      qmsPostgresUrl: targetQmsPostgresUrl,
      nexusEndpoint: requiredString(target.nexusEndpoint, 'target.nexusEndpoint'),
      nexusAuthToken: optionalEnvSecret(env, target.nexusAuthTokenEnv, 'target.nexusAuthTokenEnv'),
      loginMethod: loginMethod(target.loginMethod),
      skillhubBaseUrl: requiredString(target.skillhubBaseUrl, 'target.skillhubBaseUrl'),
      sudorouterBaseUrl: optionalString(target.sudorouterBaseUrl),
      smsConfigured: target.smsConfigured === true,
    },
    migration: {
      platformCatalogOrgId: requiredString(migration.platformCatalogOrgId, 'migration.platformCatalogOrgId'),
      platformConfigOrgId: requiredString(migration.platformConfigOrgId, 'migration.platformConfigOrgId'),
      qmsBatchSize,
      defaultInitialQuota,
      identityResolutions: identityResolutions(migration.identityResolutions),
      governanceResolutions: governanceResolutions(migration.governanceResolutions),
    },
    reportsDir,
    secrets: { sourceLegacyJwtSecret, targetLegacyJwtSecret },
  }
}

export async function runMigrationCli<TConfig>(
  args: MigrationCliArgs,
  dependencies: MigrationCliDependencies<TConfig>,
): Promise<number> {
  const config = await dependencies.loadConfig(args.configPath)
  const runtime = await dependencies.createCoordinator(config)
  try {
    if (args.mode === 'dry-run') {
      const report = await runtime.coordinator.dryRun()
      dependencies.output(report)
      return report.status === 'ready' ? 0 : 2
    }
    if (args.mode === 'execute') {
      const result = await runtime.coordinator.execute()
      dependencies.output(result)
      if (runtime.writeReport) dependencies.output(await runtime.writeReport(args.mode, result))
      return 0
    }
    if (args.mode === 'resume') {
      const result = await runtime.coordinator.resume(args.runId!)
      dependencies.output(result)
      if (runtime.writeReport) dependencies.output(await runtime.writeReport(args.mode, result))
      return 0
    }
    const report = await runtime.coordinator.verify(args.runId!)
    dependencies.output(report)
    if (runtime.writeReport) dependencies.output(await runtime.writeReport(args.mode, report))
    return report.status === 'matched' ? 0 : 3
  } finally {
    await runtime.close()
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${field} 必须是对象`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  return value.trim()
}

function absoluteString(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!isAbsolute(result)) throw new Error(`${field} 必须是绝对路径`)
  return resolve(result)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} 必须是非空字符串数组`)
  }
  return [...new Set(value.map(item => String(item).trim()))]
}

function envSecret(env: Readonly<Record<string, string | undefined>>, envName: unknown, field: string): string {
  const name = requiredString(envName, field)
  const value = env[name]?.trim()
  if (!value) throw new Error(`环境变量 ${name} 未配置`)
  return value
}

function optionalEnvSecret(env: Readonly<Record<string, string | undefined>>, envName: unknown, field: string): string {
  if (envName === undefined || envName === null || envName === '') return ''
  return envSecret(env, envName, field)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function loginMethod(value: unknown): 'sms' | 'password' | 'cas' {
  if (value !== 'sms' && value !== 'password' && value !== 'cas') {
    throw new Error('target.loginMethod 必须是 sms、password 或 cas')
  }
  return value
}

function rejectDevelopmentSecret(value: string): void {
  if (DEVELOPMENT_DEFAULT_SECRETS.has(value.toLowerCase())) throw new Error('迁移配置禁止使用开发默认秘密')
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function identityResolutions(value: unknown): ManualResolution[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('migration.identityResolutions 必须是数组')
  return value.map((item, index) => {
    if (!isObject(item) || (item.kind !== 'organization' && item.kind !== 'user')) {
      throw new Error(`migration.identityResolutions[${index}] kind 非法`)
    }
    return {
      kind: item.kind,
      sourceId: requiredString(item.sourceId, `migration.identityResolutions[${index}].sourceId`),
      targetId: requiredString(item.targetId, `migration.identityResolutions[${index}].targetId`),
    }
  })
}

function governanceResolutions(value: unknown): GovernanceMigrationResolutions {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('migration.governanceResolutions 必须是对象')
  const unknownKeys = Object.keys(value).filter(key => key !== 'operationLogEnterpriseIds')
  if (unknownKeys.length > 0) throw new Error(`migration.governanceResolutions 包含未知字段: ${unknownKeys.join(', ')}`)
  if (value.operationLogEnterpriseIds === undefined) return {}
  if (!isObject(value.operationLogEnterpriseIds)) {
    throw new Error('migration.governanceResolutions.operationLogEnterpriseIds 必须是对象')
  }
  const mappings: Record<number, number> = {}
  for (const [sourceId, enterpriseId] of Object.entries(value.operationLogEnterpriseIds)) {
    const parsedSourceId = Number(sourceId)
    if (!Number.isSafeInteger(parsedSourceId) || parsedSourceId <= 0
      || !Number.isSafeInteger(enterpriseId) || Number(enterpriseId) <= 0) {
      throw new Error('migration.governanceResolutions.operationLogEnterpriseIds 必须使用正整数 ID')
    }
    mappings[parsedSourceId] = Number(enterpriseId)
  }
  return { operationLogEnterpriseIds: mappings }
}

export const MIGRATION_CLI_USAGE = `用法:
  node bin/migrate-sudowork.mjs --config <绝对路径> --dry-run
  node bin/migrate-sudowork.mjs --config <绝对路径> --execute
  node bin/migrate-sudowork.mjs --config <绝对路径> --resume <migration_run_id>
  node bin/migrate-sudowork.mjs --config <绝对路径> --verify <migration_run_id>`

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${MIGRATION_CLI_USAGE}\n`)
    return
  }
  try {
    const args = parseMigrationCliArgs(process.argv.slice(2))
    const { createProductionMigrationRuntime } = await import('./migrationRuntime.js')
    const exitCode = await runMigrationCli(args, {
      loadConfig: loadMigrationCliConfig,
      createCoordinator: createProductionMigrationRuntime,
      output: value => process.stdout.write(`${safeJson(value)}\n`),
    })
    process.exitCode = exitCode
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = /Blocked|预检|冲突/.test(error instanceof Error ? `${error.name}:${error.message}` : String(error)) ? 2 : 1
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, item) => (
    /(?:secret|password|authorization|api[_-]?key)/i.test(key) && key !== 'jwtSecretFingerprint'
      ? '[REDACTED]'
      : item
  ), 2)
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  void main()
}
