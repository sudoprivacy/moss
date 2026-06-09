import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
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
  name: string
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
    // Ruigu's bizOrgCode / user_id / groupIds[0]). All nullable —
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
      INSERT INTO users (id, org_id, email, name, department_id, role, status, password_hash,
                         password_updated_at, last_login_at, created_at, ext_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.orgId,
      user.email,
      user.name,
      user.departmentId,
      user.role,
      user.status,
      user.passwordHash,
      user.passwordUpdatedAt,
      user.lastLoginAt,
      user.createdAt,
      user.extUserId ?? null,
    )
  }

  getUserById(id: string): AuthCenterUser | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapUser(row) : null
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
          email = ?,
          org_id = ?,
          department_id = ?,
          role = ?,
          status = ?,
          ext_user_id = ?
      WHERE id = ?
    `).run(
      patch.name ?? user.name,
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
