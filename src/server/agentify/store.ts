/**
 * Persistence for agentify: per-agent config, the history index (documents,
 * chunks, keyword + vector), digest progress and agent-to-agent calls.
 *
 * The documents themselves (summaries, conversations, memory, outputs) live in
 * the agent home (Nexus VFS, or a local directory without Nexus). This store
 * only holds what is needed to find them quickly and to account for calls.
 */
import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseAgentifyConfig, type AgentifyConfig } from './config.js'

type Row = Record<string, unknown>

/**
 * `artifact` = a session's output (one document per file, plus the session's
 * file list); `input` = a file an employee gave the session (uploaded or
 * pointed at). Inputs are private to that employee unless the agent shares
 * full history.
 */
export type DocKind = 'summary' | 'conversation' | 'memory' | 'a2a' | 'artifact' | 'input'
/** `shared` = any session of the agent; `private` = only the employee who produced it. */
export type DocVisibility = 'shared' | 'private'

export interface AgentRow {
  orgId: string
  agentId: string
  agentName: string
  displayName: string
  config: AgentifyConfig
  createdAt: number
  updatedAt: number
}

export interface DocInput {
  orgId: string
  agentId: string
  kind: DocKind
  /** Stable key so re-digesting a session replaces rather than duplicates. */
  docKey: string
  sessionId?: string | null
  userId?: string | null
  visibility: DocVisibility
  path: string
  title: string
  text: string
  createdAt: number
  /**
   * Last activity of what the document describes (the session's last turn,
   * the call's finish, the memory edit). Recency ranking and deletion count
   * from here. Defaults to now.
   */
  activeAt?: number
  meta?: Record<string, unknown>
}

export interface DocRow {
  id: string
  orgId: string
  agentId: string
  kind: DocKind
  docKey: string
  sessionId: string | null
  userId: string | null
  visibility: DocVisibility
  path: string
  title: string
  createdAt: number
  updatedAt: number
  activeAt: number
  meta: Record<string, unknown>
}

export interface ChunkRow {
  id: number
  docId: string
  idx: number
  text: string
}

export type A2ACallKind = 'ask' | 'task'
export type A2ACallStatus =
  | 'pending_confirmation'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

export const A2A_TERMINAL: A2ACallStatus[] = ['done', 'failed', 'rejected', 'cancelled', 'expired']

export interface A2ACall {
  id: string
  orgId: string
  kind: A2ACallKind
  callerAgentId: string
  callerSessionId: string | null
  targetAgentId: string
  capability: string
  input: string
  status: A2ACallStatus
  resultText: string | null
  resultFiles: string[]
  targetSessionId: string | null
  depth: number
  chain: string[]
  actorUserId: string | null
  requiresConfirmation: boolean
  confirmedBy: string | null
  confirmedAt: number | null
  error: string | null
  idempotencyKey: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface CronRunInfo {
  runId: string
  /** Who the run executed as (the job's executor, or whoever triggered it by hand). */
  userId: string
  startedAt: number
  jobName: string | null
  timeZone: string | null
}

export interface SessionAgentInfo {
  sessionId: string
  orgId: string
  userId: string
  assistantName: string | null
  assistantId: string | null
  a2aCallId: string | null
  a2aDepth: number
  a2aReadonly: boolean
  transcriptPath: string
  cwd: string
  status: string
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
  source: string | null
}

function n(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0)
}
function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
function sn(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}
function jsonOr<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function encodeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}
export function decodeVector(raw: unknown): Float32Array | null {
  if (!(raw instanceof Uint8Array) || raw.byteLength % 4 !== 0 || raw.byteLength === 0) return null
  const copy = new Uint8Array(raw)
  return new Float32Array(copy.buffer)
}

export class AgentifyStore {
  constructor(readonly db: DatabaseSync) {
    this.migrate()
  }

  private hasColumn(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
    return cols.some(c => c.name === column)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agentify_agents (
        org_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agentify_docs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        session_id TEXT,
        user_id TEXT,
        visibility TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        meta_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agentify_docs_key ON agentify_docs(org_id, agent_id, doc_key);
      CREATE INDEX IF NOT EXISTS idx_agentify_docs_agent ON agentify_docs(org_id, agent_id, created_at);
      CREATE TABLE IF NOT EXISTS agentify_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_agentify_chunks_doc ON agentify_chunks(doc_id);
      CREATE TABLE IF NOT EXISTS agentify_digest_state (
        session_id TEXT PRIMARY KEY,
        transcript_size INTEGER NOT NULL,
        transcript_mtime INTEGER NOT NULL,
        digested_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS a2a_calls (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        caller_agent_id TEXT NOT NULL,
        caller_session_id TEXT,
        target_agent_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        result_text TEXT,
        result_files TEXT,
        target_session_id TEXT,
        depth INTEGER NOT NULL,
        chain_json TEXT NOT NULL,
        actor_user_id TEXT,
        requires_confirmation INTEGER NOT NULL DEFAULT 0,
        confirmed_by TEXT,
        confirmed_at INTEGER,
        error TEXT,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_target ON a2a_calls(org_id, target_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_caller ON a2a_calls(org_id, caller_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_status ON a2a_calls(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_calls_idem
        ON a2a_calls(org_id, caller_agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `)
    // Keyword index. trigram handles Chinese without a segmenter; terms
    // shorter than three characters are matched with LIKE in the query layer.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS agentify_chunks_fts
        USING fts5(text, tokenize='trigram');
    `)
    // Sessions gain a stable agent id plus agent-to-agent bookkeeping.
    if (!this.hasColumn('sessions', 'assistant_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN assistant_id TEXT`)
    }
    if (!this.hasColumn('sessions', 'a2a_call_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN a2a_call_id TEXT`)
    }
    if (!this.hasColumn('sessions', 'a2a_depth')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN a2a_depth INTEGER NOT NULL DEFAULT 0`)
    }
    if (!this.hasColumn('sessions', 'a2a_readonly')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN a2a_readonly INTEGER NOT NULL DEFAULT 0`)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_assistant_id ON sessions(assistant_id)`)
    // Last activity per document (recency ranking and deletion). Documents
    // indexed before this column existed take their session's last activity.
    if (!this.hasColumn('agentify_docs', 'active_at')) {
      this.db.exec(`ALTER TABLE agentify_docs ADD COLUMN active_at INTEGER`)
      this.db.exec(`UPDATE agentify_docs SET active_at = COALESCE(
        CASE WHEN kind IN ('summary', 'conversation', 'artifact')
          THEN (SELECT s.last_active_at FROM sessions s WHERE s.session_id = agentify_docs.session_id) END,
        updated_at) WHERE active_at IS NULL`)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_agentify_docs_active ON agentify_docs(org_id, agent_id, active_at)`)
    // Which digest format produced a session's documents; older ones are redone.
    if (!this.hasColumn('agentify_digest_state', 'version')) {
      this.db.exec(`ALTER TABLE agentify_digest_state ADD COLUMN version INTEGER NOT NULL DEFAULT 1`)
    }
    // Files employees uploaded into a session workspace (they are its inputs).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agentify_uploads (
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, path)
      )
    `)
  }

  // ---------------------------------------------------------------- agents

  upsertAgent(input: { orgId: string; agentId: string; agentName: string; displayName: string; config: AgentifyConfig }): AgentRow {
    const now = Date.now()
    this.db
      .prepare(`
        INSERT INTO agentify_agents (org_id, agent_id, agent_name, display_name, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, agent_id) DO UPDATE SET
          agent_name = excluded.agent_name,
          display_name = excluded.display_name,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `)
      .run(input.orgId, input.agentId, input.agentName, input.displayName, JSON.stringify(input.config), now, now)
    return this.getAgent(input.orgId, input.agentId)!
  }

  /** Keep the cached name / display name current without touching config. */
  touchAgentNames(orgId: string, agentId: string, agentName: string, displayName: string): void {
    this.db
      .prepare(`UPDATE agentify_agents SET agent_name = ?, display_name = ? WHERE org_id = ? AND agent_id = ?
                AND (agent_name != ? OR display_name != ?)`)
      .run(agentName, displayName, orgId, agentId, agentName, displayName)
  }

  deleteAgent(orgId: string, agentId: string): boolean {
    const r = this.db.prepare(`DELETE FROM agentify_agents WHERE org_id = ? AND agent_id = ?`).run(orgId, agentId)
    return Number(r.changes) > 0
  }

  getAgent(orgId: string, agentId: string): AgentRow | null {
    const row = this.db
      .prepare(`SELECT * FROM agentify_agents WHERE org_id = ? AND agent_id = ?`)
      .get(orgId, agentId) as Row | undefined
    return row ? this.mapAgent(row) : null
  }

  listAgents(orgId: string): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agentify_agents WHERE org_id = ? ORDER BY display_name`).all(orgId) as Row[]).map(r =>
      this.mapAgent(r),
    )
  }

  listAllAgents(): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agentify_agents`).all() as Row[]).map(r => this.mapAgent(r))
  }

  private mapAgent(r: Row): AgentRow {
    let config: AgentifyConfig
    try {
      config = parseAgentifyConfig(jsonOr(r.config_json, null))
    } catch {
      // A row that no longer validates (hand-edited) is treated as disabled
      // rather than crashing every caller.
      config = { ...parseAgentifyConfig(null), enabled: false }
    }
    return {
      orgId: s(r.org_id),
      agentId: s(r.agent_id),
      agentName: s(r.agent_name),
      displayName: s(r.display_name),
      config,
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    }
  }

  // -------------------------------------------------------------- sessions

  setSessionAgent(sessionId: string, info: { assistantId: string | null; a2aCallId?: string | null; a2aDepth?: number; a2aReadonly?: boolean }): void {
    this.db
      .prepare(`UPDATE sessions SET assistant_id = ?, a2a_call_id = COALESCE(?, a2a_call_id),
                a2a_depth = COALESCE(?, a2a_depth), a2a_readonly = COALESCE(?, a2a_readonly) WHERE session_id = ?`)
      .run(
        info.assistantId,
        info.a2aCallId ?? null,
        info.a2aDepth ?? null,
        info.a2aReadonly === undefined ? null : info.a2aReadonly ? 1 : 0,
        sessionId,
      )
  }

  getSessionAgentInfo(sessionId: string): SessionAgentInfo | null {
    const r = this.db
      .prepare(`SELECT session_id, org_id, user_id, assistant_name, assistant_id, a2a_call_id, a2a_depth, a2a_readonly,
                transcript_path, cwd, status, created_at, last_active_at, ended_at, source FROM sessions WHERE session_id = ?`)
      .get(sessionId) as Row | undefined
    return r ? this.mapSessionInfo(r) : null
  }

  private mapSessionInfo(r: Row): SessionAgentInfo {
    return {
      sessionId: s(r.session_id),
      orgId: s(r.org_id),
      userId: s(r.user_id),
      assistantName: sn(r.assistant_name),
      assistantId: sn(r.assistant_id),
      a2aCallId: sn(r.a2a_call_id),
      a2aDepth: n(r.a2a_depth),
      a2aReadonly: n(r.a2a_readonly) === 1,
      transcriptPath: s(r.transcript_path),
      cwd: s(r.cwd),
      status: s(r.status),
      createdAt: n(r.created_at),
      lastActiveAt: n(r.last_active_at),
      endedAt: r.ended_at === null || r.ended_at === undefined ? null : n(r.ended_at),
      source: sn(r.source),
    }
  }

  /** Sessions still missing a stable agent id but carrying an agent name. */
  listSessionsMissingAgentId(limit = 5000): Array<{ sessionId: string; assistantName: string }> {
    return (this.db
      .prepare(`SELECT session_id, assistant_name FROM sessions
                WHERE assistant_id IS NULL AND assistant_name IS NOT NULL AND assistant_name != '' LIMIT ?`)
      .all(limit) as Row[]).map(r => ({ sessionId: s(r.session_id), assistantName: s(r.assistant_name) }))
  }

  /** Sessions of the given agents that are candidates for (re)digest. */
  listSessionsForAgents(orgId: string, agentIds: string[], sinceMs: number): SessionAgentInfo[] {
    if (agentIds.length === 0) return []
    const marks = agentIds.map(() => '?').join(',')
    return (this.db
      .prepare(`SELECT session_id, org_id, user_id, assistant_name, assistant_id, a2a_call_id, a2a_depth, a2a_readonly,
                transcript_path, cwd, status, created_at, last_active_at, ended_at, source FROM sessions
                WHERE org_id = ? AND assistant_id IN (${marks}) AND last_active_at >= ? AND deleted_at IS NULL
                ORDER BY last_active_at DESC`)
      .all(orgId, ...agentIds, sinceMs) as Row[]).map(r => this.mapSessionInfo(r))
  }

  getDigestState(sessionId: string): { size: number; mtime: number; digestedAt: number; status: string; version: number } | null {
    const r = this.db.prepare(`SELECT * FROM agentify_digest_state WHERE session_id = ?`).get(sessionId) as Row | undefined
    return r ? { size: n(r.transcript_size), mtime: n(r.transcript_mtime), digestedAt: n(r.digested_at), status: s(r.status), version: n(r.version ?? 1) } : null
  }

  setDigestState(sessionId: string, state: { size: number; mtime: number; status: 'ok' | 'error' | 'skipped'; error?: string | null; version: number }): void {
    this.db
      .prepare(`INSERT INTO agentify_digest_state (session_id, transcript_size, transcript_mtime, digested_at, status, error, version)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET transcript_size = excluded.transcript_size,
                  transcript_mtime = excluded.transcript_mtime, digested_at = excluded.digested_at,
                  status = excluded.status, error = excluded.error, version = excluded.version`)
      .run(sessionId, state.size, state.mtime, Date.now(), state.status, state.error ?? null, state.version)
  }

  recordUpload(sessionId: string, relPath: string): void {
    this.db
      .prepare(`INSERT INTO agentify_uploads (session_id, path, uploaded_at) VALUES (?, ?, ?)
                ON CONFLICT(session_id, path) DO UPDATE SET uploaded_at = excluded.uploaded_at`)
      .run(sessionId, relPath, Date.now())
  }

  deleteUploads(sessionId: string): void {
    this.db.prepare(`DELETE FROM agentify_uploads WHERE session_id = ?`).run(sessionId)
  }

  /** Files uploaded into a session; with a time range, only those uploaded within it. */
  listUploads(sessionId: string, range?: { fromMs: number; toMs: number }): string[] {
    const rows = range
      ? this.db
          .prepare(`SELECT path FROM agentify_uploads WHERE session_id = ? AND uploaded_at >= ? AND uploaded_at <= ?`)
          .all(sessionId, range.fromMs, range.toMs)
      : this.db.prepare(`SELECT path FROM agentify_uploads WHERE session_id = ?`).all(sessionId)
    return (rows as Row[]).map(r => s(r.path))
  }

  deleteUploadsBefore(sessionId: string, beforeMs: number): void {
    this.db.prepare(`DELETE FROM agentify_uploads WHERE session_id = ? AND uploaded_at < ?`).run(sessionId, beforeMs)
  }

  /**
   * Scheduled-task runs served by a session, oldest first. A job in "reuse"
   * mode sends many runs into one session; each is digested on its own.
   */
  listCronRuns(sessionId: string): CronRunInfo[] {
    try {
      return (this.db
        .prepare(`SELECT r.id, r.user_id, r.started_at, r.created_at, j.name AS job_name, j.schedule_tz
                  FROM cron_job_runs r LEFT JOIN cron_jobs j ON j.id = r.job_id
                  WHERE r.session_id = ? ORDER BY COALESCE(r.started_at, r.created_at)`)
        .all(sessionId) as Row[]).map(r => ({
        runId: s(r.id),
        userId: s(r.user_id),
        startedAt: n(r.started_at ?? r.created_at),
        jobName: sn(r.job_name),
        timeZone: sn(r.schedule_tz),
      }))
    } catch {
      // No scheduler tables (some test databases).
      return []
    }
  }

  /** Documents of one session whose key starts with `prefix` (per-file documents). */
  listSessionDocs(orgId: string, agentId: string, sessionId: string, keyPrefix: string): DocRow[] {
    return (this.db
      .prepare(`SELECT * FROM agentify_docs WHERE org_id = ? AND agent_id = ? AND session_id = ? AND doc_key LIKE ? ESCAPE '\\'`)
      .all(orgId, agentId, sessionId, `${keyPrefix.replace(/[\\%_]/g, c => `\\${c}`)}%`) as Row[]).map(r => this.mapDoc(r))
  }

  /** Mark a document active again without re-indexing it (unchanged file). */
  touchDoc(id: string, activeAt: number): void {
    this.db.prepare(`UPDATE agentify_docs SET active_at = MAX(COALESCE(active_at, 0), ?) WHERE id = ?`).run(activeAt, id)
  }

  // ------------------------------------------------------------------ docs

  /**
   * Insert or replace a document and its chunks. Embeddings are optional per
   * chunk (the embedder may be unavailable); keyword search still works.
   */
  replaceDoc(input: DocInput, chunks: Array<{ text: string; embedding: Float32Array | null }>): DocRow {
    const now = Date.now()
    const existing = this.db
      .prepare(`SELECT id, created_at FROM agentify_docs WHERE org_id = ? AND agent_id = ? AND doc_key = ?`)
      .get(input.orgId, input.agentId, input.docKey) as Row | undefined
    const id = existing ? s(existing.id) : randomUUID()
    this.db.exec('BEGIN')
    try {
      if (existing) {
        this.deleteChunks(id)
        this.db
          .prepare(`UPDATE agentify_docs SET kind = ?, session_id = ?, user_id = ?, visibility = ?, path = ?, title = ?,
                    meta_json = ?, updated_at = ?, active_at = ? WHERE id = ?`)
          .run(input.kind, input.sessionId ?? null, input.userId ?? null, input.visibility, input.path, input.title,
            JSON.stringify(input.meta ?? {}), now, input.activeAt ?? now, id)
      } else {
        this.db
          .prepare(`INSERT INTO agentify_docs (id, org_id, agent_id, kind, doc_key, session_id, user_id, visibility, path, title,
                    meta_json, created_at, updated_at, active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.orgId, input.agentId, input.kind, input.docKey, input.sessionId ?? null, input.userId ?? null,
            input.visibility, input.path, input.title, JSON.stringify(input.meta ?? {}), input.createdAt, now, input.activeAt ?? now)
      }
      const insertChunk = this.db.prepare(`INSERT INTO agentify_chunks (doc_id, idx, text, embedding) VALUES (?, ?, ?, ?)`)
      const insertFts = this.db.prepare(`INSERT INTO agentify_chunks_fts (rowid, text) VALUES (?, ?)`)
      chunks.forEach((c, idx) => {
        const r = insertChunk.run(id, idx, c.text, c.embedding ? encodeVector(c.embedding) : null)
        insertFts.run(Number(r.lastInsertRowid), c.text)
      })
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return this.getDoc(id)!
  }

  private deleteChunks(docId: string): void {
    const ids = this.db.prepare(`SELECT id FROM agentify_chunks WHERE doc_id = ?`).all(docId) as Row[]
    const delFts = this.db.prepare(`DELETE FROM agentify_chunks_fts WHERE rowid = ?`)
    for (const r of ids) delFts.run(n(r.id))
    this.db.prepare(`DELETE FROM agentify_chunks WHERE doc_id = ?`).run(docId)
  }

  deleteDoc(orgId: string, agentId: string, docKey: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM agentify_docs WHERE org_id = ? AND agent_id = ? AND doc_key = ?`)
      .get(orgId, agentId, docKey) as Row | undefined
    return row ? this.deleteDocById(s(row.id)) : false
  }

  deleteDocById(id: string): boolean {
    if (!this.db.prepare(`SELECT 1 FROM agentify_docs WHERE id = ?`).get(id)) return false
    this.db.exec('BEGIN')
    try {
      this.deleteChunks(id)
      this.db.prepare(`DELETE FROM agentify_docs WHERE id = ?`).run(id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return true
  }

  getDoc(id: string): DocRow | null {
    const r = this.db.prepare(`SELECT * FROM agentify_docs WHERE id = ?`).get(id) as Row | undefined
    return r ? this.mapDoc(r) : null
  }

  getDocByPath(orgId: string, agentId: string, docPath: string): DocRow | null {
    const r = this.db
      .prepare(`SELECT * FROM agentify_docs WHERE org_id = ? AND agent_id = ? AND path = ? ORDER BY visibility = 'private' DESC LIMIT 1`)
      .get(orgId, agentId, docPath) as Row | undefined
    return r ? this.mapDoc(r) : null
  }

  getDocByKey(orgId: string, agentId: string, docKey: string): DocRow | null {
    const r = this.db
      .prepare(`SELECT * FROM agentify_docs WHERE org_id = ? AND agent_id = ? AND doc_key = ?`)
      .get(orgId, agentId, docKey) as Row | undefined
    return r ? this.mapDoc(r) : null
  }

  listDocs(filter: { orgId: string; agentId: string; kinds?: DocKind[]; sessionId?: string; limit?: number; offset?: number }): DocRow[] {
    const where = ['org_id = ?', 'agent_id = ?']
    const args: Array<string | number> = [filter.orgId, filter.agentId]
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`)
      args.push(...filter.kinds)
    }
    if (filter.sessionId) {
      where.push('session_id = ?')
      args.push(filter.sessionId)
    }
    args.push(filter.limit ?? 50, filter.offset ?? 0)
    return (this.db
      .prepare(`SELECT * FROM agentify_docs WHERE ${where.join(' AND ')} ORDER BY active_at DESC LIMIT ? OFFSET ?`)
      .all(...args) as Row[]).map(r => this.mapDoc(r))
  }

  /** History documents (never curated memory) last active before `beforeMs`. */
  listExpiredDocs(orgId: string, agentId: string, beforeMs: number, limit = 2000): DocRow[] {
    return (this.db
      .prepare(`SELECT * FROM agentify_docs WHERE org_id = ? AND agent_id = ? AND kind != 'memory' AND active_at < ?
                ORDER BY active_at LIMIT ?`)
      .all(orgId, agentId, beforeMs, limit) as Row[]).map(r => this.mapDoc(r))
  }

  deleteDigestState(sessionId: string): void {
    this.db.prepare(`DELETE FROM agentify_digest_state WHERE session_id = ?`).run(sessionId)
  }

  /** Delete finished calls this agent answered, finished before `beforeMs`. */
  deleteFinishedCallsBefore(orgId: string, targetAgentId: string, beforeMs: number): number {
    const marks = A2A_TERMINAL.map(() => '?').join(',')
    const r = this.db
      .prepare(`DELETE FROM a2a_calls WHERE org_id = ? AND target_agent_id = ? AND status IN (${marks})
                AND COALESCE(finished_at, created_at) < ?`)
      .run(orgId, targetAgentId, ...A2A_TERMINAL, beforeMs)
    return Number(r.changes)
  }

  countDocs(orgId: string, agentId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) c FROM agentify_docs WHERE org_id = ? AND agent_id = ?`).get(orgId, agentId) as Row
    return n(r.c)
  }

  private mapDoc(r: Row): DocRow {
    return {
      id: s(r.id),
      orgId: s(r.org_id),
      agentId: s(r.agent_id),
      kind: s(r.kind) as DocKind,
      docKey: s(r.doc_key),
      sessionId: sn(r.session_id),
      userId: sn(r.user_id),
      visibility: s(r.visibility) === 'private' ? 'private' : 'shared',
      path: s(r.path),
      title: s(r.title),
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
      activeAt: r.active_at === null || r.active_at === undefined ? n(r.updated_at) : n(r.active_at),
      meta: jsonOr<Record<string, unknown>>(r.meta_json, {}),
    }
  }

  /** Keyword candidates within one agent's documents. */
  keywordCandidates(orgId: string, agentId: string, ftsQuery: string, limit: number): Array<{ chunkId: number; score: number }> {
    if (!ftsQuery) return []
    try {
      return (this.db
        .prepare(`SELECT c.id AS chunk_id, bm25(agentify_chunks_fts) AS score
                  FROM agentify_chunks_fts f
                  JOIN agentify_chunks c ON c.id = f.rowid
                  JOIN agentify_docs d ON d.id = c.doc_id
                  WHERE agentify_chunks_fts MATCH ? AND d.org_id = ? AND d.agent_id = ?
                  ORDER BY score LIMIT ?`)
        .all(ftsQuery, orgId, agentId, limit) as Row[]).map(r => ({ chunkId: n(r.chunk_id), score: n(r.score) }))
    } catch {
      // A malformed MATCH expression must not break search.
      return []
    }
  }

  /** Substring candidates for short terms trigram cannot index (1–2 chars). */
  substringCandidates(orgId: string, agentId: string, terms: string[], limit: number): Array<{ chunkId: number; hits: number }> {
    if (terms.length === 0) return []
    const hitExpr = terms.map(() => `(instr(c.text, ?) > 0)`).join(' + ')
    return (this.db
      .prepare(`SELECT c.id AS chunk_id, (${hitExpr}) AS hits FROM agentify_chunks c
                JOIN agentify_docs d ON d.id = c.doc_id
                WHERE d.org_id = ? AND d.agent_id = ? AND (${hitExpr}) > 0
                ORDER BY hits DESC, c.id DESC LIMIT ?`)
      .all(...terms, orgId, agentId, ...terms, limit) as Row[]).map(r => ({ chunkId: n(r.chunk_id), hits: n(r.hits) }))
  }

  /** All embedded chunks of an agent, for brute-force vector scoring. */
  vectorRows(orgId: string, agentId: string): Array<{ chunkId: number; embedding: Float32Array }> {
    const rows = this.db
      .prepare(`SELECT c.id AS chunk_id, c.embedding FROM agentify_chunks c JOIN agentify_docs d ON d.id = c.doc_id
                WHERE d.org_id = ? AND d.agent_id = ? AND c.embedding IS NOT NULL`)
      .all(orgId, agentId) as Row[]
    const out: Array<{ chunkId: number; embedding: Float32Array }> = []
    for (const r of rows) {
      const v = decodeVector(r.embedding)
      if (v) out.push({ chunkId: n(r.chunk_id), embedding: v })
    }
    return out
  }

  firstChunk(docId: string): string | null {
    const r = this.db.prepare(`SELECT text FROM agentify_chunks WHERE doc_id = ? ORDER BY idx LIMIT 1`).get(docId) as Row | undefined
    return r ? s(r.text) : null
  }

  getChunksWithDocs(chunkIds: number[]): Array<ChunkRow & { doc: DocRow }> {
    if (chunkIds.length === 0) return []
    const rows = this.db
      .prepare(`SELECT c.id AS chunk_id, c.doc_id, c.idx, c.text, d.* FROM agentify_chunks c JOIN agentify_docs d ON d.id = c.doc_id
                WHERE c.id IN (${chunkIds.map(() => '?').join(',')})`)
      .all(...chunkIds) as Row[]
    return rows.map(r => ({ id: n(r.chunk_id), docId: s(r.doc_id), idx: n(r.idx), text: s(r.text), doc: this.mapDoc(r) }))
  }

  // ------------------------------------------------------------- a2a calls

  createCall(input: Omit<A2ACall, 'id' | 'createdAt' | 'startedAt' | 'finishedAt' | 'resultText' | 'resultFiles' | 'targetSessionId' | 'confirmedBy' | 'confirmedAt' | 'error'>): A2ACall | null {
    const id = randomUUID()
    try {
      this.db
        .prepare(`INSERT INTO a2a_calls (id, org_id, kind, caller_agent_id, caller_session_id, target_agent_id, capability, input,
                  status, depth, chain_json, actor_user_id, requires_confirmation, idempotency_key, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.orgId, input.kind, input.callerAgentId, input.callerSessionId, input.targetAgentId, input.capability,
          input.input, input.status, input.depth, JSON.stringify(input.chain), input.actorUserId,
          input.requiresConfirmation ? 1 : 0, input.idempotencyKey, Date.now())
    } catch (err) {
      if (input.idempotencyKey && String(err).includes('UNIQUE')) return null
      throw err
    }
    return this.getCall(id)
  }

  findCallByIdempotency(orgId: string, callerAgentId: string, key: string): A2ACall | null {
    const r = this.db
      .prepare(`SELECT * FROM a2a_calls WHERE org_id = ? AND caller_agent_id = ? AND idempotency_key = ?`)
      .get(orgId, callerAgentId, key) as Row | undefined
    return r ? this.mapCall(r) : null
  }

  getCall(id: string): A2ACall | null {
    const r = this.db.prepare(`SELECT * FROM a2a_calls WHERE id = ?`).get(id) as Row | undefined
    return r ? this.mapCall(r) : null
  }

  updateCall(id: string, patch: Partial<Pick<A2ACall, 'status' | 'resultText' | 'resultFiles' | 'targetSessionId' | 'confirmedBy' | 'confirmedAt' | 'error' | 'startedAt' | 'finishedAt'>>): A2ACall | null {
    const sets: string[] = []
    const args: Array<string | number | null> = []
    const map: Record<string, string> = {
      status: 'status',
      resultText: 'result_text',
      targetSessionId: 'target_session_id',
      confirmedBy: 'confirmed_by',
      confirmedAt: 'confirmed_at',
      error: 'error',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    }
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = ?`)
        args.push((patch as Record<string, string | number | null>)[k] ?? null)
      }
    }
    if ('resultFiles' in patch) {
      sets.push('result_files = ?')
      args.push(JSON.stringify(patch.resultFiles ?? []))
    }
    if (sets.length === 0) return this.getCall(id)
    args.push(id)
    this.db.prepare(`UPDATE a2a_calls SET ${sets.join(', ')} WHERE id = ?`).run(...args)
    return this.getCall(id)
  }

  /** Move a call from one status to another only if it is still in `from`. */
  transitionCall(id: string, from: A2ACallStatus[], to: A2ACallStatus, extra: { confirmedBy?: string; error?: string } = {}): boolean {
    const r = this.db
      .prepare(`UPDATE a2a_calls SET status = ?, confirmed_by = COALESCE(?, confirmed_by),
                confirmed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE confirmed_at END,
                error = COALESCE(?, error),
                finished_at = CASE WHEN ? IN ('done','failed','rejected','cancelled','expired') THEN ? ELSE finished_at END
                WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
      .run(to, extra.confirmedBy ?? null, extra.confirmedBy ?? null, Date.now(), extra.error ?? null, to, Date.now(), id, ...from)
    return Number(r.changes) > 0
  }

  /** Atomically claim queued tasks for execution. */
  claimQueuedTasks(limit: number): A2ACall[] {
    const ids = (this.db
      .prepare(`SELECT id FROM a2a_calls WHERE status = 'queued' AND kind = 'task' ORDER BY created_at LIMIT ?`)
      .all(limit) as Row[]).map(r => s(r.id))
    const claimed: A2ACall[] = []
    for (const id of ids) {
      const r = this.db
        .prepare(`UPDATE a2a_calls SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
        .run(Date.now(), id)
      if (Number(r.changes) > 0) claimed.push(this.getCall(id)!)
    }
    return claimed
  }

  /** Calls left `running` by a previous process can never finish. */
  failOrphanedRunning(reason: string): number {
    const r = this.db
      .prepare(`UPDATE a2a_calls SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`)
      .run(reason, Date.now())
    return Number(r.changes)
  }

  expirePendingConfirmations(olderThanMs: number): number {
    const r = this.db
      .prepare(`UPDATE a2a_calls SET status = 'expired', error = 'Not confirmed in time', finished_at = ?
                WHERE status = 'pending_confirmation' AND created_at < ?`)
      .run(Date.now(), olderThanMs)
    return Number(r.changes)
  }

  countCallsSince(orgId: string, targetAgentId: string, sinceMs: number): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) c FROM a2a_calls WHERE org_id = ? AND target_agent_id = ? AND created_at >= ?
                AND status NOT IN ('rejected')`)
      .get(orgId, targetAgentId, sinceMs) as Row
    return n(r.c)
  }

  listCalls(filter: { orgId: string; agentId?: string; status?: A2ACallStatus; limit?: number }): A2ACall[] {
    const where = ['org_id = ?']
    const args: Array<string | number> = [filter.orgId]
    if (filter.agentId) {
      where.push('(caller_agent_id = ? OR target_agent_id = ?)')
      args.push(filter.agentId, filter.agentId)
    }
    if (filter.status) {
      where.push('status = ?')
      args.push(filter.status)
    }
    args.push(filter.limit ?? 100)
    return (this.db
      .prepare(`SELECT * FROM a2a_calls WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...args) as Row[]).map(r => this.mapCall(r))
  }

  private mapCall(r: Row): A2ACall {
    return {
      id: s(r.id),
      orgId: s(r.org_id),
      kind: s(r.kind) === 'task' ? 'task' : 'ask',
      callerAgentId: s(r.caller_agent_id),
      callerSessionId: sn(r.caller_session_id),
      targetAgentId: s(r.target_agent_id),
      capability: s(r.capability),
      input: s(r.input),
      status: s(r.status) as A2ACallStatus,
      resultText: sn(r.result_text),
      resultFiles: jsonOr<string[]>(r.result_files, []),
      targetSessionId: sn(r.target_session_id),
      depth: n(r.depth),
      chain: jsonOr<string[]>(r.chain_json, []),
      actorUserId: sn(r.actor_user_id),
      requiresConfirmation: n(r.requires_confirmation) === 1,
      confirmedBy: sn(r.confirmed_by),
      confirmedAt: r.confirmed_at === null || r.confirmed_at === undefined ? null : n(r.confirmed_at),
      error: sn(r.error),
      idempotencyKey: sn(r.idempotency_key),
      createdAt: n(r.created_at),
      startedAt: r.started_at === null || r.started_at === undefined ? null : n(r.started_at),
      finishedAt: r.finished_at === null || r.finished_at === undefined ? null : n(r.finished_at),
    }
  }
}
