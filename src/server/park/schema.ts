import type { DbDriver } from '../db/driver.js'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS park_source_bodies (
    org_id TEXT NOT NULL, sha256 TEXT NOT NULL, markdown TEXT NOT NULL,
    PRIMARY KEY (org_id, sha256)
  )`,
  `CREATE TABLE IF NOT EXISTS park_session_sources (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL,
    wiki_id TEXT NOT NULL, document_id TEXT NOT NULL, version TEXT NOT NULL,
    file_name TEXT NOT NULL, body_sha256 TEXT NOT NULL, ranges_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS park_document_history (
    org_id TEXT NOT NULL, document_id TEXT NOT NULL, file_name TEXT NOT NULL,
    node_name TEXT NOT NULL, size_bytes BIGINT NOT NULL,
    PRIMARY KEY (org_id, document_id)
  )`,
  `CREATE TABLE IF NOT EXISTS park_config (
    org_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, logo_url TEXT,
    welcome_text TEXT NOT NULL, contact_enabled INTEGER NOT NULL DEFAULT 1,
    park_profile TEXT NOT NULL DEFAULT '', service_catalog TEXT NOT NULL DEFAULT '[]',
    service_catalog_version TEXT NOT NULL DEFAULT '1',
    assistant_status TEXT NOT NULL DEFAULT 'draft', assistant_config TEXT NOT NULL DEFAULT '{}',
    rate_config TEXT NOT NULL DEFAULT '{}', redaction_config TEXT NOT NULL DEFAULT '{}',
    consent_text TEXT NOT NULL DEFAULT '',
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS park_user_roles (
    org_id TEXT NOT NULL, user_id TEXT NOT NULL, park_role TEXT NOT NULL,
    granted_by TEXT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS park_policies (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL,
    version TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
    status TEXT NOT NULL, effective_from BIGINT NOT NULL,
    effective_until BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE (org_id, title, version, section)
  )`,
  `CREATE TABLE IF NOT EXISTS park_quick_questions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, question TEXT NOT NULL,
    sort_order INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS park_public_links (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL,
    label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL, UNIQUE (org_id, channel)
  )`,
  `CREATE TABLE IF NOT EXISTS park_sessions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_channel TEXT NOT NULL,
    started_at BIGINT NOT NULL, last_active_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL, risk_state TEXT NOT NULL DEFAULT 'normal',
    message_count INTEGER NOT NULL DEFAULT 0, token_budget_used INTEGER NOT NULL DEFAULT 0,
    moss_session_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS park_sessions_org_started_idx ON park_sessions (org_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS park_inquiries (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL, redacted_question TEXT NOT NULL,
    redacted_answer TEXT NOT NULL, category TEXT NOT NULL, intent TEXT NOT NULL,
    industry TEXT, scale TEXT, urgency TEXT, concerns_json TEXT NOT NULL,
    confidence REAL NOT NULL, source_refs_json TEXT NOT NULL,
    created_at BIGINT NOT NULL, UNIQUE (session_id, client_request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS park_inquiries_org_created_idx ON park_inquiries (org_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS park_leads (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_session_id TEXT NOT NULL UNIQUE,
    source_inquiry_id TEXT, score INTEGER NOT NULL,
    score_explanation TEXT NOT NULL, tags_json TEXT NOT NULL,
    suggested_action TEXT NOT NULL, contact_status TEXT NOT NULL DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'proposed', owner_id TEXT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS park_leads_org_status_idx ON park_leads (org_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS park_lead_jobs (
    inquiry_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL,
    signal_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, next_at BIGINT NOT NULL,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS park_lead_jobs_due_idx ON park_lead_jobs (status, next_at)`,
  `CREATE TABLE IF NOT EXISTS park_contacts (
    lead_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT,
    company_name TEXT, phone TEXT, email TEXT,
    consent_text TEXT NOT NULL, consent_at BIGINT NOT NULL,
    retention_until BIGINT NOT NULL, phone_verified_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS park_phone_codes (
    session_id TEXT PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    sent_at BIGINT NOT NULL, verified_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS park_phone_sends (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL, session_id TEXT NOT NULL, sent_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS park_phone_sends_phone_time_idx ON park_phone_sends (phone, sent_at)`,
  `CREATE TABLE IF NOT EXISTS park_captcha_challenges (
    session_id TEXT PRIMARY KEY, answer_hash TEXT NOT NULL,
    issued_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    passed_until BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS park_follow_ups (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, lead_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL, note TEXT NOT NULL,
    outcome TEXT, created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS park_follow_ups_lead_idx ON park_follow_ups (lead_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS park_rejection_hits (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT,
    reason TEXT NOT NULL, response_status INTEGER NOT NULL,
    ip_prefix TEXT, created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS park_rejections_org_time_idx ON park_rejection_hits (org_id, created_at)`,
]

export async function initializeParkSchema(driver: DbDriver): Promise<void> {
  for (const statement of TABLES) await driver.exec(statement)
  await migrateLegacyColumns(driver)
}

/** Additive column migrations for databases created before the column existed. */
async function addColumnIfMissing(driver: DbDriver, table: string, column: string, definition: string): Promise<void> {
  const rows = await driver.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (rows.some(row => row.name === column)) return
  await driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * Legacy databases created park_leads with `source_inquiry_id NOT NULL`; direct
 * contact submission (no prior inquiry) needs it nullable. SQLite cannot drop
 * a NOT NULL constraint in place, so the table is rebuilt once, idempotently.
 */
async function relaxLeadInquiryNullable(driver: DbDriver): Promise<void> {
  const rows = await driver.all<{ name: string; notnull: number; type: string }>('PRAGMA table_info(park_leads)')
  const column = rows.find(row => row.name === 'source_inquiry_id')
  if (!column || column.notnull === 0) return
  await driver.exec(`
    CREATE TABLE park_leads_migrated (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_session_id TEXT NOT NULL UNIQUE,
      source_inquiry_id TEXT, score INTEGER NOT NULL,
      score_explanation TEXT NOT NULL, tags_json TEXT NOT NULL,
      suggested_action TEXT NOT NULL, contact_status TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'proposed', owner_id TEXT,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
    )`)
  await driver.exec('INSERT INTO park_leads_migrated SELECT * FROM park_leads')
  await driver.exec('DROP TABLE park_leads')
  await driver.exec('ALTER TABLE park_leads_migrated RENAME TO park_leads')
  await driver.exec('CREATE INDEX IF NOT EXISTS park_leads_org_status_idx ON park_leads (org_id, status, created_at)')
}

async function migrateLegacyColumns(driver: DbDriver): Promise<void> {
  await addColumnIfMissing(driver, 'park_config', 'consent_text', "TEXT NOT NULL DEFAULT ''")
  await addColumnIfMissing(driver, 'park_sessions', 'moss_session_id', 'TEXT')
  await relaxLeadInquiryNullable(driver)
}
