import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MigrationRunStoreError, type MigrationReportKind, type MigrationRunStore } from './migrationRunStore.js'

export interface MigrationReport {
  schemaVersion: 1
  kind: MigrationReportKind
  runId: string
  generatedAt: string
  sourceFingerprint: string
  status: 'ready' | 'blocked' | 'matched' | 'mismatch' | 'failed'
  summary: Record<string, number | string | boolean | null>
  issues: string[]
  suppressedEffects: {
    count: number
    deliverableCount: number
    items: Array<{
      effectType: string
      resourceType: string
      resourceId: string
      idempotencyKey: string
      reason: string
    }>
  }
  productionGates: Array<{ name: string; status: 'passed' | 'pending' | 'failed' }>
}

export class MigrationReportWriter {
  constructor(private readonly runs: MigrationRunStore) {}

  async write(report: MigrationReport, outputDirectory: string): Promise<{
    jsonPath: string
    markdownPath: string
    sha256: string
  }> {
    const json = `${stableJson(report)}\n`
    const markdown = renderChineseMarkdown(report)
    const sha256 = createHash('sha256').update(json).update('\0').update(markdown).digest('hex')
    const existing = this.runs.getReport(report.runId, report.kind)
    if (existing && (existing.sha256 !== sha256 || existing.json !== json || existing.markdown !== markdown)) {
      throw new MigrationRunStoreError('REPORT_IMMUTABLE', `迁移报告不可覆盖: ${report.kind}`)
    }

    const directory = resolve(outputDirectory)
    await mkdir(directory, { recursive: true })
    const prefix = `${safeName(report.runId)}-${report.kind}-${sha256}`
    const jsonPath = join(directory, `${prefix}.json`)
    const markdownPath = join(directory, `${prefix}.md`)
    await writeImmutable(jsonPath, json)
    await writeImmutable(markdownPath, markdown)
    this.runs.saveReport(report.runId, report.kind, sha256, json, markdown)
    return { jsonPath, markdownPath, sha256 }
  }
}

function renderChineseMarkdown(report: MigrationReport): string {
  const summary = Object.entries(report.summary)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `| ${key} | ${String(value)} |`)
  const issues = report.issues.length > 0 ? report.issues.map(item => `- ${item}`) : ['- 无']
  const gates = report.productionGates.map(gate => `| ${gate.name} | ${gate.status} |`)
  const effects = report.suppressedEffects.items.length > 0
    ? report.suppressedEffects.items.map(effect => (
        `| ${effect.effectType} | ${effect.resourceType} | ${effect.resourceId} | ${effect.idempotencyKey} | ${effect.reason} |`
      ))
    : ['| 无 | - | - | - | - |']
  return [
    '# Sudowork 到 Moss 迁移报告',
    '',
    `- 批次：${report.runId}`,
    `- 类型：${report.kind}`,
    `- 生成时间：${report.generatedAt}`,
    `- 源指纹：${report.sourceFingerprint}`,
    `- 结果：${report.status}`,
    `- 已抑制外部副作用：${report.suppressedEffects.count}`,
    `- 可投递迁移副作用：${report.suppressedEffects.deliverableCount}`,
    '',
    '## 已抑制外部副作用',
    '',
    '| 类型 | 资源类型 | 资源 ID | 幂等键 | 原因 |',
    '| --- | --- | --- | --- | --- |',
    ...effects,
    '',
    '## 汇总',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    ...summary,
    '',
    '## 问题',
    '',
    ...issues,
    '',
    '## 生产门禁',
    '',
    '| 门禁 | 状态 |',
    '| --- | --- |',
    ...gates,
    '',
  ].join('\n')
}

async function writeImmutable(path: string, content: string): Promise<void> {
  try {
    const existing = await readFile(path, 'utf8')
    if (existing !== content) throw new MigrationRunStoreError('REPORT_IMMUTABLE', `报告文件不可覆盖: ${path}`)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function safeName(value: string): string {
  const normalized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
  if (!normalized) throw new Error('报告批次 ID 非法')
  return normalized
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}
