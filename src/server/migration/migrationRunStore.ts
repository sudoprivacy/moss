import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

export const MIGRATION_PHASES = [
  'organizations',
  'identities',
  'governance',
  'catalog',
  'configuration',
  'dify',
  'billing',
  'automation',
  'qms',
  'access',
] as const

export type MigrationPhaseName = typeof MIGRATION_PHASES[number]
export type MigrationRunStatus = 'planned' | 'running' | 'blocked' | 'failed' | 'verified'
export type MigrationPhaseStatus = 'pending' | 'running' | 'complete' | 'failed'
export type MigrationIssueSeverity = 'warning' | 'blocker'
export type MigrationReportKind = 'migration' | 'verification'

export interface MigrationRun {
  id: string
  sourceFingerprint: string
  sourceMetadataJson: string
  status: MigrationRunStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface MigrationPhaseCheckpoint {
  runId: string
  phase: MigrationPhaseName
  ordinal: number
  status: MigrationPhaseStatus
  result: Record<string, unknown> | null
  error: MigrationIssue | null
  startedAt: number | null
  completedAt: number | null
}

export interface StableMigrationMapping {
  runId: string
  namespace: string
  sourceId: string
  targetId: string
  metadata: Record<string, unknown>
}

export interface MigrationIssue {
  phase: MigrationPhaseName
  code: string
  severity: MigrationIssueSeverity
  resourceType: string
  resourceId: string
  message: string
  detail: Record<string, unknown>
}

export interface SuppressedMigrationEffect {
  runId: string
  effectType: string
  resourceType: string
  resourceId: string
  idempotencyKey: string
  reason: string
}

export interface MigrationStoredReport {
  runId: string
  kind: MigrationReportKind
  sha256: string
  json: string
  markdown: string
  createdAt: number
}

export type MigrationRunStoreErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_RESUMABLE'
  | 'SOURCE_FINGERPRINT_MISMATCH'
  | 'PHASE_ORDER_VIOLATION'
  | 'PHASE_ALREADY_COMPLETE'
  | 'PHASE_NOT_RUNNING'
  | 'RUN_NOT_VERIFIABLE'
  | 'MAPPING_CONFLICT'
  | 'SUPPRESSED_EFFECT_CONFLICT'
  | 'REPORT_IMMUTABLE'

export class MigrationRunStoreError extends Error {
  constructor(readonly code: MigrationRunStoreErrorCode, message: string) {
    super(message)
    this.name = 'MigrationRunStoreError'
  }
}

type SqlRow = Record<string, unknown>

export class MigrationRunStore {
  private readonly clock: () => number
  private readonly idFactory: () => string

  constructor(private readonly db: DatabaseSync, options: {
    clock?: () => number
    idFactory?: () => string
  } = {}) {
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.ensureSchema()
  }

  createRun(input: { sourceFingerprint: string; sourceMetadata: object }): MigrationRun {
    const id = this.idFactory()
    const createdAt = this.clock()
    this.db.prepare(`
      INSERT INTO migration_runs (
        id, source_fingerprint, source_metadata_json, status, created_at
      ) VALUES (?, ?, ?, 'planned', ?)
    `).run(id, required(input.sourceFingerprint, 'source fingerprint'), stableJson(input.sourceMetadata), createdAt)
    return this.getRun(id)!
  }

  getRun(runId: string): MigrationRun | null {
    const row = this.db.prepare('SELECT * FROM migration_runs WHERE id = ?').get(runId) as SqlRow | undefined
    return row ? mapRun(row) : null
  }

  requireResumableRun(runId: string, sourceFingerprint: string): MigrationRun {
    const run = this.getRun(runId)
    if (!run) throw new MigrationRunStoreError('RUN_NOT_FOUND', `迁移批次不存在: ${runId}`)
    if (run.sourceFingerprint !== sourceFingerprint) {
      throw new MigrationRunStoreError('SOURCE_FINGERPRINT_MISMATCH', '迁移源指纹与原批次不一致')
    }
    if (run.status !== 'running' && run.status !== 'failed') {
      throw new MigrationRunStoreError('RUN_NOT_RESUMABLE', `迁移批次状态不可恢复: ${run.status}`)
    }
    return run
  }

  beginPhase(runId: string, phase: MigrationPhaseName): MigrationPhaseCheckpoint {
    return runInTransaction(this.db, () => {
      this.requireRun(runId)
      const ordinal = phaseOrdinal(phase)
      const incompletePrior = this.db.prepare(`
        SELECT phase FROM migration_phase_checkpoints
        WHERE run_id = ? AND ordinal < ? AND status <> 'complete'
        ORDER BY ordinal LIMIT 1
      `).get(runId, ordinal) as { phase: string } | undefined
      const missingPrior = ordinal > 0 && Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM migration_phase_checkpoints
        WHERE run_id = ? AND ordinal < ? AND status = 'complete'
      `).get(runId, ordinal) as { count: number }).count) !== ordinal
      if (incompletePrior || missingPrior) {
        throw new MigrationRunStoreError('PHASE_ORDER_VIOLATION', `迁移阶段必须按顺序执行: ${phase}`)
      }

      const existing = this.getPhase(runId, phase)
      if (existing?.status === 'complete') {
        throw new MigrationRunStoreError('PHASE_ALREADY_COMPLETE', `迁移阶段已经完成: ${phase}`)
      }
      if (existing?.status === 'running') return existing

      const startedAt = this.clock()
      this.db.prepare(`
        INSERT INTO migration_phase_checkpoints (
          run_id, phase, ordinal, status, result_json, error_json, started_at, completed_at
        ) VALUES (?, ?, ?, 'running', NULL, NULL, ?, NULL)
        ON CONFLICT(run_id, phase) DO UPDATE SET
          status = 'running', result_json = NULL, error_json = NULL,
          started_at = excluded.started_at, completed_at = NULL
      `).run(runId, phase, ordinal, startedAt)
      this.db.prepare(`
        UPDATE migration_runs SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL
        WHERE id = ?
      `).run(startedAt, runId)
      return this.getPhase(runId, phase)!
    })
  }

  completePhase(runId: string, phase: MigrationPhaseName, result: Record<string, unknown>): void {
    runInTransaction(this.db, () => {
      const checkpoint = this.getPhase(runId, phase)
      if (!checkpoint || checkpoint.status !== 'running') {
        throw new MigrationRunStoreError('PHASE_NOT_RUNNING', `迁移阶段尚未运行: ${phase}`)
      }
      this.db.prepare(`
        UPDATE migration_phase_checkpoints
        SET status = 'complete', result_json = ?, error_json = NULL, completed_at = ?
        WHERE run_id = ? AND phase = ?
      `).run(stableJson(result), this.clock(), runId, phase)
    })
  }

  failPhase(runId: string, phase: MigrationPhaseName, error: MigrationIssue): void {
    runInTransaction(this.db, () => {
      const checkpoint = this.getPhase(runId, phase)
      if (!checkpoint || checkpoint.status !== 'running') {
        throw new MigrationRunStoreError('PHASE_NOT_RUNNING', `迁移阶段尚未运行: ${phase}`)
      }
      const failedAt = this.clock()
      this.db.prepare(`
        UPDATE migration_phase_checkpoints
        SET status = 'failed', error_json = ?, completed_at = ?
        WHERE run_id = ? AND phase = ?
      `).run(stableJson(error), failedAt, runId, phase)
      this.db.prepare("UPDATE migration_runs SET status = 'failed', finished_at = ? WHERE id = ?").run(failedAt, runId)
      this.insertIssue(runId, error, failedAt)
    })
  }

  getPhase(runId: string, phase: MigrationPhaseName): MigrationPhaseCheckpoint | null {
    const row = this.db.prepare(`
      SELECT * FROM migration_phase_checkpoints WHERE run_id = ? AND phase = ?
    `).get(runId, phase) as SqlRow | undefined
    return row ? mapPhase(row) : null
  }

  listPhases(runId: string): MigrationPhaseCheckpoint[] {
    return (this.db.prepare(`
      SELECT * FROM migration_phase_checkpoints WHERE run_id = ? ORDER BY ordinal
    `).all(runId) as SqlRow[]).map(mapPhase)
  }

  markVerified(runId: string): void {
    runInTransaction(this.db, () => {
      this.requireRun(runId)
      const completed = Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM migration_phase_checkpoints
        WHERE run_id = ? AND status = 'complete'
      `).get(runId) as { count: number }).count)
      if (completed !== MIGRATION_PHASES.length) {
        throw new MigrationRunStoreError('RUN_NOT_VERIFIABLE', '全部迁移阶段完成后才能标记校验通过')
      }
      this.db.prepare("UPDATE migration_runs SET status = 'verified', finished_at = ? WHERE id = ?")
        .run(this.clock(), runId)
    })
  }

  putMapping(input: StableMigrationMapping): void {
    runInTransaction(this.db, () => {
      this.requireRun(input.runId)
      const existing = this.db.prepare(`
        SELECT * FROM migration_mappings
        WHERE run_id = ? AND namespace = ? AND (source_id = ? OR target_id = ?)
        LIMIT 1
      `).get(input.runId, input.namespace, input.sourceId, input.targetId) as SqlRow | undefined
      const metadataJson = stableJson(input.metadata)
      if (existing) {
        const identical = String(existing.source_id) === input.sourceId
          && String(existing.target_id) === input.targetId
          && String(existing.metadata_json) === metadataJson
        if (identical) return
        throw new MigrationRunStoreError('MAPPING_CONFLICT', `迁移映射冲突: ${input.namespace}:${input.sourceId}`)
      }
      this.db.prepare(`
        INSERT INTO migration_mappings (
          run_id, namespace, source_id, target_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.runId, input.namespace, input.sourceId, input.targetId, metadataJson, this.clock())
    })
  }

  listMappings(runId: string): StableMigrationMapping[] {
    return (this.db.prepare(`
      SELECT run_id, namespace, source_id, target_id, metadata_json
      FROM migration_mappings WHERE run_id = ? ORDER BY namespace, source_id
    `).all(runId) as SqlRow[]).map(row => ({
      runId: String(row.run_id),
      namespace: String(row.namespace),
      sourceId: String(row.source_id),
      targetId: String(row.target_id),
      metadata: parseObject(row.metadata_json),
    }))
  }

  recordIssue(runId: string, issue: MigrationIssue): void {
    this.requireRun(runId)
    this.insertIssue(runId, issue, this.clock())
  }

  listIssues(runId: string): MigrationIssue[] {
    return (this.db.prepare(`
      SELECT phase, code, severity, resource_type, resource_id, message, detail_json
      FROM migration_issues WHERE run_id = ? ORDER BY id
    `).all(runId) as SqlRow[]).map(row => ({
      phase: String(row.phase) as MigrationPhaseName,
      code: String(row.code),
      severity: String(row.severity) as MigrationIssueSeverity,
      resourceType: String(row.resource_type),
      resourceId: String(row.resource_id),
      message: String(row.message),
      detail: parseObject(row.detail_json),
    }))
  }

  recordSuppressedEffect(runId: string, effect: SuppressedMigrationEffect): void {
    if (runId !== effect.runId) {
      throw new MigrationRunStoreError('SUPPRESSED_EFFECT_CONFLICT', '副作用记录的迁移批次不一致')
    }
    runInTransaction(this.db, () => {
      this.requireRun(runId)
      const existing = this.db.prepare(`
        SELECT * FROM migration_suppressed_effects WHERE run_id = ? AND idempotency_key = ?
      `).get(runId, effect.idempotencyKey) as SqlRow | undefined
      if (existing) {
        const current = mapSuppressedEffect(existing)
        if (stableJson(current) === stableJson(effect)) return
        throw new MigrationRunStoreError('SUPPRESSED_EFFECT_CONFLICT', `副作用幂等键冲突: ${effect.idempotencyKey}`)
      }
      this.db.prepare(`
        INSERT INTO migration_suppressed_effects (
          run_id, effect_type, resource_type, resource_id, idempotency_key, reason, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'suppressed', ?)
      `).run(
        runId, effect.effectType, effect.resourceType, effect.resourceId,
        effect.idempotencyKey, effect.reason, this.clock(),
      )
    })
  }

  listSuppressedEffects(runId: string): SuppressedMigrationEffect[] {
    return (this.db.prepare(`
      SELECT * FROM migration_suppressed_effects WHERE run_id = ? ORDER BY idempotency_key
    `).all(runId) as SqlRow[]).map(mapSuppressedEffect)
  }

  countDeliverableMigrationEffects(runId: string): number {
    return Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM migration_suppressed_effects
      WHERE run_id = ? AND status <> 'suppressed'
    `).get(runId) as { count: number }).count)
  }

  saveReport(
    runId: string,
    kind: MigrationReportKind,
    sha256: string,
    json: string,
    markdown: string,
  ): void {
    runInTransaction(this.db, () => {
      this.requireRun(runId)
      const existing = this.getReport(runId, kind)
      if (existing) {
        if (existing.sha256 === sha256 && existing.json === json && existing.markdown === markdown) return
        throw new MigrationRunStoreError('REPORT_IMMUTABLE', `迁移报告不可覆盖: ${kind}`)
      }
      this.db.prepare(`
        INSERT INTO migration_reports (run_id, kind, sha256, report_json, report_markdown, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, kind, sha256, json, markdown, this.clock())
    })
  }

  getReport(runId: string, kind: MigrationReportKind): MigrationStoredReport | null {
    const row = this.db.prepare(`
      SELECT * FROM migration_reports WHERE run_id = ? AND kind = ?
    `).get(runId, kind) as SqlRow | undefined
    return row ? {
      runId: String(row.run_id),
      kind: String(row.kind) as MigrationReportKind,
      sha256: String(row.sha256),
      json: String(row.report_json),
      markdown: String(row.report_markdown),
      createdAt: Number(row.created_at),
    } : null
  }

  private requireRun(runId: string): MigrationRun {
    const run = this.getRun(runId)
    if (!run) throw new MigrationRunStoreError('RUN_NOT_FOUND', `迁移批次不存在: ${runId}`)
    return run
  }

  private insertIssue(runId: string, issue: MigrationIssue, createdAt: number): void {
    this.db.prepare(`
      INSERT INTO migration_issues (
        run_id, phase, code, severity, resource_type, resource_id, message, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId, issue.phase, issue.code, issue.severity, issue.resourceType,
      issue.resourceId, issue.message, stableJson(issue.detail), createdAt,
    )
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_runs (
        id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_metadata_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'blocked', 'failed', 'verified')),
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS migration_phase_checkpoints (
        run_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE RESTRICT,
        phase TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
        result_json TEXT,
        error_json TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        PRIMARY KEY (run_id, phase),
        UNIQUE (run_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS migration_mappings (
        run_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, namespace, source_id),
        UNIQUE (run_id, namespace, target_id)
      );

      CREATE TABLE IF NOT EXISTS migration_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE RESTRICT,
        phase TEXT NOT NULL,
        code TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'blocker')),
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        message TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS migration_suppressed_effects (
        run_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE RESTRICT,
        effect_type TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'suppressed'),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS migration_reports (
        run_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('migration', 'verification')),
        sha256 TEXT NOT NULL,
        report_json TEXT NOT NULL,
        report_markdown TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, kind)
      );
    `)
  }
}

function phaseOrdinal(phase: MigrationPhaseName): number {
  const ordinal = MIGRATION_PHASES.indexOf(phase)
  if (ordinal < 0) throw new MigrationRunStoreError('PHASE_ORDER_VIOLATION', `未知迁移阶段: ${phase}`)
  return ordinal
}

function required(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
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

function parseObject(value: unknown): Record<string, unknown> {
  return JSON.parse(String(value)) as Record<string, unknown>
}

function mapRun(row: SqlRow): MigrationRun {
  return {
    id: String(row.id),
    sourceFingerprint: String(row.source_fingerprint),
    sourceMetadataJson: String(row.source_metadata_json),
    status: String(row.status) as MigrationRunStatus,
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  }
}

function mapPhase(row: SqlRow): MigrationPhaseCheckpoint {
  return {
    runId: String(row.run_id),
    phase: String(row.phase) as MigrationPhaseName,
    ordinal: Number(row.ordinal),
    status: String(row.status) as MigrationPhaseStatus,
    result: row.result_json == null ? null : parseObject(row.result_json),
    error: row.error_json == null ? null : JSON.parse(String(row.error_json)) as MigrationIssue,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  }
}

function mapSuppressedEffect(row: SqlRow): SuppressedMigrationEffect {
  return {
    runId: String(row.run_id),
    effectType: String(row.effect_type),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    idempotencyKey: String(row.idempotency_key),
    reason: String(row.reason),
  }
}
