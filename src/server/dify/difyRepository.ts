import type { DbDriver, SqlRow } from '../db/driver.js'

export type DifyOperationStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SUPPRESSED'

export interface DifyProviderResource {
  id: string
  orgId: string
  connectionId: string
  resourceType: 'dataset'
  externalId: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DifyProviderOperation {
  id: string
  orgId: string
  operationType: string
  aggregateId: string
  idempotencyKey: string
  status: DifyOperationStatus
  request: Record<string, unknown>
  result: Record<string, unknown> | null
  contextSource: 'online' | 'migration' | 'replay'
  errorMessage: string | null
  attempts: number
  createdAt: number
  updatedAt: number
}

export interface DifyMigrationCheckpoint {
  migrationRunId: string
  sourceChecksum: string
  phase: string
  cursor: string | null
  status: 'planned' | 'running' | 'completed' | 'failed'
  detail: Record<string, unknown>
  updatedAt: number
}

export class DifyRepositoryError extends Error {
  constructor(readonly code: 'SECRET_MATERIAL_FORBIDDEN' | 'OPERATION_NOT_FOUND', message: string) {
    super(message)
    this.name = 'DifyRepositoryError'
  }
}

export class DifyRepository {
  constructor(readonly driver: DbDriver) {}

  putResource(input: Omit<DifyProviderResource, 'createdAt' | 'updatedAt'> & {
    createdAt?: number
    updatedAt?: number
  }): Promise<DifyProviderResource> {
    return this.putResourceAsync(input)
  }

  private async putResourceAsync(input: Parameters<DifyRepository['putResource']>[0]): Promise<DifyProviderResource> {
    assertNoSecretMaterial(input.metadata)
    const timestamp = input.updatedAt ?? input.createdAt ?? Date.now()
    await this.driver.run(`
      INSERT INTO dify_provider_resources (
        id, org_id, connection_id, resource_type, external_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        org_id = excluded.org_id,
        connection_id = excluded.connection_id,
        resource_type = excluded.resource_type,
        external_id = excluded.external_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `, [
      input.id, input.orgId, input.connectionId, input.resourceType, input.externalId,
      JSON.stringify(input.metadata), input.createdAt ?? timestamp, timestamp,
    ])
    return (await this.getResource(input.id))!
  }

  async getResource(id: string): Promise<DifyProviderResource | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM dify_provider_resources WHERE id = ?', [id])
    return row ? mapResource(row) : null
  }

  getResourceByExternalId(
    orgId: string,
    connectionId: string,
    resourceType: 'dataset',
    externalId: string,
  ): Promise<DifyProviderResource | null> {
    return this.getResourceByExternalIdAsync(orgId, connectionId, resourceType, externalId)
  }

  private async getResourceByExternalIdAsync(
    orgId: string,
    connectionId: string,
    resourceType: 'dataset',
    externalId: string,
  ): Promise<DifyProviderResource | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM dify_provider_resources
      WHERE org_id = ? AND connection_id = ? AND resource_type = ? AND external_id = ?
    `, [orgId, connectionId, resourceType, externalId])
    return row ? mapResource(row) : null
  }

  async listResources(orgId: string, resourceType: 'dataset'): Promise<DifyProviderResource[]> {
    return (await this.driver.all<SqlRow>(`
      SELECT * FROM dify_provider_resources
      WHERE org_id = ? AND resource_type = ? ORDER BY updated_at DESC, id DESC
    `, [orgId, resourceType])).map(mapResource)
  }

  async deleteResource(orgId: string, resourceType: 'dataset', externalId: string): Promise<boolean> {
    return await this.driver.run(`
      DELETE FROM dify_provider_resources WHERE org_id = ? AND resource_type = ? AND external_id = ?
    `, [orgId, resourceType, externalId]) === 1
  }

  createOperation(input: {
    id: string
    orgId: string
    operationType: string
    aggregateId: string
    idempotencyKey: string
    status: DifyOperationStatus
    request: Record<string, unknown>
    contextSource: DifyProviderOperation['contextSource']
    createdAt?: number
  }): Promise<DifyProviderOperation> {
    return this.createOperationAsync(input)
  }

  private async createOperationAsync(input: Parameters<DifyRepository['createOperation']>[0]): Promise<DifyProviderOperation> {
    assertNoSecretMaterial(input.request)
    const existing = await this.getOperationByIdempotencyKey(input.idempotencyKey)
    if (existing) return existing
    const timestamp = input.createdAt ?? Date.now()
    await this.driver.run(`
      INSERT INTO dify_provider_operations (
        id, org_id, operation_type, aggregate_id, idempotency_key, status,
        request_json, result_json, context_source, error_message, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 0, ?, ?)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [
      input.id, input.orgId, input.operationType, input.aggregateId, input.idempotencyKey,
      input.status, JSON.stringify(input.request), input.contextSource, timestamp, timestamp,
    ])
    const operation = await this.getOperationByIdempotencyKey(input.idempotencyKey)
    if (!operation) throw new DifyRepositoryError('OPERATION_NOT_FOUND', 'Dify operation was not persisted')
    return operation
  }

  async getOperation(id: string): Promise<DifyProviderOperation | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM dify_provider_operations WHERE id = ?', [id])
    return row ? mapOperation(row) : null
  }

  async getOperationByIdempotencyKey(idempotencyKey: string): Promise<DifyProviderOperation | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM dify_provider_operations WHERE idempotency_key = ?', [idempotencyKey])
    return row ? mapOperation(row) : null
  }

  updateOperation(id: string, patch: {
    status?: DifyOperationStatus
    result?: Record<string, unknown> | null
    errorMessage?: string | null
    attempts?: number
  }): Promise<DifyProviderOperation> {
    return this.updateOperationAsync(id, patch)
  }

  async claimOperation(id: string): Promise<DifyProviderOperation | null> {
    const changed = await this.driver.run(`
      UPDATE dify_provider_operations
      SET status = 'PROCESSING', attempts = attempts + 1, error_message = NULL, updated_at = ?
      WHERE id = ? AND status IN ('PENDING', 'FAILED')
    `, [Date.now(), id])
    return changed === 1 ? this.getOperation(id) : null
  }

  private async updateOperationAsync(
    id: string,
    patch: Parameters<DifyRepository['updateOperation']>[1],
  ): Promise<DifyProviderOperation> {
    const current = await this.getOperation(id)
    if (!current) throw new DifyRepositoryError('OPERATION_NOT_FOUND', 'Dify operation not found')
    if (patch.result) assertNoSecretMaterial(patch.result)
    await this.driver.run(`
      UPDATE dify_provider_operations
      SET status = ?, result_json = ?, error_message = ?, attempts = ?, updated_at = ?
      WHERE id = ?
    `, [
      patch.status ?? current.status,
      patch.result === undefined ? (current.result ? JSON.stringify(current.result) : null) : (patch.result ? JSON.stringify(patch.result) : null),
      patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage,
      patch.attempts ?? current.attempts,
      Date.now(),
      id,
    ])
    return (await this.getOperation(id))!
  }

  putMigrationCheckpoint(input: {
    migrationRunId: string
    sourceChecksum: string
    phase: string
    cursor?: string | null
    status: DifyMigrationCheckpoint['status']
    detail?: Record<string, unknown>
    updatedAt?: number
  }): Promise<DifyMigrationCheckpoint> {
    return this.putMigrationCheckpointAsync(input)
  }

  private async putMigrationCheckpointAsync(
    input: Parameters<DifyRepository['putMigrationCheckpoint']>[0],
  ): Promise<DifyMigrationCheckpoint> {
    const detail = input.detail ?? {}
    assertNoSecretMaterial(detail)
    await this.driver.run(`
      INSERT INTO dify_migration_checkpoints (
        migration_run_id, source_checksum, phase, cursor, status, detail_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(migration_run_id, phase) DO UPDATE SET
        source_checksum = excluded.source_checksum,
        cursor = excluded.cursor,
        status = excluded.status,
        detail_json = excluded.detail_json,
        updated_at = excluded.updated_at
    `, [
      input.migrationRunId, input.sourceChecksum, input.phase, input.cursor ?? null,
      input.status, JSON.stringify(detail), input.updatedAt ?? Date.now(),
    ])
    return (await this.getMigrationCheckpoint(input.migrationRunId, input.phase))!
  }

  async getMigrationCheckpoint(migrationRunId: string, phase: string): Promise<DifyMigrationCheckpoint | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM dify_migration_checkpoints WHERE migration_run_id = ? AND phase = ?
    `, [migrationRunId, phase])
    return row ? {
      migrationRunId: String(row.migration_run_id),
      sourceChecksum: String(row.source_checksum),
      phase: String(row.phase),
      cursor: row.cursor == null ? null : String(row.cursor),
      status: String(row.status) as DifyMigrationCheckpoint['status'],
      detail: parseObject(row.detail_json),
      updatedAt: Number(row.updated_at),
    } : null
  }
}

function mapResource(row: SqlRow): DifyProviderResource {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    connectionId: String(row.connection_id),
    resourceType: String(row.resource_type) as 'dataset',
    externalId: String(row.external_id),
    metadata: parseObject(row.metadata_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapOperation(row: SqlRow): DifyProviderOperation {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    operationType: String(row.operation_type),
    aggregateId: String(row.aggregate_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as DifyOperationStatus,
    request: parseObject(row.request_json),
    result: row.result_json == null ? null : parseObject(row.result_json),
    contextSource: String(row.context_source) as DifyProviderOperation['contextSource'],
    errorMessage: row.error_message == null ? null : String(row.error_message),
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value)) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function assertNoSecretMaterial(value: unknown, path = 'root'): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    const reference = normalized.endsWith('ref') || normalized.endsWith('reference')
    if (!reference && (normalized.includes('apikey') || normalized.includes('password') || normalized.includes('secret') || normalized.includes('token'))) {
      throw new DifyRepositoryError('SECRET_MATERIAL_FORBIDDEN', `Secret material is forbidden at ${path}.${key}`)
    }
    assertNoSecretMaterial(nested, `${path}.${key}`)
  }
}
