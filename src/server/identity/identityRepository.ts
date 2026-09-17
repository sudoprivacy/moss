import type { DatabaseSync } from 'node:sqlite'
import { fromStoredPointUnits, toStoredPointUnits } from '../billing/pointUnits.js'

export type OrganizationLoginMethod = 'sms' | 'password' | 'cas'

export interface OrganizationProfile {
  orgId: string
  code: string
  loginMethod: OrganizationLoginMethod
  localEnabled: boolean
  cloudEnabled: boolean
  clientCronEnabled: boolean
  logo: string | null
  appName: string | null
  topName: string | null
  aboutName: string | null
  appCompanyName: string | null
  loginDescription: string | null
  createdAt: number
  updatedAt: number
}

export interface AuthIdentity {
  id: string
  orgId: string
  userId: string
  provider: string
  issuer: string
  normalizedSubject: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface InvitationRecord {
  id: string
  orgId: string
  code: string
  status: 'pending' | 'used' | 'revoked'
  initialCreditUnits: number
  legacyInitialQuotaUsd: number | null
  usedByUserId: string | null
  createdAt: number
  usedAt: number | null
}

export interface OutboxEventRecord {
  id: string
  status: 'pending' | 'suppressed' | 'completed' | 'failed'
  contextSource: 'online' | 'migration' | 'replay'
  idempotencyKey: string
  suppressReason: string | null
}

export interface IntegrationConnection {
  id: string
  orgId: string
  providerType: string
  name: string
  enabled: boolean
  secretRef: string | null
  config: Record<string, unknown>
}

export interface OperationAuditRecord {
  id: string
  legacyId: number
  orgId: string
  actorUserId: string | null
  actorLegacyId: number | null
  actorName: string | null
  action: string
  resource: string
  resourceId: string | null
  method: string | null
  path: string | null
  legacyParamsRaw: string | null
  legacyRequestDataRaw: string | null
  legacyResponseDataRaw: string | null
  requestData: unknown
  responseData: unknown
  responseStatus: number | null
  ipAddress: string | null
  userAgent: string | null
  durationMs: number | null
  errorMessage: string | null
  idempotencyKey: string
  createdAt: number
}

type SqlRow = Record<string, unknown>

function now(): number {
  return Date.now()
}

function mapOrganizationProfile(row: SqlRow): OrganizationProfile {
  return {
    orgId: String(row.org_id),
    code: String(row.code),
    loginMethod: String(row.login_method) as OrganizationLoginMethod,
    localEnabled: Boolean(row.local_enabled),
    cloudEnabled: Boolean(row.cloud_enabled),
    clientCronEnabled: row.client_cron_enabled == null ? true : Boolean(row.client_cron_enabled),
    logo: row.logo == null ? null : String(row.logo),
    appName: row.app_name == null ? null : String(row.app_name),
    topName: row.top_name == null ? null : String(row.top_name),
    aboutName: row.about_name == null ? null : String(row.about_name),
    appCompanyName: row.app_company_name == null ? null : String(row.app_company_name),
    loginDescription: row.login_description == null ? null : String(row.login_description),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapAuthIdentity(row: SqlRow): AuthIdentity {
  let metadata: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(String(row.metadata_json)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>
    }
  } catch {
    // Corrupt optional metadata must not break identity resolution.
  }
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    provider: String(row.provider),
    issuer: String(row.issuer),
    normalizedSubject: String(row.normalized_subject),
    metadata,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapInvitation(row: SqlRow): InvitationRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    code: String(row.code),
    status: String(row.status) as InvitationRecord['status'],
    initialCreditUnits: Number(row.initial_credit_units),
    legacyInitialQuotaUsd: row.legacy_initial_quota_usd == null
      ? null
      : Number(row.legacy_initial_quota_usd),
    usedByUserId: row.used_by_user_id == null ? null : String(row.used_by_user_id),
    createdAt: Number(row.created_at),
    usedAt: row.used_at == null ? null : Number(row.used_at),
  }
}

function mapIntegrationConnection(row: SqlRow): IntegrationConnection {
  let config: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(String(row.config_json)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>
  } catch {
    // Invalid optional provider config is surfaced as an empty config.
  }
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    providerType: String(row.provider_type),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    secretRef: row.secret_ref == null ? null : String(row.secret_ref),
    config,
  }
}

export class IdentityRepository {
  constructor(
    readonly db: DatabaseSync,
    options: { legacyClientCronEnabled?: boolean } = {},
  ) {
    this.initTables(options)
  }

  private initTables(options: { legacyClientCronEnabled?: boolean }): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization_profiles (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id),
        code TEXT NOT NULL UNIQUE,
        login_method TEXT NOT NULL DEFAULT 'password' CHECK (login_method IN ('sms', 'password', 'cas')),
        local_enabled INTEGER NOT NULL DEFAULT 1,
        cloud_enabled INTEGER NOT NULL DEFAULT 1,
        client_cron_enabled INTEGER NOT NULL DEFAULT 1,
        logo TEXT,
        app_name TEXT,
        top_name TEXT,
        about_name TEXT,
        app_company_name TEXT,
        login_description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_auth_identities (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        provider TEXT NOT NULL,
        issuer TEXT NOT NULL,
        normalized_subject TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (provider, issuer, normalized_subject),
        UNIQUE (user_id, provider, issuer)
      );
      CREATE INDEX IF NOT EXISTS user_auth_identities_org_idx ON user_auth_identities (org_id, user_id);

      CREATE TABLE IF NOT EXISTS resource_numeric_aliases (
        namespace TEXT NOT NULL,
        legacy_id INTEGER NOT NULL,
        resource_id TEXT NOT NULL,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        migration_run_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, legacy_id),
        UNIQUE (namespace, resource_id)
      );
      CREATE INDEX IF NOT EXISTS resource_numeric_aliases_org_idx
        ON resource_numeric_aliases (org_id, namespace, resource_id);

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'revoked')),
        initial_credit_units INTEGER NOT NULL DEFAULT 0,
        legacy_initial_quota_usd REAL,
        used_by_user_id TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS invitations_org_status_idx ON invitations (org_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS wallets (
        owner_type TEXT NOT NULL CHECK (owner_type IN ('organization', 'user')),
        owner_id TEXT NOT NULL,
        balance_units INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_type, owner_id)
      );

      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'suppressed', 'completed', 'failed')),
        context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
        idempotency_key TEXT NOT NULL UNIQUE,
        suppress_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_events_status_idx ON outbox_events (status, created_at);

      CREATE TABLE IF NOT EXISTS command_executions (
        command_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
        request_fingerprint TEXT,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (command_type, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS operation_audit_events (
        id TEXT PRIMARY KEY,
        legacy_id INTEGER NOT NULL UNIQUE,
        org_id TEXT NOT NULL,
        actor_user_id TEXT,
        actor_legacy_id INTEGER,
        actor_name TEXT,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        resource_id TEXT,
        method TEXT,
        path TEXT,
        legacy_params_raw TEXT,
        legacy_request_data_raw TEXT,
        legacy_response_data_raw TEXT,
        request_data_json TEXT,
        response_data_json TEXT,
        response_status INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        duration_ms INTEGER,
        error_message TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operation_audit_org_time_idx
        ON operation_audit_events (org_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS operation_audit_actor_time_idx
        ON operation_audit_events (actor_user_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS operation_audit_action_time_idx
        ON operation_audit_events (action, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS integration_connections (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        provider_type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        secret_ref TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (org_id, provider_type, id)
      );
      CREATE INDEX IF NOT EXISTS integration_connections_org_provider_idx
        ON integration_connections (org_id, provider_type, enabled);
    `)

    const profileColumns = this.db.prepare('PRAGMA table_info(organization_profiles)').all() as SqlRow[]
    if (!profileColumns.some(column => column.name === 'client_cron_enabled')) {
      const legacyDefault = options.legacyClientCronEnabled === false ? 0 : 1
      this.db.exec(
        `ALTER TABLE organization_profiles ADD COLUMN client_cron_enabled INTEGER NOT NULL DEFAULT ${legacyDefault}`,
      )
    }
    const invitationColumns = this.db.prepare('PRAGMA table_info(invitations)').all() as SqlRow[]
    if (!invitationColumns.some(column => column.name === 'legacy_initial_quota_usd')) {
      this.db.exec('ALTER TABLE invitations ADD COLUMN legacy_initial_quota_usd REAL')
    }
    const auditColumns = this.db.prepare('PRAGMA table_info(operation_audit_events)').all() as SqlRow[]
    for (const column of [
      'legacy_params_raw',
      'legacy_request_data_raw',
      'legacy_response_data_raw',
      'ip_address',
      'user_agent',
    ]) {
      if (!auditColumns.some(item => item.name === column)) {
        this.db.exec(`ALTER TABLE operation_audit_events ADD COLUMN ${column} TEXT`)
      }
    }
  }

  putOrganizationProfile(input: {
    orgId: string
    code: string
    loginMethod: OrganizationLoginMethod
    localEnabled: boolean
    cloudEnabled: boolean
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
  }): void {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO organization_profiles (
        org_id, code, login_method, local_enabled, cloud_enabled, logo, app_name,
        top_name, about_name, app_company_name, login_description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET
        code = excluded.code,
        login_method = excluded.login_method,
        local_enabled = excluded.local_enabled,
        cloud_enabled = excluded.cloud_enabled,
        logo = excluded.logo,
        app_name = excluded.app_name,
        top_name = excluded.top_name,
        about_name = excluded.about_name,
        app_company_name = excluded.app_company_name,
        login_description = excluded.login_description,
        updated_at = excluded.updated_at
    `).run(
      input.orgId,
      input.code,
      input.loginMethod,
      input.localEnabled ? 1 : 0,
      input.cloudEnabled ? 1 : 0,
      input.logo ?? null,
      input.appName ?? null,
      input.topName ?? null,
      input.aboutName ?? null,
      input.appCompanyName ?? null,
      input.loginDescription ?? null,
      timestamp,
      timestamp,
    )
  }

  getOrganizationProfileByCode(code: string): OrganizationProfile | null {
    const row = this.db.prepare(`
      SELECT * FROM organization_profiles WHERE code = ? LIMIT 1
    `).get(code) as SqlRow | undefined
    return row ? mapOrganizationProfile(row) : null
  }

  getOrganizationProfile(orgId: string): OrganizationProfile | null {
    const row = this.db.prepare(`
      SELECT * FROM organization_profiles WHERE org_id = ? LIMIT 1
    `).get(orgId) as SqlRow | undefined
    return row ? mapOrganizationProfile(row) : null
  }

  listOrganizationProfiles(): OrganizationProfile[] {
    const rows = this.db.prepare(`
      SELECT * FROM organization_profiles ORDER BY created_at ASC, org_id ASC
    `).all() as SqlRow[]
    return rows.map(mapOrganizationProfile)
  }

  setOrganizationClientCronEnabled(orgId: string, enabled: boolean): void {
    const result = this.db.prepare(`
      UPDATE organization_profiles SET client_cron_enabled = ?, updated_at = ? WHERE org_id = ?
    `).run(enabled ? 1 : 0, now(), orgId)
    if (result.changes !== 1) throw new Error(`Organization profile not found: ${orgId}`)
  }

  createAuthIdentity(input: {
    id: string
    orgId: string
    userId: string
    provider: string
    issuer: string
    normalizedSubject: string
    metadata: Record<string, unknown>
  }): void {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO user_auth_identities (
        id, org_id, user_id, provider, issuer, normalized_subject,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.orgId,
      input.userId,
      input.provider,
      input.issuer,
      input.normalizedSubject,
      JSON.stringify(input.metadata),
      timestamp,
      timestamp,
    )
  }

  findAuthIdentity(provider: string, issuer: string, normalizedSubject: string): AuthIdentity | null {
    const row = this.db.prepare(`
      SELECT * FROM user_auth_identities
      WHERE provider = ? AND issuer = ? AND normalized_subject = ?
      LIMIT 1
    `).get(provider, issuer, normalizedSubject) as SqlRow | undefined
    return row ? mapAuthIdentity(row) : null
  }

  findAuthIdentityByUser(userId: string, provider: string, issuer: string): AuthIdentity | null {
    const row = this.db.prepare(`
      SELECT * FROM user_auth_identities
      WHERE user_id = ? AND provider = ? AND issuer = ? LIMIT 1
    `).get(userId, provider, issuer) as SqlRow | undefined
    return row ? mapAuthIdentity(row) : null
  }

  moveUserOrganization(userId: string, orgId: string): void {
    this.db.prepare(`UPDATE user_auth_identities SET org_id = ?, updated_at = ? WHERE user_id = ?`)
      .run(orgId, now(), userId)
    this.db.prepare(`UPDATE resource_numeric_aliases SET org_id = ? WHERE namespace = 'user' AND resource_id = ?`)
      .run(orgId, userId)
  }

  assignNumericAlias(input: {
    namespace: string
    legacyId: number
    resourceId: string
    orgId: string
    migrationRunId?: string | null
  }): void {
    this.db.prepare(`
      INSERT INTO resource_numeric_aliases (
        namespace, legacy_id, resource_id, org_id, migration_run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.namespace,
      input.legacyId,
      input.resourceId,
      input.orgId,
      input.migrationRunId ?? null,
      now(),
    )
  }

  resolveNumericAlias(namespace: string, legacyId: number, orgId: string): string | null {
    const row = this.db.prepare(`
      SELECT resource_id FROM resource_numeric_aliases
      WHERE namespace = ? AND legacy_id = ? AND org_id = ?
      LIMIT 1
    `).get(namespace, legacyId, orgId) as SqlRow | undefined
    return row ? String(row.resource_id) : null
  }

  resolveNumericAliasGlobal(namespace: string, legacyId: number): { resourceId: string; orgId: string } | null {
    const row = this.db.prepare(`
      SELECT resource_id, org_id FROM resource_numeric_aliases
      WHERE namespace = ? AND legacy_id = ? LIMIT 1
    `).get(namespace, legacyId) as SqlRow | undefined
    return row ? { resourceId: String(row.resource_id), orgId: String(row.org_id) } : null
  }

  getNumericAlias(namespace: string, resourceId: string): number | null {
    const row = this.db.prepare(`
      SELECT legacy_id FROM resource_numeric_aliases
      WHERE namespace = ? AND resource_id = ? LIMIT 1
    `).get(namespace, resourceId) as SqlRow | undefined
    return row ? Number(row.legacy_id) : null
  }

  allocateNumericAlias(namespace: string, resourceId: string, orgId: string): number {
    const existing = this.getNumericAlias(namespace, resourceId)
    if (existing !== null) return existing
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(legacy_id), 0) + 1 AS next_id
      FROM resource_numeric_aliases WHERE namespace = ?
    `).get(namespace) as SqlRow
    const legacyId = Math.max(Number(row.next_id), 2_000_000_000)
    this.assignNumericAlias({ namespace, legacyId, resourceId, orgId })
    return legacyId
  }

  createInvitation(input: {
    id: string
    orgId: string
    code: string
    initialCreditUnits: number
    legacyInitialQuotaUsd?: number | null
  }): void {
    this.db.prepare(`
      INSERT INTO invitations (
        id, org_id, code, initial_credit_units, legacy_initial_quota_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.orgId, input.code, input.initialCreditUnits,
      input.legacyInitialQuotaUsd ?? null, now(),
    )
  }

  importInvitation(input: {
    id: string
    orgId: string
    code: string
    status: InvitationRecord['status']
    initialCreditUnits: number
    legacyInitialQuotaUsd: number | null
    usedByUserId: string | null
    createdAt: number
    usedAt: number | null
  }): 'inserted' | 'reused' {
    const byId = this.getInvitationById(input.id)
    const byCode = this.getInvitationByCode(input.code)
    const existing = byId ?? byCode
    if (existing) {
      if (sameInvitation(existing, input)) return 'reused'
      throw new Error(`Invitation import conflicts with existing target: ${input.code}`)
    }
    this.db.prepare(`
      INSERT INTO invitations (
        id, org_id, code, status, initial_credit_units, legacy_initial_quota_usd,
        used_by_user_id, created_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.orgId, input.code, input.status, input.initialCreditUnits,
      input.legacyInitialQuotaUsd, input.usedByUserId, input.createdAt, input.usedAt,
    )
    return 'inserted'
  }

  getInvitationByCode(code: string): InvitationRecord | null {
    const row = this.db.prepare(`SELECT * FROM invitations WHERE code = ? LIMIT 1`).get(code) as SqlRow | undefined
    return row ? mapInvitation(row) : null
  }

  getInvitationById(id: string): InvitationRecord | null {
    const row = this.db.prepare(`SELECT * FROM invitations WHERE id = ? LIMIT 1`).get(id) as SqlRow | undefined
    return row ? mapInvitation(row) : null
  }

  getInvitationByUser(userId: string): InvitationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM invitations WHERE used_by_user_id = ? ORDER BY used_at DESC LIMIT 1
    `).get(userId) as SqlRow | undefined
    return row ? mapInvitation(row) : null
  }

  listInvitations(input: {
    orgId?: string
    status?: InvitationRecord['status']
    limit?: number
    offset?: number
  } = {}): { items: InvitationRecord[]; total: number } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (input.orgId) {
      clauses.push('org_id = ?')
      params.push(input.orgId)
    }
    if (input.status) {
      clauses.push('status = ?')
      params.push(input.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM invitations ${where}`)
      .get(...params) as SqlRow
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
    const offset = Math.max(0, input.offset ?? 0)
    const rows = this.db.prepare(`
      SELECT * FROM invitations ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SqlRow[]
    return { items: rows.map(mapInvitation), total: Number(totalRow.count) }
  }

  revokeInvitation(id: string): boolean {
    return this.db.prepare(`
      UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'
    `).run(id).changes === 1
  }

  deletePendingInvitation(id: string): boolean {
    return this.db.prepare(`DELETE FROM invitations WHERE id = ? AND status = 'pending'`)
      .run(id).changes === 1
  }

  deleteUserRecords(userId: string): void {
    this.db.prepare(`DELETE FROM invitations WHERE used_by_user_id = ?`).run(userId)
    this.db.prepare(`DELETE FROM user_auth_identities WHERE user_id = ?`).run(userId)
    this.db.prepare(`DELETE FROM resource_numeric_aliases WHERE namespace = 'user' AND resource_id = ?`).run(userId)
    this.db.prepare(`DELETE FROM wallets WHERE owner_type = 'user' AND owner_id = ?`).run(userId)
  }

  deleteOrganizationRecords(orgId: string): void {
    this.db.prepare(`DELETE FROM integration_connections WHERE org_id = ?`).run(orgId)
    this.db.prepare(`DELETE FROM resource_numeric_aliases WHERE org_id = ?`).run(orgId)
    this.db.prepare(`DELETE FROM invitations WHERE org_id = ?`).run(orgId)
    this.db.prepare(`DELETE FROM wallets WHERE owner_type = 'organization' AND owner_id = ?`).run(orgId)
    this.db.prepare(`DELETE FROM organization_profiles WHERE org_id = ?`).run(orgId)
  }

  putIntegrationConnection(input: {
    id: string
    orgId: string
    providerType: string
    name: string
    enabled: boolean
    secretRef?: string | null
    config: Record<string, unknown>
  }): void {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO integration_connections (
        id, org_id, provider_type, name, enabled, secret_ref, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        org_id = excluded.org_id,
        provider_type = excluded.provider_type,
        name = excluded.name,
        enabled = excluded.enabled,
        secret_ref = excluded.secret_ref,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      input.id, input.orgId, input.providerType, input.name, input.enabled ? 1 : 0,
      input.secretRef ?? null, JSON.stringify(input.config), timestamp, timestamp,
    )
  }

  getIntegrationConnection(id: string): IntegrationConnection | null {
    const row = this.db.prepare(`SELECT * FROM integration_connections WHERE id = ? LIMIT 1`)
      .get(id) as SqlRow | undefined
    return row ? mapIntegrationConnection(row) : null
  }

  listIntegrationConnections(orgId: string, providerType?: string): IntegrationConnection[] {
    const rows = providerType
      ? this.db.prepare(`
          SELECT * FROM integration_connections
          WHERE org_id = ? AND provider_type = ? ORDER BY created_at ASC, id ASC
        `).all(orgId, providerType) as SqlRow[]
      : this.db.prepare(`
          SELECT * FROM integration_connections WHERE org_id = ? ORDER BY created_at ASC, id ASC
        `).all(orgId) as SqlRow[]
    return rows.map(mapIntegrationConnection)
  }

  consumeInvitation(id: string, userId: string): void {
    const result = this.db.prepare(`
      UPDATE invitations SET status = 'used', used_by_user_id = ?, used_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(userId, now(), id)
    if (result.changes !== 1) throw new Error('Invitation is not available')
  }

  createWallet(ownerType: 'organization' | 'user', ownerId: string, balanceUnits: number): void {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO wallets (owner_type, owner_id, balance_units, version, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(ownerType, ownerId, toStoredPointUnits(balanceUnits), timestamp, timestamp)
  }

  ensureWallet(ownerType: 'organization' | 'user', ownerId: string): void {
    const timestamp = now()
    this.db.prepare(`
      INSERT OR IGNORE INTO wallets (owner_type, owner_id, balance_units, version, created_at, updated_at)
      VALUES (?, ?, 0, 0, ?, ?)
    `).run(ownerType, ownerId, timestamp, timestamp)
  }

  getWallet(ownerType: 'organization' | 'user', ownerId: string): { balanceUnits: number; version: number } | null {
    const row = this.db.prepare(`
      SELECT balance_units, version FROM wallets WHERE owner_type = ? AND owner_id = ? LIMIT 1
    `).get(ownerType, ownerId) as SqlRow | undefined
    return row ? {
      balanceUnits: fromStoredPointUnits(row.balance_units),
      version: Number(row.version),
    } : null
  }

  createOutboxEvent(input: {
    id: string
    eventType: string
    aggregateType: string
    aggregateId: string
    payload: Record<string, unknown>
    status: OutboxEventRecord['status']
    contextSource: OutboxEventRecord['contextSource']
    idempotencyKey: string
    suppressReason?: string | null
  }): void {
    this.db.prepare(`
      INSERT INTO outbox_events (
        id, event_type, aggregate_type, aggregate_id, payload_json, status,
        context_source, idempotency_key, suppress_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.eventType, input.aggregateType, input.aggregateId,
      JSON.stringify(input.payload), input.status, input.contextSource,
      input.idempotencyKey, input.suppressReason ?? null, now(),
    )
  }

  getOutboxEvent(idempotencyKey: string): OutboxEventRecord | null {
    const row = this.db.prepare(`
      SELECT id, status, context_source, idempotency_key, suppress_reason
      FROM outbox_events WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? {
      id: String(row.id),
      status: String(row.status) as OutboxEventRecord['status'],
      contextSource: String(row.context_source) as OutboxEventRecord['contextSource'],
      idempotencyKey: String(row.idempotency_key),
      suppressReason: row.suppress_reason == null ? null : String(row.suppress_reason),
    } : null
  }

  getCommandResult<T>(commandType: string, idempotencyKey: string): T | null {
    const row = this.db.prepare(`
      SELECT result_json FROM command_executions
      WHERE command_type = ? AND idempotency_key = ? LIMIT 1
    `).get(commandType, idempotencyKey) as SqlRow | undefined
    return row ? JSON.parse(String(row.result_json)) as T : null
  }

  recordCommandResult(
    commandType: string,
    idempotencyKey: string,
    contextSource: 'online' | 'migration' | 'replay',
    result: unknown,
  ): void {
    this.db.prepare(`
      INSERT INTO command_executions (command_type, idempotency_key, context_source, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(commandType, idempotencyKey, contextSource, JSON.stringify(result), now())
  }

  insertOperationAudit(input: {
    id: string
    legacyId?: number
    orgId: string
    actorUserId?: string | null
    actorLegacyId?: number | null
    actorName?: string | null
    action: string
    resource: string
    resourceId?: string | null
    method?: string | null
    path?: string | null
    legacyParamsRaw?: string | null
    legacyRequestDataRaw?: string | null
    legacyResponseDataRaw?: string | null
    requestData?: unknown
    responseData?: unknown
    responseStatus?: number | null
    ipAddress?: string | null
    userAgent?: string | null
    durationMs?: number | null
    errorMessage?: string | null
    idempotencyKey: string
    createdAt?: number
  }): boolean {
    const legacyId = input.legacyId ?? this.nextOperationAuditLegacyId()
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO operation_audit_events (
        id, legacy_id, org_id, actor_user_id, actor_legacy_id, actor_name,
        action, resource, resource_id, method, path, legacy_params_raw,
        legacy_request_data_raw, legacy_response_data_raw, request_data_json,
        response_data_json, response_status, ip_address, user_agent, duration_ms,
        error_message, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, legacyId, input.orgId, input.actorUserId ?? null, input.actorLegacyId ?? null,
      input.actorName ?? null, input.action, input.resource, input.resourceId ?? null,
      input.method ?? null, input.path ?? null, input.legacyParamsRaw ?? null,
      input.legacyRequestDataRaw ?? null, input.legacyResponseDataRaw ?? null,
      toOptionalJson(input.requestData), toOptionalJson(input.responseData),
      input.responseStatus ?? null, input.ipAddress ?? null, input.userAgent ?? null,
      input.durationMs ?? null, input.errorMessage ?? null, input.idempotencyKey,
      input.createdAt ?? now(),
    )
    return Number(result.changes) === 1
  }

  hasOperationAudit(idempotencyKey: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM operation_audit_events WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey))
  }

  getOperationAuditByLegacyId(legacyId: number): OperationAuditRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM operation_audit_events WHERE legacy_id = ? LIMIT 1
    `).get(legacyId) as SqlRow | undefined
    return row ? mapOperationAudit(row) : null
  }

  getOperationAuditById(id: string): OperationAuditRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM operation_audit_events WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined
    return row ? mapOperationAudit(row) : null
  }

  getOperationAuditByIdempotencyKey(idempotencyKey: string): OperationAuditRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM operation_audit_events WHERE idempotency_key = ? LIMIT 1
    `).get(idempotencyKey) as SqlRow | undefined
    return row ? mapOperationAudit(row) : null
  }

  listOperationAudits(input: {
    orgId?: string
    actorUserId?: string
    action?: string
    from?: number
    to?: number
    limit: number
    offset: number
  }): { items: OperationAuditRecord[]; total: number } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (input.orgId) { clauses.push('org_id = ?'); params.push(input.orgId) }
    if (input.actorUserId) { clauses.push('actor_user_id = ?'); params.push(input.actorUserId) }
    if (input.action) { clauses.push('action = ?'); params.push(input.action) }
    if (input.from !== undefined) { clauses.push('created_at >= ?'); params.push(input.from) }
    if (input.to !== undefined) { clauses.push('created_at <= ?'); params.push(input.to) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM operation_audit_events ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as SqlRow[]
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM operation_audit_events ${where}
    `).get(...params) as SqlRow
    return { items: rows.map(mapOperationAudit), total: Number(total.count) }
  }

  private nextOperationAuditLegacyId(): number {
    const row = this.db.prepare('SELECT MAX(legacy_id) AS value FROM operation_audit_events').get() as SqlRow
    return Math.max(2_000_000_000, Number(row.value ?? 1_999_999_999) + 1)
  }
}

function toOptionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function parseOptionalJson(value: unknown): unknown {
  if (value == null) return null
  try {
    return JSON.parse(String(value)) as unknown
  } catch {
    return String(value)
  }
}

function sameInvitation(
  existing: InvitationRecord,
  expected: Omit<InvitationRecord, never>,
): boolean {
  return existing.id === expected.id
    && existing.orgId === expected.orgId
    && existing.code === expected.code
    && existing.status === expected.status
    && existing.initialCreditUnits === expected.initialCreditUnits
    && existing.legacyInitialQuotaUsd === expected.legacyInitialQuotaUsd
    && existing.usedByUserId === expected.usedByUserId
    && existing.createdAt === expected.createdAt
    && existing.usedAt === expected.usedAt
}

function mapOperationAudit(row: SqlRow): OperationAuditRecord {
  return {
    id: String(row.id),
    legacyId: Number(row.legacy_id),
    orgId: String(row.org_id),
    actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
    actorLegacyId: row.actor_legacy_id == null ? null : Number(row.actor_legacy_id),
    actorName: row.actor_name == null ? null : String(row.actor_name),
    action: String(row.action),
    resource: String(row.resource),
    resourceId: row.resource_id == null ? null : String(row.resource_id),
    method: row.method == null ? null : String(row.method),
    path: row.path == null ? null : String(row.path),
    legacyParamsRaw: row.legacy_params_raw == null ? null : String(row.legacy_params_raw),
    legacyRequestDataRaw: row.legacy_request_data_raw == null ? null : String(row.legacy_request_data_raw),
    legacyResponseDataRaw: row.legacy_response_data_raw == null ? null : String(row.legacy_response_data_raw),
    requestData: parseOptionalJson(row.request_data_json),
    responseData: parseOptionalJson(row.response_data_json),
    responseStatus: row.response_status == null ? null : Number(row.response_status),
    ipAddress: row.ip_address == null ? null : String(row.ip_address),
    userAgent: row.user_agent == null ? null : String(row.user_agent),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    idempotencyKey: String(row.idempotency_key),
    createdAt: Number(row.created_at),
  }
}
