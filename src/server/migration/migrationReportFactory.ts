import type { MigrationReport } from './migrationReportWriter.js'

type ReportMode = 'dry-run' | 'execute' | 'resume' | 'verify'

export function buildMigrationReport(input: {
  mode: ReportMode
  result: Record<string, unknown>
  createdAt: number
  suppressedEffects: MigrationReport['suppressedEffects']
}): MigrationReport {
  const phases = array(input.result.phases)
  const finalVerification = record(input.result.finalVerification)
  const checks = array(finalVerification?.checks)
  const issues = uniqueStrings([
    ...array(finalVerification?.issues),
    ...phases.flatMap(item => array(record(record(item)?.verification)?.issues)),
  ])
  return {
    schemaVersion: 1,
    kind: input.mode === 'verify' ? 'verification' : 'migration',
    runId: String(input.result.runId ?? ''),
    generatedAt: new Date(input.createdAt).toISOString(),
    sourceFingerprint: String(input.result.sourceFingerprint ?? ''),
    status: input.mode === 'verify'
      ? input.result.status === 'matched' ? 'matched' : 'mismatch'
      : input.result.status === 'blocked' ? 'blocked' : 'ready',
    summary: { checkCount: checks.length, phaseCount: phases.length },
    issues,
    suppressedEffects: input.suppressedEffects,
    productionGates: [
      { name: '代表性生产副本双次演练', status: 'pending' },
      { name: '真实 Redis/Nexus/PostgreSQL/TimescaleDB', status: 'pending' },
      { name: '正式客户端兼容矩阵', status: 'pending' },
      { name: 'Fuiou 回调与回滚演练', status: 'pending' },
    ],
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}
