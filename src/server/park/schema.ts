import type { DbDriver } from '../db/driver.js'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS park_config (
    org_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, logo_url TEXT,
    welcome_text TEXT NOT NULL, contact_enabled INTEGER NOT NULL DEFAULT 1,
    park_profile TEXT NOT NULL DEFAULT '', service_catalog TEXT NOT NULL DEFAULT '[]',
    service_catalog_version TEXT NOT NULL DEFAULT '1',
    assistant_status TEXT NOT NULL DEFAULT 'draft', assistant_config TEXT NOT NULL DEFAULT '{}',
    rate_config TEXT NOT NULL DEFAULT '{}', redaction_config TEXT NOT NULL DEFAULT '{}',
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
    message_count INTEGER NOT NULL DEFAULT 0, token_budget_used INTEGER NOT NULL DEFAULT 0
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
    source_inquiry_id TEXT NOT NULL, score INTEGER NOT NULL,
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
}
