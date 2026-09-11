import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { PgDriver, SqliteDriver, isUniqueViolation, type DbDriver, type PgPoolLike, type SqlParam } from './db/driver.js'
import { applyPgSchema } from './db/pg_schema.js'
import { McpStore } from './mcp/db.js'
import { ensureCabinTables } from './cabin/store.js'
import type {
  AttemptRecord,
  AttemptRuntimeState,
  DesiredSessionState,
  EnterpriseRecord,
  ServerConfig,
  ServerInstanceRecord,
  SessionCreateInput,
  SessionEventRecord,
  SessionListFilter,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from './types.js'
import type { SessionRuntimeInfo } from './sessionManager.js'
import { channelCredentialIdentity } from '../channels/types.js'
import { resolveRuntimeScodePath } from './runtimeScodePath.js'

type SqlRow = Record<string, unknown>

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

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function mapRuntime(row: SqlRow): SessionRuntimeInfo {
  const rawType = String(row.runtime_type)
  const type: SessionRuntimeInfo['type'] =
    rawType === 'docker' ? 'docker' : rawType === 'k8s' ? 'k8s' : 'host'
  const mode =
    row.docker_mode === 'user'
      ? 'user'
      : row.docker_mode === 'session'
        ? 'session'
        : undefined
  return {
    type,
    engine: String(row.engine) === 'scode' ? 'scode' : 'scode',
    dockerImage: typeof row.docker_image === 'string' ? row.docker_image : undefined,
    dockerMode: type === 'docker' ? mode : undefined,
    containerName:
      typeof row.container_name === 'string' ? row.container_name : undefined,
    configDir: typeof row.config_dir === 'string' ? row.config_dir : undefined,
    hostMode: type === 'host' ? mode : undefined,
    // k8s image/namespace/runtimeClass are re-derived from config.k8s by the
    // K8sBackend (not persisted as columns); only the reuse mode is carried in
    // the shared docker_mode column.
    k8sMode: type === 'k8s' ? mode : undefined,
  }
}

function mapSession(row: SqlRow): SessionRecord {
  return {
    sessionId: String(row.session_id),
    transcriptSessionId: String(row.transcript_session_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    role: String(row.role),
    scopes: parseJsonArray(row.scopes_json),
    cwd: String(row.cwd),
    runtime: mapRuntime(row),
    status: String(row.status) as SessionStatus,
    desiredState: String(row.desired_state) as DesiredSessionState,
    currentAttemptId:
      typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    transcriptPath: String(row.transcript_path),
    title: typeof row.title === 'string' ? row.title : null,
    summary: typeof row.summary === 'string' ? row.summary : null,
    assistantName: typeof row.assistant_name === 'string' ? row.assistant_name : null,
    source: typeof row.source === 'string' ? row.source : undefined,
    channelChatId: typeof row.channel_chat_id === 'string' ? row.channel_chat_id : undefined,
    clientMetadata: parseJsonObject(row.client_metadata),
    createdAt: Number(row.created_at),
    lastActiveAt: Number(row.last_active_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  }
}

function mapAttempt(row: SqlRow): AttemptRecord {
  return {
    attemptId: String(row.attempt_id),
    sessionId: String(row.session_id),
    generation: Number(row.generation),
    backendType: String(row.backend_type) === 'docker' ? 'docker' : 'host',
    runtimeState: String(row.runtime_state) as AttemptRuntimeState,
    serverInstanceId:
      typeof row.server_instance_id === 'string' ? row.server_instance_id : null,
    runnerPid: row.runner_pid == null ? null : Number(row.runner_pid),
    containerName:
      typeof row.container_name === 'string' ? row.container_name : null,
    attachPath: typeof row.attach_path === 'string' ? row.attach_path : null,
    resumeTranscriptSessionId: String(row.resume_transcript_session_id),
    startedAt: Number(row.started_at),
    lastHeartbeatAt:
      row.last_heartbeat_at == null ? null : Number(row.last_heartbeat_at),
    stoppedAt: row.stopped_at == null ? null : Number(row.stopped_at),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    exitSignal: typeof row.exit_signal === 'string' ? row.exit_signal : null,
    stopReason: typeof row.stop_reason === 'string' ? row.stop_reason : null,
    errorText: typeof row.error_text === 'string' ? row.error_text : null,
  }
}

export class DirectConnectStore {
  readonly db: DatabaseSync
  /**
   * Async driver seam (HA PG support). For sqlite this wraps `db` with async
   * signatures — zero behaviour change. Method bodies migrate from
   * `this.db.prepare(...)` to `await this.driver.*` incrementally (P1-2d);
   * the postgres backend becomes runnable once that migration completes.
   */
  readonly driver: DbDriver

  constructor(public readonly dbPath: string, pgDriver?: DbDriver) {
    // PostgreSQL construction form (reached via DirectConnectStore.forPostgres,
    // never directly): no sqlite handle exists, schema comes from pg_schema.ts
    // (applied by openStoreAsync before this constructor runs). `db` is left
    // undefined on purpose — sqlite-only consumers (tests, schema migration
    // code) never run on this form.
    if (pgDriver) {
      this.db = undefined as unknown as DatabaseSync
      this.driver = pgDriver
      return
    }
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.driver = new SqliteDriver(this.db)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        transcript_session_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        runtime_type TEXT NOT NULL,
        docker_image TEXT,
        docker_mode TEXT,
        config_dir TEXT,
        container_name TEXT,
        status TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        current_attempt_id TEXT,
        transcript_path TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        assistant_name TEXT,
        source TEXT,
        channel_chat_id TEXT,
        client_metadata TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        ended_at INTEGER,
        deleted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS session_attempts (
        attempt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        generation INTEGER NOT NULL,
        backend_type TEXT NOT NULL,
        runtime_state TEXT NOT NULL,
        server_instance_id TEXT,
        runner_pid INTEGER,
        container_name TEXT,
        attach_path TEXT,
        resume_transcript_session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER,
        stopped_at INTEGER,
        exit_code INTEGER,
        exit_signal TEXT,
        stop_reason TEXT,
        error_text TEXT,
        UNIQUE (session_id, generation)
      );

      CREATE TABLE IF NOT EXISTS server_instances (
        instance_id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        pid INTEGER,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        stopped_at INTEGER,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS enterprises (
        id TEXT PRIMARY KEY DEFAULT 'default',
        logo TEXT,
        app_name TEXT,
        top_name TEXT,
        about_name TEXT,
        app_company_name TEXT,
        login_desp TEXT,
        client_cron_enabled INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_user_idx
        ON sessions (org_id, user_id, last_active_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_state_idx
        ON sessions (org_id, status, last_active_at DESC);
      CREATE INDEX IF NOT EXISTS attempts_session_idx
        ON session_attempts (session_id, generation DESC);

      CREATE TABLE IF NOT EXISTS channel_plugins (
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        credentials_json TEXT,
        config_json TEXT,
        status TEXT NOT NULL,
        last_connected INTEGER,
        user_id TEXT NOT NULL,
        org_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, user_id)
      );

      CREATE TABLE IF NOT EXISTS channel_users (
        id TEXT PRIMARY KEY,
        platform_user_id TEXT NOT NULL,
        platform_type TEXT NOT NULL,
        plugin_scope TEXT NOT NULL DEFAULT '',
        display_name TEXT,
        authorized_at INTEGER NOT NULL,
        last_active INTEGER,
        session_id TEXT,
        org_id TEXT,
        user_id TEXT,
        UNIQUE(platform_user_id, plugin_scope, user_id)
      );

      CREATE TABLE IF NOT EXISTS channel_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        conversation_id TEXT,
        workspace TEXT,
        chat_id TEXT,
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_pairing_requests (
        code TEXT PRIMARY KEY,
        platform_user_id TEXT NOT NULL,
        platform_type TEXT NOT NULL,
        plugin_scope TEXT,
        display_name TEXT,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        user_id TEXT
      );
    `)
    ensureCabinTables(this.db)

    const nowTs = now()
    this.db.prepare(`
      INSERT INTO enterprises (id, created_at, updated_at)
      VALUES ('default', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(nowTs, nowTs)

    // Migration: add assistant_name column if it doesn't exist
    const sessionsColumns = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
    if (!sessionsColumns.some(col => col.name === 'assistant_name')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN assistant_name TEXT`)
      console.log('[DB] Added assistant_name column to sessions')
    }

    // Migration: add source and channel_chat_id columns if they don't exist
    if (!sessionsColumns.some(col => col.name === 'source')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT`)
      console.log('[DB] Added source column to sessions')
    }
    if (!sessionsColumns.some(col => col.name === 'channel_chat_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN channel_chat_id TEXT`)
      console.log('[DB] Added channel_chat_id column to sessions')
    }

    // Migration: add client_metadata (opaque per-session client JSON) if absent
    if (!sessionsColumns.some(col => col.name === 'client_metadata')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN client_metadata TEXT`)
      console.log('[DB] Added client_metadata column to sessions')
    }

    // Migration: add org_id to channel_plugins
    const channelPluginsColumns = this.db.prepare(`PRAGMA table_info(channel_plugins)`).all() as { name: string }[]
    if (!channelPluginsColumns.some(col => col.name === 'org_id')) {
      this.db.exec(`ALTER TABLE channel_plugins ADD COLUMN org_id TEXT`)
      console.log('[DB] Added org_id column to channel_plugins')
    }
    // Migration: per-(id,user_id) plugin lease (HA). One instance holds a
    // plugin row's lease while it runs, so two instances sharing the DB never
    // both start the same plugin (e.g. double Telegram polling on one token).
    // PG side is v2.
    if (!channelPluginsColumns.some(col => col.name === 'lease_owner')) {
      this.db.exec(`ALTER TABLE channel_plugins ADD COLUMN lease_owner TEXT`)
    }
    if (!channelPluginsColumns.some(col => col.name === 'lease_until')) {
      this.db.exec(`ALTER TABLE channel_plugins ADD COLUMN lease_until INTEGER`)
    }

    // Migration: add client_cron_enabled to enterprises (null = enabled by default)
    const enterprisesColumns = this.db.prepare(`PRAGMA table_info(enterprises)`).all() as { name: string }[]
    if (!enterprisesColumns.some(col => col.name === 'client_cron_enabled')) {
      this.db.exec(`ALTER TABLE enterprises ADD COLUMN client_cron_enabled INTEGER`)
      console.log('[DB] Added client_cron_enabled column to enterprises')
    }

    // Migration: backfill org_id on department_secret_policies rows written by
    // replaceConfigItemDepartments (the admin "authorized departments" flow),
    // which historically inserted without org_id. The org-scoped readers filter
    // WHERE org_id = ?, so these NULL rows were invisible — a dept credential
    // authorized for a department would never surface for that department's
    // users. config_items.org_id is the source of truth (department_id is
    // globally unique, so the join is unambiguous).
    try {
      const orphanCount = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM department_secret_policies WHERE org_id IS NULL`,
      ).get() as { n: number }).n
      if (orphanCount > 0) {
        this.db.exec(`
          UPDATE department_secret_policies
          SET org_id = (
            SELECT org_id FROM config_items
            WHERE config_items.id = department_secret_policies.config_item_id
          )
          WHERE org_id IS NULL
        `)
        console.log(`[DB] Backfilled org_id on ${orphanCount} department_secret_policies row(s)`)
      }
    } catch (err) {
      console.error('[DB] Failed to backfill department_secret_policies.org_id:', err)
    }

    // Migration: add user_id to channel_pairing_requests
    const pairingRequestsColumns = this.db.prepare(`PRAGMA table_info(channel_pairing_requests)`).all() as { name: string }[]
    if (!pairingRequestsColumns.some(col => col.name === 'user_id')) {
      this.db.exec(`ALTER TABLE channel_pairing_requests ADD COLUMN user_id TEXT`)
      console.log('[DB] Added user_id column to channel_pairing_requests')
    }
    // Migrate channel_users UNIQUE constraint from (platform_user_id, platform_type)
    // to (platform_user_id, platform_type, user_id) for multi-user isolation.
    // SQLite doesn't support ALTER TABLE constraints, so recreate the table.
    try {
      const existingConstraint = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_users'`).get() as SqlRow | undefined;
      if (existingConstraint && String(existingConstraint.sql).includes('UNIQUE(platform_user_id, platform_type)') && !String(existingConstraint.sql).includes('platform_user_id, platform_type, user_id')) {
        this.db.exec(`
          CREATE TABLE channel_users_new (
            id TEXT PRIMARY KEY,
            platform_user_id TEXT NOT NULL,
            platform_type TEXT NOT NULL,
            display_name TEXT,
            authorized_at INTEGER NOT NULL,
            last_active INTEGER,
            session_id TEXT,
            org_id TEXT,
            user_id TEXT,
            UNIQUE(platform_user_id, platform_type, user_id)
          );
          INSERT OR IGNORE INTO channel_users_new SELECT * FROM channel_users;
          DROP TABLE channel_users;
          ALTER TABLE channel_users_new RENAME TO channel_users;
        `)
        console.log('[DB] Migrated channel_users UNIQUE constraint to include user_id')
      }
    } catch (error) {
      console.error('[DB] Failed to migrate channel_users constraint:', error)
    }

    // Migration: scope channel_users to ONE connection rather than the whole platform.
    // With multiple connections of a type, `platform_type` alone let a user paired with
    // bot A talk to bot B: isUserAuthorized() matched on the platform, not the bot.
    // plugin_scope holds the owning connection (the bare platform for a type's first
    // connection, so existing rows keep resolving) and joins the UNIQUE key.
    try {
      const channelUsersSql = String((this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_users'`).get() as SqlRow | undefined)?.sql || '')
      if (channelUsersSql && !channelUsersSql.includes('plugin_scope')) {
        this.db.exec(`
          CREATE TABLE channel_users_new (
            id TEXT PRIMARY KEY,
            platform_user_id TEXT NOT NULL,
            platform_type TEXT NOT NULL,
            plugin_scope TEXT NOT NULL DEFAULT '',
            display_name TEXT,
            authorized_at INTEGER NOT NULL,
            last_active INTEGER,
            session_id TEXT,
            org_id TEXT,
            user_id TEXT,
            UNIQUE(platform_user_id, plugin_scope, user_id)
          );
          INSERT OR IGNORE INTO channel_users_new
            (id, platform_user_id, platform_type, plugin_scope, display_name, authorized_at, last_active, session_id, org_id, user_id)
            SELECT id, platform_user_id, platform_type, platform_type, display_name, authorized_at, last_active, session_id, org_id, user_id
              FROM channel_users;
          DROP TABLE channel_users;
          ALTER TABLE channel_users_new RENAME TO channel_users;
        `)
        console.log('[DB] Migrated channel_users to per-connection plugin_scope')
      }
    } catch (error) {
      console.error('[DB] Failed to migrate channel_users plugin_scope:', error)
    }

    // Migration: scope pairing codes to one connection, for the same reason.
    try {
      const pairingCols = this.db.prepare(`PRAGMA table_info(channel_pairing_requests)`).all() as { name: string }[]
      if (!pairingCols.some(col => col.name === 'plugin_scope')) {
        this.db.exec(`ALTER TABLE channel_pairing_requests ADD COLUMN plugin_scope TEXT`)
        this.db.exec(`UPDATE channel_pairing_requests SET plugin_scope = platform_type WHERE plugin_scope IS NULL`)
        console.log('[DB] Added channel_pairing_requests.plugin_scope')
      }
    } catch (error) {
      console.error('[DB] Failed to add channel_pairing_requests.plugin_scope:', error)
    }

    // Create index for channel session lookup if it doesn't exist
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_source_chat ON sessions (source, channel_chat_id, last_active_at DESC)`)
    } catch {
      // Index creation failed, ignore
    }

    // Incremental migration: per-chat conversation depth for IM turn-cap
    // rotation. Counted on channel_sessions (not the runtime `sessions` row)
    // so it SURVIVES a rotation — the whole point of the cap is to measure
    // cumulative depth across the chat, not the life of one runtime session.
    // ALTER TABLE ADD COLUMN is safe here (no constraint change, unlike the
    // channel_users rebuild above); existing rows read NULL and coalesce to 0.
    try {
      const channelSessionColumns = this.db.prepare(`PRAGMA table_info(channel_sessions)`).all() as SqlRow[]
      if (!channelSessionColumns.some(c => String(c.name) === 'turn_count')) {
        this.db.exec(`ALTER TABLE channel_sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0`)
        console.log('[DB] Added channel_sessions.turn_count for IM turn-cap rotation')
      }
    } catch (error) {
      console.error('[DB] Failed to add channel_sessions.turn_count:', error)
    }

    // Create tenant_skills table for enterprise exclusive skills
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        version TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT,
        status TEXT DEFAULT 'pending',
        source_url TEXT,
        checksum TEXT,
        file_path TEXT,
        publish_note TEXT,
        review_note TEXT,
        reviewed_by TEXT,
        reviewed_at INTEGER,
        enabled INTEGER DEFAULT 1,
        visible_to TEXT,
        org_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tenant_skills_author ON tenant_skills (author_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_skills_status ON tenant_skills (status);
    `)

    // Create tenant_assistants table for enterprise exclusive assistants
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_assistants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        default_init_prompt TEXT,
        prompts_i18n TEXT,
        categories TEXT,
        version TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT,
        status TEXT DEFAULT 'pending',
        source_url TEXT,
        checksum TEXT,
        file_path TEXT,
        enabled_skills TEXT,
        memory_mode TEXT DEFAULT 'session',
        agent_type TEXT DEFAULT 'chat',
        publish_note TEXT,
        review_note TEXT,
        reviewed_by TEXT,
        reviewed_at INTEGER,
        enabled INTEGER DEFAULT 1,
        visible_to TEXT,
        org_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tenant_assistants_author ON tenant_assistants (author_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_assistants_status ON tenant_assistants (status);
    `)

    // Migration: Add agent_type column to tenant_assistants if it doesn't exist
    const columns = this.db.prepare(`PRAGMA table_info(tenant_assistants)`).all() as { name: string }[]
    if (!columns.some(col => col.name === 'agent_type')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN agent_type TEXT DEFAULT 'chat'`)
    }

    // Migration: Add new columns to tenant_assistants for exclusive agent editing feature
    const assistantColumns = this.db.prepare(`PRAGMA table_info(tenant_assistants)`).all() as { name: string }[]
    if (!assistantColumns.some(col => col.name === 'avatar')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN avatar TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'emoji')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN emoji TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'skills')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN skills TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'enabled_wikis')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN enabled_wikis TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'enabled_corp_apps')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN enabled_corp_apps TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'workflow')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN workflow TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'default_init_prompt')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN default_init_prompt TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'prompts_i18n')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN prompts_i18n TEXT`)
    }
    if (!assistantColumns.some(col => col.name === 'categories')) {
      this.db.exec(`ALTER TABLE tenant_assistants ADD COLUMN categories TEXT`)
    }

    // Multi-org: add org_id to tenant skills/assistants (backfilled to the
    // default org later via backfillOrgScoping()).
    for (const table of ['tenant_skills', 'tenant_assistants']) {
      const tcols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
      if (!tcols.includes('org_id')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN org_id TEXT`)
        console.log(`[DB] Added org_id column to ${table}`)
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_org ON ${table} (org_id)`)
    }

    // Secrets base table must exist before column migrations below. On a fresh
    // DB, PRAGMA table_info(nonexistent) returns an empty list, and ALTER TABLE
    // would otherwise fail with "no such table: config_items" before the main
    // Secrets Management schema block runs later in this constructor.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        description   TEXT,
        icon          TEXT,
        pinyin        TEXT,
        scope         TEXT NOT NULL DEFAULT 'system',
        url_pattern   TEXT,
        scheme        TEXT,
        bearer_prefix TEXT,
        status        INTEGER DEFAULT 1,
        org_id        TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        auth_type          TEXT,
        auth_url           TEXT,
        token_url          TEXT,
        client_id          TEXT,
        client_secret_key  TEXT,
        refresh_token_key  TEXT,
        default_scopes     TEXT,
        token_request_json TEXT,
        mint_script        TEXT,
        body_auth_check    TEXT
      );
    `)

    // Migration: config_items mint/auth columns. createConfigItem/updateConfigItem
    // have long referenced these columns in their INSERT/UPDATE, but the CREATE
    // TABLE never defined them — so those writes throw against an unmigrated DB.
    // Add them here (idempotent check via PRAGMA). auth_type drives the auth proxy:
    // absent/'static' keeps today's inject-stored-secret behavior; the oauth2_* /
    // 'script' values enable per-(user,service) token minting (token_url +
    // token_request_json recipe, or mint_script fallback).
    const configItemsColumns = this.db.prepare(`PRAGMA table_info(config_items)`).all() as { name: string }[]
    // Fresh DBs use the complete schema above; pre-existing DBs may still need
    // these ALTERs.
    if (configItemsColumns.length > 0) {
      const columnsToAdd = [
        ['org_id', 'org_id TEXT'],
        ['auth_type', 'auth_type TEXT'],
        ['auth_url', 'auth_url TEXT'],
        ['token_url', 'token_url TEXT'],
        ['client_id', 'client_id TEXT'],
        ['client_secret_key', 'client_secret_key TEXT'],
        ['refresh_token_key', 'refresh_token_key TEXT'],
        ['default_scopes', 'default_scopes TEXT'],
        ['token_request_json', 'token_request_json TEXT'],
        ['mint_script', 'mint_script TEXT'],
        // Opt-in per-item recipe for detecting a body-level "unauthorized" reply
        // (HTTP 200 + {"code":401,...}) so the auth proxy can re-mint on it, not
        // just on an HTTP 401. Null keeps today's HTTP-status-only behavior.
        ['body_auth_check', 'body_auth_check TEXT'],
      ] as const
      for (const [colName, colDef] of columnsToAdd) {
        if (!configItemsColumns.some(col => col.name === colName)) {
          this.db.exec(`ALTER TABLE config_items ADD COLUMN ${colDef}`)
          console.log(`[DB] Added ${colName} column to config_items`)
        }
      }
    }

    // ============================================================
    // Document Center (P0): document tree, documents, wikis, build jobs
    // Agent ↔ Wiki association lives in agent `_moss_meta.json` (enabledWikis: string[]),
    // not in a join table, to follow the existing enabledSkills pattern.
    // ============================================================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_tree_nodes (
        id          TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL,
        parent_id   TEXT REFERENCES document_tree_nodes(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        description TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS document_tree_nodes_parent_idx
        ON document_tree_nodes (parent_id);
      CREATE INDEX IF NOT EXISTS document_tree_nodes_org_idx
        ON document_tree_nodes (org_id, sort_order);

      CREATE TABLE IF NOT EXISTS documents (
        id           TEXT PRIMARY KEY,
        org_id       TEXT NOT NULL,
        node_id      TEXT NOT NULL REFERENCES document_tree_nodes(id) ON DELETE CASCADE,
        file_name    TEXT NOT NULL,
        mime_type    TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        uploaded_by  TEXT NOT NULL,
        uploaded_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS documents_node_idx ON documents (node_id);
      CREATE INDEX IF NOT EXISTS documents_org_idx  ON documents (org_id);

      CREATE TABLE IF NOT EXISTS wikis (
        id                     TEXT PRIMARY KEY,
        org_id                 TEXT NOT NULL,
        node_id                TEXT REFERENCES document_tree_nodes(id) ON DELETE SET NULL,
        name                   TEXT NOT NULL,
        description            TEXT,
        storage_path           TEXT NOT NULL,
        build_status           TEXT NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed
        source_document_ids    TEXT NOT NULL DEFAULT '[]',       -- JSON array of document IDs
        last_built_at          INTEGER,
        last_build_error       TEXT,
        created_by             TEXT NOT NULL,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS wikis_org_idx  ON wikis (org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS wikis_node_idx ON wikis (node_id);

      CREATE TABLE IF NOT EXISTS wiki_build_jobs (
        id              TEXT PRIMARY KEY,
        wiki_id         TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
        status          TEXT NOT NULL DEFAULT 'queued',  -- queued|running|succeeded|failed|cancelled
        progress        INTEGER NOT NULL DEFAULT 0,      -- 0-100
        current_step    TEXT,
        error_message   TEXT,
        session_id      TEXT,                            -- moss session_id created by RuntimeService
        triggered_by    TEXT NOT NULL,
        queued_at       INTEGER NOT NULL,
        started_at      INTEGER,
        finished_at     INTEGER
      );

      CREATE INDEX IF NOT EXISTS wiki_build_jobs_wiki_idx
        ON wiki_build_jobs (wiki_id, queued_at DESC);
      CREATE INDEX IF NOT EXISTS wiki_build_jobs_status_idx
        ON wiki_build_jobs (status, queued_at);
    `)

    // Incremental migration: wiki build-job claim ownership (HA). claimed_by
    // records which server instance atomically claimed the job (queued→running
    // CAS); claimed_at is its claim timestamp, used by the stale-job reaper and
    // by sweepStaging to leave another live instance's in-flight artifacts
    // alone. Existing rows read NULL (unclaimed / pre-HA). PG side is v2.
    try {
      const wikiBuildJobColumns = this.db.prepare(`PRAGMA table_info(wiki_build_jobs)`).all() as SqlRow[]
      if (!wikiBuildJobColumns.some(c => String(c.name) === 'claimed_by')) {
        this.db.exec(`ALTER TABLE wiki_build_jobs ADD COLUMN claimed_by TEXT`)
      }
      if (!wikiBuildJobColumns.some(c => String(c.name) === 'claimed_at')) {
        this.db.exec(`ALTER TABLE wiki_build_jobs ADD COLUMN claimed_at INTEGER`)
      }
    } catch (error) {
      console.error('[DB] Failed to add wiki_build_jobs claim columns:', error)
    }

    // ============================================================
    // Document Center v2: external sources + connector abstraction
    // Adds support for pulling documents from external systems
    // (WeCom Drive, filesystem mounts, etc.) and mirroring them into
    // the document tree as `auto_managed` nodes. See
    // docs/document-center-v2-multi-source-design.md.
    // ============================================================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_sources (
        id                       TEXT PRIMARY KEY,
        org_id                   TEXT NOT NULL,
        type                     TEXT NOT NULL,                 -- 'wecom_drive' | 'filesystem'
        name                     TEXT NOT NULL,
        config_json              TEXT NOT NULL,                  -- {rootPath, mountedNodeId, ...}
        credentials_secret_key   TEXT,                            -- ref to tenant_secrets row
        sync_interval_sec        INTEGER NOT NULL DEFAULT 3600,
        auto_build_enabled       INTEGER NOT NULL DEFAULT 0,
        enabled                  INTEGER NOT NULL DEFAULT 1,
        last_sync_at             INTEGER,
        last_sync_status         TEXT,                            -- 'success' | 'failed' | 'running'
        last_sync_error          TEXT,
        created_by               TEXT NOT NULL,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS external_sources_org_idx
        ON external_sources (org_id);
      CREATE INDEX IF NOT EXISTS external_sources_enabled_idx
        ON external_sources (enabled, last_sync_at);
    `)

    // ============================================================
    // 企业应用管理 (Corp App Management)
    // ------------------------------------------------------------
    // Multiple named instances per type (first type: 'wecomapp').
    // Mirrors external_sources but without the sync-specific columns,
    // plus an indexed `app_key` (keyOf(config), e.g. corpId:agentId) so
    // the agent CLI can resolve an instance by key in O(1).
    // ============================================================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS corp_apps (
        id                       TEXT PRIMARY KEY,
        org_id                   TEXT NOT NULL,
        type                     TEXT NOT NULL,                 -- 'wecomapp'
        name                     TEXT NOT NULL,                 -- user-assigned unique name
        app_key                  TEXT NOT NULL,                 -- keyOf(config), e.g. corpId:agentId
        config_json              TEXT NOT NULL,                 -- {corpId, agentId, ...non-secret}
        credentials_secret_key   TEXT,                          -- ref to secret store
        enabled                  INTEGER NOT NULL DEFAULT 1,
        created_by               TEXT NOT NULL,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS corp_apps_org_name_idx
        ON corp_apps (org_id, name);
      CREATE UNIQUE INDEX IF NOT EXISTS corp_apps_org_type_key_idx
        ON corp_apps (org_id, type, app_key);
      CREATE INDEX IF NOT EXISTS corp_apps_org_idx
        ON corp_apps (org_id);

      CREATE TABLE IF NOT EXISTS corp_app_inbound (
        id           TEXT PRIMARY KEY,
        corp_app_id  TEXT NOT NULL,
        org_id       TEXT NOT NULL,
        seq          INTEGER NOT NULL,            -- monotonic per corp_app_id; poll cursor
        from_user    TEXT,
        msg_type     TEXT,
        text         TEXT,
        media_id     TEXT,
        file_name    TEXT,
        received_at  INTEGER NOT NULL,
        payload_json TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS corp_app_inbound_seq_uniq
        ON corp_app_inbound (corp_app_id, seq);
      DROP INDEX IF EXISTS corp_app_inbound_seq_idx;

      -- HA: per-corpApp msgaudit pull lease. One live instance holds a
      -- corpApp's lease while it pulls (forked child), so two instances behind
      -- an LB never pull the same instance concurrently (which would race the
      -- cursor and the JSONL read-modify-write). PG side is in v2.
      CREATE TABLE IF NOT EXISTS msgaudit_leases (
        corp_app_id  TEXT PRIMARY KEY,
        instance_id  TEXT,
        lease_until  INTEGER
      );
    `)

    // Incremental migration: add v2 columns to existing P0 tables.
    // Uses the moss-standard try/catch ALTER TABLE pattern.
    const v2NodeColumns: Array<[string, string]> = [
      ['source_id', 'TEXT'],
      ['source_path', 'TEXT'],
      ['auto_managed', 'INTEGER DEFAULT 0'],
      ['alias', 'TEXT'],
      ['last_synced_at', 'INTEGER'],
      ['deleted_at', 'INTEGER'],
    ]
    for (const [col, decl] of v2NodeColumns) {
      try {
        this.db.exec(`ALTER TABLE document_tree_nodes ADD COLUMN ${col} ${decl}`)
      } catch {
        // already exists
      }
    }
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS document_tree_nodes_source_idx
          ON document_tree_nodes (source_id, source_path)
      `)
    } catch {
      // ignore
    }

    const v2DocColumns: Array<[string, string]> = [
      ['source_id', 'TEXT'],
      ['external_id', 'TEXT'],
      ['external_etag', 'TEXT'],
      ['content_sha256', 'TEXT'],
      ['deleted_at', 'INTEGER'],
    ]
    for (const [col, decl] of v2DocColumns) {
      try {
        this.db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${decl}`)
      } catch {
        // already exists
      }
    }
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS documents_sha_idx
          ON documents (org_id, content_sha256);
        CREATE INDEX IF NOT EXISTS documents_external_idx
          ON documents (source_id, external_id);
      `)
    } catch {
      // ignore
    }

    try {
      this.db.exec(`ALTER TABLE wikis ADD COLUMN needs_rebuild INTEGER DEFAULT 0`)
    } catch {
      // already exists
    }

    // Document Center v2 — wiki source modes.
    //   source_mode: 'files' (frozen pick list) | 'dir' (track a node's recursive subtree)
    //   source_node_id: tracked node for 'dir' mode (distinct from node_id display-anchor)
    //   auto_rebuild: per-wiki auto-rebuild toggle (only meaningful for synced/dir sources)
    //   source_node_ids: JSON array of tracked dir node ids (dir mode, multi-dir).
    //     Supersedes the single source_node_id; each is tracked recursively.
    //   source_exclude_node_ids: JSON array of node ids to exclude (persistent
    //     subtree exclusions under an included dir).
    for (const alter of [
      `ALTER TABLE wikis ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'files'`,
      `ALTER TABLE wikis ADD COLUMN source_node_id TEXT`,
      `ALTER TABLE wikis ADD COLUMN auto_rebuild INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE wikis ADD COLUMN source_node_ids TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE wikis ADD COLUMN source_exclude_node_ids TEXT NOT NULL DEFAULT '[]'`,
    ]) {
      try {
        this.db.exec(alter)
      } catch {
        // already exists
      }
    }

    // ============================================================
    // Secrets Management Tables
    // ============================================================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        description   TEXT,
        icon          TEXT,
        pinyin        TEXT,
        scope         TEXT NOT NULL DEFAULT 'system',
        url_pattern   TEXT,
        scheme        TEXT,
        bearer_prefix TEXT,
        status        INTEGER DEFAULT 1,
        org_id        TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        auth_type          TEXT,
        auth_url           TEXT,
        token_url          TEXT,
        client_id          TEXT,
        client_secret_key  TEXT,
        refresh_token_key  TEXT,
        default_scopes     TEXT,
        token_request_json TEXT,
        mint_script        TEXT,
        body_auth_check    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_config_items_scope_status
        ON config_items (scope, status);
      CREATE INDEX IF NOT EXISTS idx_config_items_status
        ON config_items (status);
      CREATE INDEX IF NOT EXISTS idx_config_items_org
        ON config_items (org_id);
      -- Non-user-scope config items are org-bound: name/pinyin must be unique
      -- per org. User-scope definitions stay global (org_id NULL) and keep a
      -- single global-uniqueness guarantee.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_org_pinyin
        ON config_items (org_id, pinyin) WHERE scope != 'user';
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_org_name
        ON config_items (org_id, name) WHERE scope != 'user';
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_user_pinyin
        ON config_items (pinyin) WHERE scope = 'user';
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_user_name
        ON config_items (name) WHERE scope = 'user';

      CREATE TABLE IF NOT EXISTS config_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        config_item_id INTEGER NOT NULL,
        config_key     TEXT NOT NULL,
        name           TEXT NOT NULL,
        config_desc    TEXT,
        required       INTEGER DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        FOREIGN KEY (config_item_id) REFERENCES config_items(id) ON DELETE CASCADE,
        UNIQUE(config_item_id, config_key)
      );

      CREATE INDEX IF NOT EXISTS idx_config_entries_item
        ON config_entries (config_item_id);

      CREATE TABLE IF NOT EXISTS secret_metadata (
        id              TEXT PRIMARY KEY,
        config_item_id  INTEGER NOT NULL UNIQUE,
        org_id          TEXT,
        expires_at      INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        FOREIGN KEY (config_item_id) REFERENCES config_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_secret_metadata_expires
        ON secret_metadata (expires_at);

      CREATE TABLE IF NOT EXISTS department_secret_policies (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        department_id  TEXT NOT NULL,
        config_item_id INTEGER NOT NULL,
        org_id         TEXT,
        created_at     INTEGER NOT NULL,
        FOREIGN KEY (config_item_id) REFERENCES config_items(id) ON DELETE CASCADE,
        UNIQUE(department_id, config_item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_dept_policies_dept
        ON department_secret_policies (department_id);
      CREATE INDEX IF NOT EXISTS idx_dept_policies_config
        ON department_secret_policies (config_item_id);

      CREATE TABLE IF NOT EXISTS secret_audit_log (
        id              TEXT PRIMARY KEY,
        actor_id        TEXT NOT NULL,
        actor_name      TEXT,
        action          TEXT NOT NULL,
        config_item_id  INTEGER,
        org_id          TEXT,
        namespace       TEXT NOT NULL,
        key             TEXT NOT NULL,
        detail          TEXT,
        ip_address      TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_created
        ON secret_audit_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor_time
        ON secret_audit_log (actor_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_config_item_time
        ON secret_audit_log (config_item_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action_time
        ON secret_audit_log (action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_namespace
        ON secret_audit_log (namespace, key);

      -- ============================================================
      -- Cron Jobs: scheduled task management
      -- ============================================================
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,

        -- co_owner_ids: JSON array of user ids granted flat parity (view/manage/
        -- trigger) with the creator. NULL/absent = no co-owners. Excludes the
        -- creator (creator stays user_id).
        co_owner_ids TEXT,
        -- executor_user_id: identity a SCHEDULED run executes under (its user
        -- credentials/workspace/scopes). Set equal to the creator on create;
        -- transferable to any co-owner. NULL (legacy rows) falls back to user_id.
        executor_user_id TEXT,

        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER,

        schedule_kind TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        schedule_tz TEXT,
        schedule_description TEXT,

        payload_message TEXT NOT NULL,

        conversation_mode TEXT NOT NULL,
        bound_session_id TEXT,
        last_session_id TEXT,

        assistant_id TEXT,
        assistant_name TEXT,
        workspace TEXT,
        runtime_json TEXT,

        next_run_at INTEGER,
        lease_until INTEGER,
        last_run_at INTEGER,
        last_status TEXT,
        last_error TEXT,
        run_count INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cron_jobs_org_user
        ON cron_jobs (org_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
        ON cron_jobs (next_run_at) WHERE enabled = 1 AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_lease
        ON cron_jobs (lease_until) WHERE enabled = 1 AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_bound_session
        ON cron_jobs (bound_session_id);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_last_session
        ON cron_jobs (last_session_id);

      CREATE TABLE IF NOT EXISTS cron_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,

        session_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        summary TEXT,

        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job
        ON cron_job_runs (job_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cron_job_runs_session
        ON cron_job_runs (session_id);

      -- ============================================================
      -- Event Triggers: external systems POST an event to start an
      -- agent run in near-real-time. The cron analogue for pushes
      -- rather than schedules — see services/eventTrigger/.
      -- ============================================================
      CREATE TABLE IF NOT EXISTS event_triggers (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,

        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER,

        -- Bearer secret, stored as sha256 of the random secret (never
        -- recoverable) exactly like api_keys. secret_prefix is a display
        -- fragment so operators can identify a key without revealing it.
        secret_hash TEXT NOT NULL,
        secret_prefix TEXT NOT NULL,

        -- Instructions prepended to the POSTed payload. Kept server-side so
        -- the calling system supplies data, not agent instructions.
        prompt_template TEXT NOT NULL,

        assistant_name TEXT,
        conversation_mode TEXT NOT NULL DEFAULT 'new',
        bound_session_id TEXT,
        last_session_id TEXT,
        workspace TEXT,

        timeout_ms INTEGER,
        rate_limit_per_min INTEGER,

        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_triggers_org
        ON event_triggers (org_id, deleted_at);

      CREATE TABLE IF NOT EXISTS event_trigger_runs (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,

        session_id TEXT,
        status TEXT NOT NULL,

        -- Raw JSON event body as POSTed, appended to the prompt at run time.
        payload_json TEXT,
        -- Optional client-supplied dedupe key; unique per trigger (see index).
        idempotency_key TEXT,

        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        summary TEXT,

        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_trigger_runs_trigger
        ON event_trigger_runs (trigger_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_trigger_runs_status
        ON event_trigger_runs (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_event_trigger_runs_session
        ON event_trigger_runs (session_id);
      -- Enforces idempotency: a repeated key for the same trigger cannot
      -- create a second run. Partial so NULL keys (the common case) are exempt.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_trigger_runs_idem
        ON event_trigger_runs (trigger_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `)

    // Migration: add lease_until to cron_jobs
    const cronJobsColumns = this.db.prepare(`PRAGMA table_info(cron_jobs)`).all() as { name: string }[]
    if (!cronJobsColumns.some(col => col.name === 'lease_until')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN lease_until INTEGER;`)
      console.log('[DB] Added lease_until column to cron_jobs')
    }

    // Migration: add co_owner_ids + executor_user_id to cron_jobs. Legacy rows
    // keep NULL for both — no co-owners, and the executor falls back to user_id
    // (the creator) at runtime, so their behavior is unchanged.
    if (!cronJobsColumns.some(col => col.name === 'co_owner_ids')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN co_owner_ids TEXT;`)
      console.log('[DB] Added co_owner_ids column to cron_jobs')
    }
    if (!cronJobsColumns.some(col => col.name === 'executor_user_id')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN executor_user_id TEXT;`)
      console.log('[DB] Added executor_user_id column to cron_jobs')
    }

    // MCP Management tables
    McpStore.ensureTables(this.db)

    // Multi-org: add org_id to credential/secret tables and replace the global
    // UNIQUE(name)/UNIQUE(pinyin) on config_items with per-org partial uniques.
    // (Backfill of org_id values runs later via backfillOrgScoping(), once the
    // organizations table — created by AuthCenterDb on the same DB file — exists.)
    this.migrateConfigItemsOrgScoping()
  }

  /**
   * Migrate an existing config_items table that still carries the legacy global
   * UNIQUE on name/pinyin. SQLite can't drop a column-level constraint in place,
   * so recreate the table preserving every existing column (discovered via
   * PRAGMA so we don't have to hard-code the migrated column set), then add the
   * org_id column + per-org partial unique indexes. Idempotent.
   */
  private migrateConfigItemsOrgScoping(): void {
    try {
      const createSql = (this.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='config_items'`)
        .get() as SqlRow | undefined)?.sql as string | undefined
      // Recreate only if the legacy column-level UNIQUE is still present.
      if (createSql && /\bUNIQUE\b/i.test(createSql)) {
        const cols = (this.db.prepare(`PRAGMA table_info(config_items)`).all() as { name: string }[])
          .map(c => c.name)
        const hasOrg = cols.includes('org_id')
        const colList = cols.join(', ')
        // New table without the column-level UNIQUE; keep org_id if already added.
        this.db.exec(`
          CREATE TABLE config_items_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT NOT NULL,
            description   TEXT,
            icon          TEXT,
            pinyin        TEXT,
            scope         TEXT NOT NULL DEFAULT 'system',
            url_pattern   TEXT,
            scheme        TEXT,
            bearer_prefix TEXT,
            status        INTEGER DEFAULT 1,
            org_id        TEXT,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            auth_type TEXT, auth_url TEXT, token_url TEXT, client_id TEXT,
            client_secret_key TEXT, refresh_token_key TEXT, default_scopes TEXT,
            token_request_json TEXT, mint_script TEXT, body_auth_check TEXT
          );
        `)
        // Copy the intersection of old columns and the new table's columns.
        const newCols = new Set([
          'id', 'name', 'description', 'icon', 'pinyin', 'scope', 'url_pattern',
          'scheme', 'bearer_prefix', 'status', 'org_id', 'created_at', 'updated_at',
          'auth_type', 'auth_url', 'token_url', 'client_id', 'client_secret_key',
          'refresh_token_key', 'default_scopes', 'token_request_json', 'mint_script',
          'body_auth_check',
        ])
        const shared = cols.filter(c => newCols.has(c)).join(', ')
        this.db.exec(`INSERT INTO config_items_new (${shared}) SELECT ${shared} FROM config_items;`)
        this.db.exec(`DROP TABLE config_items;`)
        this.db.exec(`ALTER TABLE config_items_new RENAME TO config_items;`)
        void hasOrg
        void colList
        console.log('[DB] Recreated config_items without global UNIQUE (per-org uniqueness)')
      } else {
        // Fresh/already-migrated table: just ensure org_id exists.
        const cols = (this.db.prepare(`PRAGMA table_info(config_items)`).all() as { name: string }[])
          .map(c => c.name)
        if (!cols.includes('org_id')) {
          this.db.exec(`ALTER TABLE config_items ADD COLUMN org_id TEXT`)
        }
      }
      // (Re)create indexes — partial uniques enforce per-org isolation for
      // non-user scope while keeping user-scope definitions globally unique.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_config_items_scope_status ON config_items (scope, status);
        CREATE INDEX IF NOT EXISTS idx_config_items_status ON config_items (status);
        CREATE INDEX IF NOT EXISTS idx_config_items_org ON config_items (org_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_org_pinyin
          ON config_items (org_id, pinyin) WHERE scope != 'user';
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_org_name
          ON config_items (org_id, name) WHERE scope != 'user';
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_user_pinyin
          ON config_items (pinyin) WHERE scope = 'user';
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_config_items_user_name
          ON config_items (name) WHERE scope = 'user';
      `)
    } catch (error) {
      console.error('[DB] config_items org-scoping migration failed:', error)
    }

    // Add org_id to the dependent secret tables (ALTER is safe — no constraints).
    for (const [table] of [['secret_metadata'], ['department_secret_policies'], ['secret_audit_log']]) {
      try {
        const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
        if (!cols.includes('org_id')) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN org_id TEXT`)
          console.log(`[DB] Added org_id column to ${table}`)
        }
      } catch (error) {
        console.error(`[DB] Failed to add org_id to ${table}:`, error)
      }
    }
  }

  /**
   * Backfill org_id on pre-existing credential/secret/channel rows to the
   * default (first) organization. Must run AFTER the organizations table is
   * populated (i.e. after auth bootstrap). Non-user-scope config items get the
   * default org; user-scope definitions stay global (org_id NULL). Idempotent —
   * only touches NULL org_id rows. `defaultOrgId` is the org to assign.
   */
  async backfillOrgScoping(defaultOrgId: string): Promise<void> {
    if (!defaultOrgId) return
    try {
      await this.driver.run(
        `UPDATE config_items SET org_id = ? WHERE org_id IS NULL AND scope != 'user'`,
        [defaultOrgId],
      )
      // secret_metadata inherits its config item's org.
      await this.driver.exec(`
        UPDATE secret_metadata
        SET org_id = (SELECT ci.org_id FROM config_items ci WHERE ci.id = secret_metadata.config_item_id)
        WHERE org_id IS NULL
      `)
      await this.driver.run(
        `UPDATE department_secret_policies SET org_id = ? WHERE org_id IS NULL`,
        [defaultOrgId],
      )
      await this.driver.run(
        `UPDATE secret_audit_log SET org_id = ? WHERE org_id IS NULL`,
        [defaultOrgId],
      )
      // Tenant skills/assistants: stranded global rows go to the default org.
      await this.driver.run(`UPDATE tenant_skills SET org_id = ? WHERE org_id IS NULL`, [defaultOrgId])
      await this.driver.run(`UPDATE tenant_assistants SET org_id = ? WHERE org_id IS NULL`, [defaultOrgId])
      // Channels: backfill from the owning user's org where resolvable, else default.
      await this.driver.exec(`
        UPDATE channel_plugins
        SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = channel_plugins.user_id), '${defaultOrgId}')
        WHERE org_id IS NULL OR org_id = ''
      `)
      await this.driver.exec(`
        UPDATE channel_users
        SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = channel_users.user_id), '${defaultOrgId}')
        WHERE org_id IS NULL OR org_id = ''
      `)
    } catch (error) {
      console.error('[DB] backfillOrgScoping failed:', error)
    }
  }

  async close(): Promise<void> {
    ;(this as any)._closed = true
    // Driver-polymorphic: sqlite closes its handle, postgres ends the pool.
    // The postgres construction form leaves `db` undefined, so the old
    // `this.db.close()` crashed there and never released the connections.
    await this.driver.close()
  }

  isOpen(): boolean {
    return !(this as any)._closed
  }

  async registerServerInstance(host: string, pid = process.pid, instanceId?: string): Promise<ServerInstanceRecord> {
    // With a stable MOSS_INSTANCE_ID the row survives restarts (stop only
    // marks it stopped), so a fixed id must UPSERT over its own previous
    // incarnation instead of INSERT — otherwise the second start crashes on
    // the PRIMARY KEY with a restart loop. Unset ids stay random and never
    // conflict (single-instance behavior unchanged).
    const resolvedInstanceId = instanceId ?? randomUUID()
    const ts = now()
    await this.driver.run(`
      INSERT INTO server_instances (
        instance_id, host, pid, started_at, heartbeat_at, status
      ) VALUES (?, ?, ?, ?, ?, 'running')
      ON CONFLICT(instance_id) DO UPDATE SET
        host = excluded.host,
        pid = excluded.pid,
        started_at = excluded.started_at,
        heartbeat_at = excluded.heartbeat_at,
        status = 'running',
        stopped_at = NULL
    `, [resolvedInstanceId, host, pid, ts, ts])
    return {
      instanceId: resolvedInstanceId,
      host,
      pid,
      startedAt: ts,
      heartbeatAt: ts,
      stoppedAt: null,
      status: 'running',
    }
  }

  async heartbeatServerInstance(instanceId: string): Promise<void> {
    await this.driver.run(`
      UPDATE server_instances
      SET heartbeat_at = ?, status = 'running'
      WHERE instance_id = ?
    `, [now(), instanceId])
  }

  async stopServerInstance(instanceId: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE server_instances
      SET heartbeat_at = ?, stopped_at = ?, status = 'stopped'
      WHERE instance_id = ?
    `, [ts, ts, instanceId])
  }

  async createSession(input: {
    sessionId: string
    transcriptSessionId: string
    transcriptPath: string
    userId: string
    orgId: string
    role: string
    scopes: string[]
    cwd: string
    runtime: SessionRuntimeInfo
    status: SessionStatus
    desiredState: DesiredSessionState
    assistantName?: string
    source?: string
    channelChatId?: string
  }): Promise<SessionRecord> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO sessions (
        session_id, transcript_session_id, org_id, user_id, role, scopes_json,
        cwd, runtime_type, docker_image, docker_mode, config_dir, container_name,
        status, desired_state, current_attempt_id, transcript_path, title, summary, assistant_name,
        source, channel_chat_id,
        created_at, last_active_at, ended_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL)
    `, [
      input.sessionId,
      input.transcriptSessionId,
      input.orgId,
      input.userId,
      input.role,
      JSON.stringify(input.scopes),
      input.cwd,
      input.runtime.type,
      input.runtime.dockerImage ?? null,
      (input.runtime.type === 'docker'
        ? input.runtime.dockerMode
        : input.runtime.type === 'k8s'
          ? input.runtime.k8sMode
          : input.runtime.hostMode) ?? null,
      input.runtime.configDir ?? null,
      input.runtime.containerName ?? null,
      input.status,
      input.desiredState,
      input.transcriptPath,
      input.assistantName ?? null,
      input.source ?? null,
      input.channelChatId ?? null,
      ts,
      ts,
    ])
    await this.addEvent(input.sessionId, null, 'session_created', {
      runtime: input.runtime,
      cwd: input.cwd,
      assistantName: input.assistantName,
    })
    return (await this.getSession(input.sessionId))!
  }

  async createAttempt(input: {
    sessionId: string
    generation: number
    backendType: 'host' | 'docker' | 'k8s'
    resumeTranscriptSessionId: string
    serverInstanceId: string
    containerName?: string
    attachPath?: string
  }): Promise<AttemptRecord> {
    const attemptId = randomUUID()
    const ts = now()
    await this.driver.run(`
      INSERT INTO session_attempts (
        attempt_id, session_id, generation, backend_type, runtime_state,
        server_instance_id, runner_pid, container_name, attach_path,
        resume_transcript_session_id, started_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, 'starting', ?, NULL, ?, ?, ?, ?, ?)
    `, [
      attemptId,
      input.sessionId,
      input.generation,
      input.backendType,
      input.serverInstanceId,
      input.containerName ?? null,
      input.attachPath ?? null,
      input.resumeTranscriptSessionId,
      ts,
      ts,
    ])
    await this.addEvent(input.sessionId, attemptId, 'attempt_created', {
      generation: input.generation,
      backendType: input.backendType,
      attachPath: input.attachPath,
      containerName: input.containerName,
    })
    return (await this.getAttempt(attemptId))!
  }

  async setCurrentAttempt(sessionId: string, attemptId: string | null): Promise<void> {
    await this.driver.run(`
      UPDATE sessions
      SET current_attempt_id = ?
      WHERE session_id = ?
    `, [attemptId, sessionId])
  }

  /**
   * Concurrent multi-instance HA: atomically claim ownership of an attempt for
   * this instance. Succeeds only when the attempt is already ours, unowned, or
   * its current owner is dead (server instance stopped, gone, or heartbeat stale
   * beyond `heartbeatTimeoutMs`). A live owner keeps its attempt untouched, so at
   * most one instance ever runs a session's runner. The UPDATE is a single
   * statement, so SQLite (WAL) / any transactional store serialises the CAS and
   * exactly one contending instance wins (`changes === 1`).
   */
  async claimAttempt(attemptId: string, selfInstanceId: string, heartbeatTimeoutMs: number): Promise<boolean> {
    // The common WebSocket path checks an attempt already owned by this process.
    // Avoid rewriting that row: besides being unnecessary, a write here can wait
    // behind another SQLite writer and delay the HTTP upgrade even though no
    // ownership transfer is needed.
    const current = await this.getAttempt(attemptId)
    if (!current) return false
    if (current.serverInstanceId === selfInstanceId) return true

    const deadBefore = now() - heartbeatTimeoutMs
    const changes = await this.driver.run(`
      UPDATE session_attempts
      SET server_instance_id = ?
      WHERE attempt_id = ?
        AND (
          server_instance_id = ?
          OR server_instance_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM server_instances si
            WHERE si.instance_id = session_attempts.server_instance_id
              AND si.status = 'running'
              AND si.heartbeat_at >= ?
          )
        )
    `, [selfInstanceId, attemptId, selfInstanceId, deadBefore])
    return changes > 0
  }

  /**
   * Owner-aware LB (HA design §9.1): resolve the owning instance of an attempt
   * plus whether it is live (running + heartbeat fresh) — the same liveness
   * predicate claimAttempt uses for its CAS, exposed read-only for API
   * serialization. Single JOIN so per-request calls stay one query.
   */
  async getAttemptOwnerStatus(
    attemptId: string,
    heartbeatTimeoutMs: number,
  ): Promise<{ ownerInstanceId: string | null; ownerLive: boolean }> {
    const row = await this.driver.get<SqlRow>(`
      SELECT a.server_instance_id AS owner,
        EXISTS (
          SELECT 1 FROM server_instances si
          WHERE si.instance_id = a.server_instance_id
            AND si.status = 'running'
            AND si.heartbeat_at >= ?
        ) AS live
      FROM session_attempts a
      WHERE a.attempt_id = ?
    `, [now() - heartbeatTimeoutMs, attemptId])
    if (!row) return { ownerInstanceId: null, ownerLive: false }
    return {
      ownerInstanceId: typeof row.owner === 'string' ? row.owner : null,
      ownerLive: Boolean(row.live),
    }
  }

  async setSessionLifecycle(
    sessionId: string,
    status: SessionStatus,
    desiredState: DesiredSessionState,
  ): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE sessions
      SET status = ?, desired_state = ?, last_active_at = ?
      WHERE session_id = ?
    `, [status, desiredState, ts, sessionId])
  }

  /**
   * Reactivate a session that was previously idle-killed (status=ended,
   * desired=active, ended_at set). Clears ended_at and resets status/desired
   * to 'active' so the row reads as a live session again after respawn.
   */
  async reactivateSession(sessionId: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE sessions
      SET status = 'active', desired_state = 'active', ended_at = NULL,
          last_active_at = ?
      WHERE session_id = ?
    `, [ts, sessionId])
  }

  async markSessionEnded(
    sessionId: string,
    status: SessionStatus,
    desiredState: DesiredSessionState,
  ): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE sessions
      SET status = ?, desired_state = ?, ended_at = ?, last_active_at = ?
      WHERE session_id = ?
    `, [status, desiredState, ts, ts, sessionId])
  }

  async touchSessionActivity(sessionId: string): Promise<void> {
    await this.driver.run(`
      UPDATE sessions
      SET last_active_at = ?
      WHERE session_id = ?
    `, [now(), sessionId])
  }

  /**
   * Find the runtime session backing one IM chat.
   *
   * `chatId` must be the connection-scoped chat key (see scopedChatId): with multiple
   * connections of a type, the platform's own chat id repeats across bots — a DM is keyed
   * by the platform user — so an unscoped lookup would hand bot B the session belonging to
   * bot A, mixing two conversations into one. `source` stays the bare platform because the
   * sessions UI renders it as the platform label.
   */
  async findChannelSession(source: string, chatId: string, userId: string): Promise<SessionRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT *
      FROM sessions
      WHERE source = ? AND channel_chat_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY last_active_at DESC
      LIMIT 1
    `, [source, chatId, userId])
    return row ? mapSession(row) : null
  }

  async updateSessionTranscript(
    sessionId: string,
    patch: {
      transcriptSessionId: string
      transcriptPath: string
    },
  ): Promise<void> {
    await this.driver.run(`
      UPDATE sessions
      SET transcript_session_id = ?,
          transcript_path = ?
      WHERE session_id = ?
    `, [
      patch.transcriptSessionId,
      patch.transcriptPath,
      sessionId,
    ])
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: { title?: string | null; summary?: string | null },
  ): Promise<void> {
    await this.driver.run(`
      UPDATE sessions
      SET title = COALESCE(?, title),
          summary = COALESCE(?, summary)
      WHERE session_id = ?
    `, [
      patch.title === undefined ? null : patch.title,
      patch.summary === undefined ? null : patch.summary,
      sessionId,
    ])
  }

  /**
   * Shallow-merge `patch` into the session's opaque client_metadata JSON blob.
   * A key set to `undefined` in `patch` deletes that key; any other value
   * (including `null`) overwrites it. Read-merge-write, so callers only send the
   * keys they want to change. Missing session or empty result collapses to NULL.
   */
  async updateSessionClientMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.driver.get<SqlRow>(
      `SELECT client_metadata FROM sessions WHERE session_id = ?`,
      [sessionId],
    )
    if (!row) return
    const current = parseJsonObject(row.client_metadata) ?? {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete current[key]
      } else {
        current[key] = value
      }
    }
    const serialized = Object.keys(current).length > 0 ? JSON.stringify(current) : null
    await this.driver.run(`
      UPDATE sessions
      SET client_metadata = ?
      WHERE session_id = ?
    `, [serialized, sessionId])
  }

  async updateSessionRuntimeImage(sessionId: string, dockerImage: string): Promise<void> {
    await this.driver.run(`
      UPDATE sessions
      SET docker_image = ?
      WHERE session_id = ?
    `, [dockerImage, sessionId])
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.driver.run(`
      UPDATE sessions
      SET deleted_at = ?
      WHERE session_id = ?
    `, [now(), sessionId])
  }

  async updateAttemptRunner(attemptId: string, runnerPid: number): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE session_attempts
      SET runner_pid = ?, runtime_state = 'running', last_heartbeat_at = ?
      WHERE attempt_id = ?
    `, [runnerPid, ts, attemptId])
  }

  /**
   * Runner heartbeat. With `ownerInstanceId` (multi-instance mode,
   * MOSS_INSTANCE_ID configured) this doubles as fencing: the UPDATE only
   * lands while the attempt still belongs to that owner and is still
   * 'running'. Returns false when another instance claimed the attempt or it
   * reached a terminal state — the caller (runner daemon) must then exit so
   * a new owner can respawn cleanly. Without `ownerInstanceId` (single
   * instance — manifest carries no instanceId to match the resolved UUID
   * anyway) the unconditional legacy UPDATE applies and this always returns
   * true.
   */
  async touchAttemptHeartbeat(
    attemptId: string,
    state: AttemptRuntimeState = 'running',
    ownerInstanceId?: string,
  ): Promise<boolean> {
    if (ownerInstanceId) {
      const changes = await this.driver.run(`
        UPDATE session_attempts
        SET last_heartbeat_at = ?, runtime_state = ?
        WHERE attempt_id = ?
          AND server_instance_id = ?
          AND runtime_state IN ('starting', 'running')
      `, [now(), state, attemptId, ownerInstanceId])
      return changes > 0
    }
    await this.driver.run(`
      UPDATE session_attempts
      SET last_heartbeat_at = ?, runtime_state = ?
      WHERE attempt_id = ?
    `, [now(), state, attemptId])
    return true
  }

  /**
   * Write an attempt terminal. With `ownerInstanceId` (fencing-aware exit
   * chain — mirrors touchAttemptHeartbeat's owner mode) the UPDATE only lands
   * while this instance still owns the attempt AND it is still starting/running,
   * returning false when a new owner already claimed it: a fenced old daemon
   * must NOT clobber the takeover owner's live session. Without it the
   * unconditional legacy UPDATE applies and this returns true (single-instance
   * / markAttemptLost / reconcile paths unchanged).
   */
  async markAttemptStopped(
    attemptId: string,
    input: {
      runtimeState: AttemptRuntimeState
      exitCode?: number | null
      exitSignal?: string | null
      stopReason?: string | null
      errorText?: string | null
    },
    ownerInstanceId?: string,
  ): Promise<boolean> {
    const ts = now()
    const setClause = `
      SET runtime_state = ?, stopped_at = ?, last_heartbeat_at = ?,
          exit_code = ?, exit_signal = ?, stop_reason = ?, error_text = ?`
    const setParams = [
      input.runtimeState,
      ts,
      ts,
      input.exitCode ?? null,
      input.exitSignal ?? null,
      input.stopReason ?? null,
      input.errorText ?? null,
    ]
    if (ownerInstanceId) {
      const changes = await this.driver.run(`
        UPDATE session_attempts
        ${setClause}
        WHERE attempt_id = ?
          AND server_instance_id = ?
          AND runtime_state IN ('starting', 'running')
      `, [...setParams, attemptId, ownerInstanceId])
      return changes > 0
    }
    await this.driver.run(`
      UPDATE session_attempts
      ${setClause}
      WHERE attempt_id = ?
    `, [...setParams, attemptId])
    return true
  }

  async markAttemptLost(attemptId: string, errorText: string): Promise<void> {
    await this.markAttemptStopped(attemptId, {
      runtimeState: 'lost',
      stopReason: 'runner_unavailable',
      errorText,
    })
  }

  /**
   * Returns every attempt whose runtime_state column says it is still
   * starting/running/detached (i.e. has not been written terminal yet).
   * Used by reconcileOnStartup to clean stale rows whose runner_pid is no
   * longer alive on the host.
   */
  async listAttemptsByRuntimeState(states: AttemptRuntimeState[]): Promise<AttemptRecord[]> {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(',')
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM session_attempts
      WHERE runtime_state IN (${placeholders})
    `, states)
    return rows.map(mapAttempt)
  }

  async listSessionRecords(filter: SessionListFilter): Promise<SessionRecord[]> {
    const clauses = ['org_id = ?']
    const values: Array<string | number> = [filter.orgId]
    if (filter.userId) {
      clauses.push('user_id = ?')
      values.push(filter.userId)
    }
    if (!filter.includeDeleted) {
      clauses.push('deleted_at IS NULL')
    }
    if (filter.activeOnly) {
      clauses.push(`status IN ('creating', 'active', 'detached')`)
    }
    const rows = await this.driver.all<SqlRow>(`
      SELECT *
      FROM sessions
      WHERE ${clauses.join(' AND ')}
      ORDER BY last_active_at DESC
    `, values)
    return rows.map(mapSession)
  }

  async listSessions(filter: SessionListFilter): Promise<SessionSummary[]> {
    return (await this.listSessionRecords(filter)).map(toSessionSummary)
  }

  async listUserSessions(orgId: string, userId: string): Promise<SessionRecord[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT *
      FROM sessions
      WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY last_active_at DESC
    `, [orgId, userId])
    return rows.map(mapSession)
  }

  /** Look up a user's org_id from the users table */
  async getUserOrgId(userId: string): Promise<string | null> {
    const row = await this.driver.get<SqlRow>(`SELECT org_id FROM users WHERE id = ?`, [userId])
    return row?.org_id ? String(row.org_id) : null
  }

  async listSessionsToRecover(): Promise<SessionRecord[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT *
      FROM sessions
      WHERE desired_state = 'active'
        AND deleted_at IS NULL
        AND status IN ('creating', 'active', 'detached', 'lost', 'failed')
      ORDER BY last_active_at DESC
    `)
    return rows.map(mapSession)
  }

  /**
   * Concurrent multi-instance HA: active sessions whose current attempt is owned
   * by a DEAD *other* instance (stopped, gone, or heartbeat stale beyond
   * `heartbeatTimeoutMs`). These are orphans a surviving instance should adopt +
   * recover. Our own sessions are excluded — we already run them, so a periodic
   * adoption pass never re-probes healthy local sessions.
   */
  async listOrphanedActiveSessions(selfInstanceId: string, heartbeatTimeoutMs: number): Promise<SessionRecord[]> {
    const deadBefore = now() - heartbeatTimeoutMs
    const rows = await this.driver.all<SqlRow>(`
      SELECT s.*
      FROM sessions s
      JOIN session_attempts a ON a.attempt_id = s.current_attempt_id
      WHERE s.desired_state = 'active'
        AND s.deleted_at IS NULL
        AND s.status IN ('creating', 'active', 'detached', 'lost', 'failed')
        AND a.server_instance_id IS NOT NULL
        AND a.server_instance_id != ?
        AND NOT EXISTS (
          SELECT 1 FROM server_instances si
          WHERE si.instance_id = a.server_instance_id
            AND si.status = 'running'
            AND si.heartbeat_at >= ?
        )
      ORDER BY s.last_active_at DESC
    `, [selfInstanceId, deadBefore])
    return rows.map(mapSession)
  }

  async countActiveSessions(): Promise<number> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE deleted_at IS NULL
        AND status IN ('creating', 'active', 'detached')
    `)
    return Number(row?.count ?? 0)
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT *
      FROM sessions
      WHERE session_id = ? AND deleted_at IS NULL
      LIMIT 1
    `, [sessionId])
    return row ? mapSession(row) : null
  }

  async getAttempt(attemptId: string): Promise<AttemptRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT *
      FROM session_attempts
      WHERE attempt_id = ?
      LIMIT 1
    `, [attemptId])
    return row ? mapAttempt(row) : null
  }

  async getCurrentAttempt(sessionId: string): Promise<AttemptRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT a.*
      FROM session_attempts a
      JOIN sessions s ON s.current_attempt_id = a.attempt_id
      WHERE s.session_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `, [sessionId])
    return row ? mapAttempt(row) : null
  }

  async getNextGeneration(sessionId: string): Promise<number> {
    const row = await this.driver.get<SqlRow>(`
      SELECT COALESCE(MAX(generation), 0) AS max_generation
      FROM session_attempts
      WHERE session_id = ?
    `, [sessionId])
    return Number(row?.max_generation ?? 0) + 1
  }

  async addEvent(
    sessionId: string,
    attemptId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<SessionEventRecord> {
    const eventId = randomUUID()
    const createdAt = now()
    await this.driver.run(`
      INSERT INTO session_events (
        event_id, session_id, attempt_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      eventId,
      sessionId,
      attemptId,
      eventType,
      JSON.stringify(payload),
      createdAt,
    ])
    return {
      eventId,
      sessionId,
      attemptId,
      eventType,
      payload,
      createdAt,
    }
  }

  async latestEvent(sessionId: string, eventType: string): Promise<SessionEventRecord | null> {
    const row = await this.driver.get<SqlRow>(`
      SELECT *
      FROM session_events
      WHERE session_id = ? AND event_type = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [sessionId, eventType])
    if (!row) {
      return null
    }
    return {
      eventId: String(row.event_id),
      sessionId: String(row.session_id),
      attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
      eventType: String(row.event_type),
      payload:
        typeof row.payload_json === 'string'
          ? (JSON.parse(row.payload_json) as Record<string, unknown>)
          : {},
      createdAt: Number(row.created_at),
    }
  }

  async getEnterprise(): Promise<EnterpriseRecord> {
    const row = await this.driver.get<SqlRow>(`
      SELECT * FROM enterprises WHERE id = 'default' LIMIT 1
    `)

    if (!row) {
      throw new Error('Default enterprise record not found')
    }

    return {
      id: String(row.id),
      logo: typeof row.logo === 'string' ? row.logo : null,
      app_name: typeof row.app_name === 'string' ? row.app_name : null,
      top_name: typeof row.top_name === 'string' ? row.top_name : null,
      about_name: typeof row.about_name === 'string' ? row.about_name : null,
      app_company_name: typeof row.app_company_name === 'string' ? row.app_company_name : null,
      login_desp: typeof row.login_desp === 'string' ? row.login_desp : null,
      // null (column never set) is preserved so the client applies its
      // default-on behaviour; 0/1 map to false/true.
      client_cron_enabled:
        row.client_cron_enabled === null || row.client_cron_enabled === undefined
          ? null
          : Number(row.client_cron_enabled) !== 0,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }
  }

  async updateEnterprise(patch: Partial<Omit<EnterpriseRecord, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const entries = Object.entries(patch)
    if (entries.length === 0) return

    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    // SQLite has no boolean type — coerce booleans to 0/1 so INTEGER columns
    // (e.g. client_cron_enabled) bind correctly; everything else passes through.
    const values = entries.map(([, value]) =>
      typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null,
    )
    const ts = now()

    await this.driver.run(`
      UPDATE enterprises
      SET ${sets}, updated_at = ?
      WHERE id = 'default'
    `, [...values, ts])
  }

  // ==================== Channel Plugins ====================

  async listChannelPlugins(userId?: string): Promise<SqlRow[]> {
    if (userId) {
      return this.driver.all<SqlRow>(`SELECT * FROM channel_plugins WHERE user_id = ? ORDER BY created_at DESC`, [userId])
    }
    return this.driver.all<SqlRow>(`SELECT * FROM channel_plugins ORDER BY created_at DESC`)
  }

  /**
   * Claim (or renew) the lease on one plugin row for `owner` (HA). Takes the
   * lease when it is unheld, already ours, or expired; renews lease_until when
   * already ours. A peer's fresh lease is left untouched. changes > 0 iff this
   * instance now holds it. Per (id, user_id) so multi-user rows of one plugin
   * id lease independently.
   */
  async claimChannelPluginLease(id: string, userId: string, owner: string, leaseUntil: number, now: number): Promise<boolean> {
    const changes = await this.driver.run(`
      UPDATE channel_plugins
      SET lease_owner = ?, lease_until = ?
      WHERE id = ? AND user_id = ? AND enabled = 1
        AND (lease_owner IS NULL OR lease_owner = ? OR lease_until < ?)
    `, [owner, leaseUntil, id, userId, owner, now])
    return changes > 0
  }

  /** Release every plugin lease this instance holds (graceful shutdown). */
  async releaseAllChannelPluginLeases(owner: string): Promise<void> {
    await this.driver.run(
      `UPDATE channel_plugins SET lease_owner = NULL WHERE lease_owner = ?`,
      [owner],
    )
  }

  /**
   * Find another user in the same org who already configured this channel with the
   * same bot identity. Used to reject duplicate configurations: two users sharing one
   * bot credential means the IM platform pushes each message to both connections,
   * and the chat sees a duplicate reply for every message.
   *
   * Only enabled rows reserve an identity: a disabled connection holds no subscription and
   * therefore causes no duplicates, so it must not block another user (or the same bot being
   * re-saved after its previous owner turned it off).
   *
   * Returns the conflicting owner (id + display name) or null when the identity is free.
   */
  async findChannelPluginCredentialOwner(params: {
    type: string
    identity: string
    orgId: string | null
    excludeUserId: string
  }): Promise<{ userId: string; name: string } | null> {
    const { type, identity, orgId, excludeUserId } = params
    if (!identity) return null
    const rows = await this.driver.all<SqlRow>(
      `SELECT p.user_id AS user_id, p.org_id AS org_id, p.credentials_json AS credentials_json,
              u.display_name AS display_name, u.name AS name, u.email AS email
         FROM channel_plugins p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.type = ? AND p.user_id != ? AND p.enabled = 1`,
      [type, excludeUserId],
    )

    for (const row of rows) {
      // Only conflict within the same org; rows with no org are treated as global.
      if (orgId && row.org_id && String(row.org_id) !== orgId) continue
      const owner = row.user_id ? String(row.user_id) : ''
      if (!owner) continue
      if (!row.credentials_json) continue
      let creds: Record<string, unknown>
      try {
        creds = JSON.parse(String(row.credentials_json)) as Record<string, unknown>
      } catch {
        continue
      }
      if (channelCredentialIdentity(type, creds) !== identity) continue
      const name = String(row.display_name || row.name || row.email || owner)
      return { userId: owner, name }
    }
    return null
  }

  /**
   * Whether this user already connected the same bot identity under a DIFFERENT plugin id.
   *
   * Now that a user may hold several connections of one type, they can point two of them at
   * the same bot by mistake. The IM platform would then push every message to both
   * connections and the chat would see a duplicate reply, so the second one is rejected —
   * the same rule findChannelPluginCredentialOwner enforces across users.
   */
  async findOwnChannelPluginWithIdentity(params: {
    type: string
    identity: string
    userId: string
    excludePluginId: string
  }): Promise<string | null> {
    const { type, identity, userId, excludePluginId } = params
    if (!identity) return null
    const rows = await this.driver.all<SqlRow>(
      `SELECT id, name, credentials_json FROM channel_plugins
        WHERE type = ? AND user_id = ? AND id != ? AND enabled = 1`,
      [type, userId, excludePluginId],
    )

    for (const row of rows) {
      if (!row.credentials_json) continue
      let creds: Record<string, unknown>
      try {
        creds = JSON.parse(String(row.credentials_json)) as Record<string, unknown>
      } catch {
        continue
      }
      if (channelCredentialIdentity(type, creds) !== identity) continue
      return String(row.name || row.id)
    }
    return null
  }

  async getChannelPlugin(id: string, userId?: string): Promise<SqlRow | null> {
    if (userId) {
      return (await this.driver.get<SqlRow>(`SELECT * FROM channel_plugins WHERE id = ? AND user_id = ?`, [id, userId])) ?? null
    }
    return (await this.driver.get<SqlRow>(`SELECT * FROM channel_plugins WHERE id = ?`, [id])) ?? null
  }

  async upsertChannelPlugin(row: {
    id: string
    type: string
    name: string
    enabled: number
    credentials_json?: string | null
    config_json?: string | null
    status: string
    last_connected?: number | null
    user_id: string
    org_id?: string | null
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO channel_plugins (
        id, type, name, enabled, credentials_json, config_json, status, last_connected, user_id, org_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, user_id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        credentials_json = COALESCE(excluded.credentials_json, credentials_json),
        config_json = COALESCE(excluded.config_json, config_json),
        status = excluded.status,
        last_connected = COALESCE(excluded.last_connected, last_connected),
        org_id = COALESCE(excluded.org_id, org_id),
        updated_at = excluded.updated_at
    `, [
      row.id,
      row.type,
      row.name,
      row.enabled,
      row.credentials_json ?? null,
      row.config_json ?? null,
      row.status,
      row.last_connected ?? null,
      row.user_id,
      row.org_id ?? null,
      ts,
      ts,
    ])
  }

  async updateChannelPluginStatus(id: string, status: string, lastConnected?: number, userId?: string): Promise<void> {
    const ts = now()
    if (userId) {
      await this.driver.run(`
        UPDATE channel_plugins
        SET status = ?, last_connected = COALESCE(?, last_connected), updated_at = ?
        WHERE id = ? AND user_id = ?
      `, [status, lastConnected ?? null, ts, id, userId])
    } else {
      await this.driver.run(`
        UPDATE channel_plugins
        SET status = ?, last_connected = COALESCE(?, last_connected), updated_at = ?
        WHERE id = ?
      `, [status, lastConnected ?? null, ts, id])
    }
  }

  /** Remove one connection row. Used when a user deletes a channel connection. */
  async deleteChannelPlugin(id: string, userId: string): Promise<void> {
    await this.driver.run(`DELETE FROM channel_plugins WHERE id = ? AND user_id = ?`, [id, userId])
  }

  // ==================== Channel Users ====================

  async listChannelUsers(userId?: string): Promise<SqlRow[]> {
    if (userId) {
      return this.driver.all<SqlRow>(`SELECT * FROM channel_users WHERE user_id = ? ORDER BY authorized_at DESC`, [userId])
    }
    return this.driver.all<SqlRow>(`SELECT * FROM channel_users ORDER BY authorized_at DESC`)
  }

  /**
   * Look up an authorized channel user within ONE connection.
   *
   * `scope` is the connection scope (pluginScope): the bare platform for a type's first
   * connection, the plugin id for any additional one. Matching on the platform instead
   * would let a user paired with one bot talk to every other bot of that type.
   */
  async getChannelUserByPlatform(platformUserId: string, scope: string, userId?: string): Promise<SqlRow | null> {
    if (userId) {
      return (await this.driver.get<SqlRow>(
        `SELECT * FROM channel_users WHERE platform_user_id = ? AND plugin_scope = ? AND user_id = ?`,
        [platformUserId, scope, userId],
      )) ?? null
    }
    return (await this.driver.get<SqlRow>(
      `SELECT * FROM channel_users WHERE platform_user_id = ? AND plugin_scope = ?`,
      [platformUserId, scope],
    )) ?? null
  }

  async upsertChannelUser(row: {
    id: string
    platform_user_id: string
    platform_type: string
    plugin_scope?: string | null
    display_name?: string | null
    authorized_at: number
    last_active?: number | null
    session_id?: string | null
    org_id?: string | null
    user_id?: string | null
  }): Promise<void> {
    await this.driver.run(`
      INSERT INTO channel_users (
        id, platform_user_id, platform_type, plugin_scope, display_name, authorized_at, last_active, session_id, org_id, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_user_id, plugin_scope, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        last_active = excluded.last_active,
        session_id = excluded.session_id,
        org_id = excluded.org_id,
        user_id = excluded.user_id
    `, [
      row.id,
      row.platform_user_id,
      row.platform_type,
      row.plugin_scope ?? row.platform_type,
      row.display_name ?? null,
      row.authorized_at,
      row.last_active ?? null,
      row.session_id ?? null,
      row.org_id ?? null,
      row.user_id ?? null,
    ])
  }

  async getChannelUserById(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM channel_users WHERE id = ?`, [id])) ?? null
  }

  async deleteChannelUser(id: string): Promise<void> {
    await this.driver.run(`DELETE FROM channel_users WHERE id = ?`, [id])
  }

  /**
   * Drop authorized users for ONE connection (scope), not the whole platform:
   * disabling one bot must not deauthorize everyone paired with its siblings.
   */
  async deleteChannelUsersByPlatform(scope: string, userId?: string): Promise<number> {
    if (userId) {
      return this.driver.run(`DELETE FROM channel_users WHERE plugin_scope = ? AND user_id = ?`, [scope, userId])
    }
    return this.driver.run(`DELETE FROM channel_users WHERE plugin_scope = ?`, [scope])
  }

  // ==================== Channel Sessions ====================

  async listChannelSessions(): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(`SELECT * FROM channel_sessions ORDER BY last_activity DESC`)
  }

  async upsertChannelSession(row: {
    id: string
    user_id: string
    agent_type: string
    conversation_id?: string | null
    workspace?: string | null
    chat_id?: string | null
    created_at: number
    last_activity: number
  }): Promise<void> {
    await this.driver.run(`
      INSERT INTO channel_sessions (
        id, user_id, agent_type, conversation_id, workspace, chat_id, created_at, last_activity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        workspace = excluded.workspace,
        chat_id = excluded.chat_id,
        last_activity = excluded.last_activity
    `, [
      row.id,
      row.user_id,
      row.agent_type,
      row.conversation_id ?? null,
      row.workspace ?? null,
      row.chat_id ?? null,
      row.created_at,
      row.last_activity,
    ])
  }

  /**
   * Conversation depth for a chat, in user turns. Drives IM turn-cap rotation.
   *
   * Keyed by (user_id, chat_id) rather than the channel_sessions PRIMARY KEY:
   * SessionManager.createSessionWithConversation DELETEs the old row and
   * INSERTs one with a fresh uuid whenever a chat's session record is rebuilt,
   * so a depth counted against `id` would silently reset to 0 there. Since
   * rebuilding the row is routine, the cap would then never fire and the
   * compaction growth it exists to bound would go unchecked — the failure
   * would only surface months later as [single_request_too_large].
   */
  async getChannelSessionTurnCount(userId: string, chatId?: string): Promise<number> {
    const row = await this.driver.get<SqlRow>(
      `SELECT MAX(COALESCE(turn_count, 0)) AS tc FROM channel_sessions
       WHERE user_id = ? AND COALESCE(chat_id, '') = COALESCE(?, '')`,
      [userId, chatId ?? null],
    )
    return row ? Number(row.tc ?? 0) : 0
  }

  /** Increment a chat's conversation depth by one turn; returns the new value. */
  async incrementChannelSessionTurnCount(userId: string, chatId?: string): Promise<number> {
    await this.driver.run(
      `UPDATE channel_sessions SET turn_count = COALESCE(turn_count, 0) + 1
       WHERE user_id = ? AND COALESCE(chat_id, '') = COALESCE(?, '')`,
      [userId, chatId ?? null],
    )
    return this.getChannelSessionTurnCount(userId, chatId)
  }

  /** Seed a freshly-inserted row's depth, used by SessionManager to carry the
   *  count across a channel_sessions row rebuild. Keyed by row id because the
   *  new row is the only one for that chat at call time. */
  async setChannelSessionTurnCount(id: string, turnCount: number): Promise<void> {
    await this.driver.run(
      `UPDATE channel_sessions SET turn_count = ? WHERE id = ?`,
      [Math.max(0, Math.trunc(turnCount)), id],
    )
  }

  /** Reset depth to zero. Called ONLY after a rotation actually replaced the
   *  runtime session — never on an idle revive. */
  async resetChannelSessionTurnCount(userId: string, chatId?: string): Promise<void> {
    await this.driver.run(
      `UPDATE channel_sessions SET turn_count = 0
       WHERE user_id = ? AND COALESCE(chat_id, '') = COALESCE(?, '')`,
      [userId, chatId ?? null],
    )
  }

  async deleteChannelSession(id: string): Promise<void> {
    await this.driver.run(`DELETE FROM channel_sessions WHERE id = ?`, [id])
  }

  // ==================== Channel Pairings ====================

  async listPendingPairingRequests(userId?: string): Promise<SqlRow[]> {
    if (userId) {
      return this.driver.all<SqlRow>(`SELECT * FROM channel_pairing_requests WHERE status = 'pending' AND expires_at > ? AND (user_id = ? OR user_id IS NULL)`, [now(), userId])
    }
    return this.driver.all<SqlRow>(`SELECT * FROM channel_pairing_requests WHERE status = 'pending' AND expires_at > ?`, [now()])
  }

  async getPairingRequest(code: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM channel_pairing_requests WHERE code = ?`, [code])) ?? null
  }

  async upsertPairingRequest(row: {
    code: string
    platform_user_id: string
    platform_type: string
    plugin_scope?: string | null
    display_name?: string | null
    requested_at: number
    expires_at: number
    status: string
    user_id?: string | null
  }): Promise<void> {
    await this.driver.run(`
      INSERT INTO channel_pairing_requests (
        code, platform_user_id, platform_type, plugin_scope, display_name, requested_at, expires_at, status, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        status = excluded.status,
        user_id = excluded.user_id,
        platform_type = excluded.platform_type,
        plugin_scope = excluded.plugin_scope,
        display_name = excluded.display_name,
        requested_at = excluded.requested_at,
        expires_at = excluded.expires_at
    `, [
      row.code,
      row.platform_user_id,
      row.platform_type,
      row.plugin_scope ?? row.platform_type,
      row.display_name ?? null,
      row.requested_at,
      row.expires_at,
      row.status,
      row.user_id ?? null,
    ])
  }

  async updatePairingRequestStatus(code: string, status: string): Promise<void> {
    await this.driver.run(`UPDATE channel_pairing_requests SET status = ? WHERE code = ?`, [status, code])
  }

  /** Drop pending pairing codes for ONE connection (scope), not the whole platform. */
  async deletePairingRequestsByUserAndPlatform(userId: string, scope: string): Promise<void> {
    await this.driver.run(`DELETE FROM channel_pairing_requests WHERE user_id = ? AND plugin_scope = ?`, [userId, scope])
  }

  // ==================== Tenant Skills ====================

  async listTenantSkills(status?: string, orgId?: string): Promise<SqlRow[]> {
    const conds: string[] = []
    const params: unknown[] = []
    if (status) { conds.push('status = ?'); params.push(status) }
    // Org isolation: a NULL org_id row is legacy/global and stays visible.
    if (orgId) { conds.push('(org_id = ? OR org_id IS NULL)'); params.push(orgId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    return this.driver.all<SqlRow>(`SELECT * FROM tenant_skills ${where} ORDER BY created_at DESC`, params as SqlParam[])
  }

  async getTenantSkill(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM tenant_skills WHERE id = ?`, [id])) ?? null
  }

  async getTenantSkillByName(name: string, orgId?: string): Promise<SqlRow | null> {
    if (orgId) {
      return (await this.driver.get<SqlRow>(`SELECT * FROM tenant_skills WHERE name = ? AND (org_id = ? OR org_id IS NULL)`, [name, orgId])) ?? null
    }
    return (await this.driver.get<SqlRow>(`SELECT * FROM tenant_skills WHERE name = ?`, [name])) ?? null
  }

  async createTenantSkill(row: {
    id: string
    name: string
    display_name?: string | null
    description?: string | null
    version?: string | null
    author_id: string
    author_name?: string | null
    status?: string
    source_url?: string | null
    checksum?: string | null
    file_path?: string | null
    publish_note?: string | null
    enabled?: number
    visible_to?: string | null
    org_id?: string | null
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO tenant_skills (
        id, name, display_name, description, version, author_id, author_name, status,
        source_url, checksum, file_path, publish_note, enabled, visible_to, org_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id,
      row.name,
      row.display_name ?? null,
      row.description ?? null,
      row.version ?? null,
      row.author_id,
      row.author_name ?? null,
      row.status ?? 'pending',
      row.source_url ?? null,
      row.checksum ?? null,
      row.file_path ?? null,
      row.publish_note ?? null,
      row.enabled ?? 1,
      row.visible_to ?? null,
      row.org_id ?? null,
      ts,
      ts,
    ])
  }

  async updateTenantSkillStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE tenant_skills
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
      WHERE id = ?
    `, [status, reviewedBy, ts, reviewNote ?? null, ts, id])
  }

  async updateTenantSkillMeta(id: string, updates: {
    display_name?: string
    description?: string
    enabled?: number
    visible_to?: string | null
  }): Promise<void> {
    const ts = now()
    const existing = await this.getTenantSkill(id)
    if (!existing) return

    const displayName = updates.display_name ?? existing.display_name
    const description = updates.description ?? existing.description
    const enabled = updates.enabled ?? existing.enabled
    const visibleTo = updates.visible_to !== undefined ? updates.visible_to : existing.visible_to

    await this.driver.run(`
      UPDATE tenant_skills
      SET display_name = ?, description = ?, enabled = ?, visible_to = ?, updated_at = ?
      WHERE id = ?
    `, [displayName as string, description as string, enabled as number, visibleTo as string | null, ts, id])
  }

  async updateTenantSkillFilePath(id: string, filePath: string, sourceUrl: string, checksum: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE tenant_skills
      SET file_path = ?, source_url = ?, checksum = ?, updated_at = ?
      WHERE id = ?
    `, [filePath, sourceUrl, checksum, ts, id])
  }

  async deleteTenantSkill(id: string): Promise<void> {
    await this.driver.run(`DELETE FROM tenant_skills WHERE id = ?`, [id])
  }

  // ==================== Tenant Assistants ====================

  async listTenantAssistants(status?: string, orgId?: string): Promise<SqlRow[]> {
    const conds: string[] = []
    const params: unknown[] = []
    if (status) { conds.push('status = ?'); params.push(status) }
    if (orgId) { conds.push('(org_id = ? OR org_id IS NULL)'); params.push(orgId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    return this.driver.all<SqlRow>(`SELECT * FROM tenant_assistants ${where} ORDER BY created_at DESC`, params as SqlParam[])
  }

  async getTenantAssistant(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM tenant_assistants WHERE id = ?`, [id])) ?? null
  }

  async getTenantAssistantByName(name: string, orgId?: string): Promise<SqlRow | null> {
    if (orgId) {
      return (await this.driver.get<SqlRow>(`SELECT * FROM tenant_assistants WHERE name = ? AND (org_id = ? OR org_id IS NULL)`, [name, orgId])) ?? null
    }
    return (await this.driver.get<SqlRow>(`SELECT * FROM tenant_assistants WHERE name = ?`, [name])) ?? null
  }

  async createTenantAssistant(row: {
    id: string
    name: string
    display_name?: string | null
    description?: string | null
    default_init_prompt?: string | null
    prompts_i18n?: string | null
    categories?: string | null
    avatar?: string | null
    emoji?: string | null
    version?: string | null
    author_id: string
    author_name?: string | null
    status?: string
    source_url?: string | null
    checksum?: string | null
    file_path?: string | null
    enabled_skills?: string | null
    enabled_wikis?: string | null
    enabled_corp_apps?: string | null
    skills?: string | null
    memory_mode?: string
    agent_type?: string
    publish_note?: string | null
    enabled?: number
    visible_to?: string | null
    workflow?: string | null
    org_id?: string | null
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO tenant_assistants (
        id, name, display_name, description, default_init_prompt, prompts_i18n, categories, avatar, emoji, version, author_id, author_name, status,
        source_url, checksum, file_path, enabled_skills, skills, memory_mode, agent_type, publish_note, enabled, visible_to, enabled_wikis, enabled_corp_apps, workflow, org_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id,
      row.name,
      row.display_name ?? null,
      row.description ?? null,
      row.default_init_prompt ?? null,
      row.prompts_i18n ?? null,
      row.categories ?? null,
      row.avatar ?? null,
      row.emoji ?? null,
      row.version ?? null,
      row.author_id,
      row.author_name ?? null,
      row.status ?? 'pending',
      row.source_url ?? null,
      row.checksum ?? null,
      row.file_path ?? null,
      row.enabled_skills ?? null,
      row.skills ?? null,
      row.memory_mode ?? 'session',
      row.agent_type ?? 'chat',
      row.publish_note ?? null,
      row.enabled ?? 1,
      row.visible_to ?? null,
      row.enabled_wikis ?? null,
      row.enabled_corp_apps ?? null,
      row.workflow ?? null,
      row.org_id ?? null,
      ts,
      ts,
    ])
  }

  async updateTenantAssistantStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE tenant_assistants
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
      WHERE id = ?
    `, [status, reviewedBy, ts, reviewNote ?? null, ts, id])
  }

  async updateTenantAssistantMeta(id: string, updates: {
    display_name?: string
    description?: string
    default_init_prompt?: string | null
    prompts_i18n?: string | null
    categories?: string | null
    enabled?: number
    visible_to?: string | null
    enabled_skills?: string | null
    avatar?: string | null
    emoji?: string | null
    agent_type?: string
    memory_mode?: string
    enabled_wikis?: string | null
    enabled_corp_apps?: string | null
    skills?: string | null
    workflow?: string | null
  }): Promise<void> {
    const ts = now()
    const existing = await this.getTenantAssistant(id)
    if (!existing) return

    const displayName = updates.display_name ?? existing.display_name
    const description = updates.description ?? existing.description
    const defaultInitPrompt = updates.default_init_prompt !== undefined ? updates.default_init_prompt : (existing.default_init_prompt as string | null)
    const promptsI18n = updates.prompts_i18n !== undefined ? updates.prompts_i18n : (existing.prompts_i18n as string | null)
    const categories = updates.categories !== undefined ? updates.categories : (existing.categories as string | null)
    const enabled = updates.enabled ?? existing.enabled
    const visibleTo = updates.visible_to !== undefined ? updates.visible_to : existing.visible_to
    const enabledSkills = updates.enabled_skills ?? existing.enabled_skills
    const avatar = updates.avatar !== undefined ? updates.avatar : (existing.avatar as string | null)
    const emoji = updates.emoji !== undefined ? updates.emoji : (existing.emoji as string | null)
    const agentType = updates.agent_type ?? existing.agent_type
    const memoryMode = updates.memory_mode ?? existing.memory_mode
    const enabledWikis = updates.enabled_wikis !== undefined ? updates.enabled_wikis : (existing.enabled_wikis as string | null)
    const enabledCorpApps = updates.enabled_corp_apps !== undefined ? updates.enabled_corp_apps : (existing.enabled_corp_apps as string | null)
    const skills = updates.skills !== undefined ? updates.skills : (existing.skills as string | null)
    const workflow = updates.workflow !== undefined ? updates.workflow : (existing.workflow as string | null)

    await this.driver.run(`
      UPDATE tenant_assistants
      SET display_name = ?, description = ?, default_init_prompt = ?, prompts_i18n = ?, categories = ?, enabled = ?, visible_to = ?, enabled_skills = ?,
          avatar = ?, emoji = ?, agent_type = ?, memory_mode = ?, enabled_wikis = ?, enabled_corp_apps = ?, skills = ?, workflow = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      displayName as string,
      description as string,
      defaultInitPrompt,
      promptsI18n,
      categories,
      enabled as number,
      visibleTo as string | null,
      enabledSkills as string | null,
      avatar,
      emoji,
      agentType as string,
      memoryMode as string,
      enabledWikis,
      enabledCorpApps,
      skills,
      workflow,
      ts,
      id
    ])
  }

  async updateTenantAssistantFilePath(id: string, filePath: string, sourceUrl: string, checksum: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE tenant_assistants
      SET file_path = ?, source_url = ?, checksum = ?, updated_at = ?
      WHERE id = ?
    `, [filePath, sourceUrl, checksum, ts, id])
  }

  /**
   * Update tenant agent file_path only (used after approval to point to tenant directory)
   */
  async updateTenantAssistantPath(id: string, filePath: string): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE tenant_assistants
      SET file_path = ?, updated_at = ?
      WHERE id = ?
    `, [filePath, ts, id])
  }

  async deleteTenantAssistant(id: string): Promise<void> {
    await this.driver.run(`DELETE FROM tenant_assistants WHERE id = ?`, [id])
  }

  // ==================== Document Center: Tree Nodes ====================

  async listDocumentTreeNodes(orgId: string): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM document_tree_nodes WHERE org_id = ? ORDER BY sort_order, created_at`,
      [orgId],
    )
  }

  async getDocumentTreeNode(id: string, orgId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM document_tree_nodes WHERE id = ? AND org_id = ?`, [id, orgId])) ?? null
  }

  async createDocumentTreeNode(row: {
    id: string
    org_id: string
    parent_id: string | null
    name: string
    description?: string | null
    sort_order?: number
    source_id?: string | null
    source_path?: string | null
    auto_managed?: number
    alias?: string | null
    last_synced_at?: number | null
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO document_tree_nodes (
        id, org_id, parent_id, name, description, sort_order, created_at, updated_at,
        source_id, source_path, auto_managed, alias, last_synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id,
      row.org_id,
      row.parent_id ?? null,
      row.name,
      row.description ?? null,
      row.sort_order ?? 0,
      ts,
      ts,
      row.source_id ?? null,
      row.source_path ?? null,
      row.auto_managed ?? 0,
      row.alias ?? null,
      row.last_synced_at ?? null,
    ])
  }

  async updateDocumentTreeNode(id: string, orgId: string, updates: {
    parent_id?: string | null
    name?: string
    description?: string | null
    sort_order?: number
  }): Promise<void> {
    const ts = now()
    const existing = await this.getDocumentTreeNode(id, orgId)
    if (!existing) return
    await this.driver.run(`
      UPDATE document_tree_nodes
      SET parent_id = ?, name = ?, description = ?, sort_order = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `, [
      updates.parent_id !== undefined ? updates.parent_id : (existing.parent_id as string | null),
      updates.name ?? (existing.name as string),
      updates.description !== undefined ? updates.description : (existing.description as string | null),
      updates.sort_order ?? (existing.sort_order as number),
      ts,
      id,
      orgId,
    ])
  }

  async deleteDocumentTreeNode(id: string, orgId: string): Promise<void> {
    // ON DELETE CASCADE will remove child nodes and their documents
    await this.driver.run(`DELETE FROM document_tree_nodes WHERE id = ? AND org_id = ?`, [id, orgId])
  }

  // ==================== Document Center: Documents ====================

  async listDocumentsByNode(nodeId: string, orgId: string): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM documents WHERE node_id = ? AND org_id = ? ORDER BY uploaded_at DESC`,
      [nodeId, orgId],
    )
  }

  async getDocument(id: string, orgId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM documents WHERE id = ? AND org_id = ?`, [id, orgId])) ?? null
  }

  async createDocument(row: {
    id: string
    org_id: string
    node_id: string
    file_name: string
    mime_type: string
    size_bytes: number
    storage_path: string
    uploaded_by: string
    source_id?: string | null
    external_id?: string | null
    external_etag?: string | null
    content_sha256?: string | null
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO documents (
        id, org_id, node_id, file_name, mime_type, size_bytes, storage_path,
        uploaded_by, uploaded_at,
        source_id, external_id, external_etag, content_sha256
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id,
      row.org_id,
      row.node_id,
      row.file_name,
      row.mime_type,
      row.size_bytes,
      row.storage_path,
      row.uploaded_by,
      ts,
      row.source_id ?? null,
      row.external_id ?? null,
      row.external_etag ?? null,
      row.content_sha256 ?? null,
    ])
  }

  async deleteDocument(id: string, orgId: string): Promise<void> {
    await this.driver.run(`DELETE FROM documents WHERE id = ? AND org_id = ?`, [id, orgId])
  }

  // ==================== Document Center: Wikis ====================

  async listWikis(orgId: string, filter?: { nodeId?: string; buildStatus?: string }): Promise<SqlRow[]> {
    const conditions = ['org_id = ?']
    const params: unknown[] = [orgId]
    if (filter?.nodeId) {
      conditions.push('node_id = ?')
      params.push(filter.nodeId)
    }
    if (filter?.buildStatus) {
      conditions.push('build_status = ?')
      params.push(filter.buildStatus)
    }
    return this.driver.all<SqlRow>(
      `SELECT * FROM wikis WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params as SqlParam[],
    )
  }

  async getWiki(id: string, orgId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM wikis WHERE id = ? AND org_id = ?`, [id, orgId])) ?? null
  }

  /** Cross-org getter for runtime / build worker use. */
  async getWikiById(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM wikis WHERE id = ?`, [id])) ?? null
  }

  async createWiki(row: {
    id: string
    org_id: string
    node_id?: string | null
    name: string
    description?: string | null
    storage_path: string
    source_document_ids?: string[]
    source_mode?: 'files' | 'dir'
    source_node_id?: string | null
    source_node_ids?: string[]
    source_exclude_node_ids?: string[]
    auto_rebuild?: boolean
    created_by: string
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO wikis (
        id, org_id, node_id, name, description, storage_path,
        build_status, source_document_ids, source_mode, source_node_id, auto_rebuild,
        source_node_ids, source_exclude_node_ids,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id,
      row.org_id,
      row.node_id ?? null,
      row.name,
      row.description ?? null,
      row.storage_path,
      JSON.stringify(row.source_document_ids ?? []),
      row.source_mode ?? 'files',
      row.source_node_id ?? null,
      row.auto_rebuild ? 1 : 0,
      JSON.stringify(row.source_node_ids ?? []),
      JSON.stringify(row.source_exclude_node_ids ?? []),
      row.created_by,
      ts,
      ts,
    ])
  }

  async updateWiki(id: string, orgId: string, updates: {
    name?: string
    description?: string | null
    node_id?: string | null
    source_document_ids?: string[]
    source_mode?: 'files' | 'dir'
    source_node_id?: string | null
    source_node_ids?: string[]
    source_exclude_node_ids?: string[]
    auto_rebuild?: boolean
  }): Promise<void> {
    const ts = now()
    const existing = await this.getWiki(id, orgId)
    if (!existing) return
    await this.driver.run(`
      UPDATE wikis
      SET name = ?, description = ?, node_id = ?, source_document_ids = ?,
          source_mode = ?, source_node_id = ?, auto_rebuild = ?,
          source_node_ids = ?, source_exclude_node_ids = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `, [
      updates.name ?? (existing.name as string),
      updates.description !== undefined ? updates.description : (existing.description as string | null),
      updates.node_id !== undefined ? updates.node_id : (existing.node_id as string | null),
      updates.source_document_ids !== undefined
        ? JSON.stringify(updates.source_document_ids)
        : (existing.source_document_ids as string),
      updates.source_mode ?? (existing.source_mode as string),
      updates.source_node_id !== undefined ? updates.source_node_id : (existing.source_node_id as string | null),
      updates.auto_rebuild !== undefined
        ? (updates.auto_rebuild ? 1 : 0)
        : (existing.auto_rebuild as number),
      updates.source_node_ids !== undefined
        ? JSON.stringify(updates.source_node_ids)
        : (existing.source_node_ids as string),
      updates.source_exclude_node_ids !== undefined
        ? JSON.stringify(updates.source_exclude_node_ids)
        : (existing.source_exclude_node_ids as string),
      ts,
      id,
      orgId,
    ])
  }

  async updateWikiBuildResult(id: string, result: {
    build_status: 'pending' | 'running' | 'succeeded' | 'failed'
    last_built_at?: number
    last_build_error?: string | null
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      UPDATE wikis
      SET build_status = ?, last_built_at = ?, last_build_error = ?, updated_at = ?
      WHERE id = ?
    `, [
      result.build_status,
      result.last_built_at ?? null,
      result.last_build_error ?? null,
      ts,
      id,
    ])
  }

  async deleteWiki(id: string, orgId: string): Promise<void> {
    await this.driver.run(`DELETE FROM wikis WHERE id = ? AND org_id = ?`, [id, orgId])
  }

  // ==================== Document Center: Build Jobs ====================

  async listWikiBuildJobs(wikiId: string, limit = 20): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM wiki_build_jobs WHERE wiki_id = ? ORDER BY queued_at DESC LIMIT ?`,
      [wikiId, limit],
    )
  }

  async listWikiBuildJobsForOrg(orgId: string, opts?: {
    status?: string
    wikiId?: string
    limit?: number
    offset?: number
  }): Promise<{ items: SqlRow[]; total: number }> {
    const where = ['w.org_id = ?']
    const params: Array<string | number> = [orgId]
    if (opts?.status) {
      where.push('j.status = ?')
      params.push(opts.status)
    }
    if (opts?.wikiId) {
      where.push('j.wiki_id = ?')
      params.push(opts.wikiId)
    }
    const whereSql = where.join(' AND ')
    const totalRow = await this.driver.get<{ c: number }>(`
        SELECT COUNT(*) AS c
        FROM wiki_build_jobs j
        JOIN wikis w ON w.id = j.wiki_id
        WHERE ${whereSql}
      `, params)
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 50), 1), 200)
    const offset = Math.max(Math.floor(opts?.offset ?? 0), 0)
    const items = await this.driver.all<SqlRow>(`
        SELECT
          j.*,
          w.name AS wiki_name,
          w.node_id AS wiki_node_id,
          w.build_status AS wiki_build_status,
          w.needs_rebuild AS wiki_needs_rebuild
        FROM wiki_build_jobs j
        JOIN wikis w ON w.id = j.wiki_id
        WHERE ${whereSql}
        ORDER BY j.queued_at DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, offset])
    return { items, total: totalRow ? Number(totalRow.c) : 0 }
  }

  async getWikiBuildJobForOrg(id: string, orgId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`
        SELECT
          j.*,
          w.name AS wiki_name,
          w.node_id AS wiki_node_id,
          w.build_status AS wiki_build_status,
          w.needs_rebuild AS wiki_needs_rebuild
        FROM wiki_build_jobs j
        JOIN wikis w ON w.id = j.wiki_id
        WHERE j.id = ? AND w.org_id = ?
      `, [id, orgId])) ?? null
  }

  async getWikiBuildJob(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM wiki_build_jobs WHERE id = ?`, [id])) ?? null
  }

  async getLatestWikiBuildJob(wikiId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(
      `SELECT * FROM wiki_build_jobs WHERE wiki_id = ? ORDER BY queued_at DESC LIMIT 1`,
      [wikiId],
    )) ?? null
  }

  async countRunningWikiBuildJobs(): Promise<number> {
    const row = await this.driver.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM wiki_build_jobs WHERE status IN ('queued', 'running')`,
    )
    return row ? Number(row.c) : 0
  }

  async listQueuedWikiBuildJobs(limit = 10): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM wiki_build_jobs WHERE status = 'queued' ORDER BY queued_at LIMIT ?`,
      [limit],
    )
  }

  /**
   * Atomically claim up to `limit` queued jobs, flipping them to 'running' and
   * stamping the owning instance in the SAME statement (CAS). The inner SELECT
   * picks candidates; the outer `AND status = 'queued'` re-checks under the row
   * lock (PG EvalPlanQual / SQLite writer serialization) so two instances polling
   * concurrently never both claim the same job and double-run the build. Only the
   * rows this call actually flipped come back via RETURNING.
   */
  async claimQueuedWikiBuildJobs(limit: number, instanceId: string | undefined, now: number): Promise<SqlRow[]> {
    if (limit <= 0) return []
    return this.driver.all<SqlRow>(`
      UPDATE wiki_build_jobs
      SET status = 'running', claimed_by = ?, claimed_at = ?, started_at = COALESCE(started_at, ?)
      WHERE id IN (
        SELECT id FROM wiki_build_jobs
        WHERE status = 'queued'
        ORDER BY queued_at
        LIMIT ?
      )
      AND status = 'queued'
      RETURNING *
    `, [instanceId ?? null, now, now, limit])
  }

  /**
   * Jobs still 'running' whose claim/start stamp is older than `before` — i.e.
   * the owning instance crashed or wedged mid-build. The reaper fails these so
   * they stop occupying the wiki's build slot forever.
   */
  async listStaleRunningWikiBuildJobs(before: number): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM wiki_build_jobs WHERE status = 'running' AND COALESCE(claimed_at, started_at) < ?`,
      [before],
    )
  }

  async createWikiBuildJob(row: {
    id: string
    wiki_id: string
    triggered_by: string
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO wiki_build_jobs (id, wiki_id, status, progress, triggered_by, queued_at)
      VALUES (?, ?, 'queued', 0, ?, ?)
    `, [row.id, row.wiki_id, row.triggered_by, ts])
  }

  async updateWikiBuildJob(id: string, updates: {
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    progress?: number
    current_step?: string | null
    error_message?: string | null
    session_id?: string | null
    started_at?: number
    finished_at?: number
  }): Promise<void> {
    // Dynamic SET: only the columns explicitly provided are written. Read-then-
    // write-all would let a slow owner's progress update (which carries no
    // status) re-write existing.status='running' back over a value the stale
    // reaper just set to 'failed', resurrecting a dead job and making the reaper
    // useless. Touching only provided columns keeps status changes authoritative.
    const sets: string[] = []
    const params: SqlParam[] = []
    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status) }
    if (updates.progress !== undefined) { sets.push('progress = ?'); params.push(updates.progress) }
    if (updates.current_step !== undefined) { sets.push('current_step = ?'); params.push(updates.current_step) }
    if (updates.error_message !== undefined) { sets.push('error_message = ?'); params.push(updates.error_message) }
    if (updates.session_id !== undefined) { sets.push('session_id = ?'); params.push(updates.session_id) }
    if (updates.started_at !== undefined) { sets.push('started_at = ?'); params.push(updates.started_at) }
    if (updates.finished_at !== undefined) { sets.push('finished_at = ?'); params.push(updates.finished_at) }
    if (sets.length === 0) return
    params.push(id)
    await this.driver.run(
      `UPDATE wiki_build_jobs SET ${sets.join(', ')} WHERE id = ?`,
      params,
    )
  }

  // ==================== Document Center v2: External Sources ====================

  async listExternalSources(orgId: string, opts?: { enabledOnly?: boolean }): Promise<SqlRow[]> {
    if (opts?.enabledOnly) {
      return this.driver.all<SqlRow>(
        `SELECT * FROM external_sources WHERE org_id = ? AND enabled = 1 ORDER BY created_at`,
        [orgId],
      )
    }
    return this.driver.all<SqlRow>(
      `SELECT * FROM external_sources WHERE org_id = ? ORDER BY created_at`,
      [orgId],
    )
  }

  /** Cross-org: used by the sync worker which has no caller context. */
  async listAllEnabledExternalSources(): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM external_sources WHERE enabled = 1 ORDER BY last_sync_at`,
    )
  }

  async getExternalSource(id: string, orgId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM external_sources WHERE id = ? AND org_id = ?`, [id, orgId])) ?? null
  }

  /** Cross-org getter for the sync worker. */
  async getExternalSourceById(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM external_sources WHERE id = ?`, [id])) ?? null
  }

  async createExternalSource(row: {
    id: string
    org_id: string
    type: string
    name: string
    config_json: string
    credentials_secret_key?: string | null
    sync_interval_sec?: number
    auto_build_enabled?: number
    created_by: string
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO external_sources (
        id, org_id, type, name, config_json, credentials_secret_key,
        sync_interval_sec, auto_build_enabled, enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `, [
      row.id,
      row.org_id,
      row.type,
      row.name,
      row.config_json,
      row.credentials_secret_key ?? null,
      row.sync_interval_sec ?? 3600,
      row.auto_build_enabled ?? 0,
      row.created_by,
      ts,
      ts,
    ])
  }

  async updateExternalSource(id: string, orgId: string, updates: {
    name?: string
    config_json?: string
    credentials_secret_key?: string | null
    sync_interval_sec?: number
    auto_build_enabled?: number
    enabled?: number
  }): Promise<void> {
    const existing = await this.getExternalSource(id, orgId)
    if (!existing) return
    const ts = now()
    await this.driver.run(`
      UPDATE external_sources
      SET name = ?, config_json = ?, credentials_secret_key = ?,
          sync_interval_sec = ?, auto_build_enabled = ?, enabled = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `, [
      updates.name ?? (existing.name as string),
      updates.config_json ?? (existing.config_json as string),
      updates.credentials_secret_key !== undefined
        ? updates.credentials_secret_key
        : (existing.credentials_secret_key as string | null),
      updates.sync_interval_sec ?? (existing.sync_interval_sec as number),
      updates.auto_build_enabled !== undefined ? updates.auto_build_enabled : (existing.auto_build_enabled as number),
      updates.enabled !== undefined ? updates.enabled : (existing.enabled as number),
      ts,
      id,
      orgId,
    ])
  }

  async updateExternalSourceSyncStatus(id: string, status: {
    last_sync_at?: number
    last_sync_status?: 'success' | 'failed' | 'running'
    last_sync_error?: string | null
  }): Promise<void> {
    const existing = await this.getExternalSourceById(id)
    if (!existing) return
    await this.driver.run(`
      UPDATE external_sources
      SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?
      WHERE id = ?
    `, [
      status.last_sync_at ?? (existing.last_sync_at as number | null),
      status.last_sync_status ?? (existing.last_sync_status as string | null),
      status.last_sync_error !== undefined ? status.last_sync_error : (existing.last_sync_error as string | null),
      id,
    ])
  }

  async deleteExternalSource(id: string, orgId: string, opts?: { cascadeTree?: boolean }): Promise<void> {
    // The auto-managed knowledge tree this source created (document_tree_nodes with
    // source_id = <id>) is handled per the caller's choice:
    //   - cascadeTree: remove those nodes too. documents under them cascade
    //     (documents.node_id ON DELETE CASCADE); any built wiki survives with
    //     node_id nulled (wikis.node_id ON DELETE SET NULL).
    //   - otherwise: keep the tree, just orphaned. There is no FK to external_sources
    //     and no future sync will ever sweep it, so it stays until an admin deletes
    //     the orphaned node manually (allowed once its source is gone).
    if (opts?.cascadeTree) {
      await this.driver.run(`DELETE FROM document_tree_nodes WHERE source_id = ? AND org_id = ?`, [id, orgId])
    }
    await this.driver.run(`DELETE FROM external_sources WHERE id = ? AND org_id = ?`, [id, orgId])
  }

  // ==================== 企业应用管理 (Corp Apps) ====================

  async listCorpApps(orgId: string, opts?: { enabledOnly?: boolean }): Promise<SqlRow[]> {
    if (opts?.enabledOnly) {
      return this.driver.all<SqlRow>(
        `SELECT * FROM corp_apps WHERE org_id = ? AND enabled = 1 ORDER BY created_at`,
        [orgId],
      )
    }
    return this.driver.all<SqlRow>(
      `SELECT * FROM corp_apps WHERE org_id = ? ORDER BY created_at`,
      [orgId],
    )
  }

  async getCorpApp(id: string, orgId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM corp_apps WHERE id = ? AND org_id = ?`, [id, orgId])) ?? null
  }

  /** Cross-org getter (callback listener has no caller org context). */
  async getCorpAppById(id: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM corp_apps WHERE id = ?`, [id])) ?? null
  }

  /**
   * Cross-org listing of enabled instances of one type. Used by the
   * 会话存档 pull worker, which is a background loop with no caller org
   * context (like the callback listener above).
   */
  async listAllCorpAppsByType(type: string): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM corp_apps WHERE type = ? AND enabled = 1 ORDER BY created_at`,
      [type],
    )
  }

  /**
   * Claim the msgaudit pull lease for one corpApp. Single-statement UPSERT: the
   * INSERT wins when no row exists; on conflict the DO UPDATE runs ONLY when the
   * existing lease has expired (`lease_until < now`), so a live holder is never
   * displaced. Returns true iff this call took/renewed the lease (changes > 0).
   * Verified: the conflict-with-unmet-WHERE reports 0 affected rows on both
   * SQLite and PG (see msgAuditLease.test.ts).
   */
  async claimMsgAuditLease(corpAppId: string, instanceId: string, leaseUntil: number, now: number): Promise<boolean> {
    const changes = await this.driver.run(`
      INSERT INTO msgaudit_leases (corp_app_id, instance_id, lease_until)
      VALUES (?, ?, ?)
      ON CONFLICT(corp_app_id) DO UPDATE SET
        instance_id = excluded.instance_id,
        lease_until = excluded.lease_until
      WHERE msgaudit_leases.lease_until < ?
    `, [corpAppId, instanceId, leaseUntil, now])
    return changes > 0
  }

  /** Release a lease this instance holds (no-op if another instance owns it). */
  async releaseMsgAuditLease(corpAppId: string, instanceId: string): Promise<void> {
    await this.driver.run(
      `DELETE FROM msgaudit_leases WHERE corp_app_id = ? AND instance_id = ?`,
      [corpAppId, instanceId],
    )
  }

  async getCorpAppByName(orgId: string, name: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(`SELECT * FROM corp_apps WHERE org_id = ? AND name = ?`, [orgId, name])) ?? null
  }

  async getCorpAppByKey(orgId: string, type: string, appKey: string): Promise<SqlRow | null> {
    return (
      (await this.driver.get<SqlRow>(
        `SELECT * FROM corp_apps WHERE org_id = ? AND type = ? AND app_key = ?`,
        [orgId, type, appKey],
      )) ?? null
    )
  }

  /** Insert a corp app. Throws on (org_id, name) or (org_id, type, app_key) collision. */
  async createCorpApp(row: {
    id: string
    org_id: string
    type: string
    name: string
    app_key: string
    config_json: string
    credentials_secret_key?: string | null
    created_by: string
  }): Promise<void> {
    const ts = now()
    await this.driver.run(`
      INSERT INTO corp_apps (
        id, org_id, type, name, app_key, config_json, credentials_secret_key,
        enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `, [
      row.id,
      row.org_id,
      row.type,
      row.name,
      row.app_key,
      row.config_json,
      row.credentials_secret_key ?? null,
      row.created_by,
      ts,
      ts,
    ])
  }

  async updateCorpApp(id: string, orgId: string, updates: {
    name?: string
    app_key?: string
    config_json?: string
    credentials_secret_key?: string | null
    enabled?: number
  }): Promise<void> {
    const existing = await this.getCorpApp(id, orgId)
    if (!existing) return
    const ts = now()
    await this.driver.run(`
      UPDATE corp_apps
      SET name = ?, app_key = ?, config_json = ?, credentials_secret_key = ?,
          enabled = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `, [
      updates.name ?? (existing.name as string),
      updates.app_key ?? (existing.app_key as string),
      updates.config_json ?? (existing.config_json as string),
      updates.credentials_secret_key !== undefined
        ? updates.credentials_secret_key
        : (existing.credentials_secret_key as string | null),
      updates.enabled !== undefined ? updates.enabled : (existing.enabled as number),
      ts,
      id,
      orgId,
    ])
  }

  async deleteCorpApp(id: string, orgId: string): Promise<void> {
    await this.driver.run(`DELETE FROM corp_apps WHERE id = ? AND org_id = ?`, [id, orgId])
  }

  // ---- Inbound message buffer ----

  /** Append an inbound message, assigning the next per-app sequence number. */
  async appendCorpAppInbound(msg: {
    corp_app_id: string
    org_id: string
    from_user?: string | null
    msg_type?: string | null
    text?: string | null
    media_id?: string | null
    file_name?: string | null
    received_at?: number
    payload_json?: string | null
  }): Promise<number> {
    // seq is the per-corp-app monotonic poll cursor for consumers
    // (`seq > sinceSeq`). Single-statement atomic increment: with multiple
    // instances receiving callbacks behind an LB, the old two-step
    // SELECT MAX → INSERT let two concurrent inserts pick the same seq (the
    // consumer cursor then skips the later row — silent message loss). As
    // ONE statement SQLite (WAL, single writer) serialises the self-read
    // under the write lock. On PostgreSQL (P1) READ COMMITTED snapshots
    // still race: the (corp_app_id, seq) unique index rejects the duplicate
    // (SQLSTATE 23505) and the loop below re-runs the statement — the new
    // snapshot sees the winner's committed row and picks MAX+1, so the
    // cursor never skips a message. Deliberately NOT ON CONFLICT DO NOTHING:
    // a silently skipped row (rowCount 0) is exactly the message-loss bug.
    const id = randomUUID()
    const params = [
      id,
      msg.corp_app_id,
      msg.org_id,
      msg.corp_app_id,
      msg.from_user ?? null,
      msg.msg_type ?? null,
      msg.text ?? null,
      msg.media_id ?? null,
      msg.file_name ?? null,
      msg.received_at ?? now(),
      msg.payload_json ?? null,
    ]
    for (let attempt = 0; ; attempt++) {
      try {
        await this.driver.run(`
          INSERT INTO corp_app_inbound (
            id, corp_app_id, org_id, seq, from_user, msg_type, text,
            media_id, file_name, received_at, payload_json
          ) VALUES (
            ?, ?, ?,
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM corp_app_inbound WHERE corp_app_id = ?),
            ?, ?, ?, ?, ?, ?, ?
          )
        `, params)
        break
      } catch (err) {
        // SQLite never reaches here (single-writer serialisation); this is
        // the PostgreSQL concurrent-callback race resolved by retry.
        if (attempt < 8 && isUniqueViolation(err)) continue
        throw err
      }
    }
    const r = await this.driver.get<{ seq: number }>(
      `SELECT seq FROM corp_app_inbound WHERE id = ?`,
      [id],
    )
    return r?.seq ?? 0
  }

  /** List inbound messages with seq > sinceSeq, oldest first. */
  async listCorpAppInbound(corpAppId: string, sinceSeq: number, limit: number): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM corp_app_inbound WHERE corp_app_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      [corpAppId, sinceSeq, Math.max(1, Math.min(limit, 500))],
    )
  }

  // ==================== Document Center v2: Soft-delete helpers ====================

  /** Soft-delete a document by setting deleted_at. */
  async softDeleteDocument(id: string): Promise<void> {
    const ts = now()
    await this.driver.run(`UPDATE documents SET deleted_at = ? WHERE id = ?`, [ts, id])
  }

  /** Undelete (restore from soft-delete). */
  async undeleteDocument(id: string): Promise<void> {
    await this.driver.run(`UPDATE documents SET deleted_at = NULL WHERE id = ?`, [id])
  }

  async softDeleteTreeNode(id: string): Promise<void> {
    const ts = now()
    await this.driver.run(`UPDATE document_tree_nodes SET deleted_at = ? WHERE id = ?`, [ts, id])
  }

  async undeleteTreeNode(id: string): Promise<void> {
    await this.driver.run(`UPDATE document_tree_nodes SET deleted_at = NULL WHERE id = ?`, [id])
  }

  /** Hard-delete docs/nodes that have been soft-deleted for longer than `cutoffTs`. */
  async purgeOldSoftDeletes(cutoffTs: number): Promise<{ documents: number; nodes: number }> {
    const documents = await this.driver.run(
      `DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
      [cutoffTs],
    )
    const nodes = await this.driver.run(
      `DELETE FROM document_tree_nodes WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
      [cutoffTs],
    )
    return {
      documents: Number(documents ?? 0),
      nodes: Number(nodes ?? 0),
    }
  }

  // ==================== Document Center v2: Source-aware lookups ====================

  /** Find a tree node by (source_id, source_path). Used by the sync diff. */
  async findTreeNodeBySource(sourceId: string, sourcePath: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(
      `SELECT * FROM document_tree_nodes WHERE source_id = ? AND source_path = ? LIMIT 1`,
      [sourceId, sourcePath],
    )) ?? null
  }

  /** Find a document by (source_id, external_id). Used by the sync diff. */
  async findDocumentBySource(sourceId: string, externalId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(
      `SELECT * FROM documents WHERE source_id = ? AND external_id = ? LIMIT 1`,
      [sourceId, externalId],
    )) ?? null
  }

  /** Find a non-deleted document by content hash within an org (for dedup). */
  async findDocumentByHash(orgId: string, sha256: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(
      `SELECT * FROM documents WHERE org_id = ? AND content_sha256 = ? AND deleted_at IS NULL LIMIT 1`,
      [orgId, sha256],
    )) ?? null
  }

  /** All non-deleted documents/nodes for a source, for the reverse sweep. */
  async listDocumentsBySource(sourceId: string): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM documents WHERE source_id = ? AND deleted_at IS NULL`,
      [sourceId],
    )
  }

  async listTreeNodesBySource(sourceId: string): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      `SELECT * FROM document_tree_nodes WHERE source_id = ? AND deleted_at IS NULL`,
      [sourceId],
    )
  }

  /** The top-level (parent_id IS NULL) node that is the source's auto-created root. */
  async findSourceRootNode(sourceId: string): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>(
      `SELECT * FROM document_tree_nodes
       WHERE source_id = ? AND parent_id IS NULL AND deleted_at IS NULL LIMIT 1`,
      [sourceId],
    )) ?? null
  }

  /** Rename a tree node (used to keep the source root node named after the source). */
  async renameTreeNode(id: string, name: string): Promise<void> {
    await this.driver.run(
      `UPDATE document_tree_nodes SET name = ?, updated_at = ? WHERE id = ?`,
      [name, now(), id],
    )
  }

  /** Document Center v2: update an existing document row's content (sha/etag/path). */
  async updateDocumentContent(id: string, updates: {
    external_etag?: string | null
    content_sha256?: string | null
    storage_path?: string
    size_bytes?: number
  }): Promise<void> {
    const existing = await this.driver.get<SqlRow>(`SELECT * FROM documents WHERE id = ?`, [id])
    if (!existing) return
    await this.driver.run(`
      UPDATE documents
      SET external_etag = ?, content_sha256 = ?, storage_path = ?, size_bytes = ?
      WHERE id = ?
    `, [
      updates.external_etag !== undefined ? updates.external_etag : (existing.external_etag as string | null),
      updates.content_sha256 !== undefined ? updates.content_sha256 : (existing.content_sha256 as string | null),
      updates.storage_path ?? (existing.storage_path as string),
      updates.size_bytes ?? (existing.size_bytes as number),
      id,
    ])
  }

  /** Update tree node position/name (used by sync diff on rename/move). */
  async updateTreeNodeSourceLocation(id: string, updates: {
    parent_id?: string | null
    name?: string
    source_path?: string
    last_synced_at?: number
  }): Promise<void> {
    const existing = await this.driver.get<SqlRow>(`SELECT * FROM document_tree_nodes WHERE id = ?`, [id])
    if (!existing) return
    const ts = now()
    await this.driver.run(`
      UPDATE document_tree_nodes
      SET parent_id = ?, name = ?, source_path = ?, last_synced_at = ?, updated_at = ?
      WHERE id = ?
    `, [
      updates.parent_id !== undefined ? updates.parent_id : (existing.parent_id as string | null),
      updates.name ?? (existing.name as string),
      updates.source_path ?? (existing.source_path as string | null),
      updates.last_synced_at ?? ts,
      ts,
      id,
    ])
  }

  /** Document Center v2: list wikis whose source_document_ids contains this doc id. */
  async findWikisReferencingDocument(docId: string): Promise<SqlRow[]> {
    // SQLite has no native JSON contains; use LIKE on the canonical JSON form.
    // source_document_ids is stored as JSON array of strings, e.g. ["abc","def"]
    return this.driver.all<SqlRow>(
      `SELECT * FROM wikis WHERE source_document_ids LIKE ?`,
      [`%"${docId}"%`],
    )
  }

  /**
   * Document Center v2 — recursively list all non-deleted documents under a
   * tree node (the node's whole subtree). Used to materialize a dir-mode
   * wiki's inputs at build time. Collects descendant node IDs by walking
   * parent_id from the org's node list, then selects documents in that set.
   */
  /** Build a parent→children adjacency map for the org's tree once. */
  private async childrenByParentMap(orgId: string): Promise<Map<string | null, string[]>> {
    const nodes = await this.listDocumentTreeNodes(orgId)
    const m = new Map<string | null, string[]>()
    for (const n of nodes) {
      const parent = (n.parent_id as string | null) ?? null
      const arr = m.get(parent) ?? []
      arr.push(String(n.id))
      m.set(parent, arr)
    }
    return m
  }

  /** All node ids in the subtree rooted at `rootId` (inclusive). */
  private subtreeNodeIds(rootId: string, childrenByParent: Map<string | null, string[]>): Set<string> {
    const out = new Set<string>()
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (out.has(id)) continue
      out.add(id)
      for (const child of childrenByParent.get(id) ?? []) stack.push(child)
    }
    return out
  }

  async listDocumentsUnderNode(rootNodeId: string, orgId: string): Promise<SqlRow[]> {
    return this.listDocumentsUnderNodes([rootNodeId], [], orgId)
  }

  /**
   * Document Center v2 — non-deleted documents under any of `includeIds`'
   * subtrees, minus documents under any of `excludeIds`' subtrees. Used to
   * materialize a dir-mode wiki's inputs (multi-dir with persistent exclusions)
   * at build time.
   */
  async listDocumentsUnderNodes(includeIds: string[], excludeIds: string[], orgId: string): Promise<SqlRow[]> {
    if (includeIds.length === 0) return []
    const childrenByParent = await this.childrenByParentMap(orgId)
    const included = new Set<string>()
    for (const id of includeIds) for (const n of this.subtreeNodeIds(id, childrenByParent)) included.add(n)
    for (const id of excludeIds) for (const n of this.subtreeNodeIds(id, childrenByParent)) included.delete(n)
    const ids = [...included]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.driver.all<SqlRow>(
      `SELECT * FROM documents
       WHERE org_id = ? AND deleted_at IS NULL AND node_id IN (${placeholders})
       ORDER BY node_id, file_name`,
      [orgId, ...ids],
    )
  }

  /**
   * Document Center v2 — find dir-mode wikis whose *effective tracked set*
   * includes the given changed node. A wiki matches if one of its included dir
   * nodes (source_node_ids) is the changed node or an ancestor of it, AND none
   * of its excluded nodes is the changed node or an ancestor (i.e. the change
   * isn't inside an excluded subtree). `nodeIdChain` = changed node + ancestors.
   */
  async findDirWikisForNode(nodeIdChain: string[]): Promise<SqlRow[]> {
    if (nodeIdChain.length === 0) return []
    const chain = new Set(nodeIdChain)
    const dirWikis = await this.driver.all<SqlRow>(`SELECT * FROM wikis WHERE source_mode = 'dir'`)
    const parseIds = (v: unknown): string[] => {
      if (typeof v !== 'string' || !v.trim()) return []
      try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [] } catch { return [] }
    }
    return dirWikis.filter((w) => {
      // Back-compat: fold legacy single source_node_id into the include set.
      const includes = parseIds(w.source_node_ids)
      const legacy = typeof w.source_node_id === 'string' ? [w.source_node_id] : []
      const include = [...includes, ...legacy]
      const exclude = parseIds(w.source_exclude_node_ids)
      const includedHit = include.some(id => chain.has(id))
      if (!includedHit) return false
      const excludedHit = exclude.some(id => chain.has(id))
      return !excludedHit
    })
  }

  async markWikiNeedsRebuild(wikiId: string, needs: boolean): Promise<void> {
    await this.driver.run(`UPDATE wikis SET needs_rebuild = ? WHERE id = ?`, [needs ? 1 : 0, wikiId])
  }

  /** Set node alias (Q2: source-managed nodes can't be renamed, but admins can set a display alias). */
  async setTreeNodeAlias(id: string, orgId: string, alias: string | null): Promise<void> {
    await this.driver.run(
      `UPDATE document_tree_nodes SET alias = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
      [alias, now(), id, orgId],
    )
  }

  // ==================== Secrets Management ====================

  // --- Config Items ---

  async listConfigItems(opts: {
    name?: string
    scope?: string
    status?: string
    page?: number
    pageSize?: number
    /** When set, restrict non-user-scope items to this org; user-scope
     *  definitions are global and always included. */
    orgId?: string
  }): Promise<{ items: SqlRow[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.orgId) {
      conditions.push(`(scope = 'user' OR org_id = ?)`)
      params.push(opts.orgId)
    }
    if (opts.name) {
      conditions.push('(name LIKE ? OR pinyin LIKE ?)')
      params.push(`%${opts.name}%`, `%${opts.name}%`)
    }
    if (opts.scope) {
      conditions.push('scope = ?')
      params.push(opts.scope)
    }
    if (opts.status !== undefined && opts.status !== '') {
      conditions.push('status = ?')
      params.push(Number(opts.status))
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const countRow = await this.driver.get<{ c: number }>(`SELECT COUNT(*) AS c FROM config_items ${where}`, params as SqlParam[])
    const total = countRow?.c ?? 0
    // Normalize page/pageSize: entry points pass raw strings (?page=abc / ?page=-5),
    // which would crash SQLite (datatype mismatch) or PG (OFFSET -N → 500).
    const page = Number.isFinite(Number(opts.page)) ? Math.max(1, Number(opts.page)) : 1
    const pageSize = Number.isFinite(Number(opts.pageSize)) ? Math.min(100, Math.max(1, Number(opts.pageSize))) : 20
    const offset = (page - 1) * pageSize
    const items = await this.driver.all<SqlRow>(
      `SELECT * FROM config_items ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset] as SqlParam[],
    )
    return { items, total }
  }

  async getConfigItem(id: number, orgId?: string): Promise<SqlRow | null> {
    const row = (await this.driver.get<SqlRow>('SELECT * FROM config_items WHERE id = ?', [id])) ?? null
    // Org guard: a non-user-scope item only resolves within its own org.
    if (row && orgId && row.scope !== 'user' && row.org_id !== orgId) {
      return null
    }
    return row
  }

  async getConfigItemByPinyin(pinyin: string, orgId?: string): Promise<SqlRow | null> {
    // User-scope definitions are global and globally unique by pinyin. Non-user
    // pinyins are unique per org, so resolve within the caller's org.
    if (orgId) {
      const scoped = await this.driver.get<SqlRow>(
        `SELECT * FROM config_items WHERE pinyin = ? AND scope != 'user' AND org_id = ?`,
        [pinyin, orgId],
      )
      if (scoped) return scoped
      return (
        (await this.driver.get<SqlRow>(
          `SELECT * FROM config_items WHERE pinyin = ? AND scope = 'user'`,
          [pinyin],
        )) ?? null
      )
    }
    return (await this.driver.get<SqlRow>('SELECT * FROM config_items WHERE pinyin = ?', [pinyin])) ?? null
  }

  async getConfigItemsByScope(scope: string, status?: number, orgId?: string): Promise<SqlRow[]> {
    const conds = ['scope = ?']
    const params: unknown[] = [scope]
    if (status !== undefined) {
      conds.push('status = ?')
      params.push(status)
    }
    // Org filter applies only to non-user scope; user-scope is global.
    if (orgId && scope !== 'user') {
      conds.push('org_id = ?')
      params.push(orgId)
    }
    return this.driver.all<SqlRow>(
      `SELECT * FROM config_items WHERE ${conds.join(' AND ')}`,
      params as SqlParam[],
    )
  }

  async getAllActiveConfigItems(orgId?: string): Promise<SqlRow[]> {
    if (orgId) {
      return this.driver.all<SqlRow>(
        `SELECT * FROM config_items WHERE status = 1 AND (scope = 'user' OR org_id = ?)`,
        [orgId],
      )
    }
    return this.driver.all<SqlRow>('SELECT * FROM config_items WHERE status = 1')
  }

  /**
   * Cross-instance auth-proxy rules refresh (HA): fingerprint over
   * config_items + config_entries. Per the call-chain audit every current
   * mutation path bumps config_items (create/delete → COUNT change,
   * update/updateStatus → updated_at, both precede replaceConfigEntries);
   * config_entries is included defensively in case a future path bypasses
   * the config_items timestamp. Secret VALUES live in Nexus (fetched per
   * request by the proxy) and need no fingerprint.
   */
  async getConfigRulesFingerprint(): Promise<string> {
    // CAST(...) AS TEXT keeps the || concatenation valid on both dialects:
    // SQLite's || coerces anything to text, PostgreSQL refuses integer || text.
    const row = await this.driver.get<SqlRow>(`
      SELECT
        (SELECT CAST(COUNT(*) AS TEXT) || ':' || CAST(COALESCE(MAX(updated_at), 0) AS TEXT) FROM config_items) || '|' ||
        (SELECT CAST(COUNT(*) AS TEXT) || ':' || CAST(COALESCE(MAX(updated_at), 0) AS TEXT) FROM config_entries) AS fp
    `)
    return String(row?.fp ?? '')
  }

  /**
   * Ensure default config items exist (e.g., ShareOne for user-level key storage)
   */
  async ensureDefaultConfigItems(): Promise<void> {
    const ts = now()

    // ShareOne config item for user-level API key storage
    const shareoneExists = await this.getConfigItemByPinyin('shareone')
    if (!shareoneExists) {
      const rows = await this.driver.all<{ id: number }>(`
        INSERT INTO config_items (name, description, icon, pinyin, scope, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        'ShareOne',
        'ShareOne 分享服务 API Key，用于发布分享内容',
        null,
        'shareone',
        'user',
        1,
        ts,
        ts,
      ])
      const configItemId = Number(rows[0]?.id ?? 0)

      // Add the shareone_key entry
      await this.driver.run(`
        INSERT INTO config_entries (config_item_id, config_key, name, config_desc, required, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [configItemId, 'shareone_key', 'ShareOne Key', 'ShareOne API Key 用于认证分享发布', 1, ts, ts])

      console.log('[DB] Created default ShareOne config item')
    }
  }

  async createConfigItem(row: {
    name: string
    description?: string
    icon?: string
    pinyin: string
    scope: string
    url_pattern?: string
    scheme?: string
    bearer_prefix?: string
    status?: number
    /** Owning org for non-user-scope items. User-scope definitions are global
     *  (pass null/undefined). */
    org_id?: string | null
    auth_type?: string
    auth_url?: string
    token_url?: string
    client_id?: string
    client_secret_key?: string
    refresh_token_key?: string
    default_scopes?: string
    token_request_json?: string
    mint_script?: string
    body_auth_check?: string
  }): Promise<number> {
    const ts = now()
    // User-scope definitions stay global regardless of any org passed in.
    const orgId = row.scope === 'user' ? null : (row.org_id ?? null)
    const rows = await this.driver.all<{ id: number }>(`
      INSERT INTO config_items (
        name, description, icon, pinyin, scope, url_pattern, scheme, bearer_prefix, status, org_id,
        auth_type, auth_url, token_url, client_id, client_secret_key, refresh_token_key, default_scopes,
        token_request_json, mint_script, body_auth_check,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      row.name,
      row.description ?? null,
      row.icon ?? null,
      row.pinyin,
      row.scope,
      row.url_pattern ?? null,
      row.scheme ?? null,
      row.bearer_prefix ?? null,
      row.status ?? 1,
      orgId,
      row.auth_type ?? null,
      row.auth_url ?? null,
      row.token_url ?? null,
      row.client_id ?? null,
      row.client_secret_key ?? null,
      row.refresh_token_key ?? null,
      row.default_scopes ?? null,
      row.token_request_json ?? null,
      row.mint_script ?? null,
      row.body_auth_check ?? null,
      ts, ts,
    ])
    return Number(rows[0]?.id ?? 0)
  }

  async updateConfigItem(id: number, updates: {
    name?: string
    description?: string
    icon?: string
    pinyin?: string
    scope?: string
    url_pattern?: string
    scheme?: string
    bearer_prefix?: string
    status?: number
    auth_type?: string
    auth_url?: string
    token_url?: string
    client_id?: string
    client_secret_key?: string | null
    refresh_token_key?: string | null
    default_scopes?: string
    token_request_json?: string | null
    mint_script?: string | null
    body_auth_check?: string | null
  }, orgId?: string): Promise<void> {
    // Org guard: a non-user-scope item can only be updated within its own org.
    const existing = await this.getConfigItem(id, orgId)
    if (!existing) return
    const ts = now()
    await this.driver.run(`
      UPDATE config_items
      SET name = ?, description = ?, icon = ?, pinyin = ?, scope = ?,
          url_pattern = ?, scheme = ?, bearer_prefix = ?, status = ?,
          auth_type = ?, auth_url = ?, token_url = ?, client_id = ?,
          client_secret_key = ?, refresh_token_key = ?, default_scopes = ?,
          token_request_json = ?, mint_script = ?, body_auth_check = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      updates.name ?? (existing.name as string),
      updates.description !== undefined ? updates.description : (existing.description as string | null),
      updates.icon !== undefined ? updates.icon : (existing.icon as string | null),
      updates.pinyin ?? (existing.pinyin as string),
      updates.scope ?? (existing.scope as string),
      updates.url_pattern !== undefined ? updates.url_pattern : (existing.url_pattern as string | null),
      updates.scheme !== undefined ? updates.scheme : (existing.scheme as string | null),
      updates.bearer_prefix !== undefined ? updates.bearer_prefix : (existing.bearer_prefix as string | null),
      updates.status !== undefined ? updates.status : (existing.status as number),
      updates.auth_type !== undefined ? updates.auth_type : (existing.auth_type as string | null),
      updates.auth_url !== undefined ? updates.auth_url : (existing.auth_url as string | null),
      updates.token_url !== undefined ? updates.token_url : (existing.token_url as string | null),
      updates.client_id !== undefined ? updates.client_id : (existing.client_id as string | null),
      updates.client_secret_key !== undefined ? updates.client_secret_key : (existing.client_secret_key as string | null),
      updates.refresh_token_key !== undefined ? updates.refresh_token_key : (existing.refresh_token_key as string | null),
      updates.default_scopes !== undefined ? updates.default_scopes : (existing.default_scopes as string | null),
      updates.token_request_json !== undefined ? updates.token_request_json : (existing.token_request_json as string | null),
      updates.mint_script !== undefined ? updates.mint_script : (existing.mint_script as string | null),
      updates.body_auth_check !== undefined ? updates.body_auth_check : (existing.body_auth_check as string | null),
      ts, id,
    ])
  }

  async deleteConfigItem(id: number, orgId?: string): Promise<void> {
    // Org guard: don't let one org delete another org's config item.
    if (orgId) {
      const existing = await this.getConfigItem(id, orgId)
      if (!existing) return
    }
    await this.driver.run('DELETE FROM config_items WHERE id = ?', [id])
  }

  // --- Config Entries ---

  async getConfigEntries(configItemId: number): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>('SELECT * FROM config_entries WHERE config_item_id = ?', [configItemId])
  }

  async replaceConfigEntries(configItemId: number, entries: {
    config_key: string
    name: string
    config_desc?: string
    required?: boolean
  }[]): Promise<void> {
    const ts = now()
    await this.driver.run('DELETE FROM config_entries WHERE config_item_id = ?', [configItemId])
    for (const e of entries) {
      await this.driver.run(`
        INSERT INTO config_entries (config_item_id, config_key, name, config_desc, required, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [configItemId, e.config_key, e.name, e.config_desc ?? null, e.required ? 1 : 0, ts, ts])
    }
  }

  // --- Secret Metadata ---

  async getSecretMetadata(configItemId: number): Promise<SqlRow | null> {
    return (await this.driver.get<SqlRow>('SELECT * FROM secret_metadata WHERE config_item_id = ?', [configItemId])) ?? null
  }

  async getAllSecretMetadata(orgId?: string): Promise<SqlRow[]> {
    if (orgId) {
      return this.driver.all<SqlRow>(
        'SELECT * FROM secret_metadata WHERE org_id = ? OR org_id IS NULL',
        [orgId],
      )
    }
    return this.driver.all<SqlRow>('SELECT * FROM secret_metadata')
  }

  async upsertSecretMetadata(configItemId: number, expiresAt: number | null, orgId?: string | null): Promise<void> {
    const ts = now()
    // Denormalize the owning org from the config item when not supplied.
    const resolvedOrg =
      orgId !== undefined ? orgId : (((await this.getConfigItem(configItemId))?.org_id as string | null) ?? null)
    const existing = await this.getSecretMetadata(configItemId)
    if (existing) {
      await this.driver.run('UPDATE secret_metadata SET expires_at = ?, org_id = ?, updated_at = ? WHERE config_item_id = ?',
        [expiresAt, resolvedOrg, ts, configItemId])
    } else {
      await this.driver.run(`
        INSERT INTO secret_metadata (id, config_item_id, org_id, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [randomUUID(), configItemId, resolvedOrg, expiresAt, ts, ts])
    }
  }

  async getExpiringSecretMetadata(beforeTs: number, orgId?: string): Promise<SqlRow[]> {
    if (orgId) {
      return this.driver.all<SqlRow>(
        'SELECT * FROM secret_metadata WHERE expires_at IS NOT NULL AND expires_at < ? AND (org_id = ? OR org_id IS NULL)',
        [beforeTs, orgId],
      )
    }
    return this.driver.all<SqlRow>(
      'SELECT * FROM secret_metadata WHERE expires_at IS NOT NULL AND expires_at < ?',
      [beforeTs],
    )
  }

  // --- Department Secret Policies ---

  async getDepartmentPolicies(departmentId: string, orgId?: string): Promise<SqlRow[]> {
    // department_id is globally unique, but filter by org for defense-in-depth.
    if (orgId) {
      return this.driver.all<SqlRow>(
        'SELECT * FROM department_secret_policies WHERE department_id = ? AND org_id = ?',
        [departmentId, orgId],
      )
    }
    return this.driver.all<SqlRow>(
      'SELECT * FROM department_secret_policies WHERE department_id = ?',
      [departmentId],
    )
  }

  async replaceDepartmentPolicies(departmentId: string, configItemIds: number[], orgId?: string | null): Promise<void> {
    const ts = now()
    await this.driver.run('DELETE FROM department_secret_policies WHERE department_id = ?', [departmentId])
    for (const cid of configItemIds) {
      await this.driver.run(`
        INSERT INTO department_secret_policies (department_id, config_item_id, org_id, created_at)
        VALUES (?, ?, ?, ?)
      `, [departmentId, cid, orgId ?? null, ts])
    }
  }

  async getConfigItemAuthorizedDepartments(configItemId: number): Promise<SqlRow[]> {
    return this.driver.all<SqlRow>(
      'SELECT * FROM department_secret_policies WHERE config_item_id = ?',
      [configItemId],
    )
  }

  async deleteDepartmentPoliciesByConfigItem(configItemId: number): Promise<void> {
    await this.driver.run('DELETE FROM department_secret_policies WHERE config_item_id = ?', [configItemId])
  }

  async replaceConfigItemDepartments(configItemId: number, departmentIds: string[], orgId?: string | null): Promise<void> {
    const ts = now()
    await this.driver.run('DELETE FROM department_secret_policies WHERE config_item_id = ?', [configItemId])
    // org_id must be persisted: the org-scoped readers (getDepartmentPolicies
    // with an orgId, used by config-item visibility and credential-usage gates)
    // filter WHERE org_id = ?, so a NULL here makes the policy invisible.
    for (const deptId of departmentIds) {
      await this.driver.run(`
        INSERT INTO department_secret_policies (department_id, config_item_id, org_id, created_at)
        VALUES (?, ?, ?, ?)
      `, [deptId, configItemId, orgId ?? null, ts])
    }
  }

  // --- Secret Audit Log ---

  async insertAuditLog(row: {
    id: string
    actor_id: string
    actor_name?: string
    action: string
    config_item_id?: number
    org_id?: string | null
    namespace: string
    key: string
    detail?: string
    ip_address?: string
  }): Promise<void> {
    await this.driver.run(`
      INSERT INTO secret_audit_log (id, actor_id, actor_name, action, config_item_id, org_id, namespace, key, detail, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.actor_id, row.actor_name ?? null, row.action,
      row.config_item_id ?? null, row.org_id ?? null, row.namespace, row.key,
      row.detail ?? null, row.ip_address ?? null, now(),
    ])
  }

  async queryAuditLog(opts: {
    actor_id?: string
    /** Restrict to this set of actor ids (credential audit subtree/self gate).
     *  An empty array matches nothing (fail-closed). Applied in addition to
     *  actor_id if both are given. */
    actorIds?: string[]
    config_item_id?: number
    /** Restrict to audit rows whose config item has one of these scopes
     *  (credential audit scope gate: dept_admin => department+user, user => user).
     *  Rows with a null/unresolvable config_item_id are excluded (fail-closed).
     *  Undefined means no scope restriction (full admin). */
    scopes?: string[]
    action?: string
    since?: number
    until?: number
    page?: number
    pageSize?: number
    orgId?: string
  }): Promise<{ items: SqlRow[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    // Org filter: a NULL org_id row is legacy/global and remains visible so
    // pre-migration audit history isn't hidden; everything else is org-bound.
    if (opts.orgId) {
      conditions.push('(org_id = ? OR org_id IS NULL)')
      params.push(opts.orgId)
    }
    if (opts.actor_id) {
      conditions.push('actor_id = ?')
      params.push(opts.actor_id)
    }
    if (opts.actorIds) {
      // Restrict to the caller's visible actor set (dept subtree / self). An
      // empty set must match zero rows rather than degrade to "no filter".
      if (opts.actorIds.length === 0) {
        conditions.push('1 = 0')
      } else {
        conditions.push(`actor_id IN (${opts.actorIds.map(() => '?').join(', ')})`)
        params.push(...opts.actorIds)
      }
    }
    if (opts.config_item_id) {
      conditions.push('config_item_id = ?')
      params.push(opts.config_item_id)
    }
    if (opts.scopes) {
      // Restrict to rows whose config item is in the caller's visible scope set.
      // Empty set matches nothing; null config_item_id rows are excluded so a
      // non-admin never sees audit entries for credentials outside their scope.
      if (opts.scopes.length === 0) {
        conditions.push('1 = 0')
      } else {
        conditions.push(
          `config_item_id IN (SELECT id FROM config_items WHERE scope IN (${opts.scopes.map(() => '?').join(', ')}))`,
        )
        params.push(...opts.scopes)
      }
    }
    if (opts.action) {
      conditions.push('action = ?')
      params.push(opts.action)
    }
    if (opts.since) {
      conditions.push('created_at >= ?')
      params.push(opts.since)
    }
    if (opts.until) {
      conditions.push('created_at <= ?')
      params.push(opts.until)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const countRow = await this.driver.get<{ c: number }>(`SELECT COUNT(*) AS c FROM secret_audit_log ${where}`, params as SqlParam[])
    const total = countRow?.c ?? 0
    const page = Number.isFinite(Number(opts.page)) ? Math.max(1, Number(opts.page)) : 1
    const pageSize = Number.isFinite(Number(opts.pageSize)) ? Math.min(100, Math.max(1, Number(opts.pageSize))) : 20
    const offset = (page - 1) * pageSize
    const items = await this.driver.all<SqlRow>(
      `SELECT * FROM secret_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset] as SqlParam[],
    )
    return { items, total }
  }
}

export function openDirectConnectStore(config: ServerConfig): DirectConnectStore {
  return new DirectConnectStore(config.dbPath)
}

/**
 * PostgreSQL construction form of DirectConnectStore. The schema must already
 * exist (applyPgSchema in openStoreAsync); the sqlite constructor path
 * (file open, PRAGMAs, ad-hoc DDL, column migrations) never runs.
 */
export function forPostgresDirectConnectStore(driver: DbDriver): DirectConnectStore {
  return new DirectConnectStore(':postgresql:', driver)
}

/**
 * Async store factory (HA). SQLite resolves synchronously under the hood
 * (zero behaviour change vs openDirectConnectStore); postgres builds a
 * node-postgres Pool wrapped in PgDriver, applies the versioned pg_schema
 * DDL, and returns a driver-backed store. This is the single async entry the
 * server and runner funnel through so switching the backend is a one-line
 * config change (MOSS_DATABASE_URL).
 */
export async function openStoreAsync(config: ServerConfig): Promise<DirectConnectStore> {
  if (config.dbBackend === 'postgres') {
    // The connection string normally arrives via ServerConfig (env
    // MOSS_DATABASE_URL > settings file). Runner children get a manifest
    // whose config has the secret stripped, so fall back to the inherited
    // env here rather than ever persisting the URL (it contains credentials).
    const databaseUrl = config.databaseUrl || process.env.MOSS_DATABASE_URL?.trim()
    if (!databaseUrl) {
      throw new Error(
        'postgres backend requires a connection string: set MOSS_DATABASE_URL (or storage.databaseUrl)',
      )
    }
    const { Pool, types } = await import('pg')
    // int8 (BIGINT columns, COUNT(*)) arrives as string by default in
    // node-postgres; moss's integer domain is well below 2^53, so parse every
    // int8 as a JS number globally (P1 type-normalisation rule).
    types.setTypeParser(20, Number)
    const pool = new Pool({ connectionString: databaseUrl })
    // pg.Pool satisfies PgPoolLike structurally at runtime (query/connect/
    // on/end); @types/pg's overloaded query signatures just don't line up with
    // the seam's single-signature view, hence the cast.
    const driver = new PgDriver(
      pool as unknown as PgPoolLike,
      err => process.stderr.write(`[PgDriver] idle client error: ${err.message}\n`),
    )
    await applyPgSchema(driver)
    // Seed the default enterprise row (the sqlite constructor does this
    // inline); same statement text on both dialects.
    const ts = Date.now()
    await driver.run(
      `INSERT INTO enterprises (id, created_at, updated_at)
       VALUES ('default', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [ts, ts],
    )
    return forPostgresDirectConnectStore(driver)
  }
  return openDirectConnectStore(config)
}

export function toSessionSummary(session: SessionRecord): SessionSummary {
  return {
    sessionId: session.sessionId,
    transcriptSessionId: session.transcriptSessionId,
    workDir: session.cwd,
    userId: session.userId,
    orgId: session.orgId,
    role: session.role,
    scopes: session.scopes,
    runtime: session.runtime,
    status: session.status,
    desiredState: session.desiredState,
    assistantName: session.assistantName,
    source: session.source,
    channelChatId: session.channelChatId,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    endedAt: session.endedAt,
  }
}

export function mergeRuntime(
  config: ServerConfig,
  runtime?: SessionCreateInput['runtime'],
): SessionRuntimeInfo {
  const type = runtime?.type || config.defaultRuntime
  const dockerMode =
    type === 'docker' ? runtime?.dockerMode || config.dockerMode : undefined
  const hostMode = type === 'host' ? runtime?.hostMode : undefined
  const k8sMode = type === 'k8s' ? runtime?.k8sMode : undefined
  return {
    type,
    engine: runtime?.engine || config.engine || 'scode',
    dockerImage: runtime?.dockerImage || config.dockerImage,
    dockerMode,
    configDir: runtime?.configDir,
    scodePath: resolveRuntimeScodePath(config, type, runtime?.scodePath),
    hostMode,
    ...(type === 'k8s'
      ? {
          k8sImage: runtime?.k8sImage || config.k8s?.image,
          k8sNamespace: runtime?.k8sNamespace || config.k8s?.namespace,
          k8sRuntimeClassName: runtime?.k8sRuntimeClassName || config.k8s?.runtimeClassName,
          k8sKubeconfig: runtime?.k8sKubeconfig || config.k8s?.kubeconfig,
          k8sMode,
        }
      : {}),
  }
}
