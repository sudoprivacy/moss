import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'
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

function mapRuntime(row: SqlRow): SessionRuntimeInfo {
  const type = String(row.runtime_type) === 'docker' ? 'docker' : 'host'
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

  constructor(public readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
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
        display_name TEXT,
        authorized_at INTEGER NOT NULL,
        last_active INTEGER,
        session_id TEXT,
        org_id TEXT,
        user_id TEXT,
        UNIQUE(platform_user_id, platform_type, user_id)
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
      INSERT OR IGNORE INTO enterprises (id, created_at, updated_at)
      VALUES ('default', ?, ?)
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

    // Migration: add org_id to channel_plugins
    const channelPluginsColumns = this.db.prepare(`PRAGMA table_info(channel_plugins)`).all() as { name: string }[]
    if (!channelPluginsColumns.some(col => col.name === 'org_id')) {
      this.db.exec(`ALTER TABLE channel_plugins ADD COLUMN org_id TEXT`)
      console.log('[DB] Added org_id column to channel_plugins')
    }

    // Migration: add client_cron_enabled to enterprises (null = enabled by default)
    const enterprisesColumns = this.db.prepare(`PRAGMA table_info(enterprises)`).all() as { name: string }[]
    if (!enterprisesColumns.some(col => col.name === 'client_cron_enabled')) {
      this.db.exec(`ALTER TABLE enterprises ADD COLUMN client_cron_enabled INTEGER`)
      console.log('[DB] Added client_cron_enabled column to enterprises')
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

    // Create index for channel session lookup if it doesn't exist
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_source_chat ON sessions (source, channel_chat_id, last_active_at DESC)`)
    } catch {
      // Index creation failed, ignore
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
        mint_script        TEXT
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
    // Assistant ↔ Wiki association lives in assistant `_moss_meta.json` (enabledWikis: string[]),
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

      CREATE INDEX IF NOT EXISTS corp_app_inbound_seq_idx
        ON corp_app_inbound (corp_app_id, seq);
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
        mint_script        TEXT
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
    `)

    // Migration: add lease_until to cron_jobs
    const cronJobsColumns = this.db.prepare(`PRAGMA table_info(cron_jobs)`).all() as { name: string }[]
    if (!cronJobsColumns.some(col => col.name === 'lease_until')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN lease_until INTEGER;`)
      console.log('[DB] Added lease_until column to cron_jobs')
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
            token_request_json TEXT, mint_script TEXT
          );
        `)
        // Copy the intersection of old columns and the new table's columns.
        const newCols = new Set([
          'id', 'name', 'description', 'icon', 'pinyin', 'scope', 'url_pattern',
          'scheme', 'bearer_prefix', 'status', 'org_id', 'created_at', 'updated_at',
          'auth_type', 'auth_url', 'token_url', 'client_id', 'client_secret_key',
          'refresh_token_key', 'default_scopes', 'token_request_json', 'mint_script',
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
  backfillOrgScoping(defaultOrgId: string): void {
    if (!defaultOrgId) return
    try {
      this.db.prepare(
        `UPDATE config_items SET org_id = ? WHERE org_id IS NULL AND scope != 'user'`,
      ).run(defaultOrgId)
      // secret_metadata inherits its config item's org.
      this.db.exec(`
        UPDATE secret_metadata
        SET org_id = (SELECT ci.org_id FROM config_items ci WHERE ci.id = secret_metadata.config_item_id)
        WHERE org_id IS NULL
      `)
      this.db.prepare(
        `UPDATE department_secret_policies SET org_id = ? WHERE org_id IS NULL`,
      ).run(defaultOrgId)
      this.db.prepare(
        `UPDATE secret_audit_log SET org_id = ? WHERE org_id IS NULL`,
      ).run(defaultOrgId)
      // Tenant skills/assistants: stranded global rows go to the default org.
      this.db.prepare(`UPDATE tenant_skills SET org_id = ? WHERE org_id IS NULL`).run(defaultOrgId)
      this.db.prepare(`UPDATE tenant_assistants SET org_id = ? WHERE org_id IS NULL`).run(defaultOrgId)
      // Channels: backfill from the owning user's org where resolvable, else default.
      this.db.exec(`
        UPDATE channel_plugins
        SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = channel_plugins.user_id), '${defaultOrgId}')
        WHERE org_id IS NULL OR org_id = ''
      `)
      this.db.exec(`
        UPDATE channel_users
        SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = channel_users.user_id), '${defaultOrgId}')
        WHERE org_id IS NULL OR org_id = ''
      `)
    } catch (error) {
      console.error('[DB] backfillOrgScoping failed:', error)
    }
  }

  close(): void {
    (this as any)._closed = true
    this.db.close()
  }

  isOpen(): boolean {
    return !(this as any)._closed
  }

  registerServerInstance(host: string, pid = process.pid): ServerInstanceRecord {
    const instanceId = randomUUID()
    const ts = now()
    this.db.prepare(`
      INSERT INTO server_instances (
        instance_id, host, pid, started_at, heartbeat_at, status
      ) VALUES (?, ?, ?, ?, ?, 'running')
    `).run(instanceId, host, pid, ts, ts)
    return {
      instanceId,
      host,
      pid,
      startedAt: ts,
      heartbeatAt: ts,
      stoppedAt: null,
      status: 'running',
    }
  }

  heartbeatServerInstance(instanceId: string): void {
    this.db.prepare(`
      UPDATE server_instances
      SET heartbeat_at = ?, status = 'running'
      WHERE instance_id = ?
    `).run(now(), instanceId)
  }

  stopServerInstance(instanceId: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE server_instances
      SET heartbeat_at = ?, stopped_at = ?, status = 'stopped'
      WHERE instance_id = ?
    `).run(ts, ts, instanceId)
  }

  createSession(input: {
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
  }): SessionRecord {
    const ts = now()
    this.db.prepare(`
      INSERT INTO sessions (
        session_id, transcript_session_id, org_id, user_id, role, scopes_json,
        cwd, runtime_type, docker_image, docker_mode, config_dir, container_name,
        status, desired_state, current_attempt_id, transcript_path, title, summary, assistant_name,
        source, channel_chat_id,
        created_at, last_active_at, ended_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
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
    )
    this.addEvent(input.sessionId, null, 'session_created', {
      runtime: input.runtime,
      cwd: input.cwd,
      assistantName: input.assistantName,
    })
    return this.getSession(input.sessionId)!
  }

  createAttempt(input: {
    sessionId: string
    generation: number
    backendType: 'host' | 'docker'
    resumeTranscriptSessionId: string
    serverInstanceId: string
    containerName?: string
    attachPath?: string
  }): AttemptRecord {
    const attemptId = randomUUID()
    const ts = now()
    this.db.prepare(`
      INSERT INTO session_attempts (
        attempt_id, session_id, generation, backend_type, runtime_state,
        server_instance_id, runner_pid, container_name, attach_path,
        resume_transcript_session_id, started_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, 'starting', ?, NULL, ?, ?, ?, ?, ?)
    `).run(
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
    )
    this.addEvent(input.sessionId, attemptId, 'attempt_created', {
      generation: input.generation,
      backendType: input.backendType,
      attachPath: input.attachPath,
      containerName: input.containerName,
    })
    return this.getAttempt(attemptId)!
  }

  setCurrentAttempt(sessionId: string, attemptId: string | null): void {
    this.db.prepare(`
      UPDATE sessions
      SET current_attempt_id = ?
      WHERE session_id = ?
    `).run(attemptId, sessionId)
  }

  setSessionLifecycle(
    sessionId: string,
    status: SessionStatus,
    desiredState: DesiredSessionState,
  ): void {
    const ts = now()
    this.db.prepare(`
      UPDATE sessions
      SET status = ?, desired_state = ?, last_active_at = ?
      WHERE session_id = ?
    `).run(status, desiredState, ts, sessionId)
  }

  /**
   * Reactivate a session that was previously idle-killed (status=ended,
   * desired=active, ended_at set). Clears ended_at and resets status/desired
   * to 'active' so the row reads as a live session again after respawn.
   */
  reactivateSession(sessionId: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE sessions
      SET status = 'active', desired_state = 'active', ended_at = NULL,
          last_active_at = ?
      WHERE session_id = ?
    `).run(ts, sessionId)
  }

  markSessionEnded(
    sessionId: string,
    status: SessionStatus,
    desiredState: DesiredSessionState,
  ): void {
    const ts = now()
    this.db.prepare(`
      UPDATE sessions
      SET status = ?, desired_state = ?, ended_at = ?, last_active_at = ?
      WHERE session_id = ?
    `).run(status, desiredState, ts, ts, sessionId)
  }

  touchSessionActivity(sessionId: string): void {
    this.db.prepare(`
      UPDATE sessions
      SET last_active_at = ?
      WHERE session_id = ?
    `).run(now(), sessionId)
  }

  findChannelSession(source: string, chatId: string, userId: string): SessionRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE source = ? AND channel_chat_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY last_active_at DESC
      LIMIT 1
    `).get(source, chatId, userId) as SqlRow | undefined
    return row ? mapSession(row) : null
  }

  updateSessionTranscript(
    sessionId: string,
    patch: {
      transcriptSessionId: string
      transcriptPath: string
    },
  ): void {
    this.db.prepare(`
      UPDATE sessions
      SET transcript_session_id = ?,
          transcript_path = ?
      WHERE session_id = ?
    `).run(
      patch.transcriptSessionId,
      patch.transcriptPath,
      sessionId,
    )
  }

  updateSessionMetadata(
    sessionId: string,
    patch: { title?: string | null; summary?: string | null },
  ): void {
    this.db.prepare(`
      UPDATE sessions
      SET title = COALESCE(?, title),
          summary = COALESCE(?, summary)
      WHERE session_id = ?
    `).run(
      patch.title === undefined ? null : patch.title,
      patch.summary === undefined ? null : patch.summary,
      sessionId,
    )
  }

  updateSessionRuntimeImage(sessionId: string, dockerImage: string): void {
    this.db.prepare(`
      UPDATE sessions
      SET docker_image = ?
      WHERE session_id = ?
    `).run(dockerImage, sessionId)
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(`
      UPDATE sessions
      SET deleted_at = ?
      WHERE session_id = ?
    `).run(now(), sessionId)
  }

  updateAttemptRunner(attemptId: string, runnerPid: number): void {
    const ts = now()
    this.db.prepare(`
      UPDATE session_attempts
      SET runner_pid = ?, runtime_state = 'running', last_heartbeat_at = ?
      WHERE attempt_id = ?
    `).run(runnerPid, ts, attemptId)
  }

  touchAttemptHeartbeat(
    attemptId: string,
    state: AttemptRuntimeState = 'running',
  ): void {
    this.db.prepare(`
      UPDATE session_attempts
      SET last_heartbeat_at = ?, runtime_state = ?
      WHERE attempt_id = ?
    `).run(now(), state, attemptId)
  }

  markAttemptStopped(
    attemptId: string,
    input: {
      runtimeState: AttemptRuntimeState
      exitCode?: number | null
      exitSignal?: string | null
      stopReason?: string | null
      errorText?: string | null
    },
  ): void {
    const ts = now()
    this.db.prepare(`
      UPDATE session_attempts
      SET runtime_state = ?, stopped_at = ?, last_heartbeat_at = ?,
          exit_code = ?, exit_signal = ?, stop_reason = ?, error_text = ?
      WHERE attempt_id = ?
    `).run(
      input.runtimeState,
      ts,
      ts,
      input.exitCode ?? null,
      input.exitSignal ?? null,
      input.stopReason ?? null,
      input.errorText ?? null,
      attemptId,
    )
  }

  markAttemptLost(attemptId: string, errorText: string): void {
    this.markAttemptStopped(attemptId, {
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
  listAttemptsByRuntimeState(states: AttemptRuntimeState[]): AttemptRecord[] {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT * FROM session_attempts
      WHERE runtime_state IN (${placeholders})
    `).all(...states) as SqlRow[]
    return rows.map(mapAttempt)
  }

  listSessionRecords(filter: SessionListFilter): SessionRecord[] {
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
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE ${clauses.join(' AND ')}
      ORDER BY last_active_at DESC
    `).all(...values) as SqlRow[]
    return rows.map(mapSession)
  }

  listSessions(filter: SessionListFilter): SessionSummary[] {
    return this.listSessionRecords(filter).map(toSessionSummary)
  }

  listUserSessions(orgId: string, userId: string): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY last_active_at DESC
    `).all(orgId, userId) as SqlRow[]
    return rows.map(mapSession)
  }

  /** Look up a user's org_id from the users table */
  getUserOrgId(userId: string): string | null {
    const row = this.db.prepare(`SELECT org_id FROM users WHERE id = ?`).get(userId) as SqlRow | undefined
    return row?.org_id ? String(row.org_id) : null
  }

  listSessionsToRecover(): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE desired_state = 'active'
        AND deleted_at IS NULL
        AND status IN ('creating', 'active', 'detached', 'lost', 'failed')
      ORDER BY last_active_at DESC
    `).all() as SqlRow[]
    return rows.map(mapSession)
  }

  countActiveSessions(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE deleted_at IS NULL
        AND status IN ('creating', 'active', 'detached')
    `).get() as SqlRow | undefined
    return Number(row?.count ?? 0)
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE session_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(sessionId) as SqlRow | undefined
    return row ? mapSession(row) : null
  }

  getAttempt(attemptId: string): AttemptRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM session_attempts
      WHERE attempt_id = ?
      LIMIT 1
    `).get(attemptId) as SqlRow | undefined
    return row ? mapAttempt(row) : null
  }

  getCurrentAttempt(sessionId: string): AttemptRecord | null {
    const row = this.db.prepare(`
      SELECT a.*
      FROM session_attempts a
      JOIN sessions s ON s.current_attempt_id = a.attempt_id
      WHERE s.session_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(sessionId) as SqlRow | undefined
    return row ? mapAttempt(row) : null
  }

  getNextGeneration(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS max_generation
      FROM session_attempts
      WHERE session_id = ?
    `).get(sessionId) as SqlRow | undefined
    return Number(row?.max_generation ?? 0) + 1
  }

  addEvent(
    sessionId: string,
    attemptId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): SessionEventRecord {
    const eventId = randomUUID()
    const createdAt = now()
    this.db.prepare(`
      INSERT INTO session_events (
        event_id, session_id, attempt_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      sessionId,
      attemptId,
      eventType,
      JSON.stringify(payload),
      createdAt,
    )
    return {
      eventId,
      sessionId,
      attemptId,
      eventType,
      payload,
      createdAt,
    }
  }

  latestEvent(sessionId: string, eventType: string): SessionEventRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM session_events
      WHERE session_id = ? AND event_type = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId, eventType) as SqlRow | undefined
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

  getEnterprise(): EnterpriseRecord {
    const row = this.db.prepare(`
      SELECT * FROM enterprises WHERE id = 'default' LIMIT 1
    `).get() as SqlRow | undefined

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

  updateEnterprise(patch: Partial<Omit<EnterpriseRecord, 'id' | 'created_at' | 'updated_at'>>): void {
    const entries = Object.entries(patch)
    if (entries.length === 0) return

    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    // SQLite has no boolean type — coerce booleans to 0/1 so INTEGER columns
    // (e.g. client_cron_enabled) bind correctly; everything else passes through.
    const values = entries.map(([, value]) =>
      typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null,
    )
    const ts = now()

    this.db.prepare(`
      UPDATE enterprises
      SET ${sets}, updated_at = ?
      WHERE id = 'default'
    `).run(...values, ts)
  }

  // ==================== Channel Plugins ====================

  listChannelPlugins(userId?: string): SqlRow[] {
    if (userId) {
      return this.db.prepare(`SELECT * FROM channel_plugins WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as SqlRow[]
    }
    return this.db.prepare(`SELECT * FROM channel_plugins ORDER BY created_at DESC`).all() as SqlRow[]
  }

  getChannelPlugin(id: string, userId?: string): SqlRow | null {
    if (userId) {
      return (this.db.prepare(`SELECT * FROM channel_plugins WHERE id = ? AND user_id = ?`).get(id, userId) as SqlRow) ?? null
    }
    return (this.db.prepare(`SELECT * FROM channel_plugins WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  upsertChannelPlugin(row: {
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
  }): void {
    const ts = now()
    this.db.prepare(`
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
    `).run(
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
    )
  }

  updateChannelPluginStatus(id: string, status: string, lastConnected?: number, userId?: string): void {
    const ts = now()
    if (userId) {
      this.db.prepare(`
        UPDATE channel_plugins
        SET status = ?, last_connected = COALESCE(?, last_connected), updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(status, lastConnected ?? null, ts, id, userId)
    } else {
      this.db.prepare(`
        UPDATE channel_plugins
        SET status = ?, last_connected = COALESCE(?, last_connected), updated_at = ?
        WHERE id = ?
      `).run(status, lastConnected ?? null, ts, id)
    }
  }

  // ==================== Channel Users ====================

  listChannelUsers(userId?: string): SqlRow[] {
    if (userId) {
      return this.db.prepare(`SELECT * FROM channel_users WHERE user_id = ? ORDER BY authorized_at DESC`).all(userId) as SqlRow[]
    }
    return this.db.prepare(`SELECT * FROM channel_users ORDER BY authorized_at DESC`).all() as SqlRow[]
  }

  getChannelUserByPlatform(platformUserId: string, platformType: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM channel_users WHERE platform_user_id = ? AND platform_type = ?`).get(platformUserId, platformType) as SqlRow) ?? null
  }

  upsertChannelUser(row: {
    id: string
    platform_user_id: string
    platform_type: string
    display_name?: string | null
    authorized_at: number
    last_active?: number | null
    session_id?: string | null
    org_id?: string | null
    user_id?: string | null
  }): void {
    this.db.prepare(`
      INSERT INTO channel_users (
        id, platform_user_id, platform_type, display_name, authorized_at, last_active, session_id, org_id, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_user_id, platform_type, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        last_active = excluded.last_active,
        session_id = excluded.session_id,
        org_id = excluded.org_id,
        user_id = excluded.user_id
    `).run(
      row.id,
      row.platform_user_id,
      row.platform_type,
      row.display_name ?? null,
      row.authorized_at,
      row.last_active ?? null,
      row.session_id ?? null,
      row.org_id ?? null,
      row.user_id ?? null,
    )
  }

  getChannelUserById(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM channel_users WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  deleteChannelUser(id: string): void {
    this.db.prepare(`DELETE FROM channel_users WHERE id = ?`).run(id)
  }

  deleteChannelUsersByPlatform(platformType: string, userId?: string): number {
    if (userId) {
      const result = this.db.prepare(`DELETE FROM channel_users WHERE platform_type = ? AND user_id = ?`).run(platformType, userId)
      return result.changes
    }
    const result = this.db.prepare(`DELETE FROM channel_users WHERE platform_type = ?`).run(platformType)
    return result.changes
  }

  // ==================== Channel Sessions ====================

  listChannelSessions(): SqlRow[] {
    return this.db.prepare(`SELECT * FROM channel_sessions ORDER BY last_activity DESC`).all() as SqlRow[]
  }

  upsertChannelSession(row: {
    id: string
    user_id: string
    agent_type: string
    conversation_id?: string | null
    workspace?: string | null
    chat_id?: string | null
    created_at: number
    last_activity: number
  }): void {
    this.db.prepare(`
      INSERT INTO channel_sessions (
        id, user_id, agent_type, conversation_id, workspace, chat_id, created_at, last_activity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        workspace = excluded.workspace,
        chat_id = excluded.chat_id,
        last_activity = excluded.last_activity
    `).run(
      row.id,
      row.user_id,
      row.agent_type,
      row.conversation_id ?? null,
      row.workspace ?? null,
      row.chat_id ?? null,
      row.created_at,
      row.last_activity,
    )
  }

  deleteChannelSession(id: string): void {
    this.db.prepare(`DELETE FROM channel_sessions WHERE id = ?`).run(id)
  }

  // ==================== Channel Pairings ====================

  listPendingPairingRequests(userId?: string): SqlRow[] {
    if (userId) {
      return this.db.prepare(`SELECT * FROM channel_pairing_requests WHERE status = 'pending' AND expires_at > ? AND (user_id = ? OR user_id IS NULL)`).all(now(), userId) as SqlRow[]
    }
    return this.db.prepare(`SELECT * FROM channel_pairing_requests WHERE status = 'pending' AND expires_at > ?`).all(now()) as SqlRow[]
  }

  getPairingRequest(code: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM channel_pairing_requests WHERE code = ?`).get(code) as SqlRow) ?? null
  }

  upsertPairingRequest(row: {
    code: string
    platform_user_id: string
    platform_type: string
    display_name?: string | null
    requested_at: number
    expires_at: number
    status: string
    user_id?: string | null
  }): void {
    this.db.prepare(`
      INSERT INTO channel_pairing_requests (
        code, platform_user_id, platform_type, display_name, requested_at, expires_at, status, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        status = excluded.status,
        user_id = excluded.user_id,
        platform_type = excluded.platform_type,
        display_name = excluded.display_name,
        requested_at = excluded.requested_at,
        expires_at = excluded.expires_at
    `).run(
      row.code,
      row.platform_user_id,
      row.platform_type,
      row.display_name ?? null,
      row.requested_at,
      row.expires_at,
      row.status,
      row.user_id ?? null,
    )
  }

  updatePairingRequestStatus(code: string, status: string): void {
    this.db.prepare(`UPDATE channel_pairing_requests SET status = ? WHERE code = ?`).run(status, code)
  }

  deletePairingRequestsByUserAndPlatform(userId: string, platformType: string): void {
    this.db.prepare(`DELETE FROM channel_pairing_requests WHERE user_id = ? AND platform_type = ?`).run(userId, platformType)
  }

  // ==================== Tenant Skills ====================

  listTenantSkills(status?: string, orgId?: string): SqlRow[] {
    const conds: string[] = []
    const params: unknown[] = []
    if (status) { conds.push('status = ?'); params.push(status) }
    // Org isolation: a NULL org_id row is legacy/global and stays visible.
    if (orgId) { conds.push('(org_id = ? OR org_id IS NULL)'); params.push(orgId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    return this.db.prepare(`SELECT * FROM tenant_skills ${where} ORDER BY created_at DESC`).all(...params) as SqlRow[]
  }

  getTenantSkill(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM tenant_skills WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  getTenantSkillByName(name: string, orgId?: string): SqlRow | null {
    if (orgId) {
      return (this.db.prepare(`SELECT * FROM tenant_skills WHERE name = ? AND (org_id = ? OR org_id IS NULL)`).get(name, orgId) as SqlRow) ?? null
    }
    return (this.db.prepare(`SELECT * FROM tenant_skills WHERE name = ?`).get(name) as SqlRow) ?? null
  }

  createTenantSkill(row: {
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
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO tenant_skills (
        id, name, display_name, description, version, author_id, author_name, status,
        source_url, checksum, file_path, publish_note, enabled, visible_to, org_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    )
  }

  updateTenantSkillStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE tenant_skills
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
      WHERE id = ?
    `).run(status, reviewedBy, ts, reviewNote ?? null, ts, id)
  }

  updateTenantSkillMeta(id: string, updates: {
    display_name?: string
    description?: string
    enabled?: number
    visible_to?: string | null
  }): void {
    const ts = now()
    const existing = this.getTenantSkill(id)
    if (!existing) return

    const displayName = updates.display_name ?? existing.display_name
    const description = updates.description ?? existing.description
    const enabled = updates.enabled ?? existing.enabled
    const visibleTo = updates.visible_to !== undefined ? updates.visible_to : existing.visible_to

    this.db.prepare(`
      UPDATE tenant_skills
      SET display_name = ?, description = ?, enabled = ?, visible_to = ?, updated_at = ?
      WHERE id = ?
    `).run(displayName as string, description as string, enabled as number, visibleTo as string | null, ts, id)
  }

  updateTenantSkillFilePath(id: string, filePath: string, sourceUrl: string, checksum: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE tenant_skills
      SET file_path = ?, source_url = ?, checksum = ?, updated_at = ?
      WHERE id = ?
    `).run(filePath, sourceUrl, checksum, ts, id)
  }

  deleteTenantSkill(id: string): void {
    this.db.prepare(`DELETE FROM tenant_skills WHERE id = ?`).run(id)
  }

  // ==================== Tenant Assistants ====================

  listTenantAssistants(status?: string, orgId?: string): SqlRow[] {
    const conds: string[] = []
    const params: unknown[] = []
    if (status) { conds.push('status = ?'); params.push(status) }
    if (orgId) { conds.push('(org_id = ? OR org_id IS NULL)'); params.push(orgId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    return this.db.prepare(`SELECT * FROM tenant_assistants ${where} ORDER BY created_at DESC`).all(...params) as SqlRow[]
  }

  getTenantAssistant(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM tenant_assistants WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  getTenantAssistantByName(name: string, orgId?: string): SqlRow | null {
    if (orgId) {
      return (this.db.prepare(`SELECT * FROM tenant_assistants WHERE name = ? AND (org_id = ? OR org_id IS NULL)`).get(name, orgId) as SqlRow) ?? null
    }
    return (this.db.prepare(`SELECT * FROM tenant_assistants WHERE name = ?`).get(name) as SqlRow) ?? null
  }

  createTenantAssistant(row: {
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
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO tenant_assistants (
        id, name, display_name, description, version, author_id, author_name, status,
        source_url, checksum, file_path, enabled_skills, skills, memory_mode, agent_type, publish_note, enabled, visible_to, enabled_wikis, enabled_corp_apps, workflow, org_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    )
  }

  updateTenantAssistantStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE tenant_assistants
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
      WHERE id = ?
    `).run(status, reviewedBy, ts, reviewNote ?? null, ts, id)
  }

  updateTenantAssistantMeta(id: string, updates: {
    display_name?: string
    description?: string
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
  }): void {
    const ts = now()
    const existing = this.getTenantAssistant(id)
    if (!existing) return

    const displayName = updates.display_name ?? existing.display_name
    const description = updates.description ?? existing.description
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

    this.db.prepare(`
      UPDATE tenant_assistants
      SET display_name = ?, description = ?, enabled = ?, visible_to = ?, enabled_skills = ?,
          avatar = ?, emoji = ?, agent_type = ?, memory_mode = ?, enabled_wikis = ?, enabled_corp_apps = ?, skills = ?, workflow = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      displayName as string,
      description as string,
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
    )
  }

  updateTenantAssistantFilePath(id: string, filePath: string, sourceUrl: string, checksum: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE tenant_assistants
      SET file_path = ?, source_url = ?, checksum = ?, updated_at = ?
      WHERE id = ?
    `).run(filePath, sourceUrl, checksum, ts, id)
  }

  /**
   * Update tenant assistant file_path only (used after approval to point to tenant directory)
   */
  updateTenantAssistantPath(id: string, filePath: string): void {
    const ts = now()
    this.db.prepare(`
      UPDATE tenant_assistants
      SET file_path = ?, updated_at = ?
      WHERE id = ?
    `).run(filePath, ts, id)
  }

  deleteTenantAssistant(id: string): void {
    this.db.prepare(`DELETE FROM tenant_assistants WHERE id = ?`).run(id)
  }

  // ==================== Document Center: Tree Nodes ====================

  listDocumentTreeNodes(orgId: string): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM document_tree_nodes WHERE org_id = ? ORDER BY sort_order, created_at`)
      .all(orgId) as SqlRow[]
  }

  getDocumentTreeNode(id: string, orgId: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM document_tree_nodes WHERE id = ? AND org_id = ?`).get(id, orgId) as SqlRow) ?? null
  }

  createDocumentTreeNode(row: {
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
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO document_tree_nodes (
        id, org_id, parent_id, name, description, sort_order, created_at, updated_at,
        source_id, source_path, auto_managed, alias, last_synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    )
  }

  updateDocumentTreeNode(id: string, orgId: string, updates: {
    parent_id?: string | null
    name?: string
    description?: string | null
    sort_order?: number
  }): void {
    const ts = now()
    const existing = this.getDocumentTreeNode(id, orgId)
    if (!existing) return
    this.db.prepare(`
      UPDATE document_tree_nodes
      SET parent_id = ?, name = ?, description = ?, sort_order = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
      updates.parent_id !== undefined ? updates.parent_id : (existing.parent_id as string | null),
      updates.name ?? (existing.name as string),
      updates.description !== undefined ? updates.description : (existing.description as string | null),
      updates.sort_order ?? (existing.sort_order as number),
      ts,
      id,
      orgId,
    )
  }

  deleteDocumentTreeNode(id: string, orgId: string): void {
    // ON DELETE CASCADE will remove child nodes and their documents
    this.db.prepare(`DELETE FROM document_tree_nodes WHERE id = ? AND org_id = ?`).run(id, orgId)
  }

  // ==================== Document Center: Documents ====================

  listDocumentsByNode(nodeId: string, orgId: string): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM documents WHERE node_id = ? AND org_id = ? ORDER BY uploaded_at DESC`)
      .all(nodeId, orgId) as SqlRow[]
  }

  getDocument(id: string, orgId: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM documents WHERE id = ? AND org_id = ?`).get(id, orgId) as SqlRow) ?? null
  }

  createDocument(row: {
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
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO documents (
        id, org_id, node_id, file_name, mime_type, size_bytes, storage_path,
        uploaded_by, uploaded_at,
        source_id, external_id, external_etag, content_sha256
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    )
  }

  deleteDocument(id: string, orgId: string): void {
    this.db.prepare(`DELETE FROM documents WHERE id = ? AND org_id = ?`).run(id, orgId)
  }

  // ==================== Document Center: Wikis ====================

  listWikis(orgId: string, filter?: { nodeId?: string; buildStatus?: string }): SqlRow[] {
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
    return this.db
      .prepare(`SELECT * FROM wikis WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`)
      .all(...params) as SqlRow[]
  }

  getWiki(id: string, orgId: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM wikis WHERE id = ? AND org_id = ?`).get(id, orgId) as SqlRow) ?? null
  }

  /** Cross-org getter for runtime / build worker use. */
  getWikiById(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM wikis WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  createWiki(row: {
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
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO wikis (
        id, org_id, node_id, name, description, storage_path,
        build_status, source_document_ids, source_mode, source_node_id, auto_rebuild,
        source_node_ids, source_exclude_node_ids,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    )
  }

  updateWiki(id: string, orgId: string, updates: {
    name?: string
    description?: string | null
    node_id?: string | null
    source_document_ids?: string[]
    source_mode?: 'files' | 'dir'
    source_node_id?: string | null
    source_node_ids?: string[]
    source_exclude_node_ids?: string[]
    auto_rebuild?: boolean
  }): void {
    const ts = now()
    const existing = this.getWiki(id, orgId)
    if (!existing) return
    this.db.prepare(`
      UPDATE wikis
      SET name = ?, description = ?, node_id = ?, source_document_ids = ?,
          source_mode = ?, source_node_id = ?, auto_rebuild = ?,
          source_node_ids = ?, source_exclude_node_ids = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
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
    )
  }

  updateWikiBuildResult(id: string, result: {
    build_status: 'pending' | 'running' | 'succeeded' | 'failed'
    last_built_at?: number
    last_build_error?: string | null
  }): void {
    const ts = now()
    this.db.prepare(`
      UPDATE wikis
      SET build_status = ?, last_built_at = ?, last_build_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.build_status,
      result.last_built_at ?? null,
      result.last_build_error ?? null,
      ts,
      id,
    )
  }

  deleteWiki(id: string, orgId: string): void {
    this.db.prepare(`DELETE FROM wikis WHERE id = ? AND org_id = ?`).run(id, orgId)
  }

  // ==================== Document Center: Build Jobs ====================

  listWikiBuildJobs(wikiId: string, limit = 20): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM wiki_build_jobs WHERE wiki_id = ? ORDER BY queued_at DESC LIMIT ?`)
      .all(wikiId, limit) as SqlRow[]
  }

  listWikiBuildJobsForOrg(orgId: string, opts?: {
    status?: string
    wikiId?: string
    limit?: number
    offset?: number
  }): { items: SqlRow[]; total: number } {
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
    const totalRow = this.db
      .prepare(`
        SELECT COUNT(*) AS c
        FROM wiki_build_jobs j
        JOIN wikis w ON w.id = j.wiki_id
        WHERE ${whereSql}
      `)
      .get(...params) as { c: number } | undefined
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 50), 1), 200)
    const offset = Math.max(Math.floor(opts?.offset ?? 0), 0)
    const items = this.db
      .prepare(`
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
      `)
      .all(...params, limit, offset) as SqlRow[]
    return { items, total: totalRow ? Number(totalRow.c) : 0 }
  }

  getWikiBuildJobForOrg(id: string, orgId: string): SqlRow | null {
    return (this.db
      .prepare(`
        SELECT
          j.*,
          w.name AS wiki_name,
          w.node_id AS wiki_node_id,
          w.build_status AS wiki_build_status,
          w.needs_rebuild AS wiki_needs_rebuild
        FROM wiki_build_jobs j
        JOIN wikis w ON w.id = j.wiki_id
        WHERE j.id = ? AND w.org_id = ?
      `)
      .get(id, orgId) as SqlRow) ?? null
  }

  getWikiBuildJob(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM wiki_build_jobs WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  getLatestWikiBuildJob(wikiId: string): SqlRow | null {
    return (this.db
      .prepare(`SELECT * FROM wiki_build_jobs WHERE wiki_id = ? ORDER BY queued_at DESC LIMIT 1`)
      .get(wikiId) as SqlRow) ?? null
  }

  countRunningWikiBuildJobs(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM wiki_build_jobs WHERE status IN ('queued', 'running')`)
      .get() as { c: number } | undefined
    return row ? Number(row.c) : 0
  }

  listQueuedWikiBuildJobs(limit = 10): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM wiki_build_jobs WHERE status = 'queued' ORDER BY queued_at LIMIT ?`)
      .all(limit) as SqlRow[]
  }

  createWikiBuildJob(row: {
    id: string
    wiki_id: string
    triggered_by: string
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO wiki_build_jobs (id, wiki_id, status, progress, triggered_by, queued_at)
      VALUES (?, ?, 'queued', 0, ?, ?)
    `).run(row.id, row.wiki_id, row.triggered_by, ts)
  }

  updateWikiBuildJob(id: string, updates: {
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    progress?: number
    current_step?: string | null
    error_message?: string | null
    session_id?: string | null
    started_at?: number
    finished_at?: number
  }): void {
    const existing = this.getWikiBuildJob(id)
    if (!existing) return
    this.db.prepare(`
      UPDATE wiki_build_jobs
      SET status = ?, progress = ?, current_step = ?, error_message = ?,
          session_id = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      updates.status ?? (existing.status as string),
      updates.progress !== undefined ? updates.progress : (existing.progress as number),
      updates.current_step !== undefined ? updates.current_step : (existing.current_step as string | null),
      updates.error_message !== undefined ? updates.error_message : (existing.error_message as string | null),
      updates.session_id !== undefined ? updates.session_id : (existing.session_id as string | null),
      updates.started_at ?? (existing.started_at as number | null),
      updates.finished_at ?? (existing.finished_at as number | null),
      id,
    )
  }

  // ==================== Document Center v2: External Sources ====================

  listExternalSources(orgId: string, opts?: { enabledOnly?: boolean }): SqlRow[] {
    if (opts?.enabledOnly) {
      return this.db
        .prepare(`SELECT * FROM external_sources WHERE org_id = ? AND enabled = 1 ORDER BY created_at`)
        .all(orgId) as SqlRow[]
    }
    return this.db
      .prepare(`SELECT * FROM external_sources WHERE org_id = ? ORDER BY created_at`)
      .all(orgId) as SqlRow[]
  }

  /** Cross-org: used by the sync worker which has no caller context. */
  listAllEnabledExternalSources(): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM external_sources WHERE enabled = 1 ORDER BY last_sync_at`)
      .all() as SqlRow[]
  }

  getExternalSource(id: string, orgId: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM external_sources WHERE id = ? AND org_id = ?`).get(id, orgId) as SqlRow) ?? null
  }

  /** Cross-org getter for the sync worker. */
  getExternalSourceById(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM external_sources WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  createExternalSource(row: {
    id: string
    org_id: string
    type: string
    name: string
    config_json: string
    credentials_secret_key?: string | null
    sync_interval_sec?: number
    auto_build_enabled?: number
    created_by: string
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO external_sources (
        id, org_id, type, name, config_json, credentials_secret_key,
        sync_interval_sec, auto_build_enabled, enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
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
    )
  }

  updateExternalSource(id: string, orgId: string, updates: {
    name?: string
    config_json?: string
    credentials_secret_key?: string | null
    sync_interval_sec?: number
    auto_build_enabled?: number
    enabled?: number
  }): void {
    const existing = this.getExternalSource(id, orgId)
    if (!existing) return
    const ts = now()
    this.db.prepare(`
      UPDATE external_sources
      SET name = ?, config_json = ?, credentials_secret_key = ?,
          sync_interval_sec = ?, auto_build_enabled = ?, enabled = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
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
    )
  }

  updateExternalSourceSyncStatus(id: string, status: {
    last_sync_at?: number
    last_sync_status?: 'success' | 'failed' | 'running'
    last_sync_error?: string | null
  }): void {
    const existing = this.getExternalSourceById(id)
    if (!existing) return
    this.db.prepare(`
      UPDATE external_sources
      SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?
      WHERE id = ?
    `).run(
      status.last_sync_at ?? (existing.last_sync_at as number | null),
      status.last_sync_status ?? (existing.last_sync_status as string | null),
      status.last_sync_error !== undefined ? status.last_sync_error : (existing.last_sync_error as string | null),
      id,
    )
  }

  deleteExternalSource(id: string, orgId: string): void {
    // Note: documents and tree nodes with this source_id are NOT cascade-deleted;
    // the next sync sweep will soft-delete them. Keep DB referential integrity loose.
    this.db.prepare(`DELETE FROM external_sources WHERE id = ? AND org_id = ?`).run(id, orgId)
  }

  // ==================== 企业应用管理 (Corp Apps) ====================

  listCorpApps(orgId: string, opts?: { enabledOnly?: boolean }): SqlRow[] {
    if (opts?.enabledOnly) {
      return this.db
        .prepare(`SELECT * FROM corp_apps WHERE org_id = ? AND enabled = 1 ORDER BY created_at`)
        .all(orgId) as SqlRow[]
    }
    return this.db
      .prepare(`SELECT * FROM corp_apps WHERE org_id = ? ORDER BY created_at`)
      .all(orgId) as SqlRow[]
  }

  getCorpApp(id: string, orgId: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM corp_apps WHERE id = ? AND org_id = ?`).get(id, orgId) as SqlRow) ?? null
  }

  /** Cross-org getter (callback listener has no caller org context). */
  getCorpAppById(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM corp_apps WHERE id = ?`).get(id) as SqlRow) ?? null
  }

  getCorpAppByName(orgId: string, name: string): SqlRow | null {
    return (this.db.prepare(`SELECT * FROM corp_apps WHERE org_id = ? AND name = ?`).get(orgId, name) as SqlRow) ?? null
  }

  getCorpAppByKey(orgId: string, type: string, appKey: string): SqlRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM corp_apps WHERE org_id = ? AND type = ? AND app_key = ?`)
        .get(orgId, type, appKey) as SqlRow) ?? null
    )
  }

  /** Insert a corp app. Throws on (org_id, name) or (org_id, type, app_key) collision. */
  createCorpApp(row: {
    id: string
    org_id: string
    type: string
    name: string
    app_key: string
    config_json: string
    credentials_secret_key?: string | null
    created_by: string
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO corp_apps (
        id, org_id, type, name, app_key, config_json, credentials_secret_key,
        enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
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
    )
  }

  updateCorpApp(id: string, orgId: string, updates: {
    name?: string
    app_key?: string
    config_json?: string
    credentials_secret_key?: string | null
    enabled?: number
  }): void {
    const existing = this.getCorpApp(id, orgId)
    if (!existing) return
    const ts = now()
    this.db.prepare(`
      UPDATE corp_apps
      SET name = ?, app_key = ?, config_json = ?, credentials_secret_key = ?,
          enabled = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(
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
    )
  }

  deleteCorpApp(id: string, orgId: string): void {
    this.db.prepare(`DELETE FROM corp_apps WHERE id = ? AND org_id = ?`).run(id, orgId)
  }

  // ---- Inbound message buffer ----

  /** Append an inbound message, assigning the next per-app sequence number. */
  appendCorpAppInbound(msg: {
    corp_app_id: string
    org_id: string
    from_user?: string | null
    msg_type?: string | null
    text?: string | null
    media_id?: string | null
    file_name?: string | null
    received_at?: number
    payload_json?: string | null
  }): number {
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM corp_app_inbound WHERE corp_app_id = ?`)
      .get(msg.corp_app_id) as { m: number }
    const seq = (r?.m ?? 0) + 1
    this.db.prepare(`
      INSERT INTO corp_app_inbound (
        id, corp_app_id, org_id, seq, from_user, msg_type, text,
        media_id, file_name, received_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      msg.corp_app_id,
      msg.org_id,
      seq,
      msg.from_user ?? null,
      msg.msg_type ?? null,
      msg.text ?? null,
      msg.media_id ?? null,
      msg.file_name ?? null,
      msg.received_at ?? now(),
      msg.payload_json ?? null,
    )
    return seq
  }

  /** List inbound messages with seq > sinceSeq, oldest first. */
  listCorpAppInbound(corpAppId: string, sinceSeq: number, limit: number): SqlRow[] {
    return this.db
      .prepare(
        `SELECT * FROM corp_app_inbound WHERE corp_app_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(corpAppId, sinceSeq, Math.max(1, Math.min(limit, 500))) as SqlRow[]
  }

  // ==================== Document Center v2: Soft-delete helpers ====================

  /** Soft-delete a document by setting deleted_at. */
  softDeleteDocument(id: string): void {
    const ts = now()
    this.db.prepare(`UPDATE documents SET deleted_at = ? WHERE id = ?`).run(ts, id)
  }

  /** Undelete (restore from soft-delete). */
  undeleteDocument(id: string): void {
    this.db.prepare(`UPDATE documents SET deleted_at = NULL WHERE id = ?`).run(id)
  }

  softDeleteTreeNode(id: string): void {
    const ts = now()
    this.db.prepare(`UPDATE document_tree_nodes SET deleted_at = ? WHERE id = ?`).run(ts, id)
  }

  undeleteTreeNode(id: string): void {
    this.db.prepare(`UPDATE document_tree_nodes SET deleted_at = NULL WHERE id = ?`).run(id)
  }

  /** Hard-delete docs/nodes that have been soft-deleted for longer than `cutoffTs`. */
  purgeOldSoftDeletes(cutoffTs: number): { documents: number; nodes: number } {
    const docResult = this.db
      .prepare(`DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .run(cutoffTs)
    const nodeResult = this.db
      .prepare(`DELETE FROM document_tree_nodes WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .run(cutoffTs)
    return {
      documents: Number(docResult.changes ?? 0),
      nodes: Number(nodeResult.changes ?? 0),
    }
  }

  // ==================== Document Center v2: Source-aware lookups ====================

  /** Find a tree node by (source_id, source_path). Used by the sync diff. */
  findTreeNodeBySource(sourceId: string, sourcePath: string): SqlRow | null {
    return (this.db
      .prepare(`SELECT * FROM document_tree_nodes WHERE source_id = ? AND source_path = ? LIMIT 1`)
      .get(sourceId, sourcePath) as SqlRow) ?? null
  }

  /** Find a document by (source_id, external_id). Used by the sync diff. */
  findDocumentBySource(sourceId: string, externalId: string): SqlRow | null {
    return (this.db
      .prepare(`SELECT * FROM documents WHERE source_id = ? AND external_id = ? LIMIT 1`)
      .get(sourceId, externalId) as SqlRow) ?? null
  }

  /** Find a non-deleted document by content hash within an org (for dedup). */
  findDocumentByHash(orgId: string, sha256: string): SqlRow | null {
    return (this.db
      .prepare(`SELECT * FROM documents WHERE org_id = ? AND content_sha256 = ? AND deleted_at IS NULL LIMIT 1`)
      .get(orgId, sha256) as SqlRow) ?? null
  }

  /** All non-deleted documents/nodes for a source, for the reverse sweep. */
  listDocumentsBySource(sourceId: string): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM documents WHERE source_id = ? AND deleted_at IS NULL`)
      .all(sourceId) as SqlRow[]
  }

  listTreeNodesBySource(sourceId: string): SqlRow[] {
    return this.db
      .prepare(`SELECT * FROM document_tree_nodes WHERE source_id = ? AND deleted_at IS NULL`)
      .all(sourceId) as SqlRow[]
  }

  /** The top-level (parent_id IS NULL) node that is the source's auto-created root. */
  findSourceRootNode(sourceId: string): SqlRow | null {
    return (this.db
      .prepare(
        `SELECT * FROM document_tree_nodes
         WHERE source_id = ? AND parent_id IS NULL AND deleted_at IS NULL LIMIT 1`,
      )
      .get(sourceId) as SqlRow) ?? null
  }

  /** Rename a tree node (used to keep the source root node named after the source). */
  renameTreeNode(id: string, name: string): void {
    this.db
      .prepare(`UPDATE document_tree_nodes SET name = ?, updated_at = ? WHERE id = ?`)
      .run(name, now(), id)
  }

  /** Document Center v2: update an existing document row's content (sha/etag/path). */
  updateDocumentContent(id: string, updates: {
    external_etag?: string | null
    content_sha256?: string | null
    storage_path?: string
    size_bytes?: number
  }): void {
    const existing = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as SqlRow | undefined
    if (!existing) return
    this.db.prepare(`
      UPDATE documents
      SET external_etag = ?, content_sha256 = ?, storage_path = ?, size_bytes = ?
      WHERE id = ?
    `).run(
      updates.external_etag !== undefined ? updates.external_etag : (existing.external_etag as string | null),
      updates.content_sha256 !== undefined ? updates.content_sha256 : (existing.content_sha256 as string | null),
      updates.storage_path ?? (existing.storage_path as string),
      updates.size_bytes ?? (existing.size_bytes as number),
      id,
    )
  }

  /** Update tree node position/name (used by sync diff on rename/move). */
  updateTreeNodeSourceLocation(id: string, updates: {
    parent_id?: string | null
    name?: string
    source_path?: string
    last_synced_at?: number
  }): void {
    const existing = this.db.prepare(`SELECT * FROM document_tree_nodes WHERE id = ?`).get(id) as SqlRow | undefined
    if (!existing) return
    const ts = now()
    this.db.prepare(`
      UPDATE document_tree_nodes
      SET parent_id = ?, name = ?, source_path = ?, last_synced_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.parent_id !== undefined ? updates.parent_id : (existing.parent_id as string | null),
      updates.name ?? (existing.name as string),
      updates.source_path ?? (existing.source_path as string | null),
      updates.last_synced_at ?? ts,
      ts,
      id,
    )
  }

  /** Document Center v2: list wikis whose source_document_ids contains this doc id. */
  findWikisReferencingDocument(docId: string): SqlRow[] {
    // SQLite has no native JSON contains; use LIKE on the canonical JSON form.
    // source_document_ids is stored as JSON array of strings, e.g. ["abc","def"]
    return this.db
      .prepare(`SELECT * FROM wikis WHERE source_document_ids LIKE ?`)
      .all(`%"${docId}"%`) as SqlRow[]
  }

  /**
   * Document Center v2 — recursively list all non-deleted documents under a
   * tree node (the node's whole subtree). Used to materialize a dir-mode
   * wiki's inputs at build time. Collects descendant node IDs by walking
   * parent_id from the org's node list, then selects documents in that set.
   */
  /** Build a parent→children adjacency map for the org's tree once. */
  private childrenByParentMap(orgId: string): Map<string | null, string[]> {
    const nodes = this.listDocumentTreeNodes(orgId)
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

  listDocumentsUnderNode(rootNodeId: string, orgId: string): SqlRow[] {
    return this.listDocumentsUnderNodes([rootNodeId], [], orgId)
  }

  /**
   * Document Center v2 — non-deleted documents under any of `includeIds`'
   * subtrees, minus documents under any of `excludeIds`' subtrees. Used to
   * materialize a dir-mode wiki's inputs (multi-dir with persistent exclusions)
   * at build time.
   */
  listDocumentsUnderNodes(includeIds: string[], excludeIds: string[], orgId: string): SqlRow[] {
    if (includeIds.length === 0) return []
    const childrenByParent = this.childrenByParentMap(orgId)
    const included = new Set<string>()
    for (const id of includeIds) for (const n of this.subtreeNodeIds(id, childrenByParent)) included.add(n)
    for (const id of excludeIds) for (const n of this.subtreeNodeIds(id, childrenByParent)) included.delete(n)
    const ids = [...included]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT * FROM documents
         WHERE org_id = ? AND deleted_at IS NULL AND node_id IN (${placeholders})
         ORDER BY node_id, file_name`,
      )
      .all(orgId, ...ids) as SqlRow[]
  }

  /**
   * Document Center v2 — find dir-mode wikis whose *effective tracked set*
   * includes the given changed node. A wiki matches if one of its included dir
   * nodes (source_node_ids) is the changed node or an ancestor of it, AND none
   * of its excluded nodes is the changed node or an ancestor (i.e. the change
   * isn't inside an excluded subtree). `nodeIdChain` = changed node + ancestors.
   */
  findDirWikisForNode(nodeIdChain: string[]): SqlRow[] {
    if (nodeIdChain.length === 0) return []
    const chain = new Set(nodeIdChain)
    const dirWikis = this.db
      .prepare(`SELECT * FROM wikis WHERE source_mode = 'dir'`)
      .all() as SqlRow[]
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

  markWikiNeedsRebuild(wikiId: string, needs: boolean): void {
    this.db.prepare(`UPDATE wikis SET needs_rebuild = ? WHERE id = ?`).run(needs ? 1 : 0, wikiId)
  }

  /** Set node alias (Q2: source-managed nodes can't be renamed, but admins can set a display alias). */
  setTreeNodeAlias(id: string, orgId: string, alias: string | null): void {
    this.db
      .prepare(`UPDATE document_tree_nodes SET alias = ?, updated_at = ? WHERE id = ? AND org_id = ?`)
      .run(alias, now(), id, orgId)
  }

  // ==================== Secrets Management ====================

  // --- Config Items ---

  listConfigItems(opts: {
    name?: string
    scope?: string
    status?: string
    page?: number
    pageSize?: number
    /** When set, restrict non-user-scope items to this org; user-scope
     *  definitions are global and always included. */
    orgId?: string
  }): { items: SqlRow[]; total: number } {
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
    const countRow = this.db.prepare(`SELECT COUNT(*) AS c FROM config_items ${where}`).get(...params) as { c: number }
    const total = countRow.c
    const page = opts.page ?? 1
    const pageSize = opts.pageSize ?? 20
    const offset = (page - 1) * pageSize
    const items = this.db.prepare(
      `SELECT * FROM config_items ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, offset) as SqlRow[]
    return { items, total }
  }

  getConfigItem(id: number, orgId?: string): SqlRow | null {
    const row = (this.db.prepare('SELECT * FROM config_items WHERE id = ?').get(id) as SqlRow) ?? null
    // Org guard: a non-user-scope item only resolves within its own org.
    if (row && orgId && row.scope !== 'user' && row.org_id !== orgId) {
      return null
    }
    return row
  }

  getConfigItemByPinyin(pinyin: string, orgId?: string): SqlRow | null {
    // User-scope definitions are global and globally unique by pinyin. Non-user
    // pinyins are unique per org, so resolve within the caller's org.
    if (orgId) {
      const scoped = this.db
        .prepare(`SELECT * FROM config_items WHERE pinyin = ? AND scope != 'user' AND org_id = ?`)
        .get(pinyin, orgId) as SqlRow | undefined
      if (scoped) return scoped
      return (
        (this.db
          .prepare(`SELECT * FROM config_items WHERE pinyin = ? AND scope = 'user'`)
          .get(pinyin) as SqlRow) ?? null
      )
    }
    return (this.db.prepare('SELECT * FROM config_items WHERE pinyin = ?').get(pinyin) as SqlRow) ?? null
  }

  getConfigItemsByScope(scope: string, status?: number, orgId?: string): SqlRow[] {
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
    return this.db
      .prepare(`SELECT * FROM config_items WHERE ${conds.join(' AND ')}`)
      .all(...params) as SqlRow[]
  }

  getAllActiveConfigItems(orgId?: string): SqlRow[] {
    if (orgId) {
      return this.db
        .prepare(`SELECT * FROM config_items WHERE status = 1 AND (scope = 'user' OR org_id = ?)`)
        .all(orgId) as SqlRow[]
    }
    return this.db.prepare('SELECT * FROM config_items WHERE status = 1').all() as SqlRow[]
  }

  /**
   * Ensure default config items exist (e.g., ShareOne for user-level key storage)
   */
  ensureDefaultConfigItems(): void {
    const ts = now()

    // ShareOne config item for user-level API key storage
    const shareoneExists = this.getConfigItemByPinyin('shareone')
    if (!shareoneExists) {
      const result = this.db.prepare(`
        INSERT INTO config_items (name, description, icon, pinyin, scope, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'ShareOne',
        'ShareOne 分享服务 API Key，用于发布分享内容',
        null,
        'shareone',
        'user',
        1,
        ts,
        ts,
      )
      const configItemId = Number(result.lastInsertRowid)

      // Add the shareone_key entry
      this.db.prepare(`
        INSERT INTO config_entries (config_item_id, config_key, name, config_desc, required, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(configItemId, 'shareone_key', 'ShareOne Key', 'ShareOne API Key 用于认证分享发布', 1, ts, ts)

      console.log('[DB] Created default ShareOne config item')
    }
  }

  createConfigItem(row: {
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
  }): number {
    const ts = now()
    // User-scope definitions stay global regardless of any org passed in.
    const orgId = row.scope === 'user' ? null : (row.org_id ?? null)
    const result = this.db.prepare(`
      INSERT INTO config_items (
        name, description, icon, pinyin, scope, url_pattern, scheme, bearer_prefix, status, org_id,
        auth_type, auth_url, token_url, client_id, client_secret_key, refresh_token_key, default_scopes,
        token_request_json, mint_script,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      ts, ts,
    )
    return Number(result.lastInsertRowid)
  }

  updateConfigItem(id: number, updates: {
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
  }, orgId?: string): void {
    // Org guard: a non-user-scope item can only be updated within its own org.
    const existing = this.getConfigItem(id, orgId)
    if (!existing) return
    const ts = now()
    this.db.prepare(`
      UPDATE config_items
      SET name = ?, description = ?, icon = ?, pinyin = ?, scope = ?,
          url_pattern = ?, scheme = ?, bearer_prefix = ?, status = ?,
          auth_type = ?, auth_url = ?, token_url = ?, client_id = ?,
          client_secret_key = ?, refresh_token_key = ?, default_scopes = ?,
          token_request_json = ?, mint_script = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
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
      ts, id,
    )
  }

  deleteConfigItem(id: number, orgId?: string): void {
    // Org guard: don't let one org delete another org's config item.
    if (orgId) {
      const existing = this.getConfigItem(id, orgId)
      if (!existing) return
    }
    this.db.prepare('DELETE FROM config_items WHERE id = ?').run(id)
  }

  // --- Config Entries ---

  getConfigEntries(configItemId: number): SqlRow[] {
    return this.db.prepare('SELECT * FROM config_entries WHERE config_item_id = ?').all(configItemId) as SqlRow[]
  }

  replaceConfigEntries(configItemId: number, entries: {
    config_key: string
    name: string
    config_desc?: string
    required?: boolean
  }[]): void {
    const ts = now()
    this.db.prepare('DELETE FROM config_entries WHERE config_item_id = ?').run(configItemId)
    const stmt = this.db.prepare(`
      INSERT INTO config_entries (config_item_id, config_key, name, config_desc, required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const e of entries) {
      stmt.run(configItemId, e.config_key, e.name, e.config_desc ?? null, e.required ? 1 : 0, ts, ts)
    }
  }

  // --- Secret Metadata ---

  getSecretMetadata(configItemId: number): SqlRow | null {
    return (this.db.prepare('SELECT * FROM secret_metadata WHERE config_item_id = ?').get(configItemId) as SqlRow) ?? null
  }

  getAllSecretMetadata(orgId?: string): SqlRow[] {
    if (orgId) {
      return this.db
        .prepare('SELECT * FROM secret_metadata WHERE org_id = ? OR org_id IS NULL')
        .all(orgId) as SqlRow[]
    }
    return this.db.prepare('SELECT * FROM secret_metadata').all() as SqlRow[]
  }

  upsertSecretMetadata(configItemId: number, expiresAt: number | null, orgId?: string | null): void {
    const ts = now()
    // Denormalize the owning org from the config item when not supplied.
    const resolvedOrg =
      orgId !== undefined ? orgId : ((this.getConfigItem(configItemId)?.org_id as string | null) ?? null)
    const existing = this.getSecretMetadata(configItemId)
    if (existing) {
      this.db.prepare('UPDATE secret_metadata SET expires_at = ?, org_id = ?, updated_at = ? WHERE config_item_id = ?')
        .run(expiresAt, resolvedOrg, ts, configItemId)
    } else {
      this.db.prepare(`
        INSERT INTO secret_metadata (id, config_item_id, org_id, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), configItemId, resolvedOrg, expiresAt, ts, ts)
    }
  }

  getExpiringSecretMetadata(beforeTs: number, orgId?: string): SqlRow[] {
    if (orgId) {
      return this.db.prepare(
        'SELECT * FROM secret_metadata WHERE expires_at IS NOT NULL AND expires_at < ? AND (org_id = ? OR org_id IS NULL)',
      ).all(beforeTs, orgId) as SqlRow[]
    }
    return this.db.prepare(
      'SELECT * FROM secret_metadata WHERE expires_at IS NOT NULL AND expires_at < ?',
    ).all(beforeTs) as SqlRow[]
  }

  // --- Department Secret Policies ---

  getDepartmentPolicies(departmentId: string, orgId?: string): SqlRow[] {
    // department_id is globally unique, but filter by org for defense-in-depth.
    if (orgId) {
      return this.db.prepare(
        'SELECT * FROM department_secret_policies WHERE department_id = ? AND org_id = ?',
      ).all(departmentId, orgId) as SqlRow[]
    }
    return this.db.prepare(
      'SELECT * FROM department_secret_policies WHERE department_id = ?',
    ).all(departmentId) as SqlRow[]
  }

  replaceDepartmentPolicies(departmentId: string, configItemIds: number[], orgId?: string | null): void {
    const ts = now()
    this.db.prepare('DELETE FROM department_secret_policies WHERE department_id = ?').run(departmentId)
    const stmt = this.db.prepare(`
      INSERT INTO department_secret_policies (department_id, config_item_id, org_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
    for (const cid of configItemIds) {
      stmt.run(departmentId, cid, orgId ?? null, ts)
    }
  }

  getConfigItemAuthorizedDepartments(configItemId: number): SqlRow[] {
    return this.db.prepare(
      'SELECT * FROM department_secret_policies WHERE config_item_id = ?',
    ).all(configItemId) as SqlRow[]
  }

  deleteDepartmentPoliciesByConfigItem(configItemId: number): void {
    this.db.prepare('DELETE FROM department_secret_policies WHERE config_item_id = ?').run(configItemId)
  }

  replaceConfigItemDepartments(configItemId: number, departmentIds: string[]): void {
    const ts = now()
    this.db.prepare('DELETE FROM department_secret_policies WHERE config_item_id = ?').run(configItemId)
    const stmt = this.db.prepare(`
      INSERT INTO department_secret_policies (department_id, config_item_id, created_at)
      VALUES (?, ?, ?)
    `)
    for (const deptId of departmentIds) {
      stmt.run(deptId, configItemId, ts)
    }
  }

  // --- Secret Audit Log ---

  insertAuditLog(row: {
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
  }): void {
    this.db.prepare(`
      INSERT INTO secret_audit_log (id, actor_id, actor_name, action, config_item_id, org_id, namespace, key, detail, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.actor_id, row.actor_name ?? null, row.action,
      row.config_item_id ?? null, row.org_id ?? null, row.namespace, row.key,
      row.detail ?? null, row.ip_address ?? null, now(),
    )
  }

  queryAuditLog(opts: {
    actor_id?: string
    /** Restrict to this set of actor ids (credential audit subtree/self gate).
     *  An empty array matches nothing (fail-closed). Applied in addition to
     *  actor_id if both are given. */
    actorIds?: string[]
    config_item_id?: number
    action?: string
    since?: number
    until?: number
    page?: number
    pageSize?: number
    orgId?: string
  }): { items: SqlRow[]; total: number } {
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
    const countRow = this.db.prepare(`SELECT COUNT(*) AS c FROM secret_audit_log ${where}`).get(...params) as { c: number }
    const total = countRow.c
    const page = opts.page ?? 1
    const pageSize = opts.pageSize ?? 20
    const offset = (page - 1) * pageSize
    const items = this.db.prepare(
      `SELECT * FROM secret_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, offset) as SqlRow[]
    return { items, total }
  }
}

export function openDirectConnectStore(config: ServerConfig): DirectConnectStore {
  return new DirectConnectStore(config.dbPath)
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
  return {
    type,
    engine: runtime?.engine || config.engine || 'scode',
    dockerImage: runtime?.dockerImage || config.dockerImage,
    dockerMode,
    configDir: runtime?.configDir,
    scodePath: runtime?.scodePath || config.scodePath,
    hostMode,
  }
}
