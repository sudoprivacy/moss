import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { RechargeOrder, RechargeSyncStatus, RefundRecord } from '../credits/recharge.js'

export type AuthCenterOrganization = {
  id: string
  name: string
  extOrgId: string | null
  createdAt: number
}

export type AuthCenterDepartment = {
  id: string
  orgId: string
  parentId: string | null
  name: string
  extDeptId: string | null
  tokenLimit: number | null
  createdAt: number
  updatedAt: number
}

export type AuthCenterUser = {
  id: string
  orgId: string
  email: string
  /** Login username (matched on password login). Non-null, unique-per-org via service layer. */
  name: string
  /** Optional human display name shown in UIs / agent identity. Distinct from the login `name`. */
  displayName: string | null
  departmentId: string | null
  role: string
  status: 'active' | 'disabled'
  localAuth: boolean
  tokenLimit: number | null
  createdAt: number
  passwordHash: string | null
  passwordUpdatedAt: number | null
  lastLoginAt: number | null
  extUserId: string | null
  /** Phone identity for `login_method: 0`; null for password- and IdP-backed users. */
  phone: string | null
}

/**
 * A user's own credential for the metered model gateway. Kept off
 * `AuthCenterUser` on purpose so it cannot reach an API response — see the
 * migration comment in `ensureSchema`.
 */
export type UserModelCredential = {
  sudorouterUserId: string | null
  sudorouterKey: string
}

/** A credit application row, as stored. Points, never gateway quota. */
export type CreditApplicationRow = {
  id: number
  applicationNo: string
  userId: string
  orgId: string
  requestedPoints: number
  approvedPoints: number | null
  reason: string | null
  status: string
  adminComment: string | null
  createdAt: number
  reviewedAt: number | null
  sudorouterError: string | null
}

export type RechargeOrderRow = RechargeOrder
export type RefundRecordRow = RefundRecord

/** A pending phone verification code. Only the HMAC of the code is stored. */
export type PhoneLoginCode = {
  phone: string
  codeHash: string
  createdAt: number
  expiresAt: number
  attempts: number
}

export type AuthCenterApiKey = {
  id: string
  orgId: string
  userId: string
  name: string
  prefix: string
  secretHash: string
  scopes: string[]
  status: 'active' | 'revoked'
  createdAt: number
  lastUsedAt: number | null
}

export type AuthCenterStore = {
  version: 1 | 2 | 3
  issuer: string
  jwtSecret: string
  organizations: AuthCenterOrganization[]
  departments?: AuthCenterDepartment[]
  users: AuthCenterUser[]
  apiKeys: AuthCenterApiKey[]
}

export type SanitizedAuthCenterUser = Omit<
  AuthCenterUser,
  'passwordHash' | 'email'
> & {
  email: string | null
}

export type SanitizedAuthCenterDepartment = AuthCenterDepartment & {
  userCount: number
}

export type AuthCenterBootstrap = {
  created: boolean
  bootstrapAdminUsername?: string
  bootstrapAdminApiKey?: string
  bootstrapAdminEmail?: string
  bootstrapAdminPassword?: string
}

export type BootstrapAdminConfig = {
  username: string
  password?: string
  email?: string
}

type SqlRow = Record<string, unknown>

const INTERNAL_EMAIL_DOMAIN = 'users.internal.moss'

function now(): number {
  return Date.now()
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []
  } catch {
    return []
  }
}

function mapOrganization(row: SqlRow): AuthCenterOrganization {
  return {
    id: String(row.id),
    name: String(row.name),
    extOrgId: row.ext_org_id == null ? null : String(row.ext_org_id),
    createdAt: Number(row.created_at),
  }
}

function mapDepartment(row: SqlRow): AuthCenterDepartment {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    name: String(row.name),
    extDeptId: row.ext_dept_id == null ? null : String(row.ext_dept_id),
    tokenLimit: row.token_limit == null ? null : Number(row.token_limit),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapUser(row: SqlRow): AuthCenterUser {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    email: String(row.email),
    name: String(row.name),
    displayName: row.display_name == null ? null : String(row.display_name),
    departmentId: row.department_id == null ? null : String(row.department_id),
    role: String(row.role),
    status: String(row.status) as 'active' | 'disabled',
    localAuth: Boolean(row.local_auth),
    tokenLimit: row.token_limit == null ? null : Number(row.token_limit),
    createdAt: Number(row.created_at),
    passwordHash: row.password_hash == null ? null : String(row.password_hash),
    passwordUpdatedAt: row.password_updated_at == null ? null : Number(row.password_updated_at),
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
    extUserId: row.ext_user_id == null ? null : String(row.ext_user_id),
    phone: row.phone == null ? null : String(row.phone),
  }
}

function mapCreditApplication(row: SqlRow): CreditApplicationRow {
  return {
    id: Number(row.id),
    applicationNo: String(row.application_no),
    userId: String(row.user_id),
    orgId: String(row.org_id),
    requestedPoints: Number(row.requested_points),
    approvedPoints: row.approved_points == null ? null : Number(row.approved_points),
    reason: row.reason == null ? null : String(row.reason),
    status: String(row.status),
    adminComment: row.admin_comment == null ? null : String(row.admin_comment),
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    sudorouterError: row.sudorouter_error == null ? null : String(row.sudorouter_error),
  }
}

function mapRechargeOrder(row: SqlRow): RechargeOrderRow {
  return {
    id: Number(row.id),
    orderNo: String(row.order_no),
    userId: String(row.user_id),
    userPhone: row.user_phone == null ? null : String(row.user_phone),
    orgId: String(row.org_id),
    amountUsd: Number(row.amount_usd),
    amountYuan: Number(row.amount_yuan),
    amountCents: Number(row.amount_cents),
    exchangeRate: Number(row.exchange_rate),
    quotaAmount: Number(row.quota_amount),
    pointsAmount: Number(row.points_amount),
    bonusPoints: Number(row.bonus_points ?? 0),
    paymentMethod: String(row.payment_method) as RechargeOrderRow['paymentMethod'],
    orderDate: String(row.order_date),
    fuiouOrderInfo: row.fuiou_order_info == null ? null : String(row.fuiou_order_info),
    status: Number(row.status) as RechargeOrderRow['status'],
    syncStatus: String(row.sync_status ?? 'NONE') as RechargeSyncStatus,
    syncError: row.sync_error == null ? null : String(row.sync_error),
    callbackData: row.callback_data == null ? null : String(row.callback_data),
    callbackTime: row.callback_time == null ? null : Number(row.callback_time),
    callbackAmountCents: row.callback_amount_cents == null ? null : Number(row.callback_amount_cents),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiredAt: Number(row.expired_at),
    remark: row.remark == null ? null : String(row.remark),
  }
}

function mapRefundRecord(row: SqlRow): RefundRecordRow {
  return {
    id: Number(row.id),
    refundNo: String(row.refund_no),
    orderId: Number(row.order_id),
    orderNo: String(row.order_no),
    userId: String(row.user_id),
    orgId: String(row.org_id),
    adminId: row.admin_id == null ? null : String(row.admin_id),
    refundAmountYuan: Number(row.refund_amount_yuan),
    refundQuota: Number(row.refund_quota),
    refundPoints: Number(row.refund_points),
    refundReason: row.refund_reason == null ? null : String(row.refund_reason),
    refundType: String(row.refund_type),
    status: Number(row.status),
    syncStatus: String(row.sync_status ?? 'NONE') as RechargeSyncStatus,
    syncError: row.sync_error == null ? null : String(row.sync_error),
    fuiouRefundNo: row.fuiou_refund_no == null ? null : String(row.fuiou_refund_no),
    fuiouResponse: row.fuiou_response == null ? null : String(row.fuiou_response),
    createdAt: Number(row.created_at),
    processedAt: row.processed_at == null ? null : Number(row.processed_at),
  }
}

function mapApiKey(row: SqlRow): AuthCenterApiKey {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    name: String(row.name),
    prefix: String(row.prefix),
    secretHash: String(row.secret_hash),
    scopes: parseJsonArray(row.scopes_json),
    status: String(row.status) as 'active' | 'revoked',
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  }
}

export function getDefaultAuthCenterDbPath(): string {
  return join(getClaudeConfigHomeDir(), 'authcenter.db')
}

export function getDefaultAuthCenterJsonPath(): string {
  return join(getClaudeConfigHomeDir(), 'auth-center', 'store.json')
}

export class AuthCenterDb {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly #ownsConnection: boolean

  constructor(dbOrPath: string | DatabaseSync, dbPath?: string) {
    if (typeof dbOrPath === 'string') {
      this.dbPath = dbOrPath
      mkdirSync(dirname(dbOrPath), { recursive: true })
      this.db = new DatabaseSync(dbOrPath)
      this.#ownsConnection = true
    } else {
      this.db = dbOrPath
      this.dbPath = dbPath ?? ':memory:'
      this.#ownsConnection = false
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
    `)
    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        parent_id TEXT REFERENCES departments(id),
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        department_id TEXT REFERENCES departments(id),
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        password_hash TEXT,
        password_updated_at INTEGER,
        last_login_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_provider_tokens (
        user_id TEXT PRIMARY KEY,
        token_enc TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      -- Per-(user, service) access tokens minted by the auth proxy from the
      -- user's stored login credential, keyed by config_item_id (the 凭据).
      -- Distinct from oauth_provider_tokens (the single moss-login IdP token,
      -- cleared on logout) — these have their own per-service lifecycle.
      CREATE TABLE IF NOT EXISTS minted_service_tokens (
        user_id TEXT NOT NULL,
        config_item_id INTEGER NOT NULL,
        token_enc TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, config_item_id)
      );
      CREATE INDEX IF NOT EXISTS minted_service_tokens_expiry_idx ON minted_service_tokens (expires_at);

      CREATE TABLE IF NOT EXISTS server_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Pending phone verification codes (login_method: 0). In the shared store
      -- rather than in a process Map because moss can run several instances
      -- behind a load balancer: a code minted on one must verify on another.
      -- Only the HMAC of the code is kept, so a database read does not hand over
      -- the ability to log in as a pending number.
      CREATE TABLE IF NOT EXISTS phone_login_codes (
        phone TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      -- Send log backing the per-number hourly cap. Separate from the code row
      -- because that row is deleted on successful verification, and a deleted
      -- row must not reset someone's rate limit.
      CREATE TABLE IF NOT EXISTS phone_login_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS phone_login_sends_idx
        ON phone_login_sends (phone, sent_at);

      CREATE INDEX IF NOT EXISTS departments_org_idx ON departments (org_id);
      CREATE INDEX IF NOT EXISTS departments_parent_idx ON departments (parent_id);
      CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);
      CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
      CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);
      CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
      CREATE INDEX IF NOT EXISTS revoked_tokens_expiry_idx ON revoked_tokens (expires_at);
      CREATE INDEX IF NOT EXISTS oauth_provider_tokens_expiry_idx ON oauth_provider_tokens (expires_at);
    `)

    // oauth_provider_tokens was originally keyed by the login JWT's jti; it is
    // now keyed by user_id (so any of a user's sessions — including the runtime
    // container's SESSION_TOKEN — can resolve the token, and refreshes upsert
    // the same row). SQLite can't change a PRIMARY KEY in place, so on an older
    // DB we drop + recreate. Existing rows are short-lived, now-unreachable
    // session tokens — safe to discard (callers re-login/refresh; the null
    // contract covers the gap). Self-healing and idempotent on every boot.
    {
      const cols = this.db
        .prepare('PRAGMA table_info(oauth_provider_tokens)')
        .all() as SqlRow[]
      const hasUserId = cols.some(c => String(c.name) === 'user_id')
      if (cols.length > 0 && !hasUserId) {
        this.db.exec(`
          DROP TABLE oauth_provider_tokens;
          CREATE TABLE oauth_provider_tokens (
            user_id TEXT PRIMARY KEY,
            token_enc TEXT NOT NULL,
            token_iv TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS oauth_provider_tokens_expiry_idx ON oauth_provider_tokens (expires_at);
        `)
      }
    }

    // Older databases may need the column added before SQLite can create the index.
    this.ensureColumn(
      'users',
      'department_id',
      'ALTER TABLE users ADD COLUMN department_id TEXT REFERENCES departments(id)',
    )
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS users_department_idx ON users (department_id);
    `)
    this.ensureColumn(
      'users',
      'token_limit',
      'ALTER TABLE users ADD COLUMN token_limit INTEGER',
    )
    this.ensureColumn(
      'departments',
      'token_limit',
      'ALTER TABLE departments ADD COLUMN token_limit INTEGER',
    )
    this.ensureColumn(
      'users',
      'local_auth',
      'ALTER TABLE users ADD COLUMN local_auth INTEGER NOT NULL DEFAULT 0',
    )

    // External-ID columns: stable identifiers from the upstream IdP (e.g.
    // a bizOrgCode / user_id / groupIds[0]). All nullable —
    // locally-authenticated users + the bootstrap default org leave them
    // NULL. Uniqueness is enforced by SQL partial UNIQUE indexes below;
    // NULL values don't compete for uniqueness, so any number of rows can
    // leave ext_* unset.
    this.db.exec(`DROP INDEX IF EXISTS users_provider_idx`)
    this.dropColumn('users', 'provider')
    this.dropColumn('users', 'provider_user_id')
    this.ensureColumn(
      'organizations',
      'ext_org_id',
      'ALTER TABLE organizations ADD COLUMN ext_org_id TEXT',
    )
    this.ensureColumn(
      'users',
      'ext_user_id',
      'ALTER TABLE users ADD COLUMN ext_user_id TEXT',
    )
    // Optional human display name, distinct from the login `name` (username).
    // Nullable, not unique — existing rows stay NULL and resolve to `name`.
    this.ensureColumn(
      'users',
      'display_name',
      'ALTER TABLE users ADD COLUMN display_name TEXT',
    )
    // Phone identity for `login_method: 0`. Nullable: password- and IdP-backed
    // users never have one. Unique GLOBALLY rather than per-org (unlike
    // ext_user_id) because a phone number identifies one human across the whole
    // deployment — the same number signing in twice must reach the same account,
    // not create a second one in another org.
    this.ensureColumn(
      'users',
      'phone',
      'ALTER TABLE users ADD COLUMN phone TEXT',
    )
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uniq
        ON users (phone) WHERE phone IS NOT NULL;
    `)
    // The upstream model gateway (SudoRouter) owns the credit ledger and keys it
    // on a per-user token. A deployment that bills per user has to spend that
    // token, not a shared server key — otherwise every session bills one account
    // and each user's balance never moves. Nullable: deployments without a
    // metered gateway (private / on-prem) have no per-user token and fall back to
    // the server key.
    //
    // Deliberately NOT part of `AuthCenterUser`: that type flows into
    // `SanitizedAuthCenterUser`, which only omits `passwordHash` and `email`, so
    // anything mapped there reaches API responses. Keeping the token off the
    // mapped type makes leaking it impossible by construction rather than by
    // remembering to omit it. Reads go through `getUserModelCredential`.
    // Credit applications (`approve` recharge mode). The balance itself lives at
    // the model gateway; this table holds only the request and the outcome of
    // trying to credit it, which is why it carries a sync-error column.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_no TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        org_id TEXT NOT NULL,
        requested_points INTEGER NOT NULL,
        approved_points INTEGER,
        reason TEXT,
        status TEXT NOT NULL,
        admin_comment TEXT,
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        sudorouter_error TEXT
      );
      CREATE INDEX IF NOT EXISTS credit_applications_user_idx
        ON credit_applications (user_id, created_at DESC);
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recharge_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        user_phone TEXT,
        org_id TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        amount_yuan REAL NOT NULL,
        amount_cents INTEGER NOT NULL,
        exchange_rate REAL NOT NULL,
        quota_amount INTEGER NOT NULL,
        points_amount INTEGER NOT NULL,
        bonus_points INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL,
        order_date TEXT NOT NULL,
        fuiou_order_info TEXT,
        status INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'NONE',
        sync_error TEXT,
        callback_data TEXT,
        callback_time INTEGER,
        callback_amount_cents INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expired_at INTEGER NOT NULL,
        remark TEXT
      );
      CREATE INDEX IF NOT EXISTS recharge_orders_user_idx
        ON recharge_orders (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS recharge_orders_org_idx
        ON recharge_orders (org_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS recharge_orders_status_idx
        ON recharge_orders (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS refund_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        refund_no TEXT NOT NULL UNIQUE,
        order_id INTEGER NOT NULL REFERENCES recharge_orders(id),
        order_no TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        org_id TEXT NOT NULL,
        admin_id TEXT,
        refund_amount_yuan REAL NOT NULL,
        refund_quota INTEGER NOT NULL,
        refund_points INTEGER NOT NULL,
        refund_reason TEXT,
        refund_type TEXT NOT NULL,
        status INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'NONE',
        sync_error TEXT,
        fuiou_refund_no TEXT,
        fuiou_response TEXT,
        created_at INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS refund_records_order_idx
        ON refund_records (order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS refund_records_user_idx
        ON refund_records (user_id, created_at DESC);
    `)
    this.ensureColumn(
      'refund_records',
      'admin_id',
      'ALTER TABLE refund_records ADD COLUMN admin_id TEXT',
    )
    this.ensureColumn(
      'users',
      'sudorouter_user_id',
      'ALTER TABLE users ADD COLUMN sudorouter_user_id TEXT',
    )
    this.ensureColumn(
      'users',
      'sudorouter_key',
      'ALTER TABLE users ADD COLUMN sudorouter_key TEXT',
    )
    this.ensureColumn(
      'departments',
      'ext_dept_id',
      'ALTER TABLE departments ADD COLUMN ext_dept_id TEXT',
    )
    // Drop the original non-unique indexes (older builds had these), then
    // create the partial UNIQUE replacements. A partial UNIQUE serves both
    // as lookup index and as uniqueness constraint.
    this.db.exec(`
      DROP INDEX IF EXISTS users_ext_idx;
      DROP INDEX IF EXISTS departments_ext_idx;
      DROP INDEX IF EXISTS organizations_ext_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS users_ext_uniq
        ON users (org_id, ext_user_id) WHERE ext_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS departments_ext_uniq
        ON departments (org_id, ext_dept_id) WHERE ext_dept_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS organizations_ext_uniq
        ON organizations (ext_org_id) WHERE ext_org_id IS NOT NULL;
    `)

    this.db.exec(`
      UPDATE users
      SET role = 'user'
      WHERE role IN ('member', 'viewer')
    `)

    const legacyConfigTable = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'app_config'
      LIMIT 1
    `).get() as SqlRow | undefined

    if (legacyConfigTable) {
      this.db.exec(`
        INSERT OR IGNORE INTO server_config (key, value)
        SELECT key, value
        FROM app_config
      `)
    }
  }

  private ensureColumn(
    tableName: string,
    columnName: string,
    statement: string,
  ): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as SqlRow[]
    const hasColumn = columns.some(column => String(column.name) === columnName)
    if (!hasColumn) {
      this.db.exec(statement)
    }
  }

  private dropColumn(tableName: string, columnName: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as SqlRow[]
    const hasColumn = columns.some(column => String(column.name) === columnName)
    if (hasColumn) {
      this.db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`)
    }
  }

  close(): void {
    if (this.#ownsConnection) {
      this.db.close()
    }
  }

  // Organization operations
  createOrganization(
    id: string,
    name: string,
    createdAt: number,
    extOrgId: string | null = null,
  ): void {
    this.db.prepare(`
      INSERT INTO organizations (id, name, ext_org_id, created_at) VALUES (?, ?, ?, ?)
    `).run(id, name, extOrgId, createdAt)
  }

  getOrganization(id: string): AuthCenterOrganization | null {
    const row = this.db.prepare(`
      SELECT * FROM organizations WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapOrganization(row) : null
  }

  listOrganizations(): AuthCenterOrganization[] {
    const rows = this.db.prepare(`
      SELECT * FROM organizations ORDER BY created_at ASC
    `).all() as SqlRow[]
    return rows.map(mapOrganization)
  }

  getOrganizationByName(name: string): AuthCenterOrganization | null {
    const row = this.db.prepare(`
      SELECT * FROM organizations WHERE name = ? ORDER BY created_at ASC LIMIT 1
    `).get(name) as SqlRow | undefined
    return row ? mapOrganization(row) : null
  }

  getOrganizationByExtId(extOrgId: string): AuthCenterOrganization | null {
    const row = this.db.prepare(`
      SELECT * FROM organizations WHERE ext_org_id = ? LIMIT 1
    `).get(extOrgId) as SqlRow | undefined
    return row ? mapOrganization(row) : null
  }

  updateOrganization(
    id: string,
    patch: { name?: string; extOrgId?: string | null },
  ): void {
    const org = this.getOrganization(id)
    if (!org) {
      return
    }
    const nextName = patch.name === undefined ? org.name : patch.name
    const nextExtOrgId = patch.extOrgId === undefined ? org.extOrgId : patch.extOrgId
    this.db.prepare(`
      UPDATE organizations SET name = ?, ext_org_id = ? WHERE id = ?
    `).run(nextName, nextExtOrgId, id)
  }

  /**
   * Delete an organization. Relies on the SQL FK constraint (org_id
   * NOT NULL REFERENCES organizations(id) on both users and departments,
   * with PRAGMA foreign_keys=ON) to reject deletion of a non-empty org —
   * callers should translate the SQLite FOREIGN KEY error into a clean
   * application-level 409. The last-remaining-org case is also covered
   * by the FK (the bootstrap admin row pins it).
   */
  deleteOrganization(id: string): void {
    this.db.prepare(`DELETE FROM organizations WHERE id = ?`).run(id)
  }

  countUsersByOrg(orgId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM users WHERE org_id = ?
    `).get(orgId) as SqlRow | undefined
    return row ? Number(row.c) : 0
  }

  countDepartmentsByOrg(orgId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM departments WHERE org_id = ?
    `).get(orgId) as SqlRow | undefined
    return row ? Number(row.c) : 0
  }

  // Department operations
  createDepartment(department: AuthCenterDepartment): void {
    this.db.prepare(`
      INSERT INTO departments (id, org_id, parent_id, name, ext_dept_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      department.id,
      department.orgId,
      department.parentId,
      department.name,
      department.extDeptId,
      department.createdAt,
      department.updatedAt,
    )
  }

  getDepartmentByExtId(orgId: string, extDeptId: string): AuthCenterDepartment | null {
    const row = this.db.prepare(`
      SELECT * FROM departments WHERE org_id = ? AND ext_dept_id = ? LIMIT 1
    `).get(orgId, extDeptId) as SqlRow | undefined
    return row ? mapDepartment(row) : null
  }

  getDepartmentById(id: string): AuthCenterDepartment | null {
    const row = this.db.prepare(`
      SELECT * FROM departments WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapDepartment(row) : null
  }

  getDepartmentName(id: string | null): string | null {
    if (!id) {
      return null
    }
    const department = this.getDepartmentById(id)
    return department ? department.name : null
  }

  getDepartmentByIdAndOrg(
    id: string,
    orgId: string,
  ): AuthCenterDepartment | null {
    const row = this.db.prepare(`
      SELECT * FROM departments WHERE id = ? AND org_id = ? LIMIT 1
    `).get(id, orgId) as SqlRow | undefined
    return row ? mapDepartment(row) : null
  }

  listDepartmentsByOrg(orgId: string): AuthCenterDepartment[] {
    const rows = this.db.prepare(`
      SELECT * FROM departments WHERE org_id = ? ORDER BY created_at ASC
    `).all(orgId) as SqlRow[]
    return rows.map(mapDepartment)
  }

  updateDepartment(
    id: string,
    patch: {
      name?: string
      parentId?: string | null
      extDeptId?: string | null
    },
  ): void {
    const department = this.getDepartmentById(id)
    if (!department) {
      return
    }

    this.db.prepare(`
      UPDATE departments
      SET name = ?,
          parent_id = ?,
          ext_dept_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      patch.name ?? department.name,
      patch.parentId === undefined ? department.parentId : patch.parentId,
      patch.extDeptId === undefined ? department.extDeptId : patch.extDeptId,
      now(),
      id,
    )
  }

  deleteDepartment(id: string): void {
    this.db.prepare(`
      DELETE FROM departments WHERE id = ?
    `).run(id)
  }

  // User operations
  createUser(user: AuthCenterUser): void {
    this.db.prepare(`
      INSERT INTO users (id, org_id, email, name, display_name, department_id, role, status, password_hash,
                         password_updated_at, last_login_at, created_at, ext_user_id, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.orgId,
      user.email,
      user.name,
      user.displayName ?? null,
      user.departmentId,
      user.role,
      user.status,
      user.passwordHash,
      user.passwordUpdatedAt,
      user.lastLoginAt,
      user.createdAt,
      user.extUserId ?? null,
      user.phone ?? null,
    )
  }

  getUserById(id: string): AuthCenterUser | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapUser(row) : null
  }

  getUserByPhone(phone: string): AuthCenterUser | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE phone = ? LIMIT 1
    `).get(phone) as SqlRow | undefined
    return row ? mapUser(row) : null
  }

  // ---- per-user model gateway credential ----

  /**
   * The user's own token for the metered model gateway, or null when they have
   * none and the shared server key applies.
   */
  getUserModelCredential(userId: string): UserModelCredential | null {
    const row = this.db.prepare(`
      SELECT sudorouter_user_id, sudorouter_key FROM users WHERE id = ? LIMIT 1
    `).get(userId) as SqlRow | undefined
    const key = row?.sudorouter_key
    if (key == null || String(key) === '') return null
    return {
      sudorouterUserId: row?.sudorouter_user_id == null ? null : String(row.sudorouter_user_id),
      sudorouterKey: String(key),
    }
  }

  setUserModelCredential(userId: string, credential: UserModelCredential): void {
    this.db.prepare(`
      UPDATE users SET sudorouter_user_id = ?, sudorouter_key = ? WHERE id = ?
    `).run(credential.sudorouterUserId, credential.sudorouterKey, userId)
  }

  // ---- credit applications (`approve` recharge mode) ----

  createCreditApplication(input: {
    applicationNo: string
    userId: string
    orgId: string
    requestedPoints: number
    reason: string | null
    createdAt: number
  }): CreditApplicationRow {
    this.db.prepare(`
      INSERT INTO credit_applications
        (application_no, user_id, org_id, requested_points, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(
      input.applicationNo,
      input.userId,
      input.orgId,
      input.requestedPoints,
      input.reason,
      input.createdAt,
    )
    const row = this.db.prepare(`
      SELECT * FROM credit_applications WHERE application_no = ?
    `).get(input.applicationNo) as SqlRow
    return mapCreditApplication(row)
  }

  getCreditApplication(id: number): CreditApplicationRow | null {
    const row = this.db.prepare(`
      SELECT * FROM credit_applications WHERE id = ?
    `).get(id) as SqlRow | undefined
    return row ? mapCreditApplication(row) : null
  }

  listCreditApplicationsForUser(
    userId: string,
    limit: number,
    offset: number,
  ): { list: CreditApplicationRow[]; total: number } {
    const rows = this.db.prepare(`
      SELECT * FROM credit_applications
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as SqlRow[]
    const counted = this.db.prepare(`
      SELECT COUNT(*) AS n FROM credit_applications WHERE user_id = ?
    `).get(userId) as SqlRow | undefined
    return { list: rows.map(mapCreditApplication), total: Number(counted?.n ?? 0) }
  }

  /** PROCESSING counts as pending: it is a decision in flight, not a finished one. */
  hasPendingCreditApplication(userId: string): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM credit_applications
      WHERE user_id = ? AND status IN ('PENDING', 'PROCESSING')
    `).get(userId) as SqlRow | undefined
    return Number(row?.n ?? 0) > 0
  }

  updateCreditApplicationStatus(id: number, patch: {
    status: string
    approvedPoints?: number | null
    adminComment?: string | null
    reviewedAt?: number | null
    sudorouterError?: string | null
  }): void {
    const sets = ['status = ?']
    const values: unknown[] = [patch.status]
    // Only the fields the caller named are written; a status move that carries
    // no new comment must not blank the one already recorded.
    if ('approvedPoints' in patch) { sets.push('approved_points = ?'); values.push(patch.approvedPoints ?? null) }
    if ('adminComment' in patch) { sets.push('admin_comment = ?'); values.push(patch.adminComment ?? null) }
    if ('reviewedAt' in patch) { sets.push('reviewed_at = ?'); values.push(patch.reviewedAt ?? null) }
    if ('sudorouterError' in patch) { sets.push('sudorouter_error = ?'); values.push(patch.sudorouterError ?? null) }
    values.push(id)
    this.db.prepare(`UPDATE credit_applications SET ${sets.join(', ')} WHERE id = ?`).run(...values as never[])
  }

  // ---- paid recharge orders (`pay` recharge mode) ----

  createRechargeOrder(input: Omit<RechargeOrderRow, 'id' | 'createdAt' | 'updatedAt' | 'fuiouOrderInfo'
    | 'status' | 'syncStatus' | 'syncError' | 'callbackData' | 'callbackTime'
    | 'callbackAmountCents' | 'remark'>): RechargeOrderRow {
    const ts = now()
    this.db.prepare(`
      INSERT INTO recharge_orders (
        order_no, user_id, user_phone, org_id,
        amount_usd, amount_yuan, amount_cents, exchange_rate,
        quota_amount, points_amount, bonus_points,
        payment_method, order_date, status, sync_status,
        created_at, updated_at, expired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'NONE', ?, ?, ?)
    `).run(
      input.orderNo,
      input.userId,
      input.userPhone,
      input.orgId,
      input.amountUsd,
      input.amountYuan,
      input.amountCents,
      input.exchangeRate,
      input.quotaAmount,
      input.pointsAmount,
      input.bonusPoints,
      input.paymentMethod,
      input.orderDate,
      ts,
      ts,
      input.expiredAt,
    )
    const row = this.db.prepare(`
      SELECT * FROM recharge_orders WHERE order_no = ?
    `).get(input.orderNo) as SqlRow
    return mapRechargeOrder(row)
  }

  getRechargeOrderByNo(orderNo: string): RechargeOrderRow | null {
    const row = this.db.prepare(`
      SELECT * FROM recharge_orders WHERE order_no = ? LIMIT 1
    `).get(orderNo) as SqlRow | undefined
    return row ? mapRechargeOrder(row) : null
  }

  getRechargeOrderById(id: number): RechargeOrderRow | null {
    const row = this.db.prepare(`
      SELECT * FROM recharge_orders WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapRechargeOrder(row) : null
  }

  listRechargeOrdersForUser(
    userId: string,
    limit: number,
    offset: number,
  ): { list: RechargeOrderRow[]; total: number } {
    const rows = this.db.prepare(`
      SELECT * FROM recharge_orders
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as SqlRow[]
    const counted = this.db.prepare(`
      SELECT COUNT(*) AS n FROM recharge_orders WHERE user_id = ?
    `).get(userId) as SqlRow | undefined
    return { list: rows.map(mapRechargeOrder), total: Number(counted?.n ?? 0) }
  }

  listRechargeOrdersForAdmin(input: {
    orgId?: string
    status?: number
    syncStatus?: RechargeSyncStatus
    orderNo?: string
    userPhone?: string
    startDate?: string
    endDate?: string
    limit: number
    offset: number
  }): { list: RechargeOrderRow[]; total: number } {
    const where: string[] = []
    const params: unknown[] = []
    if (input.orgId) {
      where.push('org_id = ?')
      params.push(input.orgId)
    }
    if (input.status !== undefined) {
      where.push('status = ?')
      params.push(input.status)
    }
    if (input.syncStatus) {
      where.push('sync_status = ?')
      params.push(input.syncStatus)
    }
    if (input.orderNo) {
      where.push('order_no LIKE ?')
      params.push(`%${input.orderNo}%`)
    }
    if (input.userPhone) {
      where.push('user_phone LIKE ?')
      params.push(`%${input.userPhone}%`)
    }
    if (input.startDate) {
      const start = Date.parse(`${input.startDate}T00:00:00`)
      if (Number.isFinite(start)) {
        where.push('created_at >= ?')
        params.push(start)
      }
    }
    if (input.endDate) {
      const end = Date.parse(`${input.endDate}T23:59:59`)
      if (Number.isFinite(end)) {
        where.push('created_at <= ?')
        params.push(end)
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM recharge_orders
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const counted = this.db.prepare(`
      SELECT COUNT(*) AS n FROM recharge_orders ${whereSql}
    `).get(...params) as SqlRow | undefined
    return { list: rows.map(mapRechargeOrder), total: Number(counted?.n ?? 0) }
  }

  updateRechargeOrder(id: number, patch: Partial<Pick<RechargeOrderRow,
    'status' | 'syncStatus' | 'syncError' | 'fuiouOrderInfo' | 'callbackData'
    | 'callbackTime' | 'callbackAmountCents' | 'remark'>>): void {
    const columns: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      columns.push(`${column} = ?`)
      values.push(value)
    }
    if ('status' in patch) add('status', patch.status)
    if ('syncStatus' in patch) add('sync_status', patch.syncStatus)
    if ('syncError' in patch) add('sync_error', patch.syncError ?? null)
    if ('fuiouOrderInfo' in patch) add('fuiou_order_info', patch.fuiouOrderInfo ?? null)
    if ('callbackData' in patch) add('callback_data', patch.callbackData ?? null)
    if ('callbackTime' in patch) add('callback_time', patch.callbackTime ?? null)
    if ('callbackAmountCents' in patch) add('callback_amount_cents', patch.callbackAmountCents ?? null)
    if ('remark' in patch) add('remark', patch.remark ?? null)
    if (!columns.length) return
    add('updated_at', now())
    values.push(id)
    this.db.prepare(`
      UPDATE recharge_orders SET ${columns.join(', ')} WHERE id = ?
    `).run(...values as never[])
  }

  claimRechargeRefund(id: number, reason: string): boolean {
    const result = this.db.prepare(`
      UPDATE recharge_orders
      SET status = ?, remark = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(
      4,
      `退款原因: ${reason}`,
      now(),
      id,
      2,
    )
    return result.changes > 0
  }

  createRefundRecord(input: Omit<RefundRecordRow, 'id' | 'createdAt'>): RefundRecordRow {
    const ts = now()
    this.db.prepare(`
      INSERT INTO refund_records (
        refund_no, order_id, order_no, user_id, org_id,
        admin_id,
        refund_amount_yuan, refund_quota, refund_points,
        refund_reason, refund_type, status, sync_status, sync_error,
        fuiou_refund_no, fuiou_response, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.refundNo,
      input.orderId,
      input.orderNo,
      input.userId,
      input.orgId,
      input.adminId,
      input.refundAmountYuan,
      input.refundQuota,
      input.refundPoints,
      input.refundReason,
      input.refundType,
      input.status,
      input.syncStatus,
      input.syncError,
      input.fuiouRefundNo,
      input.fuiouResponse,
      ts,
      input.processedAt,
    )
    const row = this.db.prepare(`
      SELECT * FROM refund_records WHERE refund_no = ?
    `).get(input.refundNo) as SqlRow
    return mapRefundRecord(row)
  }

  listRefundRecordsForAdmin(input: {
    orgId?: string
    orderNo?: string
    userId?: string
    userPhone?: string
    startDate?: string
    endDate?: string
    limit: number
    offset: number
  }): { list: RefundRecordRow[]; total: number } {
    const where: string[] = []
    const params: unknown[] = []
    if (input.orgId) {
      where.push('org_id = ?')
      params.push(input.orgId)
    }
    if (input.orderNo) {
      where.push('order_no LIKE ?')
      params.push(`%${input.orderNo}%`)
    }
    if (input.userId) {
      where.push('user_id = ?')
      params.push(input.userId)
    }
    if (input.userPhone) {
      where.push('order_no IN (SELECT order_no FROM recharge_orders WHERE user_phone LIKE ?)')
      params.push(`%${input.userPhone}%`)
    }
    if (input.startDate) {
      const start = Date.parse(`${input.startDate}T00:00:00`)
      if (Number.isFinite(start)) {
        where.push('created_at >= ?')
        params.push(start)
      }
    }
    if (input.endDate) {
      const end = Date.parse(`${input.endDate}T23:59:59`)
      if (Number.isFinite(end)) {
        where.push('created_at <= ?')
        params.push(end)
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM refund_records
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const counted = this.db.prepare(`
      SELECT COUNT(*) AS n FROM refund_records ${whereSql}
    `).get(...params) as SqlRow | undefined
    return { list: rows.map(mapRefundRecord), total: Number(counted?.n ?? 0) }
  }

  // ---- phone verification codes (login_method: 0) ----

  getPhoneLoginCode(phone: string): PhoneLoginCode | null {
    const row = this.db.prepare(`
      SELECT * FROM phone_login_codes WHERE phone = ? LIMIT 1
    `).get(phone) as SqlRow | undefined
    if (!row) return null
    return {
      phone: String(row.phone),
      codeHash: String(row.code_hash),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      attempts: Number(row.attempts),
    }
  }

  /** One pending code per number: a resend replaces the previous one. */
  upsertPhoneLoginCode(code: PhoneLoginCode): void {
    this.db.prepare(`
      INSERT INTO phone_login_codes (phone, code_hash, created_at, expires_at, attempts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        code_hash = excluded.code_hash,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        attempts = excluded.attempts
    `).run(code.phone, code.codeHash, code.createdAt, code.expiresAt, code.attempts)
  }

  bumpPhoneLoginCodeAttempts(phone: string): void {
    this.db.prepare(`
      UPDATE phone_login_codes SET attempts = attempts + 1 WHERE phone = ?
    `).run(phone)
  }

  deletePhoneLoginCode(phone: string): void {
    this.db.prepare('DELETE FROM phone_login_codes WHERE phone = ?').run(phone)
  }

  /** Drop expired codes and send-log rows older than the rate-limit window. */
  prunePhoneLoginCodes(now: number): void {
    this.db.prepare('DELETE FROM phone_login_codes WHERE expires_at <= ?').run(now)
    this.db.prepare('DELETE FROM phone_login_sends WHERE sent_at < ?').run(now - 24 * 60 * 60 * 1000)
  }

  recordPhoneLoginSend(phone: string, sentAt: number): void {
    this.db.prepare('INSERT INTO phone_login_sends (phone, sent_at) VALUES (?, ?)').run(phone, sentAt)
  }

  countPhoneLoginSends(phone: string, since: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM phone_login_sends WHERE phone = ? AND sent_at >= ?
    `).get(phone, since) as SqlRow | undefined
    return row ? Number(row.n) : 0
  }

  getUserByEmail(email: string): AuthCenterUser | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE email = ? LIMIT 1
    `).get(email) as SqlRow | undefined
    return row ? mapUser(row) : null
  }

  getUserByExtId(orgId: string, extUserId: string): AuthCenterUser | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE org_id = ? AND ext_user_id = ? LIMIT 1
    `).get(orgId, extUserId) as SqlRow | undefined
    return row ? mapUser(row) : null
  }

  listUsersByName(name: string): AuthCenterUser[] {
    const rows = this.db.prepare(`
      SELECT * FROM users WHERE name = ? ORDER BY created_at ASC
    `).all(name) as SqlRow[]
    return rows.map(mapUser)
  }

  getUserByIdAndOrg(id: string, orgId: string): AuthCenterUser | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE id = ? AND org_id = ? LIMIT 1
    `).get(id, orgId) as SqlRow | undefined
    return row ? mapUser(row) : null
  }

  listUsersByOrg(orgId: string): AuthCenterUser[] {
    const rows = this.db.prepare(`
      SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC
    `).all(orgId) as SqlRow[]
    return rows.map(mapUser)
  }

  listUsersByRole(role: string): AuthCenterUser[] {
    const rows = this.db.prepare(`
      SELECT * FROM users WHERE role = ? ORDER BY created_at ASC
    `).all(role) as SqlRow[]
    return rows.map(mapUser)
  }

  updateUserPassword(id: string, passwordHash: string, updatedAt: number): void {
    this.db.prepare(`
      UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?
    `).run(passwordHash, updatedAt, id)
  }

  updateUser(
    id: string,
    patch: {
      name?: string
      displayName?: string | null
      email?: string
      orgId?: string
      departmentId?: string | null
      role?: string
      status?: 'active' | 'disabled'
      extUserId?: string | null
    },
  ): void {
    const user = this.getUserById(id)
    if (!user) {
      return
    }

    this.db.prepare(`
      UPDATE users
      SET name = ?,
          display_name = ?,
          email = ?,
          org_id = ?,
          department_id = ?,
          role = ?,
          status = ?,
          ext_user_id = ?
      WHERE id = ?
    `).run(
      patch.name ?? user.name,
      patch.displayName === undefined ? user.displayName : patch.displayName,
      patch.email ?? user.email,
      patch.orgId ?? user.orgId,
      patch.departmentId === undefined ? user.departmentId : patch.departmentId,
      patch.role ?? user.role,
      patch.status ?? user.status,
      patch.extUserId === undefined ? user.extUserId : patch.extUserId,
      id,
    )
  }

  updateUserLastLogin(id: string): void {
    this.db.prepare(`
      UPDATE users SET last_login_at = ? WHERE id = ?
    `).run(now(), id)
  }

  updateUserOrg(id: string, orgId: string): void {
    this.db.prepare(`
      UPDATE users SET org_id = ? WHERE id = ?
    `).run(orgId, id)
  }

  setUserTokenLimit(id: string, tokenLimit: number | null): void {
    this.db.prepare(`
      UPDATE users SET token_limit = ? WHERE id = ?
    `).run(tokenLimit, id)
  }

  setLocalAuth(id: string, localAuth: boolean): void {
    this.db.prepare(`
      UPDATE users SET local_auth = ? WHERE id = ?
    `).run(localAuth ? 1 : 0, id)
  }

  setDepartmentTokenLimit(id: string, tokenLimit: number | null): void {
    this.db.prepare(`
      UPDATE departments SET token_limit = ? WHERE id = ?
    `).run(tokenLimit, id)
  }

  // API Key operations
  createApiKey(apiKey: AuthCenterApiKey): void {
    this.db.prepare(`
      INSERT INTO api_keys (id, org_id, user_id, name, prefix, secret_hash,
                            scopes_json, status, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      apiKey.id,
      apiKey.orgId,
      apiKey.userId,
      apiKey.name,
      apiKey.prefix,
      apiKey.secretHash,
      JSON.stringify(apiKey.scopes),
      apiKey.status,
      apiKey.createdAt,
      apiKey.lastUsedAt,
    )
  }

  getApiKeyById(id: string): AuthCenterApiKey | null {
    const row = this.db.prepare(`
      SELECT * FROM api_keys WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapApiKey(row) : null
  }

  findActiveApiKey(plainTextKey: string): AuthCenterApiKey | null {
    const match = plainTextKey.match(/^moss_sk_([^\.]+)\.(.+)$/)
    if (!match) {
      return null
    }
    const [, id, secret] = match
    const apiKey = this.getApiKeyById(id)
    if (!apiKey || apiKey.status !== 'active') {
      return null
    }
    return apiKey.secretHash === sha256(secret) ? apiKey : null
  }

  listApiKeysByOrg(orgId: string): AuthCenterApiKey[] {
    const rows = this.db.prepare(`
      SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at ASC
    `).all(orgId) as SqlRow[]
    return rows.map(mapApiKey)
  }

  updateApiKeyLastUsed(id: string): void {
    this.db.prepare(`
      UPDATE api_keys SET last_used_at = ? WHERE id = ?
    `).run(now(), id)
  }

  revokeApiKey(id: string): void {
    this.db.prepare(`
      UPDATE api_keys SET status = 'revoked' WHERE id = ?
    `).run(id)
  }

  // Token revocation operations
  revokeToken(jti: string, expiresAt: number): void {
    this.db.prepare(`
      INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)
      ON CONFLICT(jti) DO UPDATE SET expires_at = excluded.expires_at
    `).run(jti, expiresAt)
  }

  isTokenRevoked(jti: string): boolean {
    const row = this.db.prepare(`
      SELECT jti FROM revoked_tokens WHERE jti = ? LIMIT 1
    `).get(jti) as SqlRow | undefined
    return row !== undefined
  }

  cleanupExpiredRevokedTokens(): void {
    const nowSec = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      DELETE FROM revoked_tokens WHERE expires_at < ?
    `).run(nowSec)
    this.db.prepare(`
      DELETE FROM oauth_provider_tokens WHERE expires_at < ?
    `).run(nowSec)
    this.db.prepare(`
      DELETE FROM minted_service_tokens WHERE expires_at < ?
    `).run(nowSec)
  }

  // OAuth2 provider-token store: holds the provider access_token encrypted,
  // keyed by user_id, so any of a user's sessions (including the runtime
  // container's SESSION_TOKEN) can resolve it and refreshes overwrite the same
  // row. expires_at == the provider token's lifetime. The token never enters
  // the moss JWT or reaches the client.
  putProviderToken(userId: string, token: string, expiresAt: number): void {
    const { enc, iv } = this.#encryptProviderToken(token)
    this.db.prepare(`
      INSERT INTO oauth_provider_tokens (user_id, token_enc, token_iv, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token_enc = excluded.token_enc,
        token_iv = excluded.token_iv,
        expires_at = excluded.expires_at
    `).run(userId, enc, iv, expiresAt)
  }

  getProviderToken(userId: string): { token: string; expiresAt: number } | null {
    const row = this.db.prepare(`
      SELECT token_enc, token_iv, expires_at FROM oauth_provider_tokens WHERE user_id = ? LIMIT 1
    `).get(userId) as SqlRow | undefined
    if (!row) return null
    if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) {
      this.deleteProviderToken(userId)
      return null
    }
    try {
      return {
        token: this.#decryptProviderToken(String(row.token_enc), String(row.token_iv)),
        expiresAt: Number(row.expires_at),
      }
    } catch {
      return null
    }
  }

  deleteProviderToken(userId: string): void {
    this.db.prepare(`
      DELETE FROM oauth_provider_tokens WHERE user_id = ?
    `).run(userId)
  }

  // Per-(user, service) minted access tokens. Same AES-256-GCM encryption as
  // oauth_provider_tokens (reuses #encrypt/#decryptProviderToken), but keyed by
  // (user_id, config_item_id) so each third-party service has its own cached
  // token with its own expiry.
  putMintedToken(userId: string, configItemId: number, token: string, expiresAt: number): void {
    const { enc, iv } = this.#encryptProviderToken(token)
    this.db.prepare(`
      INSERT INTO minted_service_tokens (user_id, config_item_id, token_enc, token_iv, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, config_item_id) DO UPDATE SET
        token_enc = excluded.token_enc,
        token_iv = excluded.token_iv,
        expires_at = excluded.expires_at
    `).run(userId, configItemId, enc, iv, expiresAt)
  }

  getMintedToken(userId: string, configItemId: number): { token: string; expiresAt: number } | null {
    const row = this.db.prepare(`
      SELECT token_enc, token_iv, expires_at FROM minted_service_tokens
      WHERE user_id = ? AND config_item_id = ? LIMIT 1
    `).get(userId, configItemId) as SqlRow | undefined
    if (!row) return null
    if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) {
      this.deleteMintedToken(userId, configItemId)
      return null
    }
    try {
      return {
        token: this.#decryptProviderToken(String(row.token_enc), String(row.token_iv)),
        expiresAt: Number(row.expires_at),
      }
    } catch {
      return null
    }
  }

  deleteMintedToken(userId: string, configItemId: number): void {
    this.db.prepare(`
      DELETE FROM minted_service_tokens WHERE user_id = ? AND config_item_id = ?
    `).run(userId, configItemId)
  }

  // AES-256-GCM. The key is derived from the existing jwt_secret via HKDF, so
  // no new secret is introduced; the auth-token format ('iv:tag:ciphertext'
  // base64url parts) keeps everything in one TEXT column pair.
  #providerTokenKey(): Buffer {
    const secret = this.getJwtSecret()
    if (!secret) {
      throw new Error('jwt_secret not initialized; cannot encrypt provider token')
    }
    return Buffer.from(hkdfSync('sha256', secret, '', 'oauth-provider-token', 32))
  }

  #encryptProviderToken(token: string): { enc: string; iv: string } {
    const key = this.#providerTokenKey()
    const ivBuf = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, ivBuf)
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // Store ciphertext+tag together; iv separately.
    return {
      enc: Buffer.concat([ciphertext, tag]).toString('base64'),
      iv: ivBuf.toString('base64'),
    }
  }

  #decryptProviderToken(enc: string, iv: string): string {
    const key = this.#providerTokenKey()
    const ivBuf = Buffer.from(iv, 'base64')
    const blob = Buffer.from(enc, 'base64')
    const tag = blob.subarray(blob.length - 16)
    const ciphertext = blob.subarray(0, blob.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, ivBuf)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  // Config operations
  getConfig(key: string): string | null {
    const row = this.db.prepare(`
      SELECT value FROM server_config WHERE key = ? LIMIT 1
    `).get(key) as SqlRow | undefined
    return row ? String(row.value) : null
  }

  setConfig(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO server_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  getIssuer(): string {
    return this.getConfig('issuer') ?? 'moss-server'
  }

  getJwtSecret(): string {
    return this.getConfig('jwt_secret') ?? ''
  }

  // Bootstrap - create initial admin user and org
  bootstrap(config: BootstrapAdminConfig = { username: 'admin' }): AuthCenterBootstrap {
    const orgId = randomUUID()
    const adminUserId = randomUUID()
    const resolvedAdmin = resolveBootstrapAdminConfig(config)
    const { apiKey, plainTextKey } = createApiKeyRecord({
      orgId,
      userId: adminUserId,
      name: 'bootstrap-admin',
      scopes: ['*'],
    })

    this.db.exec('BEGIN TRANSACTION')
    try {
      this.createOrganization(orgId, 'Default Organization', now())
      this.createUser({
        id: adminUserId,
        orgId,
        email: resolvedAdmin.email,
        name: resolvedAdmin.username,
        displayName: null,
        departmentId: null,
        // The seeded bootstrap admin is the platform root-of-trust: it gets the
        // super_admin role so it can promote other super admins and switch
        // across organizations. Normal admins cannot mint super admins.
        role: 'super_admin',
        status: 'active',
        localAuth: true,
        tokenLimit: null,
        createdAt: now(),
        passwordHash: hashPassword(resolvedAdmin.password),
        passwordUpdatedAt: now(),
        lastLoginAt: null,
        extUserId: null,
        phone: null,
      })
      this.createApiKey(apiKey)
      this.setConfig('issuer', 'moss-server')
      this.setConfig('jwt_secret', randomBytes(32).toString('base64url'))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return {
      created: true,
      bootstrapAdminUsername: resolvedAdmin.username,
      bootstrapAdminApiKey: plainTextKey,
      bootstrapAdminEmail: resolvedAdmin.email,
      bootstrapAdminPassword: resolvedAdmin.password,
    }
  }

  ensureBootstrapAdmin(config: BootstrapAdminConfig = { username: 'admin' }): AuthCenterBootstrap {
    // A super_admin already exists → nothing to do.
    if (this.listUsersByRole('super_admin').length > 0) {
      return { created: false }
    }

    // Upgrade path for systems bootstrapped before super_admin existed: if there
    // is no super_admin but at least one admin, promote the earliest-created
    // admin (the original bootstrap root-of-trust) to super_admin so org
    // switching and super_admin management work after upgrade. listUsersByRole
    // orders by created_at ASC, so [0] is that original account.
    const admins = this.listUsersByRole('admin')
    if (admins.length > 0) {
      const root = admins[0]
      this.updateUser(root.id, { role: 'super_admin' })
      console.log(`[DB] Promoted existing bootstrap admin "${root.name}" to super_admin`)
      return { created: false }
    }

    const resolvedAdmin = resolveBootstrapAdminConfig(config)
    const existingNameUser = this.listUsersByName(resolvedAdmin.username)[0]
    if (existingNameUser) {
      throw new Error(
        `Cannot create bootstrap admin: username already exists (${resolvedAdmin.username})`,
      )
    }

    const existingEmailUser = this.getUserByEmail(resolvedAdmin.email)
    if (existingEmailUser) {
      throw new Error(
        `Cannot create bootstrap admin: email already exists (${resolvedAdmin.email})`,
      )
    }

    const org = this.listOrganizations()[0]
    const orgId = org?.id ?? randomUUID()
    const adminUserId = randomUUID()
    const { apiKey, plainTextKey } = createApiKeyRecord({
      orgId,
      userId: adminUserId,
      name: 'bootstrap-admin',
      scopes: ['*'],
    })

    this.db.exec('BEGIN TRANSACTION')
    try {
      if (!org) {
        this.createOrganization(orgId, 'Default Organization', now())
      }
      this.createUser({
        id: adminUserId,
        orgId,
        email: resolvedAdmin.email,
        name: resolvedAdmin.username,
        displayName: null,
        departmentId: null,
        // Seeded root-of-trust account — see bootstrap() for rationale.
        role: 'super_admin',
        status: 'active',
        localAuth: true,
        tokenLimit: null,
        createdAt: now(),
        passwordHash: hashPassword(resolvedAdmin.password),
        passwordUpdatedAt: now(),
        lastLoginAt: null,
        extUserId: null,
        phone: null,
      })
      this.createApiKey(apiKey)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return {
      created: true,
      bootstrapAdminUsername: resolvedAdmin.username,
      bootstrapAdminApiKey: plainTextKey,
      bootstrapAdminEmail: resolvedAdmin.email,
      bootstrapAdminPassword: resolvedAdmin.password,
    }
  }

  isInitialized(): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM server_config WHERE key = 'jwt_secret'
    `).get() as SqlRow | undefined
    return Number(row?.count ?? 0) > 0
  }

  // Migration from JSON store
  migrateFromJson(jsonStore: AuthCenterStore): void {
    this.db.exec('BEGIN TRANSACTION')
    try {
      // Migrate organizations
      for (const org of jsonStore.organizations) {
        this.createOrganization(org.id, org.name, org.createdAt)
      }

      // Migrate departments
      for (const department of jsonStore.departments ?? []) {
        this.createDepartment(department)
      }

      // Migrate users
      for (const user of jsonStore.users) {
        this.createUser(user)
      }

      // Migrate api keys
      for (const apiKey of jsonStore.apiKeys) {
        this.createApiKey(apiKey)
      }

      // Migrate config
      this.setConfig('issuer', jsonStore.issuer)
      this.setConfig('jwt_secret', jsonStore.jwtSecret)

      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function toPasswordHashRecord(password: string, salt?: string): string {
  const actualSalt = salt ?? randomBytes(16).toString('hex')
  const derived = scryptSync(password, actualSalt, 64).toString('hex')
  return `scrypt$${actualSalt}$${derived}`
}

export function hashPassword(password: string): string {
  return toPasswordHashRecord(password)
}

export function verifyPassword(
  password: string,
  passwordHash: string | null | undefined,
): boolean {
  if (!passwordHash) {
    return false
  }
  const match = passwordHash.match(/^scrypt\$([^$]+)\$([0-9a-f]+)$/)
  if (!match) {
    return false
  }
  const [, salt, expectedHex] = match
  const actual = Buffer.from(
    toPasswordHashRecord(password, salt).split('$')[2] || '',
    'hex',
  )
  const expected = Buffer.from(expectedHex || '', 'hex')
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  )
}

export function createTemporaryPassword(length = 20): string {
  return randomBytes(length).toString('base64url').slice(0, length)
}

function resolveBootstrapAdminConfig(
  config: BootstrapAdminConfig,
): {
  username: string
  email: string
  password: string
} {
  const username = config.username.trim() || 'admin'
  return {
    username,
    email: resolveBootstrapAdminEmail(username, config.email),
    password:
      typeof config.password === 'string' && config.password.length > 0
        ? config.password
        : createTemporaryPassword(),
  }
}

function resolveBootstrapAdminEmail(
  username: string,
  configuredEmail?: string,
): string {
  const email = configuredEmail?.trim()
  if (email) {
    return email
  }

  const localPart = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `${localPart || 'admin'}@local`
}

function createApiKeyValue(id: string, secret: string): string {
  return `moss_sk_${id}.${secret}`
}

export function createApiKeyRecord(input: {
  orgId: string
  userId: string
  name: string
  scopes: string[]
}): {
  apiKey: AuthCenterApiKey
  plainTextKey: string
} {
  const id = randomUUID()
  const secret = randomBytes(24).toString('base64url')
  const plainTextKey = createApiKeyValue(id, secret)

  return {
    apiKey: {
      id,
      orgId: input.orgId,
      userId: input.userId,
      name: input.name,
      prefix: plainTextKey.slice(0, 16),
      secretHash: sha256(secret),
      scopes: input.scopes,
      status: 'active',
      createdAt: Date.now(),
      lastUsedAt: null,
    },
    plainTextKey,
  }
}

// JSON store compatibility - for migration detection
export async function readJsonAuthCenterStore(
  jsonPath: string,
): Promise<AuthCenterStore> {
  const { readFile } = await import('fs/promises')
  const raw = await readFile(jsonPath, 'utf8')
  const parsed = JSON.parse(raw) as AuthCenterStore
  if (
    (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
    typeof parsed.issuer !== 'string' ||
    typeof parsed.jwtSecret !== 'string' ||
    !Array.isArray(parsed.organizations) ||
    !Array.isArray(parsed.users) ||
    !Array.isArray(parsed.apiKeys)
  ) {
    throw new Error(`Invalid auth center store: ${jsonPath}`)
  }
  return {
    version: 3,
    issuer: parsed.issuer,
    jwtSecret: parsed.jwtSecret,
    organizations: parsed.organizations.map(org => ({
      ...org,
      extOrgId: (org as Partial<AuthCenterOrganization>).extOrgId ?? null,
    })),
    departments: (parsed.departments ?? []).map(dept => ({
      ...dept,
      extDeptId: (dept as Partial<AuthCenterDepartment>).extDeptId ?? null,
    })),
    users: parsed.users.map(user => ({
      ...user,
      displayName: (user as Partial<AuthCenterUser>).displayName ?? null,
      departmentId: user.departmentId ?? null,
      passwordHash: user.passwordHash ?? null,
      passwordUpdatedAt: user.passwordUpdatedAt ?? null,
      lastLoginAt: user.lastLoginAt ?? null,
      extUserId: (user as Partial<AuthCenterUser>).extUserId ?? null,
    })),
    apiKeys: parsed.apiKeys,
  }
}

export function sanitizeApiKey(apiKey: AuthCenterApiKey): Omit<
  AuthCenterApiKey,
  'secretHash'
> {
  const { secretHash: _secretHash, ...rest } = apiKey
  return rest
}

export function sanitizeUser(
  user: AuthCenterUser,
): SanitizedAuthCenterUser {
  const { passwordHash: _passwordHash, email, ...rest } = user
  return {
    ...rest,
    email: sanitizePublicEmail(email),
  }
}

function sanitizePublicEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const [, domain = ''] = normalized.split('@')
  if (domain === INTERNAL_EMAIL_DOMAIN || domain === 'local') {
    return null
  }

  return email
}

export function createSyntheticUserEmail(seed: string): string {
  const localPart = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `${localPart || randomUUID()}@${INTERNAL_EMAIL_DOMAIN}`
}
