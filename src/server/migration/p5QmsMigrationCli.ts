import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import postgres, { type Sql } from 'postgres'

import { migrationCommandContext } from '../application/commandContext.js'
import { QmsPostgresStore } from '../qms/postgresStore.js'
import type { QmsAggregateMode, QmsSqlPort } from '../qms/qmsSchema.js'
import { P5QmsMigrationBlockedError, P5QmsMigrationService, PostgresP5QmsMigrationTarget } from './p5QmsMigrationService.js'
import { SudoworkP5QmsSourceReader } from './sudoworkP5QmsSourceReader.js'

export interface P5QmsMigrationCliOptions {
  mode: 'plan' | 'execute' | 'verify'
  sourceUrl: string
  targetUrl: string
  mossDbPath: string
  aggregateMode: QmsAggregateMode
  batchSize: number
  runId?: string
  confirmedChecksum?: string
}

export function parseP5QmsMigrationArgs(argv: readonly string[]): P5QmsMigrationCliOptions {
  const values = new Map<string, string>()
  const allowed = new Set([
    '--mode', '--source-url', '--target-url', '--moss-db', '--aggregate-mode', '--batch-size',
    '--run-id', '--confirm-source-checksum',
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!
    if (!allowed.has(key)) throw new Error(`未知参数: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`)
    if (values.has(key)) throw new Error(`参数重复: ${key}`)
    values.set(key, value)
  }
  const mode = values.get('--mode')
  if (mode !== 'plan' && mode !== 'execute' && mode !== 'verify') throw new Error('--mode 必须是 plan、execute 或 verify')
  const sourceUrl = required(values, '--source-url')
  const targetUrl = required(values, '--target-url')
  const mossDbPath = required(values, '--moss-db')
  if (sourceUrl === targetUrl) throw new Error('源库与目标库不能相同')
  const aggregateMode = values.get('--aggregate-mode') ?? 'auto'
  if (aggregateMode !== 'auto' && aggregateMode !== 'regular' && aggregateMode !== 'continuous') {
    throw new Error('--aggregate-mode 必须是 auto、regular 或 continuous')
  }
  const batchSize = Number(values.get('--batch-size') ?? 500)
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error('--batch-size 必须是 1 到 10000 的整数')
  }
  const runId = values.get('--run-id')
  const confirmedChecksum = values.get('--confirm-source-checksum')
  if (mode === 'execute' && !confirmedChecksum) throw new Error('execute 必须提供 --confirm-source-checksum')
  if (mode === 'execute' && !runId) throw new Error('execute 必须提供 --run-id')
  return {
    mode,
    sourceUrl,
    targetUrl,
    mossDbPath,
    aggregateMode,
    batchSize,
    runId,
    confirmedChecksum,
  }
}

export async function runP5QmsMigrationCli(
  options: P5QmsMigrationCliOptions,
  output: (value: unknown) => void = value => console.log(JSON.stringify(value, null, 2)),
): Promise<number> {
  const sourceSql = postgres(options.sourceUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: true })
  const source = new ReadonlyPostgresPort(sourceSql)
  const targetStore = new QmsPostgresStore(options.targetUrl, undefined, { aggregateMode: options.aggregateMode })
  const mossDb = new DatabaseSync(resolve(options.mossDbPath), { readOnly: true })
  mossDb.exec('PRAGMA query_only=ON')
  try {
    await source.initialize()
    await assertDifferentDatabases(source, options.targetUrl)
    const targetState = await targetStore.start()
    const organizations = {
      hasCode: (code: string) => Boolean(mossDb.prepare(
        'SELECT 1 FROM organization_profiles WHERE code = ? LIMIT 1',
      ).get(code)),
    }
    const service = new P5QmsMigrationService({
      source: new SudoworkP5QmsSourceReader(source),
      target: new PostgresP5QmsMigrationTarget(targetStore, targetState),
      organizations,
      batchSize: options.batchSize,
    })
    const plan = await service.plan()
    if (options.mode === 'plan') {
      output(plan)
      return plan.status === 'ready' ? 0 : 2
    }
    if (plan.status === 'blocked') {
      output(plan)
      return 2
    }
    if (options.mode === 'verify') {
      const verification = await service.verify(plan)
      output({ sourceChecksum: plan.sourceChecksum, ...verification })
      return verification.status === 'matched' ? 0 : 3
    }
    if (options.confirmedChecksum !== plan.sourceChecksum) {
      throw new Error(`确认摘要不匹配；本次源快照摘要为 ${plan.sourceChecksum}`)
    }
    const report = await service.execute(
      plan,
      migrationCommandContext(options.runId!, `p5-qms:${options.runId}:${plan.sourceChecksum}`),
    )
    output(report)
    return report.status === 'matched' ? 0 : 3
  } catch (error) {
    if (error instanceof P5QmsMigrationBlockedError) {
      output(error.plan)
      return 2
    }
    throw error
  } finally {
    mossDb.close()
    await targetStore.stop()
    await source.close()
  }
}

async function assertDifferentDatabases(source: QmsSqlPort, targetUrl: string): Promise<void> {
  const targetSql = postgres(targetUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: true })
  try {
    const [sourceIdentity, targetIdentity] = await Promise.all([
      databaseIdentity(source),
      databaseIdentity({
        execute: async (query, parameters = []) =>
          await targetSql.unsafe(query, [...parameters] as never[]) as unknown as readonly Record<string, unknown>[],
      }),
    ])
    if (sourceIdentity === targetIdentity) {
      throw new Error('源库与目标库实际指向同一个 PostgreSQL 数据库')
    }
  } finally {
    await targetSql.end({ timeout: 5 })
  }
}

async function databaseIdentity(db: QmsSqlPort): Promise<string> {
  const rows = await db.execute(
    `SELECT current_database() AS database_name,
      inet_server_addr()::TEXT AS server_address,
      inet_server_port() AS server_port,
      pg_postmaster_start_time() AS server_started_at`,
  )
  if (!rows[0]) throw new Error('无法识别 PostgreSQL 数据库实例')
  return JSON.stringify(rows[0])
}

class ReadonlyPostgresPort implements QmsSqlPort {
  constructor(private readonly sql: Sql) {}

  async initialize(): Promise<void> {
    await this.sql.unsafe('SET default_transaction_read_only = on')
    await this.sql.unsafe('SELECT 1 AS healthy')
  }

  async execute(query: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    if (!/^\s*SELECT\b/i.test(query)) throw new Error('Sudowork QMS 源连接只允许 SELECT')
    return await this.sql.unsafe(query, [...parameters] as never[]) as unknown as readonly Record<string, unknown>[]
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim()
  if (!value) throw new Error(`缺少必填参数 ${key}`)
  return value
}
