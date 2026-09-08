export interface QmsSqlPort {
  execute(sql: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
}

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS alert_config (
  id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL,
  metric TEXT NOT NULL, threshold DOUBLE PRECISION NOT NULL, comparison TEXT NOT NULL,
  level TEXT NOT NULL, channels TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30, description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_config_tenant_enabled ON alert_config(tenant_id, enabled);

CREATE TABLE IF NOT EXISTS alert_history (
  id BIGSERIAL PRIMARY KEY, tenant_id TEXT, config_id TEXT NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, level TEXT NOT NULL, channels TEXT NOT NULL,
  channel_results TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), success BOOLEAN DEFAULT TRUE,
  error_message TEXT, acknowledged BOOLEAN DEFAULT FALSE, acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT, delivery_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_alert_history_tenant_sent ON alert_history(tenant_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY, tenant_id TEXT, user_id TEXT, action TEXT NOT NULL,
  resource TEXT, resource_id TEXT, detail TEXT, ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qms_ingest_receipts (
  ingest_id TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant_id TEXT,
  event_timestamp TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qms_ingest_receipts_received ON qms_ingest_receipts(received_at DESC);

CREATE TABLE IF NOT EXISTS crash_issues (
  id SERIAL PRIMARY KEY, fingerprint TEXT NOT NULL, tenant_id TEXT, title TEXT NOT NULL,
  type TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'error', count INTEGER NOT NULL DEFAULT 0,
  user_count INTEGER DEFAULT 0, first_seen TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved', assigned_to TEXT, first_release TEXT,
  last_release TEXT, stack_summary TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crash_issues_fingerprint_tenant
  ON crash_issues(fingerprint, COALESCE(tenant_id, ''));
CREATE INDEX IF NOT EXISTS idx_crash_issues_tenant_status ON crash_issues(tenant_id, status);

CREATE TABLE IF NOT EXISTS source_maps (
  id SERIAL PRIMARY KEY, tenant_id TEXT, version TEXT NOT NULL, platform TEXT NOT NULL,
  file_name TEXT NOT NULL, map_content TEXT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_maps_tenant_version_platform_file
  ON source_maps(COALESCE(tenant_id, ''), version, platform, file_name);

CREATE TABLE IF NOT EXISTS telemetry_perf_raw (
  id BIGSERIAL, ingest_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown',
  org_id TEXT, user_id TEXT, tenant_id TEXT, login_mode TEXT, agent_type TEXT,
  user_nickname TEXT, user_phone TEXT, metric TEXT NOT NULL, value_ms BIGINT NOT NULL,
  session_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, timestamp), UNIQUE (ingest_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_perf_raw_tenant_timestamp ON telemetry_perf_raw(tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS telemetry_conversations (
  id BIGSERIAL, ingest_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown',
  org_id TEXT, user_id TEXT, tenant_id TEXT, login_mode TEXT, agent_type TEXT,
  user_nickname TEXT, user_phone TEXT, session_id TEXT NOT NULL, model_id TEXT NOT NULL,
  model_provider TEXT, status TEXT NOT NULL, duration_ms BIGINT NOT NULL, tokens_used INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (id, timestamp),
  UNIQUE (ingest_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_timestamp ON telemetry_conversations(tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS telemetry_turns (
  id BIGSERIAL, ingest_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown',
  org_id TEXT, user_id TEXT, tenant_id TEXT, login_mode TEXT, agent_type TEXT,
  user_nickname TEXT, user_phone TEXT, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
  model_id TEXT NOT NULL, model_provider TEXT, input_tokens INTEGER, output_tokens INTEGER,
  total_tokens INTEGER, duration_ms BIGINT NOT NULL, status TEXT NOT NULL, error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (id, timestamp),
  UNIQUE (ingest_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_turns_tenant_timestamp ON telemetry_turns(tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS telemetry_steps (
  id BIGSERIAL, ingest_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown',
  org_id TEXT, user_id TEXT, tenant_id TEXT, login_mode TEXT, agent_type TEXT,
  user_nickname TEXT, user_phone TEXT, step_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL, step_type TEXT NOT NULL, tool_name TEXT, tool_kind TEXT,
  file_path TEXT, permission_kind TEXT, thinking_tokens INTEGER, duration_ms BIGINT,
  status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, timestamp), UNIQUE (ingest_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_steps_tenant_timestamp ON telemetry_steps(tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS telemetry_install (
  install_id TEXT NOT NULL, ingest_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown',
  org_id TEXT, user_id TEXT, tenant_id TEXT, login_mode TEXT, agent_type TEXT,
  user_nickname TEXT, user_phone TEXT, status TEXT NOT NULL, duration_ms BIGINT NOT NULL,
  install_type TEXT, previous_version TEXT, error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (install_id, timestamp),
  UNIQUE (ingest_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_install_tenant_timestamp ON telemetry_install(tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS crash_events (
  id BIGSERIAL, ingest_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown',
  org_id TEXT, user_id TEXT, tenant_id TEXT, login_mode TEXT, agent_type TEXT,
  user_nickname TEXT, user_phone TEXT, process_type TEXT NOT NULL, type TEXT NOT NULL,
  crash_reason TEXT, exit_code INTEGER, signal TEXT, error_name TEXT, error_message TEXT,
  stack_trace TEXT, symbolicated_stack TEXT, context JSONB, release TEXT, environment TEXT,
  fingerprint TEXT NOT NULL, issue_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, timestamp), UNIQUE (ingest_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_crash_events_tenant_timestamp ON crash_events(tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_crash_events_issue_id ON crash_events(issue_id);

CREATE TABLE IF NOT EXISTS crash_daily_stats (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, tenant_id TEXT, type TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crash_daily_stats_dims
  ON crash_daily_stats(bucket, version, platform, COALESCE(tenant_id, ''), type);

CREATE TABLE IF NOT EXISTS telemetry_user_conversations_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, user_id TEXT NOT NULL,
  org_id TEXT, tenant_id TEXT, login_mode TEXT, user_nickname TEXT, user_phone TEXT,
  conversation_count INTEGER NOT NULL, total_tokens BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL, error_count INTEGER NOT NULL,
  user_cancel_count INTEGER NOT NULL, avg_duration_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, user_id, org_id, tenant_id, login_mode)
);
CREATE TABLE IF NOT EXISTS telemetry_user_turns_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, user_id TEXT NOT NULL,
  org_id TEXT, tenant_id TEXT, login_mode TEXT, user_nickname TEXT, user_phone TEXT,
  turn_count INTEGER NOT NULL, total_tokens BIGINT NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0, total_output_tokens BIGINT NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL, error_count INTEGER NOT NULL, avg_duration_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, user_id, org_id, tenant_id, login_mode)
);
CREATE TABLE IF NOT EXISTS telemetry_user_steps_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, user_id TEXT NOT NULL,
  org_id TEXT, tenant_id TEXT, login_mode TEXT, user_nickname TEXT, user_phone TEXT,
  step_type TEXT NOT NULL, step_count INTEGER NOT NULL, success_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL, avg_duration_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, user_id, org_id, tenant_id, login_mode, step_type)
);
CREATE INDEX IF NOT EXISTS idx_user_conversations_daily_bucket ON telemetry_user_conversations_daily(bucket DESC);
CREATE INDEX IF NOT EXISTS idx_user_conversations_daily_user_id ON telemetry_user_conversations_daily(user_id);
CREATE INDEX IF NOT EXISTS idx_user_turns_daily_bucket ON telemetry_user_turns_daily(bucket DESC);
CREATE INDEX IF NOT EXISTS idx_user_turns_daily_user_id ON telemetry_user_turns_daily(user_id);
CREATE INDEX IF NOT EXISTS idx_user_steps_daily_bucket ON telemetry_user_steps_daily(bucket DESC);
CREATE INDEX IF NOT EXISTS idx_user_steps_daily_user_id ON telemetry_user_steps_daily(user_id);

CREATE TABLE IF NOT EXISTS qms_task_leases (
  task_name TEXT PRIMARY KEY, owner_id TEXT NOT NULL, lease_until TIMESTAMPTZ NOT NULL,
  last_started_at TIMESTAMPTZ, last_completed_at TIMESTAMPTZ, last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS qms_migration_checkpoints (
  migration_id TEXT NOT NULL, table_name TEXT NOT NULL, source_checksum TEXT NOT NULL,
  cursor_json JSONB, migrated_rows BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (migration_id, table_name)
);
`

const REGULAR_AGGREGATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_perf_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown', tenant_id TEXT,
  metric TEXT NOT NULL, p50 DOUBLE PRECISION, p90 DOUBLE PRECISION, p95 DOUBLE PRECISION,
  p99 DOUBLE PRECISION, min_value DOUBLE PRECISION, max_value DOUBLE PRECISION,
  avg_value DOUBLE PRECISION, count INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, version, platform, arch, tenant_id, metric)
);
CREATE TABLE IF NOT EXISTS telemetry_conversations_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown', tenant_id TEXT,
  success_count INTEGER, error_count INTEGER, user_cancel_count INTEGER, total_count INTEGER,
  avg_duration_ms DOUBLE PRECISION, avg_tokens DOUBLE PRECISION, success_rate DOUBLE PRECISION,
  error_rate DOUBLE PRECISION, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, version, platform, arch, tenant_id)
);
CREATE TABLE IF NOT EXISTS telemetry_conversation_errors_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown', tenant_id TEXT,
  error_code TEXT NOT NULL, count INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, version, platform, arch, tenant_id, error_code)
);
CREATE TABLE IF NOT EXISTS telemetry_turns_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown', tenant_id TEXT,
  model_id TEXT NOT NULL, model_provider TEXT, success_count INTEGER, error_count INTEGER,
  total_count INTEGER, total_tokens BIGINT, total_input_tokens BIGINT, total_output_tokens BIGINT,
  avg_duration_ms DOUBLE PRECISION, success_rate DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, version, platform, arch, tenant_id, model_id, model_provider)
);
CREATE TABLE IF NOT EXISTS telemetry_steps_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown', tenant_id TEXT,
  step_type TEXT NOT NULL, success_count INTEGER, error_count INTEGER, total_count INTEGER,
  avg_duration_ms DOUBLE PRECISION, success_rate DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, version, platform, arch, tenant_id, step_type)
);
CREATE TABLE IF NOT EXISTS telemetry_install_daily (
  id BIGSERIAL PRIMARY KEY, bucket TIMESTAMPTZ NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'unknown', tenant_id TEXT,
  install_type TEXT, success_count INTEGER, failed_count INTEGER, total_count INTEGER,
  avg_duration_ms DOUBLE PRECISION, success_rate DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (bucket, version, platform, arch, tenant_id, install_type)
);
`

const CONTINUOUS_AGGREGATES = [
  `CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_perf_daily WITH (timescaledb.continuous) AS
   SELECT time_bucket('1 day', timestamp) AS bucket, version, platform, arch, tenant_id, metric,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY value_ms) AS p50,
    percentile_cont(0.90) WITHIN GROUP (ORDER BY value_ms) AS p90,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY value_ms) AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY value_ms) AS p99,
    MIN(value_ms) AS min_value, MAX(value_ms) AS max_value, AVG(value_ms) AS avg_value, COUNT(*) AS count
   FROM telemetry_perf_raw GROUP BY bucket, version, platform, arch, tenant_id, metric WITH NO DATA`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_conversations_daily WITH (timescaledb.continuous) AS
   SELECT time_bucket('1 day', timestamp) AS bucket, version, platform, arch, tenant_id,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE status = 'error') AS error_count,
    COUNT(*) FILTER (WHERE status = 'user_cancel') AS user_cancel_count, COUNT(*) AS total_count,
    AVG(duration_ms) AS avg_duration_ms, AVG(tokens_used) AS avg_tokens,
    COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'success')::DECIMAL /
      NULLIF(COUNT(*) FILTER (WHERE status IN ('success','error')), 0) * 100), 100) AS success_rate,
    ROUND(COUNT(*) FILTER (WHERE status = 'error')::DECIMAL / NULLIF(COUNT(*), 0) * 100) AS error_rate
   FROM telemetry_conversations GROUP BY bucket, version, platform, arch, tenant_id WITH NO DATA`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_conversation_errors_daily WITH (timescaledb.continuous) AS
   SELECT time_bucket('1 day', timestamp) AS bucket, version, platform, arch, tenant_id, error_code, COUNT(*) AS count
   FROM telemetry_conversations WHERE status = 'error' AND error_code IS NOT NULL
   GROUP BY bucket, version, platform, arch, tenant_id, error_code WITH NO DATA`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_turns_daily WITH (timescaledb.continuous) AS
   SELECT time_bucket('1 day', timestamp) AS bucket, version, platform, arch, tenant_id,
    model_id, model_provider,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE status = 'error') AS error_count, COUNT(*) AS total_count,
    SUM(COALESCE(total_tokens, 0)) AS total_tokens,
    SUM(COALESCE(input_tokens, 0)) AS total_input_tokens,
    SUM(COALESCE(output_tokens, 0)) AS total_output_tokens,
    AVG(duration_ms)::BIGINT AS avg_duration_ms,
    ROUND(COUNT(*) FILTER (WHERE status = 'success')::DECIMAL / NULLIF(COUNT(*), 0) * 100) AS success_rate
   FROM telemetry_turns
   GROUP BY bucket, version, platform, arch, tenant_id, model_id, model_provider WITH NO DATA`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_steps_daily WITH (timescaledb.continuous) AS
   SELECT time_bucket('1 day', timestamp) AS bucket, version, platform, arch, tenant_id, step_type,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE status = 'error') AS error_count, COUNT(*) AS total_count,
    AVG(COALESCE(duration_ms, 0))::BIGINT AS avg_duration_ms,
    ROUND(COUNT(*) FILTER (WHERE status = 'success')::DECIMAL / NULLIF(COUNT(*), 0) * 100) AS success_rate
   FROM telemetry_steps GROUP BY bucket, version, platform, arch, tenant_id, step_type WITH NO DATA`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_install_daily WITH (timescaledb.continuous) AS
   SELECT time_bucket('1 day', timestamp) AS bucket, version, platform, arch, tenant_id, install_type,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count, COUNT(*) AS total_count,
    AVG(duration_ms) AS avg_duration_ms,
    ROUND(COUNT(*) FILTER (WHERE status = 'success')::DECIMAL / NULLIF(COUNT(*), 0) * 100) AS success_rate
   FROM telemetry_install GROUP BY bucket, version, platform, arch, tenant_id, install_type WITH NO DATA`,
] as const

const HYPERTABLES = [
  'telemetry_perf_raw',
  'telemetry_conversations',
  'telemetry_turns',
  'telemetry_steps',
  'telemetry_install',
  'crash_events',
] as const

export type QmsAggregateMode = 'auto' | 'regular' | 'continuous'

export interface QmsSchemaState {
  timescaleAvailable: boolean
  continuousAggregates: boolean
}

export async function initializeQmsSchema(
  db: QmsSqlPort,
  options: { aggregateMode?: QmsAggregateMode } = {},
): Promise<QmsSchemaState> {
  await db.execute(BASE_SCHEMA)
  const extension = await db.execute(
    "SELECT TRUE AS available FROM pg_extension WHERE extname = 'timescaledb' LIMIT 1",
  )
  const timescaleAvailable = extension.length > 0
  if (timescaleAvailable) {
    for (const table of HYPERTABLES) {
      await db.execute(`SELECT create_hypertable('${table}', 'timestamp', if_not_exists => TRUE, migrate_data => TRUE)`)
    }
  }

  const aggregateRelation = await db.execute(
    "SELECT relkind FROM pg_class WHERE oid = to_regclass('telemetry_perf_daily')",
  )
  const relationKind = aggregateRelation[0]?.relkind == null ? undefined : String(aggregateRelation[0].relkind)
  if (relationKind && !['r', 'p', 'm'].includes(relationKind)) {
    throw new Error(`Unsupported QMS aggregate relation kind: ${relationKind}`)
  }

  const requestedMode = options.aggregateMode ?? 'auto'
  if (requestedMode === 'continuous' && !timescaleAvailable) {
    throw new Error('TIMESCALEDB_NOT_AVAILABLE')
  }
  if (requestedMode === 'continuous' && (relationKind === 'r' || relationKind === 'p')) {
    throw new Error('QMS_AGGREGATE_MODE_CONFLICT')
  }
  if (requestedMode === 'regular' && relationKind === 'm') {
    throw new Error('QMS_AGGREGATE_MODE_CONFLICT')
  }

  const continuousAggregates = requestedMode === 'continuous'
    || (requestedMode === 'auto' && timescaleAvailable && relationKind !== 'r' && relationKind !== 'p')

  if (continuousAggregates) {
    for (const statement of CONTINUOUS_AGGREGATES) await db.execute(statement)
    for (const table of [
      'telemetry_perf_daily', 'telemetry_conversations_daily', 'telemetry_conversation_errors_daily',
      'telemetry_turns_daily', 'telemetry_steps_daily', 'telemetry_install_daily',
    ]) {
      await db.execute(`SELECT add_continuous_aggregate_policy('${table}', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`)
      await db.execute(`SELECT add_retention_policy('${table}', INTERVAL '365 days', if_not_exists => TRUE)`)
    }
  } else {
    await db.execute(REGULAR_AGGREGATE_SCHEMA)
  }

  if (timescaleAvailable) {
    for (const [table, days] of [
      ['telemetry_perf_raw', 90], ['telemetry_install', 90], ['telemetry_conversations', 180],
      ['telemetry_turns', 90], ['telemetry_steps', 90], ['crash_events', 90],
    ] as const) {
      await db.execute(`SELECT add_retention_policy('${table}', INTERVAL '${days} days', if_not_exists => TRUE)`)
    }
  }
  return { timescaleAvailable, continuousAggregates }
}
