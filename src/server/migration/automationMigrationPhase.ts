import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext } from '../application/commandContext.js'
import type {
  MigrationExecutionContext,
  MigrationPhase,
  MigrationPhaseIssue,
  MigrationPhasePlan,
  MigrationPhaseVerification,
  MigrationPlanningContext,
  MigrationVerificationContext,
} from './migrationPhaseRegistry.js'

const REQUIRED_LOCAL_EXCLUSIONS = ['sessions', 'client_cron', 'client_channels'] as const
const SERVER_AUTOMATION_TABLE = /(?:^|_)(?:cron|scheduled?|event_triggers?|channel_configs?|channels?)(?:_|$)/i

export interface AutomationTableEvidence {
  name: string
  rowCount: number
}

export interface SudoworkAutomationSourceSnapshot {
  checksum: string
  detectedTables: AutomationTableEvidence[]
}

export interface AutomationMigrationPlan extends MigrationPhasePlan {
  sourceChecksum: string
  detectedTables: AutomationTableEvidence[]
  excludedLocalData: string[]
}

export class SudoworkAutomationSourceReader {
  private readonly databasePath: string

  constructor(snapshotDirectory: string) {
    this.databasePath = resolve(snapshotDirectory, 'sudowork.sqlite')
  }

  readSnapshot(): SudoworkAutomationSourceSnapshot {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA query_only=ON')
      const names = (db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>)
        .map(row => String(row.name))
        .filter(name => SERVER_AUTOMATION_TABLE.test(name))
      const detectedTables = names.map(name => ({
        name,
        rowCount: Number((db!.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as { count: number }).count),
      }))
      return {
        checksum: sha256(JSON.stringify(detectedTables)),
        detectedTables,
      }
    } catch (error) {
      throw new Error(`无法只读扫描 Sudowork 自动化数据: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      db?.close()
    }
  }
}

export class AutomationMigrationPhase implements MigrationPhase {
  readonly name = 'automation' as const

  constructor(private readonly source: Pick<SudoworkAutomationSourceReader, 'readSnapshot'>) {}

  async plan(context: MigrationPlanningContext): Promise<AutomationMigrationPlan> {
    const source = this.source.readSnapshot()
    const exclusions = [...context.snapshot.excludedLocalData]
    const issues = automationIssues(source.detectedTables, exclusions)
    return {
      status: issues.length === 0 ? 'ready' : 'blocked',
      issues,
      sourceChecksum: source.checksum,
      detectedTables: source.detectedTables,
      excludedLocalData: exclusions,
    }
  }

  async execute(context: MigrationExecutionContext, plan: MigrationPhasePlan) {
    const automationPlan = requirePlan(plan)
    if (automationPlan.status !== 'ready') throw new Error('自动化迁移预检未通过，拒绝执行')
    const command = context.commandContext(`migration:phase:automation:${automationPlan.sourceChecksum}`)
    assertTrustedCommandContext(command)
    if (command.source !== 'migration' || command.externalEffects !== 'suppress_external') {
      throw new Error('自动化迁移必须使用副作用抑制的 migration context')
    }
    const current = this.source.readSnapshot()
    if (current.checksum !== automationPlan.sourceChecksum) {
      throw new Error('自动化迁移源扫描结果已变化，拒绝执行')
    }
    return {
      migrated: 0,
      detectedTables: current.detectedTables,
      excludedLocalData: [...automationPlan.excludedLocalData],
    }
  }

  async verify(context: MigrationVerificationContext): Promise<MigrationPhaseVerification> {
    const source = this.source.readSnapshot()
    const issues = automationIssues(source.detectedTables, [...context.snapshot.excludedLocalData])
      .map(issue => issue.message)
    return {
      status: issues.length === 0 ? 'matched' : 'mismatch',
      issues,
      migrated: 0,
      detectedTables: source.detectedTables,
    }
  }
}

function automationIssues(tables: AutomationTableEvidence[], exclusions: string[]): MigrationPhaseIssue[] {
  const issues: MigrationPhaseIssue[] = []
  const missing = REQUIRED_LOCAL_EXCLUSIONS.filter(name => !exclusions.includes(name))
  if (missing.length > 0) {
    issues.push({
      code: 'LOCAL_AUTOMATION_EXCLUSION_MISSING',
      resourceType: 'source_snapshot',
      message: `本地数据排除声明缺失: ${missing.join(', ')}`,
      detail: { missing },
    })
  }
  for (const table of tables.filter(item => item.rowCount > 0)) {
    issues.push({
      code: 'UNSUPPORTED_SERVER_AUTOMATION_DATA',
      resourceType: 'sqlite_table',
      resourceId: table.name,
      message: `发现未纳入迁移规则的旧服务端自动化数据表 ${table.name} (${table.rowCount} 行)`,
      detail: { rowCount: table.rowCount },
    })
  }
  return issues
}

function requirePlan(plan: MigrationPhasePlan): AutomationMigrationPlan {
  if (typeof plan.sourceChecksum !== 'string' || !Array.isArray(plan.detectedTables)) {
    throw new Error('自动化迁移阶段缺少预检结果')
  }
  return plan as AutomationMigrationPlan
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
