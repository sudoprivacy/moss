import type { DatabaseSync } from 'node:sqlite'

export function ensureDifySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dify_provider_resources (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('dataset')),
      external_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (org_id, connection_id, resource_type, external_id)
    );
    CREATE INDEX IF NOT EXISTS dify_provider_resources_org_idx
      ON dify_provider_resources (org_id, resource_type, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dify_provider_operations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SUPPRESSED')),
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dify_provider_operations_status_idx
      ON dify_provider_operations (status, updated_at, id);
    CREATE INDEX IF NOT EXISTS dify_provider_operations_aggregate_idx
      ON dify_provider_operations (org_id, operation_type, aggregate_id);

    CREATE TABLE IF NOT EXISTS dify_migration_checkpoints (
      migration_run_id TEXT NOT NULL,
      source_checksum TEXT NOT NULL,
      phase TEXT NOT NULL,
      cursor TEXT,
      status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed')),
      detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (migration_run_id, phase)
    );
  `)
}
