import type { DbDriver } from '../db/driver.js'

/** New USD/quota records do not depend on legacy points columns. */
export async function ensureOrganizationBillingSchema(db: DbDriver): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS organization_model_accounts (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id),
      router_user_id BIGINT UNIQUE,
      router_username TEXT NOT NULL UNIQUE,
      initial_quota BIGINT NOT NULL CHECK (initial_quota >= 0),
      default_member_quota BIGINT CHECK (default_member_quota >= 0),
      service_quota BIGINT NOT NULL CHECK (service_quota >= 0),
      quota_per_usd BIGINT NOT NULL CHECK (quota_per_usd > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'disabled', 'needs_review')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_model_tokens (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organization_model_accounts(org_id),
      member_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('member', 'service')),
      router_user_id BIGINT NOT NULL,
      router_token_id BIGINT UNIQUE,
      secret_ref TEXT,
      initial_quota BIGINT CHECK (initial_quota >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'disabled', 'revoked', 'needs_review')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE (org_id, member_id, purpose)
    );
    CREATE INDEX IF NOT EXISTS organization_model_tokens_member_idx ON organization_model_tokens(member_id, org_id);
    CREATE TABLE IF NOT EXISTS organization_model_operations (
      reference TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organization_model_accounts(org_id),
      member_id TEXT,
      actor_user_id TEXT,
      operation_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'succeeded', 'rejected', 'unknown')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS organization_model_operations_org_idx ON organization_model_operations(org_id, created_at, reference);
    CREATE TABLE IF NOT EXISTS organization_model_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL REFERENCES organization_model_accounts(org_id),
      router_user_id BIGINT NOT NULL,
      payer_user_id TEXT NOT NULL,
      purchase_usd_micros BIGINT NOT NULL CHECK (purchase_usd_micros > 0),
      bonus_usd_micros BIGINT NOT NULL CHECK (bonus_usd_micros >= 0),
      amount_cny_fen BIGINT NOT NULL CHECK (amount_cny_fen > 0),
      exchange_rate_micros BIGINT NOT NULL CHECK (exchange_rate_micros > 0),
      credited_quota BIGINT NOT NULL CHECK (credited_quota > 0),
      quota_per_usd BIGINT NOT NULL CHECK (quota_per_usd > 0),
      payment_method TEXT NOT NULL CHECK (payment_method IN ('ALIPAY', 'WECHAT')),
      payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'paying', 'paid', 'cancelled')),
      credit_status TEXT NOT NULL CHECK (credit_status IN ('pending', 'sending', 'credited', 'needs_review')),
      payment_test_mode INTEGER NOT NULL DEFAULT 0 CHECK (payment_test_mode IN (0, 1)),
      provider_order_info TEXT,
      reference TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      paid_at BIGINT,
      credited_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS organization_model_orders_org_idx ON organization_model_orders(org_id, created_at, id);
    CREATE TABLE IF NOT EXISTS organization_model_credits (
      credit_no TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organization_model_accounts(org_id), router_user_id BIGINT NOT NULL,
      amount_usd_micros BIGINT NOT NULL CHECK (amount_usd_micros > 0), quota BIGINT NOT NULL CHECK (quota > 0),
      actor_user_id TEXT NOT NULL, reason TEXT NOT NULL, related_order_no TEXT REFERENCES organization_model_orders(order_no),
      reference TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'credited', 'failed', 'needs_review')), created_at BIGINT NOT NULL, credited_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS organization_model_credits_org_idx ON organization_model_credits(org_id, created_at, credit_no);
    CREATE INDEX IF NOT EXISTS organization_model_credits_order_idx ON organization_model_credits(related_order_no, status);
    CREATE TABLE IF NOT EXISTS organization_model_credit_attempts (
      reference TEXT PRIMARY KEY, credit_no TEXT NOT NULL REFERENCES organization_model_credits(credit_no),
      status TEXT NOT NULL CHECK (status IN ('sending', 'credited', 'failed', 'needs_review')), actor_user_id TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS organization_model_credit_attempts_credit_idx ON organization_model_credit_attempts(credit_no, created_at);
    CREATE TABLE IF NOT EXISTS organization_model_order_resolutions (
      order_no TEXT PRIMARY KEY REFERENCES organization_model_orders(order_no),
      original_outcome TEXT NOT NULL CHECK (original_outcome IN ('unknown', 'credited', 'not_executed')), is_closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS organization_model_credit_audit (
      reference TEXT PRIMARY KEY, org_id TEXT NOT NULL, target_no TEXT NOT NULL, actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL, evidence TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS organization_model_credit_audit_target_idx ON organization_model_credit_audit(target_no, org_id, created_at);
  `)
}
