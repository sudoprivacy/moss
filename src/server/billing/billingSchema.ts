import type { DatabaseSync } from 'node:sqlite'

export function ensureBillingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_ledger_entries (
      id TEXT PRIMARY KEY,
      legacy_id INTEGER UNIQUE,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('organization', 'user')),
      owner_id TEXT NOT NULL,
      delta_units INTEGER NOT NULL CHECK (typeof(delta_units) = 'integer'),
      balance_before_units INTEGER NOT NULL CHECK (typeof(balance_before_units) = 'integer'),
      balance_after_units INTEGER NOT NULL CHECK (typeof(balance_after_units) = 'integer'),
      entry_type TEXT NOT NULL,
      memo TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
      actor_user_id TEXT,
      created_at INTEGER NOT NULL,
      CHECK (balance_after_units = balance_before_units + delta_units)
    );
    CREATE INDEX IF NOT EXISTS billing_ledger_owner_idx
      ON billing_ledger_entries (owner_type, owner_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS billing_ledger_source_idx
      ON billing_ledger_entries (source_type, source_id, entry_type);
    CREATE TABLE IF NOT EXISTS billing_usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      model TEXT,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cost_units INTEGER NOT NULL CHECK (typeof(cost_units) = 'integer' AND cost_units >= 0),
      balance_after_units INTEGER NOT NULL CHECK (typeof(balance_after_units) = 'integer'),
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_usage_user_time_idx
      ON billing_usage_records (user_id, created_at DESC, id DESC);

    CREATE TRIGGER IF NOT EXISTS billing_ledger_entries_no_update
    BEFORE UPDATE ON billing_ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'billing ledger entries are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS billing_ledger_entries_no_delete
    BEFORE DELETE ON billing_ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'billing ledger entries are append-only');
    END;

    CREATE TABLE IF NOT EXISTS billing_packages (
      id TEXT PRIMARY KEY,
      amount_usd_micros INTEGER NOT NULL CHECK (typeof(amount_usd_micros) = 'integer' AND amount_usd_micros > 0),
      points_units INTEGER NOT NULL CHECK (typeof(points_units) = 'integer' AND points_units > 0),
      bonus_units INTEGER NOT NULL DEFAULT 0 CHECK (typeof(bonus_units) = 'integer' AND bonus_units >= 0),
      description TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS billing_orders (
      id TEXT PRIMARY KEY,
      legacy_id INTEGER UNIQUE,
      order_no TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      user_phone TEXT,
      amount_usd_micros INTEGER NOT NULL CHECK (typeof(amount_usd_micros) = 'integer' AND amount_usd_micros > 0),
      amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
      exchange_rate_micros INTEGER NOT NULL CHECK (typeof(exchange_rate_micros) = 'integer' AND exchange_rate_micros > 0),
      quota_units INTEGER NOT NULL CHECK (typeof(quota_units) = 'integer' AND quota_units >= 0),
      points_units INTEGER NOT NULL CHECK (typeof(points_units) = 'integer' AND points_units > 0),
      bonus_units INTEGER NOT NULL DEFAULT 0 CHECK (typeof(bonus_units) = 'integer' AND bonus_units >= 0),
      payment_method TEXT NOT NULL CHECK (payment_method IN ('ALIPAY', 'WECHAT')),
      order_date TEXT NOT NULL,
      provider_order_info TEXT,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAYING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIAL_REFUNDED')),
      callback_payload_json TEXT,
      callback_time INTEGER,
      callback_amount_cents INTEGER CHECK (callback_amount_cents IS NULL OR typeof(callback_amount_cents) = 'integer'),
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expired_at INTEGER NOT NULL,
      remark TEXT
    );
    CREATE INDEX IF NOT EXISTS billing_orders_user_idx ON billing_orders (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS billing_orders_org_status_idx ON billing_orders (org_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_payment_attempts (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES billing_orders(id),
      provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SUPPRESSED')),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_json TEXT,
      response_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS billing_payment_attempts_order_idx
      ON billing_payment_attempts (order_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_provider_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SUPPRESSED')),
      error_text TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      UNIQUE (provider, provider_event_id)
    );

    CREATE TABLE IF NOT EXISTS billing_external_accounts (
      provider TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('organization', 'user')),
      owner_id TEXT NOT NULL,
      external_account_id TEXT NOT NULL,
      quota_units INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quota_units) = 'integer'),
      used_quota_units INTEGER NOT NULL DEFAULT 0 CHECK (typeof(used_quota_units) = 'integer'),
      token_secret_ref TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, owner_type, owner_id),
      UNIQUE (provider, external_account_id)
    );

    CREATE TABLE IF NOT EXISTS billing_sudorouter_provisioning (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      initial_quota_units INTEGER NOT NULL CHECK (typeof(initial_quota_units) = 'integer' AND initial_quota_units >= 0),
      external_account_id TEXT,
      quota_units INTEGER CHECK (quota_units IS NULL OR typeof(quota_units) = 'integer'),
      used_quota_units INTEGER CHECK (used_quota_units IS NULL OR typeof(used_quota_units) = 'integer'),
      token_secret_ref TEXT,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCOUNT_READY', 'QUOTA_READY', 'TOKEN_READY', 'COMPLETED', 'FAILED', 'UNKNOWN', 'SUPPRESSED')),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (owner_id)
    );
    CREATE INDEX IF NOT EXISTS billing_sudorouter_provisioning_status_idx
      ON billing_sudorouter_provisioning (status, updated_at);

    CREATE TABLE IF NOT EXISTS billing_quota_operations (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('organization', 'user')),
      owner_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      delta_units INTEGER NOT NULL CHECK (typeof(delta_units) = 'integer'),
      observed_quota_units INTEGER CHECK (observed_quota_units IS NULL OR typeof(observed_quota_units) = 'integer'),
      observed_used_units INTEGER CHECK (observed_used_units IS NULL OR typeof(observed_used_units) = 'integer'),
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SUPPRESSED')),
      idempotency_key TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      org_id TEXT,
      actor_user_id TEXT,
      reason TEXT,
      request_fingerprint TEXT NOT NULL,
      context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
      provider_response_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS billing_quota_owner_idx
      ON billing_quota_operations (owner_type, owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_credit_applications (
      id TEXT PRIMARY KEY,
      legacy_id INTEGER UNIQUE,
      application_no TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      requested_units INTEGER NOT NULL CHECK (typeof(requested_units) = 'integer' AND requested_units > 0),
      approved_units INTEGER CHECK (approved_units IS NULL OR (typeof(approved_units) = 'integer' AND approved_units > 0)),
      quota_units INTEGER CHECK (quota_units IS NULL OR typeof(quota_units) = 'integer'),
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'SYNC_FAILED', 'SYNC_UNKNOWN')),
      admin_user_id TEXT REFERENCES users(id),
      admin_comment TEXT,
      quota_operation_id TEXT REFERENCES billing_quota_operations(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_credit_org_status_idx
      ON billing_credit_applications (org_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS billing_credit_user_idx
      ON billing_credit_applications (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_activity_records (
      id TEXT PRIMARY KEY,
      legacy_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL CHECK (activity_type IN ('CLIENT', 'ADMIN')),
      user_id TEXT NOT NULL REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      order_id TEXT REFERENCES billing_orders(id),
      actor_user_id TEXT REFERENCES users(id),
      application_id TEXT REFERENCES billing_credit_applications(id),
      points_units INTEGER NOT NULL CHECK (typeof(points_units) = 'integer'),
      quota_units INTEGER NOT NULL CHECK (typeof(quota_units) = 'integer'),
      amount_cents INTEGER CHECK (amount_cents IS NULL OR typeof(amount_cents) = 'integer'),
      payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('ALIPAY', 'WECHAT')),
      reason TEXT,
      payment_reference TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      processed_at INTEGER NOT NULL,
      UNIQUE (activity_type, legacy_id)
    );
    CREATE INDEX IF NOT EXISTS billing_activity_org_created_idx
      ON billing_activity_records (org_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS billing_activity_user_created_idx
      ON billing_activity_records (user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS billing_refunds (
      id TEXT PRIMARY KEY,
      legacy_id INTEGER UNIQUE,
      refund_no TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL REFERENCES billing_orders(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      refund_amount_cents INTEGER NOT NULL CHECK (typeof(refund_amount_cents) = 'integer' AND refund_amount_cents > 0),
      refund_quota_units INTEGER NOT NULL CHECK (typeof(refund_quota_units) = 'integer' AND refund_quota_units >= 0),
      refund_points_units INTEGER NOT NULL CHECK (typeof(refund_points_units) = 'integer' AND refund_points_units >= 0),
      reason TEXT,
      refund_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SUPPRESSED')),
      provider_refund_no TEXT,
      provider_response_json TEXT,
      quota_operation_id TEXT REFERENCES billing_quota_operations(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      processed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_refunds_order_once_idx
      ON billing_refunds (order_id) WHERE status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN');

    CREATE TABLE IF NOT EXISTS billing_reconciliations (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      reconciliation_type TEXT NOT NULL,
      expected_units INTEGER NOT NULL CHECK (typeof(expected_units) = 'integer'),
      actual_units INTEGER NOT NULL CHECK (typeof(actual_units) = 'integer'),
      difference_units INTEGER NOT NULL CHECK (typeof(difference_units) = 'integer'),
      status TEXT NOT NULL CHECK (status IN ('MATCHED', 'MISMATCH', 'RESOLVED')),
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE (scope_type, scope_id, reconciliation_type, created_at)
    );

    CREATE TABLE IF NOT EXISTS billing_audit_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      actor_user_id TEXT,
      org_id TEXT,
      context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_audit_aggregate_idx
      ON billing_audit_events (aggregate_type, aggregate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_migration_checkpoints (
      source_checksum TEXT PRIMARY KEY,
      migration_run_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      verified_at INTEGER NOT NULL
    );
  `)

  const ledgerColumns = db.prepare('PRAGMA table_info(billing_ledger_entries)').all() as Array<{ name: string }>
  if (!ledgerColumns.some(column => column.name === 'legacy_id')) {
    db.exec('ALTER TABLE billing_ledger_entries ADD COLUMN legacy_id INTEGER')
  }
  const missingLedgerLegacyIds = db.prepare(`
    SELECT COUNT(*) AS count FROM billing_ledger_entries WHERE legacy_id IS NULL
  `).get() as { count: number }
  if (Number(missingLedgerLegacyIds.count) > 0) {
    db.exec('DROP TRIGGER IF EXISTS billing_ledger_entries_no_update')
    db.exec(`
      WITH base(value) AS (
        SELECT MAX(COALESCE(MAX(legacy_id), 0), 1999999999) FROM billing_ledger_entries
      ), numbered(rowid, sequence) AS (
        SELECT rowid, ROW_NUMBER() OVER (ORDER BY created_at, id)
        FROM billing_ledger_entries
        WHERE legacy_id IS NULL
      )
      UPDATE billing_ledger_entries
      SET legacy_id = (SELECT value FROM base) + (
        SELECT sequence FROM numbered WHERE numbered.rowid = billing_ledger_entries.rowid
      )
      WHERE legacy_id IS NULL
    `)
    db.exec(`
      CREATE TRIGGER billing_ledger_entries_no_update
      BEFORE UPDATE ON billing_ledger_entries
      BEGIN
        SELECT RAISE(ABORT, 'billing ledger entries are append-only');
      END
    `)
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS billing_ledger_legacy_id_idx ON billing_ledger_entries (legacy_id)')

  const commandColumns = db.prepare('PRAGMA table_info(command_executions)').all() as Array<{ name: string }>
  if (commandColumns.length > 0 && !commandColumns.some(column => column.name === 'request_fingerprint')) {
    db.exec('ALTER TABLE command_executions ADD COLUMN request_fingerprint TEXT')
  }

  const refundColumns = db.prepare('PRAGMA table_info(billing_refunds)').all() as Array<{ name: string }>
  if (refundColumns.length > 0 && !refundColumns.some(column => column.name === 'request_fingerprint')) {
    db.exec("ALTER TABLE billing_refunds ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''")
  }

  const externalAccountColumns = db.prepare('PRAGMA table_info(billing_external_accounts)').all() as Array<{ name: string }>
  if (!externalAccountColumns.some(column => column.name === 'token_secret_ref')) {
    db.exec('ALTER TABLE billing_external_accounts ADD COLUMN token_secret_ref TEXT')
  }
}
