import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver, type DbDriver, type SqlParam } from '../db/driver.js'
import type { DirectConnectStore } from '../db.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

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
  // Async DB seam (HA PostgreSQL support). In the shared-store construction
  // form this is the DirectConnectStore's driver, so every store shares one
  // sqlite connection / one PG Pool and transactions can span stores. In the
  // standalone (path/handle) construction forms it stays a private
  // SqliteDriver over `db` — zero behaviour change. Schema init stays sqlite
  // ad-hoc on the raw `db`; the postgres path gets its schema from pg_schema.ts.
  readonly driver: DbDriver
  readonly dbPath: string
  readonly #ownsConnection: boolean
  // jwt_secret and issuer are written exactly once (bootstrap / migrateFromJson)
  // and never rotated at runtime, so they are cached in memory. This keeps
  // getJwtSecret()/getIssuer() synchronous — they sit on the per-request token
  // verification hot path, which must not become async just to read an
  // immutable value. Populated by loadSecretCache() and kept fresh by setConfig.
  #jwtSecret: string | null = null
  #issuer: string | null = null

  constructor(dbOrPath: string | DatabaseSync | DirectConnectStore, dbPath?: string) {
    // Shared-store form (the production path): shares the store's driver so
    // every store funnels through one connection/Pool — sqlite keeps its own
    // SqliteDriver over the same DatabaseSync handle (zero behaviour change),
    // postgres shares the PgDriver Pool and skips the sqlite-only schema init
    // (tables come from pg_schema.ts, applied by openStoreAsync).
    if (typeof dbOrPath !== 'string' && !(dbOrPath instanceof DatabaseSync)) {
      const store = dbOrPath as DirectConnectStore
      this.dbPath = store.dbPath
      this.db = store.db ?? (undefined as unknown as DatabaseSync)
      this.#ownsConnection = false
      this.driver = store.driver
      if (store.db) {
        this.initTables()
      }
      return
    }
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
    this.driver = new SqliteDriver(this.db)
    this.initTables()
  }

  /**
   * Load the immutable jwt_secret / issuer into the in-memory cache. Call once
   * after construction (and after bootstrap) before the token-verification hot
   * path runs. Safe to call repeatedly; a fresh DB with no secret yet leaves the
   * cache null until bootstrap writes it (setConfig updates the cache directly).
   */
  async loadSecretCache(): Promise<void> {
    this.#jwtSecret = await this.getConfig('jwt_secret')
    this.#issuer = await this.getConfig('issuer')
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
        INSERT INTO server_config (key, value)
        SELECT key, value
        FROM app_config
        WHERE true
        ON CONFLICT(key) DO NOTHING
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
  async createOrganization(
    id: string,
    name: string,
    createdAt: number,
    extOrgId: string | null = null,
  ): Promise<void> {
    await this.driver.run(`
      INSERT INTO organizations (id, name, ext_org_id, created_at) VALUES (?, ?, ?, ?)
    `, [id, name, extOrgId, createdAt])
  }

  async getOrganization(id: string): Promise<AuthCenterOrganization | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM organizations WHERE id = ? LIMIT 1
    `, [id])
    return row ? mapOrganization(row) : null
  }

  async listOrganizations(): Promise<AuthCenterOrganization[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM organizations ORDER BY created_at ASC
    `)
    return rows.map(mapOrganization)
  }

  async getOrganizationByName(name: string): Promise<AuthCenterOrganization | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM organizations WHERE name = ? ORDER BY created_at ASC LIMIT 1
    `, [name])
    return row ? mapOrganization(row) : null
  }

  async getOrganizationByExtId(extOrgId: string): Promise<AuthCenterOrganization | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM organizations WHERE ext_org_id = ? LIMIT 1
    `, [extOrgId])
    return row ? mapOrganization(row) : null
  }

  async updateOrganization(
    id: string,
    patch: { name?: string; extOrgId?: string | null },
  ): Promise<void> {
    const org = await this.getOrganization(id)
    if (!org) {
      return
    }
    const nextName = patch.name === undefined ? org.name : patch.name
    const nextExtOrgId = patch.extOrgId === undefined ? org.extOrgId : patch.extOrgId
    await this.driver.run(`
      UPDATE organizations SET name = ?, ext_org_id = ? WHERE id = ?
    `, [nextName, nextExtOrgId, id])
  }

  /**
   * Delete an organization. Relies on the SQL FK constraint (org_id
   * NOT NULL REFERENCES organizations(id) on both users and departments,
   * with PRAGMA foreign_keys=ON) to reject deletion of a non-empty org —
   * callers should translate the SQLite FOREIGN KEY error into a clean
   * application-level 409. The last-remaining-org case is also covered
   * by the FK (the bootstrap admin row pins it).
   */
  async deleteOrganization(id: string): Promise<void> {
    await this.driver.run(`DELETE FROM organizations WHERE id = ?`, [id])
  }

  async countUsersByOrg(orgId: string): Promise<number> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS c FROM users WHERE org_id = ?
    `, [orgId])
    return row ? Number(row.c) : 0
  }

  async countDepartmentsByOrg(orgId: string): Promise<number> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS c FROM departments WHERE org_id = ?
    `, [orgId])
    return row ? Number(row.c) : 0
  }

  // Department operations
  async createDepartment(department: AuthCenterDepartment): Promise<void> {
    await this.driver.run(`
      INSERT INTO departments (id, org_id, parent_id, name, ext_dept_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      department.id,
      department.orgId,
      department.parentId,
      department.name,
      department.extDeptId,
      department.createdAt,
      department.updatedAt,
    ])
  }

  async getDepartmentByExtId(orgId: string, extDeptId: string): Promise<AuthCenterDepartment | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM departments WHERE org_id = ? AND ext_dept_id = ? LIMIT 1
    `, [orgId, extDeptId])
    return row ? mapDepartment(row) : null
  }

  async getDepartmentById(id: string): Promise<AuthCenterDepartment | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM departments WHERE id = ? LIMIT 1
    `, [id])
    return row ? mapDepartment(row) : null
  }

  async getDepartmentName(id: string | null): Promise<string | null> {
    if (!id) {
      return null
    }
    const department = await this.getDepartmentById(id)
    return department ? department.name : null
  }

  async getDepartmentByIdAndOrg(
    id: string,
    orgId: string,
  ): Promise<AuthCenterDepartment | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM departments WHERE id = ? AND org_id = ? LIMIT 1
    `, [id, orgId])
    return row ? mapDepartment(row) : null
  }

  async listDepartmentsByOrg(orgId: string): Promise<AuthCenterDepartment[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM departments WHERE org_id = ? ORDER BY created_at ASC
    `, [orgId])
    return rows.map(mapDepartment)
  }

  async updateDepartment(
    id: string,
    patch: {
      name?: string
      parentId?: string | null
      extDeptId?: string | null
    },
  ): Promise<void> {
    const department = await this.getDepartmentById(id)
    if (!department) {
      return
    }

    await this.driver.run(`
      UPDATE departments
      SET name = ?,
          parent_id = ?,
          ext_dept_id = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      patch.name ?? department.name,
      patch.parentId === undefined ? department.parentId : patch.parentId,
      patch.extDeptId === undefined ? department.extDeptId : patch.extDeptId,
      now(),
      id,
    ])
  }

  async deleteDepartment(id: string): Promise<void> {
    await this.driver.run(`
      DELETE FROM departments WHERE id = ?
    `, [id])
  }

  // User operations
  async createUser(user: AuthCenterUser): Promise<void> {
    await this.driver.run(`
      INSERT INTO users (id, org_id, email, name, display_name, department_id, role, status, password_hash,
                         password_updated_at, last_login_at, created_at, ext_user_id, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ])
  }

  async getUserById(id: string): Promise<AuthCenterUser | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM users WHERE id = ? LIMIT 1
    `, [id])
    return row ? mapUser(row) : null
  }

  async getUserByPhone(phone: string): Promise<AuthCenterUser | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM users WHERE phone = ? LIMIT 1
    `, [phone])
    return row ? mapUser(row) : null
  }

  // ---- per-user model gateway credential ----

  /**
   * The user's own token for the metered model gateway, or null when they have
   * none and the shared server key applies.
   */
  async getUserModelCredential(userId: string): Promise<UserModelCredential | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT sudorouter_user_id, sudorouter_key FROM users WHERE id = ? LIMIT 1
    `, [userId])
    const key = row?.sudorouter_key
    if (key == null || String(key) === '') return null
    return {
      sudorouterUserId: row?.sudorouter_user_id == null ? null : String(row.sudorouter_user_id),
      sudorouterKey: String(key),
    }
  }

  async setUserModelCredential(userId: string, credential: UserModelCredential): Promise<void> {
    await this.driver.run(`
      UPDATE users SET sudorouter_user_id = ?, sudorouter_key = ? WHERE id = ?
    `, [credential.sudorouterUserId, credential.sudorouterKey, userId])
  }

  // ---- credit applications (`approve` recharge mode) ----

  async createCreditApplication(input: {
    applicationNo: string
    userId: string
    orgId: string
    requestedPoints: number
    reason: string | null
    createdAt: number
  }): Promise<CreditApplicationRow> {
    await this.driver.run(`
      INSERT INTO credit_applications
        (application_no, user_id, org_id, requested_points, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
    `, [
      input.applicationNo,
      input.userId,
      input.orgId,
      input.requestedPoints,
      input.reason,
      input.createdAt,
    ])
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM credit_applications WHERE application_no = ?
    `, [input.applicationNo]) as SqlRow
    return mapCreditApplication(row)
  }

  async getCreditApplication(id: number): Promise<CreditApplicationRow | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM credit_applications WHERE id = ?
    `, [id])
    return row ? mapCreditApplication(row) : null
  }

  async listCreditApplicationsForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ list: CreditApplicationRow[]; total: number }> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM credit_applications
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset])
    const counted = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS n FROM credit_applications WHERE user_id = ?
    `, [userId])
    return { list: rows.map(mapCreditApplication), total: Number(counted?.n ?? 0) }
  }

  /** PROCESSING counts as pending: it is a decision in flight, not a finished one. */
  async hasPendingCreditApplication(userId: string): Promise<boolean> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS n FROM credit_applications
      WHERE user_id = ? AND status IN ('PENDING', 'PROCESSING')
    `, [userId])
    return Number(row?.n ?? 0) > 0
  }

  async updateCreditApplicationStatus(id: number, patch: {
    status: string
    approvedPoints?: number | null
    adminComment?: string | null
    reviewedAt?: number | null
    sudorouterError?: string | null
  }): Promise<void> {
    const sets = ['status = ?']
    const values: SqlParam[] = [patch.status]
    // Only the fields the caller named are written; a status move that carries
    // no new comment must not blank the one already recorded.
    if ('approvedPoints' in patch) { sets.push('approved_points = ?'); values.push(patch.approvedPoints ?? null) }
    if ('adminComment' in patch) { sets.push('admin_comment = ?'); values.push(patch.adminComment ?? null) }
    if ('reviewedAt' in patch) { sets.push('reviewed_at = ?'); values.push(patch.reviewedAt ?? null) }
    if ('sudorouterError' in patch) { sets.push('sudorouter_error = ?'); values.push(patch.sudorouterError ?? null) }
    values.push(id)
    await this.driver.run(`UPDATE credit_applications SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  // ---- phone verification codes (login_method: 0) ----

  async getPhoneLoginCode(phone: string): Promise<PhoneLoginCode | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM phone_login_codes WHERE phone = ? LIMIT 1
    `, [phone])
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
  async upsertPhoneLoginCode(code: PhoneLoginCode): Promise<void> {
    await this.driver.run(`
      INSERT INTO phone_login_codes (phone, code_hash, created_at, expires_at, attempts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        code_hash = excluded.code_hash,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        attempts = excluded.attempts
    `, [code.phone, code.codeHash, code.createdAt, code.expiresAt, code.attempts])
  }

  async bumpPhoneLoginCodeAttempts(phone: string): Promise<void> {
    await this.driver.run(`
      UPDATE phone_login_codes SET attempts = attempts + 1 WHERE phone = ?
    `, [phone])
  }

  async deletePhoneLoginCode(phone: string): Promise<void> {
    await this.driver.run('DELETE FROM phone_login_codes WHERE phone = ?', [phone])
  }

  /** Drop expired codes and send-log rows older than the rate-limit window. */
  async prunePhoneLoginCodes(now: number): Promise<void> {
    await this.driver.run('DELETE FROM phone_login_codes WHERE expires_at <= ?', [now])
    await this.driver.run('DELETE FROM phone_login_sends WHERE sent_at < ?', [now - 24 * 60 * 60 * 1000])
  }

  async recordPhoneLoginSend(phone: string, sentAt: number): Promise<void> {
    await this.driver.run('INSERT INTO phone_login_sends (phone, sent_at) VALUES (?, ?)', [phone, sentAt])
  }

  async countPhoneLoginSends(phone: string, since: number): Promise<number> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS n FROM phone_login_sends WHERE phone = ? AND sent_at >= ?
    `, [phone, since])
    return row ? Number(row.n) : 0
  }

  async getUserByEmail(email: string): Promise<AuthCenterUser | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM users WHERE email = ? LIMIT 1
    `, [email])
    return row ? mapUser(row) : null
  }

  async getUserByExtId(orgId: string, extUserId: string): Promise<AuthCenterUser | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM users WHERE org_id = ? AND ext_user_id = ? LIMIT 1
    `, [orgId, extUserId])
    return row ? mapUser(row) : null
  }

  async listUsersByName(name: string): Promise<AuthCenterUser[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM users WHERE name = ? ORDER BY created_at ASC
    `, [name])
    return rows.map(mapUser)
  }

  async getUserByIdAndOrg(id: string, orgId: string): Promise<AuthCenterUser | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM users WHERE id = ? AND org_id = ? LIMIT 1
    `, [id, orgId])
    return row ? mapUser(row) : null
  }

  async listUsersByOrg(orgId: string): Promise<AuthCenterUser[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC
    `, [orgId])
    return rows.map(mapUser)
  }

  async listUsersByRole(role: string): Promise<AuthCenterUser[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM users WHERE role = ? ORDER BY created_at ASC
    `, [role])
    return rows.map(mapUser)
  }

  async updateUserPassword(id: string, passwordHash: string, updatedAt: number): Promise<void> {
    await this.driver.run(`
      UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?
    `, [passwordHash, updatedAt, id])
  }

  async updateUser(
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
  ): Promise<void> {
    const user = await this.getUserById(id)
    if (!user) {
      return
    }

    await this.driver.run(`
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
    `, [
      patch.name ?? user.name,
      patch.displayName === undefined ? user.displayName : patch.displayName,
      patch.email ?? user.email,
      patch.orgId ?? user.orgId,
      patch.departmentId === undefined ? user.departmentId : patch.departmentId,
      patch.role ?? user.role,
      patch.status ?? user.status,
      patch.extUserId === undefined ? user.extUserId : patch.extUserId,
      id,
    ])
  }

  async updateUserLastLogin(id: string): Promise<void> {
    await this.driver.run(`
      UPDATE users SET last_login_at = ? WHERE id = ?
    `, [now(), id])
  }

  async updateUserOrg(id: string, orgId: string): Promise<void> {
    await this.driver.run(`
      UPDATE users SET org_id = ? WHERE id = ?
    `, [orgId, id])
  }

  async setUserTokenLimit(id: string, tokenLimit: number | null): Promise<void> {
    await this.driver.run(`
      UPDATE users SET token_limit = ? WHERE id = ?
    `, [tokenLimit, id])
  }

  async setLocalAuth(id: string, localAuth: boolean): Promise<void> {
    await this.driver.run(`
      UPDATE users SET local_auth = ? WHERE id = ?
    `, [localAuth ? 1 : 0, id])
  }

  async setDepartmentTokenLimit(id: string, tokenLimit: number | null): Promise<void> {
    await this.driver.run(`
      UPDATE departments SET token_limit = ? WHERE id = ?
    `, [tokenLimit, id])
  }

  // API Key operations
  async createApiKey(apiKey: AuthCenterApiKey): Promise<void> {
    await this.driver.run(`
      INSERT INTO api_keys (id, org_id, user_id, name, prefix, secret_hash,
                            scopes_json, status, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ])
  }

  async getApiKeyById(id: string): Promise<AuthCenterApiKey | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM api_keys WHERE id = ? LIMIT 1
    `, [id])
    return row ? mapApiKey(row) : null
  }

  async findActiveApiKey(plainTextKey: string): Promise<AuthCenterApiKey | null> {
    const match = plainTextKey.match(/^moss_sk_([^\.]+)\.(.+)$/)
    if (!match) {
      return null
    }
    const [, id, secret] = match
    const apiKey = await this.getApiKeyById(id)
    if (!apiKey || apiKey.status !== 'active') {
      return null
    }
    return apiKey.secretHash === sha256(secret) ? apiKey : null
  }

  async listApiKeysByOrg(orgId: string): Promise<AuthCenterApiKey[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at ASC
    `, [orgId])
    return rows.map(mapApiKey)
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    await this.driver.run(`
      UPDATE api_keys SET last_used_at = ? WHERE id = ?
    `, [now(), id])
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.driver.run(`
      UPDATE api_keys SET status = 'revoked' WHERE id = ?
    `, [id])
  }

  // Token revocation operations
  async revokeToken(jti: string, expiresAt: number): Promise<void> {
    await this.driver.run(`
      INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)
      ON CONFLICT(jti) DO UPDATE SET expires_at = excluded.expires_at
    `, [jti, expiresAt])
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    const row = await this.driver.get<SqlRow>(`
      SELECT jti FROM revoked_tokens WHERE jti = ? LIMIT 1
    `, [jti])
    return row !== undefined
  }

  async cleanupExpiredRevokedTokens(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000)
    await this.driver.run(`
      DELETE FROM revoked_tokens WHERE expires_at < ?
    `, [nowSec])
    await this.driver.run(`
      DELETE FROM oauth_provider_tokens WHERE expires_at < ?
    `, [nowSec])
    await this.driver.run(`
      DELETE FROM minted_service_tokens WHERE expires_at < ?
    `, [nowSec])
  }

  // OAuth2 provider-token store: holds the provider access_token encrypted,
  // keyed by user_id, so any of a user's sessions (including the runtime
  // container's SESSION_TOKEN) can resolve it and refreshes overwrite the same
  // row. expires_at == the provider token's lifetime. The token never enters
  // the moss JWT or reaches the client.
  async putProviderToken(userId: string, token: string, expiresAt: number): Promise<void> {
    const { enc, iv } = this.#encryptProviderToken(token)
    await this.driver.run(`
      INSERT INTO oauth_provider_tokens (user_id, token_enc, token_iv, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token_enc = excluded.token_enc,
        token_iv = excluded.token_iv,
        expires_at = excluded.expires_at
    `, [userId, enc, iv, expiresAt])
  }

  async getProviderToken(userId: string): Promise<{ token: string; expiresAt: number } | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT token_enc, token_iv, expires_at FROM oauth_provider_tokens WHERE user_id = ? LIMIT 1
    `, [userId])
    if (!row) return null
    if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) {
      await this.deleteProviderToken(userId)
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

  async deleteProviderToken(userId: string): Promise<void> {
    await this.driver.run(`
      DELETE FROM oauth_provider_tokens WHERE user_id = ?
    `, [userId])
  }

  // Per-(user, service) minted access tokens. Same AES-256-GCM encryption as
  // oauth_provider_tokens (reuses #encrypt/#decryptProviderToken), but keyed by
  // (user_id, config_item_id) so each third-party service has its own cached
  // token with its own expiry.
  async putMintedToken(userId: string, configItemId: number, token: string, expiresAt: number): Promise<void> {
    const { enc, iv } = this.#encryptProviderToken(token)
    await this.driver.run(`
      INSERT INTO minted_service_tokens (user_id, config_item_id, token_enc, token_iv, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, config_item_id) DO UPDATE SET
        token_enc = excluded.token_enc,
        token_iv = excluded.token_iv,
        expires_at = excluded.expires_at
    `, [userId, configItemId, enc, iv, expiresAt])
  }

  async getMintedToken(userId: string, configItemId: number): Promise<{ token: string; expiresAt: number } | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT token_enc, token_iv, expires_at FROM minted_service_tokens
      WHERE user_id = ? AND config_item_id = ? LIMIT 1
    `, [userId, configItemId])
    if (!row) return null
    if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) {
      await this.deleteMintedToken(userId, configItemId)
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

  async deleteMintedToken(userId: string, configItemId: number): Promise<void> {
    await this.driver.run(`
      DELETE FROM minted_service_tokens WHERE user_id = ? AND config_item_id = ?
    `, [userId, configItemId])
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
  async getConfig(key: string): Promise<string | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT value FROM server_config WHERE key = ? LIMIT 1
    `, [key])
    return row ? String(row.value) : null
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.driver.run(`
      INSERT INTO server_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, value])
    // Keep the in-memory cache coherent for the immutable hot-path values.
    if (key === 'jwt_secret') this.#jwtSecret = value
    else if (key === 'issuer') this.#issuer = value
  }

  getIssuer(): string {
    return this.#issuer ?? 'moss-server'
  }

  getJwtSecret(): string {
    return this.#jwtSecret ?? ''
  }

  // Bootstrap - create initial admin user and org
  async bootstrap(config: BootstrapAdminConfig = { username: 'admin' }): Promise<AuthCenterBootstrap> {
    const orgId = randomUUID()
    const adminUserId = randomUUID()
    const resolvedAdmin = resolveBootstrapAdminConfig(config)
    const { apiKey, plainTextKey } = createApiKeyRecord({
      orgId,
      userId: adminUserId,
      name: 'bootstrap-admin',
      scopes: ['*'],
    })

    await this.driver.transaction(async () => {
      await this.createOrganization(orgId, 'Default Organization', now())
      await this.createUser({
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
      await this.createApiKey(apiKey)
      await this.setConfig('issuer', 'moss-server')
      await this.setConfig('jwt_secret', randomBytes(32).toString('base64url'))
    })

    return {
      created: true,
      bootstrapAdminUsername: resolvedAdmin.username,
      bootstrapAdminApiKey: plainTextKey,
      bootstrapAdminEmail: resolvedAdmin.email,
      bootstrapAdminPassword: resolvedAdmin.password,
    }
  }

  async ensureBootstrapAdmin(config: BootstrapAdminConfig = { username: 'admin' }): Promise<AuthCenterBootstrap> {
    // A super_admin already exists → nothing to do.
    if ((await this.listUsersByRole('super_admin')).length > 0) {
      return { created: false }
    }

    // Upgrade path for systems bootstrapped before super_admin existed: if there
    // is no super_admin but at least one admin, promote the earliest-created
    // admin (the original bootstrap root-of-trust) to super_admin so org
    // switching and super_admin management work after upgrade. listUsersByRole
    // orders by created_at ASC, so [0] is that original account.
    const admins = await this.listUsersByRole('admin')
    if (admins.length > 0) {
      const root = admins[0]
      await this.updateUser(root.id, { role: 'super_admin' })
      console.log(`[DB] Promoted existing bootstrap admin "${root.name}" to super_admin`)
      return { created: false }
    }

    const resolvedAdmin = resolveBootstrapAdminConfig(config)
    const existingNameUser = (await this.listUsersByName(resolvedAdmin.username))[0]
    if (existingNameUser) {
      throw new Error(
        `Cannot create bootstrap admin: username already exists (${resolvedAdmin.username})`,
      )
    }

    const existingEmailUser = await this.getUserByEmail(resolvedAdmin.email)
    if (existingEmailUser) {
      throw new Error(
        `Cannot create bootstrap admin: email already exists (${resolvedAdmin.email})`,
      )
    }

    const org = (await this.listOrganizations())[0]
    const orgId = org?.id ?? randomUUID()
    const adminUserId = randomUUID()
    const { apiKey, plainTextKey } = createApiKeyRecord({
      orgId,
      userId: adminUserId,
      name: 'bootstrap-admin',
      scopes: ['*'],
    })

    await this.driver.transaction(async () => {
      if (!org) {
        await this.createOrganization(orgId, 'Default Organization', now())
      }
      await this.createUser({
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
      await this.createApiKey(apiKey)
    })

    return {
      created: true,
      bootstrapAdminUsername: resolvedAdmin.username,
      bootstrapAdminApiKey: plainTextKey,
      bootstrapAdminEmail: resolvedAdmin.email,
      bootstrapAdminPassword: resolvedAdmin.password,
    }
  }

  async isInitialized(): Promise<boolean> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS count FROM server_config WHERE key = 'jwt_secret'
    `)
    return Number(row?.count ?? 0) > 0
  }

  // Migration from JSON store
  async migrateFromJson(jsonStore: AuthCenterStore): Promise<void> {
    await this.driver.transaction(async () => {
      // Migrate organizations
      for (const org of jsonStore.organizations) {
        await this.createOrganization(org.id, org.name, org.createdAt)
      }

      // Migrate departments
      for (const department of jsonStore.departments ?? []) {
        await this.createDepartment(department)
      }

      // Migrate users
      for (const user of jsonStore.users) {
        await this.createUser(user)
      }

      // Migrate api keys
      for (const apiKey of jsonStore.apiKeys) {
        await this.createApiKey(apiKey)
      }

      // Migrate config
      await this.setConfig('issuer', jsonStore.issuer)
      await this.setConfig('jwt_secret', jsonStore.jwtSecret)
    })
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
