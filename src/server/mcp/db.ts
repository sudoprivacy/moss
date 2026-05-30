import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { McpServer, McpPolicy, McpAuditLog, McpApprovalRequest, McpTemplate, McpServerInput, McpPolicyInput, McpTemplateInput, McpServerListFilter, McpAuditLogFilter, McpTemplateListFilter } from './types.js'
import type { VisibleTo } from '../visibilityFilter.js'

type SqlRow = Record<string, unknown>

function now(): number {
  return Date.now()
}

function parseNullableJson(value: unknown): unknown {
  if (value == null || typeof value !== 'string') return null
  try { return JSON.parse(value) } catch { return null }
}

function mapMcpServer(row: SqlRow): McpServer {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    name: row.name as string,
    display_name: row.display_name as string | null,
    description: row.description as string | null,
    icon: row.icon as string | null,
    category: row.category as string | null,
    risk_level: (row.risk_level as string) as McpServer['risk_level'],
    responsible_person: row.responsible_person as string | null,
    scope: (row.scope as string) as McpServer['scope'],
    owner_type: (row.owner_type as string) as McpServer['owner_type'],
    owner_id: row.owner_id as string,
    mcp_type: (row.mcp_type as string) as McpServer['mcp_type'],
    url: row.url as string | null,
    command: row.command as string | null,
    args_json: row.args_json as string | null,
    env_json: row.env_json as string | null,
    timeout_ms: row.timeout_ms as number,
    health_check_url: row.health_check_url as string | null,
    use_proxy: Number(row.use_proxy) === 1,
    auth_type: (row.auth_type as string) as McpServer['auth_type'],
    secret_ref: row.secret_ref as string | null,
    auth_config_json: row.auth_config_json as string | null,
    visible_to: parseNullableJson(row.visible_to) as VisibleTo,
    bound_assistants: parseNullableJson(row.bound_assistants) as string[] | null,
    bound_skills: parseNullableJson(row.bound_skills) as string[] | null,
    allow_read: Number(row.allow_read) === 1,
    allow_write: Number(row.allow_write) === 1,
    require_confirmation_for_write: Number(row.require_confirmation_for_write) === 1,
    allow_read_sensitive_fields: Number(row.allow_read_sensitive_fields) === 1,
    allow_outbound_network: Number(row.allow_outbound_network) === 1,
    allow_scheduled_task: Number(row.allow_scheduled_task) === 1,
    audit_request: Number(row.audit_request) === 1,
    audit_response_summary: Number(row.audit_response_summary) === 1,
    redact_sensitive_fields: Number(row.redact_sensitive_fields) === 1,
    allow_user_disable: Number(row.allow_user_disable) === 1,
    status: (row.status as string) as McpServer['status'],
    enabled: Number(row.enabled) === 1,
    last_invocation_at: row.last_invocation_at != null ? Number(row.last_invocation_at) : null,
    template_id: row.template_id ?? null as string | null,
    created_by: row.created_by as string,
    updated_by: row.updated_by as string | null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

function mapMcpPolicy(row: SqlRow): McpPolicy {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    allow_personal_mcp: Number(row.allow_personal_mcp) === 1,
    allow_stdio_mcp: Number(row.allow_stdio_mcp) === 1,
    allow_http_sse_mcp: Number(row.allow_http_sse_mcp) === 1,
    allow_local_file_access: Number(row.allow_local_file_access) === 1,
    allow_external_network: Number(row.allow_external_network) === 1,
    domain_whitelist_json: parseNullableJson(row.domain_whitelist_json) as string[] | null,
    require_approval: Number(row.require_approval) === 1,
    allow_auto_task_call_personal_mcp: Number(row.allow_auto_task_call_personal_mcp) === 1,
    allow_enterprise_assistant_call_personal_mcp: Number(row.allow_enterprise_assistant_call_personal_mcp) === 1,
    allow_enterprise_context_in_personal_mcp: Number(row.allow_enterprise_context_in_personal_mcp) === 1,
    require_confirmation_for_high_risk: Number(row.require_confirmation_for_high_risk) === 1,
    require_confirmation_for_write: Number(row.require_confirmation_for_write) === 1,
    audit_request_params: Number(row.audit_request_params) === 1,
    audit_response_summary: Number(row.audit_response_summary) === 1,
    redact_audit_logs: Number(row.redact_audit_logs) === 1,
    limit_concurrency_and_rate: Number(row.limit_concurrency_and_rate) === 1,
    restrict_callable_models: Number(row.restrict_callable_models) === 1,
    created_by: row.created_by as string,
    updated_by: row.updated_by as string | null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

function mapMcpAuditLog(row: SqlRow): McpAuditLog {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    mcp_server_id: row.mcp_server_id as string | null,
    mcp_server_name: row.mcp_server_name as string | null,
    session_id: row.session_id as string | null,
    user_id: row.user_id as string,
    user_name: row.user_name as string | null,
    action: row.action as string,
    tool_name: row.tool_name as string | null,
    request_params_json: row.request_params_json as string | null,
    response_summary: row.response_summary as string | null,
    status: row.status as McpAuditLog['status'],
    error_message: row.error_message as string | null,
    ip_address: row.ip_address as string | null,
    created_at: Number(row.created_at),
  }
}

function mapMcpApprovalRequest(row: SqlRow): McpApprovalRequest {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    user_id: row.user_id as string,
    user_name: row.user_name as string | null,
    mcp_server_id: row.mcp_server_id as string,
    mcp_server_snapshot: row.mcp_server_snapshot as string | null,
    status: (row.status as string) as McpApprovalRequest['status'],
    reviewed_by: row.reviewed_by as string | null,
    reviewer_name: row.reviewer_name as string | null,
    review_note: row.review_note as string | null,
    reviewed_at: row.reviewed_at != null ? Number(row.reviewed_at) : null,
    created_at: Number(row.created_at),
  }
}

function mapMcpTemplate(row: SqlRow): McpTemplate {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    name: row.name as string,
    description: row.description as string | null,
    icon: row.icon as string,
    category: row.category as string | null,
    tags_json: parseNullableJson(row.tags_json) as string[] | null,
    mcp_type: (row.mcp_type as string) as McpTemplate['mcp_type'],
    url: row.url as string | null,
    command: row.command as string | null,
    args_json: row.args_json as string | null,
    env_json: row.env_json as string | null,
    timeout_ms: row.timeout_ms as number,
    auth_type: (row.auth_type as string) as McpTemplate['auth_type'],
    scope: (row.scope as string) as McpTemplate['scope'],
    risk_level: (row.risk_level as string) as McpTemplate['risk_level'],
    config_json: row.config_json as string | null,
    downloads: row.downloads as number,
    rating: row.rating as number,
    created_by: row.created_by as string,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

export class McpStore {
  constructor(private db: DatabaseSync) {}

  static ensureTables(db: DatabaseSync): void {
    const store = new McpStore(db)
    store.createTables()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        icon TEXT,
        category TEXT,
        risk_level TEXT NOT NULL DEFAULT 'low',
        responsible_person TEXT,
        scope TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        mcp_type TEXT NOT NULL,
        url TEXT,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        timeout_ms INTEGER DEFAULT 30000,
        health_check_url TEXT,
        use_proxy INTEGER DEFAULT 0,
        auth_type TEXT DEFAULT 'none',
        secret_ref TEXT,
        auth_config_json TEXT,
        visible_to TEXT,
        bound_assistants TEXT,
        bound_skills TEXT,
        allow_read INTEGER DEFAULT 1,
        allow_write INTEGER DEFAULT 1,
        require_confirmation_for_write INTEGER DEFAULT 0,
        allow_read_sensitive_fields INTEGER DEFAULT 0,
        allow_outbound_network INTEGER DEFAULT 1,
        allow_scheduled_task INTEGER DEFAULT 0,
        audit_request INTEGER DEFAULT 0,
        audit_response_summary INTEGER DEFAULT 0,
        redact_sensitive_fields INTEGER DEFAULT 0,
        allow_user_disable INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending',
        enabled INTEGER DEFAULT 1,
        last_invocation_at INTEGER,
        created_by TEXT NOT NULL,
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_org_scope ON mcp_servers(org_id, scope);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_org_status ON mcp_servers(org_id, status);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_created_by ON mcp_servers(created_by);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_org_name ON mcp_servers(org_id, name);
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_policies (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL UNIQUE,
        allow_personal_mcp INTEGER DEFAULT 0,
        allow_stdio_mcp INTEGER DEFAULT 0,
        allow_http_sse_mcp INTEGER DEFAULT 0,
        allow_local_file_access INTEGER DEFAULT 0,
        allow_external_network INTEGER DEFAULT 0,
        domain_whitelist_json TEXT,
        require_approval INTEGER DEFAULT 0,
        allow_auto_task_call_personal_mcp INTEGER DEFAULT 0,
        allow_enterprise_assistant_call_personal_mcp INTEGER DEFAULT 0,
        allow_enterprise_context_in_personal_mcp INTEGER DEFAULT 0,
        require_confirmation_for_high_risk INTEGER DEFAULT 1,
        require_confirmation_for_write INTEGER DEFAULT 1,
        audit_request_params INTEGER DEFAULT 0,
        audit_response_summary INTEGER DEFAULT 0,
        redact_audit_logs INTEGER DEFAULT 0,
        limit_concurrency_and_rate INTEGER DEFAULT 0,
        restrict_callable_models INTEGER DEFAULT 0,
        updated_by TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_audit_log (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE SET NULL,
        mcp_server_name TEXT,
        session_id TEXT,
        user_id TEXT NOT NULL,
        user_name TEXT,
        action TEXT NOT NULL,
        tool_name TEXT,
        request_params_json TEXT,
        response_summary TEXT,
        status TEXT,
        error_message TEXT,
        ip_address TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_audit_org_time ON mcp_audit_log(org_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_server ON mcp_audit_log(mcp_server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_user ON mcp_audit_log(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_action ON mcp_audit_log(action, created_at DESC);
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_approval_requests (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        mcp_server_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        reviewed_by TEXT,
        reviewer_name TEXT,
        review_note TEXT,
        reviewed_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_approval_status ON mcp_approval_requests(org_id, status);
      CREATE INDEX IF NOT EXISTS idx_mcp_approval_user ON mcp_approval_requests(user_id);
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_templates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT NOT NULL,
        category TEXT,
        tags_json TEXT,
        mcp_type TEXT NOT NULL DEFAULT 'http',
        url TEXT,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        timeout_ms INTEGER DEFAULT 30000,
        auth_type TEXT DEFAULT 'none',
        scope TEXT DEFAULT 'org',
        risk_level TEXT DEFAULT 'low',
        config_json TEXT,
        downloads INTEGER DEFAULT 0,
        rating REAL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_templates_org ON mcp_templates(org_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_templates_category ON mcp_templates(org_id, category);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_templates_org_name ON mcp_templates(org_id, name);
    `)

    // Migration: add template_id column to mcp_servers
    try { this.db.exec('ALTER TABLE mcp_servers ADD COLUMN template_id TEXT') } catch { /* column already exists */ }

    // Migration: add mcp_server_snapshot column to mcp_approval_requests
    try { this.db.exec('ALTER TABLE mcp_approval_requests ADD COLUMN mcp_server_snapshot TEXT') } catch { /* column already exists */ }

    // Per-user disable records — tracks which MCP servers each user has disabled for themselves.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_user_disabled (
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mcp_server_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, user_id, mcp_server_id)
      );
    `)
  }

  // ==================== MCP Server CRUD ====================

  listMcpServers(orgId: string, filter?: McpServerListFilter): { items: McpServer[]; total: number } {
    const conditions: string[] = ['org_id = ?']
    const params: unknown[] = [orgId]

    if (filter?.scope) {
      conditions.push('scope = ?')
      params.push(filter.scope)
    }
    if (filter?.department_id) {
      conditions.push('owner_id = ?')
      params.push(filter.department_id)
    }
    if (filter?.status && filter.status !== 'deleted') {
      switch (filter.status) {
        case 'enabled':
          conditions.push('enabled = 1 AND status = ?')
          params.push('enabled')
          break
        case 'disabled':
          conditions.push('enabled = 0')
          break
        case 'error':
          conditions.push('enabled = 1 AND status = ?')
          params.push('error')
          break
        case 'pending':
          conditions.push('enabled = 1 AND status = ?')
          params.push('pending')
          break
      }
      conditions.push("status != 'deleted'")
    } else if (filter?.status === 'deleted') {
      conditions.push("status = 'deleted'")
    } else {
      conditions.push("status != 'deleted'")
    }
    if (filter?.risk_level) {
      conditions.push('risk_level = ?')
      params.push(filter.risk_level)
    }
    if (filter?.mcp_type) {
      conditions.push('mcp_type = ?')
      params.push(filter.mcp_type)
    }
    if (filter?.audit_enabled === true) {
      conditions.push('(audit_request = 1 OR audit_response_summary = 1)')
    } else if (filter?.audit_enabled === false) {
      conditions.push('audit_request = 0 AND audit_response_summary = 0')
    }
    if (filter?.bound_assistant) {
      conditions.push('bound_assistants LIKE ?')
      params.push(`%"${filter.bound_assistant}"%`)
    }
    if (filter?.created_by) {
      conditions.push('created_by = ?')
      params.push(filter.created_by)
    }
    if (filter?.dept_admin_department_id) {
      // dept_admin sees org-scope MCPs and their own department's MCPs only.
      conditions.push("(scope = 'org' OR (scope = 'department' AND owner_id = ?))")
      params.push(filter.dept_admin_department_id)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM mcp_servers ${where}`
    ).get(...params) as { c: number }
    const total = countRow.c

    const page = filter?.page ?? 1
    const pageSize = filter?.page_size ?? 20
    const offset = (page - 1) * pageSize

    const rows = this.db.prepare(
      `SELECT * FROM mcp_servers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset) as SqlRow[]

    return { items: rows.map(mapMcpServer), total }
  }

  getMcpServer(orgId: string, id: string): McpServer | null {
    const row = this.db.prepare(
      "SELECT * FROM mcp_servers WHERE org_id = ? AND id = ? AND status != 'deleted'"
    ).get(orgId, id) as SqlRow | undefined
    return row ? mapMcpServer(row) : null
  }

  getMcpServerByName(orgId: string, name: string): McpServer | null {
    const row = this.db.prepare(
      "SELECT * FROM mcp_servers WHERE org_id = ? AND name = ? AND status != 'deleted'"
    ).get(orgId, name) as SqlRow | undefined
    return row ? mapMcpServer(row) : null
  }

  getTemplateByName(orgId: string, name: string): McpTemplate | null {
    const row = this.db.prepare('SELECT * FROM mcp_templates WHERE org_id = ? AND name = ?').get(orgId, name) as SqlRow | undefined
    return row ? mapMcpTemplate(row) : null
  }

  createMcpServer(orgId: string, input: McpServerInput, createdBy: string): McpServer {
    const ts = now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO mcp_servers (
        id, org_id, name, display_name, description, icon, category, risk_level, responsible_person,
        scope, owner_type, owner_id,
        mcp_type, url, command, args_json, env_json, timeout_ms, health_check_url, use_proxy,
        auth_type, secret_ref, auth_config_json,
        visible_to, bound_assistants, bound_skills,
        allow_read, allow_write, require_confirmation_for_write, allow_read_sensitive_fields,
        allow_outbound_network, allow_scheduled_task, audit_request, audit_response_summary,
        redact_sensitive_fields, allow_user_disable,
        status, enabled,
        template_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, 1,
        ?,
        ?, NULL, ?, ?
      )
    `).run(
      id, orgId, input.name, input.display_name ?? null, input.description ?? null,
      input.icon ?? null, input.category ?? null, input.risk_level ?? 'low', input.responsible_person ?? null,
      input.scope, input.owner_type, input.owner_id,
      input.mcp_type, input.url ?? null, input.command ?? null, input.args_json ?? null,
      input.env_json ?? null, input.timeout_ms ?? 30000, input.health_check_url ?? null,
      input.use_proxy ? 1 : 0,
      input.auth_type ?? 'none', input.secret_ref ?? null, input.auth_config_json ?? null,
      input.visible_to != null ? JSON.stringify(input.visible_to) : null,
      input.bound_assistants ? JSON.stringify(input.bound_assistants) : null,
      input.bound_skills ? JSON.stringify(input.bound_skills) : null,
      input.allow_read !== false ? 1 : 0,
      input.allow_write !== false ? 1 : 0,
      input.require_confirmation_for_write ? 1 : 0,
      input.allow_read_sensitive_fields ? 1 : 0,
      input.allow_outbound_network !== false ? 1 : 0,
      input.allow_scheduled_task ? 1 : 0,
      input.audit_request ? 1 : 0,
      input.audit_response_summary ? 1 : 0,
      input.redact_sensitive_fields ? 1 : 0,
      input.allow_user_disable !== false ? 1 : 0,
      'pending',
      input.template_id ?? null,
      createdBy, ts, ts,
    )
    return this.getMcpServer(orgId, id)!
  }

  updateMcpServer(orgId: string, id: string, input: Partial<McpServerInput>, updatedBy: string): McpServer {
    const existing = this.getMcpServer(orgId, id)
    if (!existing) throw new Error('MCP server not found')

    const sets: string[] = []
    const params: unknown[] = []

    const setIfDefined = (col: string, val: unknown) => {
      if (val !== undefined) { sets.push(`${col} = ?`); params.push(val) }
    }

    setIfDefined('name', input.name)
    setIfDefined('display_name', input.display_name)
    setIfDefined('description', input.description)
    setIfDefined('icon', input.icon)
    setIfDefined('category', input.category)
    setIfDefined('risk_level', input.risk_level)
    setIfDefined('responsible_person', input.responsible_person)
    setIfDefined('scope', input.scope)
    setIfDefined('owner_type', input.owner_type)
    setIfDefined('owner_id', input.owner_id)
    setIfDefined('mcp_type', input.mcp_type)
    setIfDefined('url', input.url)
    setIfDefined('command', input.command)
    setIfDefined('args_json', input.args_json)
    setIfDefined('env_json', input.env_json)
    setIfDefined('timeout_ms', input.timeout_ms)
    setIfDefined('health_check_url', input.health_check_url)
    if (input.use_proxy !== undefined) { sets.push('use_proxy = ?'); params.push(input.use_proxy ? 1 : 0) }
    setIfDefined('auth_type', input.auth_type)
    setIfDefined('secret_ref', input.secret_ref)
    setIfDefined('auth_config_json', input.auth_config_json)
    if (input.visible_to !== undefined) { sets.push('visible_to = ?'); params.push(JSON.stringify(input.visible_to)) }
    if (input.bound_assistants !== undefined) { sets.push('bound_assistants = ?'); params.push(JSON.stringify(input.bound_assistants)) }
    if (input.bound_skills !== undefined) { sets.push('bound_skills = ?'); params.push(JSON.stringify(input.bound_skills)) }
    if (input.allow_read !== undefined) { sets.push('allow_read = ?'); params.push(input.allow_read ? 1 : 0) }
    if (input.allow_write !== undefined) { sets.push('allow_write = ?'); params.push(input.allow_write ? 1 : 0) }
    if (input.require_confirmation_for_write !== undefined) { sets.push('require_confirmation_for_write = ?'); params.push(input.require_confirmation_for_write ? 1 : 0) }
    if (input.allow_read_sensitive_fields !== undefined) { sets.push('allow_read_sensitive_fields = ?'); params.push(input.allow_read_sensitive_fields ? 1 : 0) }
    if (input.allow_outbound_network !== undefined) { sets.push('allow_outbound_network = ?'); params.push(input.allow_outbound_network ? 1 : 0) }
    if (input.allow_scheduled_task !== undefined) { sets.push('allow_scheduled_task = ?'); params.push(input.allow_scheduled_task ? 1 : 0) }
    if (input.audit_request !== undefined) { sets.push('audit_request = ?'); params.push(input.audit_request ? 1 : 0) }
    if (input.audit_response_summary !== undefined) { sets.push('audit_response_summary = ?'); params.push(input.audit_response_summary ? 1 : 0) }
    if (input.redact_sensitive_fields !== undefined) { sets.push('redact_sensitive_fields = ?'); params.push(input.redact_sensitive_fields ? 1 : 0) }
    if (input.allow_user_disable !== undefined) { sets.push('allow_user_disable = ?'); params.push(input.allow_user_disable ? 1 : 0) }

    sets.push('updated_by = ?')
    params.push(updatedBy)
    sets.push('updated_at = ?')
    params.push(now())

    params.push(orgId, id)

    this.db.prepare(
      `UPDATE mcp_servers SET ${sets.join(', ')} WHERE org_id = ? AND id = ?`
    ).run(...params)

    return this.getMcpServer(orgId, id)!
  }

  deleteMcpServer(orgId: string, id: string): boolean {
    const ts = now()
    const result = this.db.prepare(
      "UPDATE mcp_servers SET status = 'deleted', name = name || '__deleted_' || ?, enabled = 0, updated_at = ? WHERE org_id = ? AND id = ? AND status != 'deleted'"
    ).run(String(ts), ts, orgId, id)
    return result.changes > 0
  }

  restoreMcpServer(orgId: string, id: string, newName: string): McpServer | null {
    const ts = now()
    const result = this.db.prepare(
      "UPDATE mcp_servers SET status = 'pending', name = ?, enabled = 1, updated_at = ? WHERE org_id = ? AND id = ? AND status = 'deleted'"
    ).run(newName, ts, orgId, id)
    if (result.changes === 0) return null
    return this.getMcpServer(orgId, id)
  }

  setMcpServerEnabled(orgId: string, id: string, enabled: boolean, updatedBy: string): McpServer | null {
    const ts = now()
    this.db.prepare(
      'UPDATE mcp_servers SET enabled = ?, updated_by = ?, updated_at = ? WHERE org_id = ? AND id = ?'
    ).run(enabled ? 1 : 0, updatedBy, ts, orgId, id)
    return this.getMcpServer(orgId, id)
  }

  setMcpServerStatus(orgId: string, id: string, status: string, updatedBy: string | null): void {
    const ts = now()
    const sets = ['status = ?', 'updated_at = ?']
    const params: unknown[] = [status, ts]
    if (updatedBy) { sets.push('updated_by = ?'); params.push(updatedBy) }
    params.push(orgId, id)
    this.db.prepare(
      `UPDATE mcp_servers SET ${sets.join(', ')} WHERE org_id = ? AND id = ?`
    ).run(...params)
  }

  /**
   * Get MCP servers visible to a user (for /me endpoint).
   * Filters per plan §2.2:
   *   - scope='org': all enabled
   *   - scope='department': all enabled (further filtered by isVisibleTo at caller)
   *   - scope='user': only those whose owner_id = userId
   */
  listVisibleMcpServers(orgId: string, userId: string, userDepartmentId: string | null, scope?: 'org' | 'department' | 'user'): McpServer[] {
    const conditions: string[] = ['org_id = ?', 'enabled = 1']
    const params: unknown[] = [orgId]

    if (scope) {
      conditions.push('scope = ?')
      params.push(scope)
      if (scope === 'user') {
        conditions.push('owner_id = ?')
        params.push(userId)
      }
    } else {
      // No scope filter: exclude other users' personal MCPs.
      conditions.push("(scope != 'user' OR owner_id = ?)")
      params.push(userId)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const rows = this.db.prepare(
      `SELECT * FROM mcp_servers ${where} ORDER BY created_at DESC`
    ).all(...params) as SqlRow[]

    return rows.map(mapMcpServer)
  }

  hasUserInstalledTemplate(orgId: string, userId: string, templateId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM mcp_servers WHERE org_id = ? AND template_id = ? AND owner_id = ? AND scope = 'user' AND status != 'deleted' LIMIT 1"
    ).get(orgId, templateId, userId) as SqlRow | undefined
    return !!row
  }

  // ==================== MCP Policy CRUD ====================

  getMcpPolicy(orgId: string): McpPolicy {
    const row = this.db.prepare(
      'SELECT * FROM mcp_policies WHERE org_id = ?'
    ).get(orgId) as SqlRow | undefined

    if (row) return mapMcpPolicy(row)

    // Return default policy
    return {
      id: '',
      org_id: orgId,
      allow_personal_mcp: false,
      allow_stdio_mcp: false,
      allow_http_sse_mcp: false,
      allow_local_file_access: false,
      allow_external_network: false,
      domain_whitelist_json: null,
      require_approval: false,
      allow_auto_task_call_personal_mcp: false,
      allow_enterprise_assistant_call_personal_mcp: false,
      allow_enterprise_context_in_personal_mcp: false,
      require_confirmation_for_high_risk: true,
      require_confirmation_for_write: true,
      audit_request_params: false,
      audit_response_summary: false,
      redact_audit_logs: false,
      limit_concurrency_and_rate: false,
      restrict_callable_models: false,
      created_by: '',
      updated_by: null,
      created_at: 0,
      updated_at: 0,
    }
  }

  upsertMcpPolicy(orgId: string, input: McpPolicyInput, updatedBy: string): McpPolicy {
    const existing = this.db.prepare(
      'SELECT id FROM mcp_policies WHERE org_id = ?'
    ).get(orgId) as SqlRow | undefined

    const ts = now()

    if (existing) {
      const sets: string[] = []
      const params: unknown[] = []

      const setIfDefined = (col: string, val: boolean | undefined) => {
        if (val !== undefined) { sets.push(`${col} = ?`); params.push(val ? 1 : 0) }
      }

      setIfDefined('allow_personal_mcp', input.allow_personal_mcp)
      setIfDefined('allow_stdio_mcp', input.allow_stdio_mcp)
      setIfDefined('allow_http_sse_mcp', input.allow_http_sse_mcp)
      setIfDefined('allow_local_file_access', input.allow_local_file_access)
      setIfDefined('allow_external_network', input.allow_external_network)
      if (input.domain_whitelist_json !== undefined) { sets.push('domain_whitelist_json = ?'); params.push(input.domain_whitelist_json ? JSON.stringify(input.domain_whitelist_json) : null) }
      setIfDefined('require_approval', input.require_approval)
      setIfDefined('allow_auto_task_call_personal_mcp', input.allow_auto_task_call_personal_mcp)
      setIfDefined('allow_enterprise_assistant_call_personal_mcp', input.allow_enterprise_assistant_call_personal_mcp)
      setIfDefined('allow_enterprise_context_in_personal_mcp', input.allow_enterprise_context_in_personal_mcp)
      setIfDefined('require_confirmation_for_high_risk', input.require_confirmation_for_high_risk)
      setIfDefined('require_confirmation_for_write', input.require_confirmation_for_write)
      setIfDefined('audit_request_params', input.audit_request_params)
      setIfDefined('audit_response_summary', input.audit_response_summary)
      setIfDefined('redact_audit_logs', input.redact_audit_logs)
      setIfDefined('limit_concurrency_and_rate', input.limit_concurrency_and_rate)
      setIfDefined('restrict_callable_models', input.restrict_callable_models)

      sets.push('updated_by = ?')
      params.push(updatedBy)
      sets.push('updated_at = ?')
      params.push(ts)
      params.push(orgId)

      this.db.prepare(
        `UPDATE mcp_policies SET ${sets.join(', ')} WHERE org_id = ?`
      ).run(...params)
    } else {
      const id = randomUUID()
      const defaults = this.getMcpPolicy(orgId)
      this.db.prepare(`
        INSERT INTO mcp_policies (
          id, org_id,
          allow_personal_mcp, allow_stdio_mcp, allow_http_sse_mcp, allow_local_file_access,
          allow_external_network, domain_whitelist_json, require_approval,
          allow_auto_task_call_personal_mcp, allow_enterprise_assistant_call_personal_mcp,
          allow_enterprise_context_in_personal_mcp,
          require_confirmation_for_high_risk, require_confirmation_for_write,
          audit_request_params, audit_response_summary, redact_audit_logs,
          limit_concurrency_and_rate, restrict_callable_models,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?,
          ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?
        )
      `).run(
        id, orgId,
        (input.allow_personal_mcp ?? defaults.allow_personal_mcp) ? 1 : 0,
        (input.allow_stdio_mcp ?? defaults.allow_stdio_mcp) ? 1 : 0,
        (input.allow_http_sse_mcp ?? defaults.allow_http_sse_mcp) ? 1 : 0,
        (input.allow_local_file_access ?? defaults.allow_local_file_access) ? 1 : 0,
        (input.allow_external_network ?? defaults.allow_external_network) ? 1 : 0,
        input.domain_whitelist_json !== undefined
          ? (input.domain_whitelist_json ? JSON.stringify(input.domain_whitelist_json) : null)
          : (defaults.domain_whitelist_json ? JSON.stringify(defaults.domain_whitelist_json) : null),
        (input.require_approval ?? defaults.require_approval) ? 1 : 0,
        (input.allow_auto_task_call_personal_mcp ?? defaults.allow_auto_task_call_personal_mcp) ? 1 : 0,
        (input.allow_enterprise_assistant_call_personal_mcp ?? defaults.allow_enterprise_assistant_call_personal_mcp) ? 1 : 0,
        (input.allow_enterprise_context_in_personal_mcp ?? defaults.allow_enterprise_context_in_personal_mcp) ? 1 : 0,
        (input.require_confirmation_for_high_risk ?? defaults.require_confirmation_for_high_risk) ? 1 : 0,
        (input.require_confirmation_for_write ?? defaults.require_confirmation_for_write) ? 1 : 0,
        (input.audit_request_params ?? defaults.audit_request_params) ? 1 : 0,
        (input.audit_response_summary ?? defaults.audit_response_summary) ? 1 : 0,
        (input.redact_audit_logs ?? defaults.redact_audit_logs) ? 1 : 0,
        (input.limit_concurrency_and_rate ?? defaults.limit_concurrency_and_rate) ? 1 : 0,
        (input.restrict_callable_models ?? defaults.restrict_callable_models) ? 1 : 0,
        updatedBy, updatedBy, ts, ts,
      )
    }

    return this.getMcpPolicy(orgId)
  }

  // ==================== MCP Audit Log ====================

  insertAuditLog(entry: {
    org_id: string
    mcp_server_id: string | null
    mcp_server_name: string | null
    session_id?: string | null
    user_id: string
    user_name?: string | null
    action: string
    tool_name?: string | null
    request_params_json?: string | null
    response_summary?: string | null
    status?: string | null
    error_message?: string | null
    ip_address?: string | null
  }): void {
    const ts = now()
    this.db.prepare(`
      INSERT INTO mcp_audit_log (
        id, org_id, mcp_server_id, mcp_server_name, session_id,
        user_id, user_name, action, tool_name,
        request_params_json, response_summary, status, error_message,
        ip_address, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), entry.org_id, entry.mcp_server_id, entry.mcp_server_name,
      entry.session_id ?? null, entry.user_id, entry.user_name ?? null,
      entry.action, entry.tool_name ?? null, entry.request_params_json ?? null,
      entry.response_summary ?? null, entry.status ?? null, entry.error_message ?? null,
      entry.ip_address ?? null, ts,
    )
  }

  queryAuditLog(orgId: string, filter?: McpAuditLogFilter): { items: McpAuditLog[]; total: number } {
    const conditions: string[] = ['org_id = ?']
    const params: unknown[] = [orgId]

    if (filter?.mcp_server_id) {
      conditions.push('mcp_server_id = ?')
      params.push(filter.mcp_server_id)
    }
    if (filter?.mcp_server_name) {
      conditions.push('mcp_server_name = ?')
      params.push(filter.mcp_server_name)
    }
    if (filter?.user_id) {
      conditions.push('user_id = ?')
      params.push(filter.user_id)
    }
    if (filter?.action) {
      conditions.push('action = ?')
      params.push(filter.action)
    }
    if (filter?.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.since) {
      conditions.push('created_at >= ?')
      params.push(filter.since)
    }
    if (filter?.until) {
      conditions.push('created_at <= ?')
      params.push(filter.until)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM mcp_audit_log ${where}`
    ).get(...params) as { c: number }
    const total = countRow.c

    const page = filter?.page ?? 1
    const pageSize = filter?.page_size ?? 20
    const offset = (page - 1) * pageSize

    const rows = this.db.prepare(
      `SELECT * FROM mcp_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset) as SqlRow[]

    return { items: rows.map(mapMcpAuditLog), total }
  }

  // ==================== MCP Approval Requests (Phase 2) ====================

  createApprovalRequest(entry: {
    org_id: string
    user_id: string
    user_name?: string | null
    mcp_server_id: string
    mcp_server_snapshot?: string | null
  }): McpApprovalRequest {
    const ts = now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO mcp_approval_requests (id, org_id, user_id, user_name, mcp_server_id, mcp_server_snapshot, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, entry.org_id, entry.user_id, entry.user_name ?? null, entry.mcp_server_id, entry.mcp_server_snapshot ?? null, ts)
    return this.getMcpApprovalRequest(id)!
  }

  getMcpApprovalRequest(id: string): McpApprovalRequest | null {
    const row = this.db.prepare(
      'SELECT * FROM mcp_approval_requests WHERE id = ?'
    ).get(id) as SqlRow | undefined
    return row ? mapMcpApprovalRequest(row) : null
  }

  listApprovalRequests(orgId: string, status?: string): McpApprovalRequest[] {
    if (status) {
      const rows = this.db.prepare(
        'SELECT * FROM mcp_approval_requests WHERE org_id = ? AND status = ? ORDER BY created_at DESC'
      ).all(orgId, status) as SqlRow[]
      return rows.map(mapMcpApprovalRequest)
    }
    const rows = this.db.prepare(
      'SELECT * FROM mcp_approval_requests WHERE org_id = ? ORDER BY created_at DESC'
    ).all(orgId) as SqlRow[]
    return rows.map(mapMcpApprovalRequest)
  }

  updateApprovalRequest(id: string, update: {
    status: 'approved' | 'rejected'
    reviewed_by: string
    reviewer_name?: string | null
    review_note?: string | null
  }): McpApprovalRequest | null {
    this.db.prepare(`
      UPDATE mcp_approval_requests
      SET status = ?, reviewed_by = ?, reviewer_name = ?, review_note = ?, reviewed_at = ?
      WHERE id = ?
    `).run(update.status, update.reviewed_by, update.reviewer_name ?? null, update.review_note ?? null, now(), id)
    return this.getMcpApprovalRequest(id)
  }

  // ==================== MCP Templates (Phase 2, §4.6 模板市场) ====================

  listTemplates(orgId: string, filter?: McpTemplateListFilter): { items: McpTemplate[]; total: number } {
    const conditions: string[] = ['org_id = ?']
    const params: unknown[] = [orgId]

    if (filter?.category) {
      conditions.push('category = ?')
      params.push(filter.category)
    }
    if (filter?.search) {
      conditions.push('(name LIKE ? OR description LIKE ?)')
      const term = `%${filter.search}%`
      params.push(term, term)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM mcp_templates ${where}`
    ).get(...params) as { c: number }
    const total = countRow.c

    const page = filter?.page ?? 1
    const pageSize = filter?.page_size ?? 20
    const offset = (page - 1) * pageSize

    const rows = this.db.prepare(
      `SELECT * FROM mcp_templates ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset) as SqlRow[]

    return { items: rows.map(mapMcpTemplate), total }
  }

  getTemplate(orgId: string, id: string): McpTemplate | null {
    const row = this.db.prepare(
      'SELECT * FROM mcp_templates WHERE org_id = ? AND id = ?'
    ).get(orgId, id) as SqlRow | undefined
    return row ? mapMcpTemplate(row) : null
  }

  createTemplate(orgId: string, input: McpTemplateInput, createdBy: string): McpTemplate {
    const ts = now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO mcp_templates (
        id, org_id, name, description, icon, category, tags_json,
        mcp_type, url, command, args_json, env_json, timeout_ms, auth_type,
        scope, risk_level, config_json,
        created_by, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      id, orgId, input.name, input.description ?? null,
      input.icon ?? null, input.category ?? null,
      input.tags_json ? JSON.stringify(input.tags_json) : null,
      input.mcp_type, input.url ?? null, input.command ?? null,
      input.args_json ?? null, input.env_json ?? null, input.timeout_ms ?? 30000,
      input.auth_type ?? 'none',
      input.scope ?? 'org', input.risk_level ?? 'low',
      input.config_json ?? null,
      createdBy, ts, ts,
    )
    return this.getTemplate(orgId, id)!
  }

  deleteTemplate(orgId: string, id: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM mcp_templates WHERE org_id = ? AND id = ?'
    ).run(orgId, id)
    return result.changes > 0
  }

  updateTemplate(orgId: string, id: string, input: Partial<McpTemplateInput>): McpTemplate {
    const existing = this.getTemplate(orgId, id)
    if (!existing) throw new Error('Template not found')

    const sets: string[] = []
    const params: unknown[] = []

    const setIfDefined = (col: string, val: unknown) => {
      if (val !== undefined) { sets.push(`${col} = ?`); params.push(val) }
    }

    setIfDefined('name', input.name)
    setIfDefined('description', input.description)
    setIfDefined('icon', input.icon)
    setIfDefined('category', input.category)
    if (input.tags_json !== undefined) { sets.push('tags_json = ?'); params.push(input.tags_json ? JSON.stringify(input.tags_json) : null) }
    setIfDefined('mcp_type', input.mcp_type)
    setIfDefined('url', input.url)
    setIfDefined('command', input.command)
    setIfDefined('args_json', input.args_json)
    setIfDefined('env_json', input.env_json)
    setIfDefined('timeout_ms', input.timeout_ms)
    setIfDefined('auth_type', input.auth_type)
    setIfDefined('scope', input.scope)
    setIfDefined('risk_level', input.risk_level)
    setIfDefined('config_json', input.config_json)

    sets.push('updated_at = ?')
    params.push(now())

    params.push(orgId, id)

    this.db.prepare(
      `UPDATE mcp_templates SET ${sets.join(', ')} WHERE org_id = ? AND id = ?`
    ).run(...params)

    return this.getTemplate(orgId, id)!
  }

  incrementDownloads(orgId: string, id: string): void {
    this.db.prepare(
      'UPDATE mcp_templates SET downloads = downloads + 1 WHERE org_id = ? AND id = ?'
    ).run(orgId, id)
  }

  // ==================== Per-User Disable ====================

  /** User disables an MCP for themselves (idempotent, INSERT OR IGNORE). */
  addUserDisabledMcp(orgId: string, userId: string, mcpServerId: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO mcp_user_disabled (org_id, user_id, mcp_server_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(orgId, userId, mcpServerId, Date.now())
  }

  /** User re-enables an MCP for themselves (deletes the disable record). */
  removeUserDisabledMcp(orgId: string, userId: string, mcpServerId: string): void {
    this.db.prepare(
      `DELETE FROM mcp_user_disabled WHERE org_id = ? AND user_id = ? AND mcp_server_id = ?`,
    ).run(orgId, userId, mcpServerId)
  }

  /** Get all MCP server IDs that the user has disabled. */
  getUserDisabledMcpIds(orgId: string, userId: string): string[] {
    const rows = this.db.prepare(
      `SELECT mcp_server_id FROM mcp_user_disabled WHERE org_id = ? AND user_id = ?`,
    ).all(orgId, userId) as SqlRow[]
    return rows.map(r => r.mcp_server_id as string)
  }

  /** Clear all user-disabled records for a specific MCP server (used when admin toggles allow_user_disable). */
  clearUserDisabledForMcpServer(orgId: string, mcpServerId: string): void {
    this.db.prepare(
      `DELETE FROM mcp_user_disabled WHERE org_id = ? AND mcp_server_id = ?`,
    ).run(orgId, mcpServerId)
  }
}
