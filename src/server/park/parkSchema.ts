import type { DatabaseSync } from 'node:sqlite'

/**
 * Park domain schema (园区 AI 招商 P0). Idempotent DDL following the
 * billingSchema pattern: CREATE TABLE IF NOT EXISTS plus append-only
 * triggers on the audit table. The PG twin lives in
 * db/pg_schema.ts MIGRATION_0012_PARK.
 */
export function ensureParkSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS park_org_profiles (
      moss_org_id TEXT PRIMARY KEY REFERENCES organizations(id),
      org_type TEXT NOT NULL CHECK (org_type IN ('park', 'enterprise')),
      display_name TEXT NOT NULL,
      lifecycle TEXT,
      external_id TEXT,
      metadata_json TEXT,
      is_default_park INTEGER NOT NULL DEFAULT 0 CHECK (is_default_park IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS park_org_profiles_default_park_idx
      ON park_org_profiles (is_default_park)
      WHERE org_type = 'park' AND is_default_park = 1;

    CREATE TABLE IF NOT EXISTS park_enterprise_bindings (
      binding_id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL REFERENCES organizations(id),
      enterprise_org_id TEXT NOT NULL REFERENCES organizations(id),
      lifecycle TEXT NOT NULL DEFAULT 'prospect'
        CHECK (lifecycle IN ('prospect', 'active', 'exiting', 'exited')),
      relationship_type TEXT NOT NULL DEFAULT 'prospective'
        CHECK (relationship_type IN ('prospective', 'resident', 'partner')),
      service_scope_json TEXT,
      assigned_owner_id TEXT,
      joined_at INTEGER,
      exited_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (park_org_id, enterprise_org_id)
    );
    CREATE INDEX IF NOT EXISTS park_bindings_enterprise_idx
      ON park_enterprise_bindings (enterprise_org_id);

    CREATE TABLE IF NOT EXISTS park_members (
      id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      park_role TEXT NOT NULL
        CHECK (park_role IN ('park_leader', 'park_ops', 'park_system_operator')),
      created_at INTEGER NOT NULL,
      UNIQUE (park_org_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS enterprise_profiles (
      enterprise_org_id TEXT PRIMARY KEY REFERENCES organizations(id),
      park_org_id TEXT NOT NULL REFERENCES organizations(id),
      lifecycle TEXT NOT NULL DEFAULT 'prospect',
      enterprise_name TEXT NOT NULL,
      industry TEXT,
      scale TEXT,
      contact_name TEXT,
      contact_phone TEXT,
      assigned_owner_id TEXT,
      tags_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS enterprise_profiles_park_idx
      ON enterprise_profiles (park_org_id);

    CREATE TABLE IF NOT EXISTS inquiries (
      inquiry_id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL,
      enterprise_org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_session_id TEXT,
      question_ref TEXT,
      redacted_question TEXT,
      answer_ref TEXT,
      redacted_answer TEXT,
      category TEXT NOT NULL DEFAULT 'consultation'
        CHECK (category IN ('consultation', 'service_request')),
      intent TEXT,
      confidence INTEGER CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
      source_refs_json TEXT,
      consent_state TEXT NOT NULL DEFAULT 'granted',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inquiries_park_created_idx
      ON inquiries (park_org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS inquiries_enterprise_idx
      ON inquiries (enterprise_org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS inquiries_user_idx
      ON inquiries (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS leads (
      lead_id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL,
      enterprise_org_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('inquiry', 'manual')),
      source_inquiry_id TEXT REFERENCES inquiries(inquiry_id),
      score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
      score_explanation TEXT,
      industry_tags_json TEXT,
      policy_matches_json TEXT,
      suggested_action TEXT,
      owner_id TEXT,
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'assigned', 'following_up', 'converted', 'lost', 'rejected')),
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (park_org_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS leads_park_status_idx
      ON leads (park_org_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS leads_owner_idx
      ON leads (owner_id);

    CREATE TABLE IF NOT EXISTS lead_watches (
      lead_id TEXT NOT NULL REFERENCES leads(lead_id),
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (lead_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS park_assistant_assignments (
      id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      enterprise_org_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (park_org_id, assistant_id, enterprise_org_id)
    );
    CREATE INDEX IF NOT EXISTS park_assignments_enterprise_idx
      ON park_assistant_assignments (enterprise_org_id);
    CREATE INDEX IF NOT EXISTS park_assignments_assistant_idx
      ON park_assistant_assignments (assistant_id);

    CREATE TABLE IF NOT EXISTS park_audit_events (
      audit_id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_org_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      reason TEXT,
      before_summary_json TEXT,
      after_summary_json TEXT,
      result TEXT,
      request_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS park_audit_park_created_idx
      ON park_audit_events (park_org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS park_audit_actor_idx
      ON park_audit_events (actor_user_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS park_audit_events_no_update
    BEFORE UPDATE ON park_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'park audit events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS park_audit_events_no_delete
    BEFORE DELETE ON park_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'park audit events are append-only');
    END;

    CREATE TABLE IF NOT EXISTS exit_cases (
      exit_case_id TEXT PRIMARY KEY,
      park_org_id TEXT NOT NULL,
      enterprise_org_id TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'approved', 'inventorying', 'archived', 'completed', 'cancelled')),
      retention_policy TEXT,
      asset_recovery_status TEXT,
      data_cleanup_status TEXT,
      approved_by TEXT,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}
