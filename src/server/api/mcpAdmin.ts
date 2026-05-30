import type { McpStore } from '../mcp/db.js'
import type { AuthContext } from '../auth/token.js'
import type { AuthService } from '../auth/service.js'
import type { McpServerInput, McpPolicyInput, McpServerListFilter, McpAuditLogFilter, McpTemplateListFilter, McpTemplateInput } from '../mcp/types.js'
import { testMcpConnection } from '../mcp/testConnection.js'
import { validateAuthConfig } from '../mcp/authResolver.js'
import { broadcastMcpEvent } from './mcpEvents.js'

interface McpAdminDeps {
  mcpStore: McpStore
  authService: AuthService
  getUserName: (userId: string) => string | undefined
  getUserDepartmentId: (userId: string) => string | null
}

export function createMcpAdminApi(deps: McpAdminDeps) {
  const { mcpStore, authService, getUserName, getUserDepartmentId } = deps

  /**
   * dept_admin write constraint:
   * - Can only create scope=department MCP
   * - owner_id must be their own department
   * - Can only modify/delete MCPs where owner_type=department and owner_id is their department
   */
  function assertCanManageMcp(auth: AuthContext, input: { scope: string; owner_type: string; owner_id: string }, operation: string): void {
    if (auth.role === 'admin') return // admin has * scope, no restriction

    if (auth.role === 'dept_admin') {
      const deptId = getUserDepartmentId(auth.userId)
      if (input.scope === 'org') {
        throw Object.assign(new Error('部门管理员不能创建企业级 MCP'), { statusCode: 403 })
      }
      if (input.scope === 'department') {
        if (input.owner_id !== deptId) {
          throw Object.assign(new Error('部门管理员只能管理本部门的 MCP'), { statusCode: 403 })
        }
      }
      return
    }

    throw Object.assign(new Error('权限不足'), { statusCode: 403 })
  }

  function assertCanManageExistingMcp(auth: AuthContext, server: { scope: string; owner_type: string; owner_id: string }): void {
    if (auth.role === 'admin') return

    if (auth.role === 'dept_admin') {
      const deptId = getUserDepartmentId(auth.userId)
      if (server.owner_type === 'department' && server.owner_id === deptId) return
      throw Object.assign(new Error('权限不足，只能管理本部门的 MCP'), { statusCode: 403 })
    }

    throw Object.assign(new Error('权限不足'), { statusCode: 403 })
  }

  const writeAudit = (
    orgId: string,
    userId: string,
    action: string,
    mcpServerId: string | null,
    mcpServerName: string | null,
    detail?: Record<string, unknown>,
    ip?: string,
    status?: 'success' | 'error',
  ) => {
    try {
      mcpStore.insertAuditLog({
        org_id: orgId,
        mcp_server_id: mcpServerId,
        mcp_server_name: mcpServerName,
        user_id: userId,
        user_name: getUserName(userId),
        action,
        request_params_json: detail ? JSON.stringify(detail) : null,
        status: status ?? null,
        ip_address: ip,
      })
    } catch {
      // Audit log failure should not block operations
    }
  }

  function validateConfigJson(configJson: string | null): { ok: boolean; message?: string } {
    if (!configJson) return { ok: true }
    let parsed: unknown
    try { parsed = JSON.parse(configJson) } catch { return { ok: false, message: 'config_json 不是合法 JSON' } }
    if (typeof parsed !== 'object' || parsed === null) return { ok: true }
    const items = (parsed as Record<string, unknown>).user_config_items
    if (items === undefined) return { ok: true }
    if (!Array.isArray(items)) return { ok: false, message: 'user_config_items 必须是数组' }
    const keyRegex = /^[A-Za-z0-9_-]+$/
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown> | undefined
      if (!item || typeof item !== 'object') return { ok: false, message: `user_config_items[${i}] 必须是对象` }
      if (!item.name || typeof item.name !== 'string') return { ok: false, message: `user_config_items[${i}].name 必填` }
      if (!item.target || (item.target !== 'env' && item.target !== 'headers')) return { ok: false, message: `user_config_items[${i}].target 必须是 env 或 headers` }
      if (!item.key || typeof item.key !== 'string' || !keyRegex.test(item.key as string)) return { ok: false, message: `user_config_items[${i}].key 必须匹配 ${keyRegex.source}` }
    }
    return { ok: true }
  }

  const api = {
    // ==================== MCP Server CRUD ====================

    listMcpServers(auth: AuthContext, filter?: McpServerListFilter, ip?: string) {
      authService.requireScope(auth, 'admin:mcp')
      // For dept_admin, push the visibility restriction into the SQL layer so that
      // `total` reflects the post-filter count and pagination remains correct.
      const effectiveFilter: McpServerListFilter = { ...(filter ?? {}) }
      if (auth.role === 'dept_admin') {
        const deptId = getUserDepartmentId(auth.userId) ?? ''
        effectiveFilter.dept_admin_department_id = deptId
      }
      const result = mcpStore.listMcpServers(auth.orgId, effectiveFilter)
      return { success: true, data: result.items, total: result.total, page: filter?.page ?? 1, page_size: filter?.page_size ?? 20 }
    },

    getMcpServer(auth: AuthContext, id: string) {
      authService.requireScope(auth, 'admin:mcp')
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      if (auth.role === 'dept_admin') {
        assertCanManageExistingMcp(auth, server)
      }

      return { success: true, data: server }
    },

    createMcpServer(auth: AuthContext, input: McpServerInput, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      assertCanManageMcp(auth, input, 'create')

      // 必填字段校验
      if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
        const err = new Error('name 为必填字段')
        Object.assign(err, { statusCode: 400 })
        throw err
      }
      if (input.scope === 'department' && (!input.owner_id || !input.owner_id.trim())) {
        const err = new Error('部门级 MCP 必须指定所属部门')
        Object.assign(err, { statusCode: 400 })
        throw err
      }

      // Check name uniqueness
      const existing = mcpStore.getMcpServerByName(auth.orgId, input.name)
      if (existing) {
        const err = new Error('MCP 名称已存在')
        Object.assign(err, { statusCode: 409 })
        throw err
      }

      // 补全可枚举字段的默认值(与前端 wizard Select 默认值一致)
      const resolvedInput: McpServerInput = {
        scope: input.scope ?? 'org',
        owner_type: input.owner_type ?? 'system',
        mcp_type: input.mcp_type ?? 'http',
        risk_level: input.risk_level ?? 'low',
        auth_type: input.auth_type ?? 'none',
        timeout_ms: input.timeout_ms ?? 30000,
        ...input,
      }

      // Auto-fill owner_id when scope=org and owner_type=system
      if (resolvedInput.scope === 'org' && resolvedInput.owner_type === 'system' && !resolvedInput.owner_id) {
        resolvedInput.owner_id = auth.orgId
      }
      if (resolvedInput.scope === 'department' && resolvedInput.owner_type === 'department' && !resolvedInput.owner_id) {
        resolvedInput.owner_id = getUserDepartmentId(auth.userId) ?? ''
      }
      // Plan §2.2 step 5: scope=department MCPs default visible_to to {department_ids: [owner_id]}
      // so that without explicit visibility config they are scoped to their own department only.
      if (
        resolvedInput.scope === 'department'
        && resolvedInput.owner_id
        && resolvedInput.visible_to == null
      ) {
        resolvedInput.visible_to = { department_ids: [resolvedInput.owner_id] }
      }

      // 鉴权配置结构校验
      const authError = validateAuthConfig(resolvedInput.auth_type ?? 'none', resolvedInput.auth_config_json ?? null, resolvedInput.secret_ref ?? null)
      if (authError) { const err = new Error(authError); Object.assign(err, { statusCode: 400 }); throw err }

      const server = mcpStore.createMcpServer(auth.orgId, resolvedInput, auth.userId)
      writeAudit(auth.orgId, auth.userId, 'create', server.id, server.name, { name: input.name }, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true, data: server }
    },

    updateMcpServer(auth: AuthContext, id: string, input: Partial<McpServerInput>, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const existing = mcpStore.getMcpServer(auth.orgId, id)
      if (!existing) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      assertCanManageExistingMcp(auth, existing)

      // 部门级 MCP 更新时如果 owner_id 被清空则拒绝
      const effectiveScope = input.scope ?? existing.scope
      const effectiveOwnerId = input.owner_id ?? existing.owner_id
      if (effectiveScope === 'department' && (!effectiveOwnerId || !effectiveOwnerId.trim())) {
        const err = new Error('部门级 MCP 必须指定所属部门')
        Object.assign(err, { statusCode: 400 })
        throw err
      }

      // If name is being changed, check uniqueness
      if (input.name && input.name !== existing.name) {
        const nameConflict = mcpStore.getMcpServerByName(auth.orgId, input.name)
        if (nameConflict) {
          const err = new Error('MCP 名称已存在')
          Object.assign(err, { statusCode: 409 })
          throw err
        }
      }

      // 鉴权配置结构校验（仅当 auth 相关字段被更新时）
      const effectiveAuthType = input.auth_type ?? existing.auth_type
      const effectiveAuthConfigJson = input.auth_config_json !== undefined ? input.auth_config_json : existing.auth_config_json
      const effectiveSecretRef = input.secret_ref !== undefined ? input.secret_ref : existing.secret_ref
      const authError = validateAuthConfig(effectiveAuthType, effectiveAuthConfigJson ?? null, effectiveSecretRef ?? null)
      if (authError) { const err = new Error(authError); Object.assign(err, { statusCode: 400 }); throw err }

      const server = mcpStore.updateMcpServer(auth.orgId, id, input, auth.userId)

      // If allow_user_disable changed from true to false, clear all user-disabled records
      if (existing.allow_user_disable === true && input.allow_user_disable === false) {
        mcpStore.clearUserDisabledForMcpServer(auth.orgId, id)
      }

      writeAudit(auth.orgId, auth.userId, 'update', server.id, server.name, { updated_fields: Object.keys(input) }, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true, data: server }
    },

    deleteMcpServer(auth: AuthContext, id: string, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const existing = mcpStore.getMcpServer(auth.orgId, id)
      if (!existing) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      assertCanManageExistingMcp(auth, existing)

      const deleted = mcpStore.deleteMcpServer(auth.orgId, id)
      if (deleted) {
        writeAudit(auth.orgId, auth.userId, 'delete', null, existing.name, { id }, ip)
        broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      }
      return { success: true }
    },

    setMcpServerEnabled(auth: AuthContext, id: string, enabled: boolean, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const existing = mcpStore.getMcpServer(auth.orgId, id)
      if (!existing) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      assertCanManageExistingMcp(auth, existing)

      const server = mcpStore.setMcpServerEnabled(auth.orgId, id, enabled, auth.userId)
      writeAudit(auth.orgId, auth.userId, enabled ? 'enable' : 'disable', id, existing.name, undefined, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true, data: server }
    },

    async testConnection(auth: AuthContext, id: string, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      const result = await testMcpConnection(server)

      // Update status based on test result
      if (result.ok) {
        mcpStore.setMcpServerStatus(auth.orgId, id, 'enabled', auth.userId)
      } else {
        mcpStore.setMcpServerStatus(auth.orgId, id, 'error', auth.userId)
      }

      writeAudit(
        auth.orgId, auth.userId, 'test_connection', id, server.name,
        { ok: result.ok, message: result.message, latency_ms: result.latency_ms },
        ip,
        result.ok ? 'success' : 'error',
      )

      return { success: true, data: result }
    },

    // ==================== Audit Logs ====================

    getAuditLogs(auth: AuthContext, filter?: McpAuditLogFilter) {
      authService.requireScope(auth, 'admin:mcp:audit')
      const result = mcpStore.queryAuditLog(auth.orgId, filter)
      return { success: true, data: result.items, total: result.total, page: filter?.page ?? 1, page_size: filter?.page_size ?? 20 }
    },

    getServerAuditLogs(auth: AuthContext, serverId: string, filter?: Omit<McpAuditLogFilter, 'mcp_server_id'>) {
      authService.requireScope(auth, 'admin:mcp:audit')
      const server = mcpStore.getMcpServer(auth.orgId, serverId)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      const result = mcpStore.queryAuditLog(auth.orgId, { ...filter, mcp_server_id: serverId })
      return { success: true, data: result.items, total: result.total, page: filter?.page ?? 1, page_size: filter?.page_size ?? 20 }
    },

    // ==================== Policy ====================

    getMcpPolicy(auth: AuthContext) {
      const policy = mcpStore.getMcpPolicy(auth.orgId)
      const { id, org_id, created_by, updated_by, created_at, updated_at, ...rest } = policy
      return { success: true, data: rest }
    },

    updateMcpPolicy(auth: AuthContext, input: McpPolicyInput, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const policy = mcpStore.upsertMcpPolicy(auth.orgId, input, auth.userId)
      writeAudit(auth.orgId, auth.userId, 'update_policy', null, null, { updated_fields: Object.keys(input) }, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.policy.changed' })
      return { success: true, data: policy }
    },

    // ==================== Approval Requests (Phase 2) ====================

    listApprovalRequests(auth: AuthContext, status?: string) {
      authService.requireScope(auth, 'admin:mcp')
      const requests = mcpStore.listApprovalRequests(auth.orgId, status)
      return { success: true, data: requests }
    },

    approveRequest(auth: AuthContext, requestId: string, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const request = mcpStore.getMcpApprovalRequest(requestId)
      if (!request) return { success: false, error: { code: 'not_found', message: '审批请求不存在' } }
      if (request.org_id !== auth.orgId) return { success: false, error: { code: 'forbidden', message: '无权操作' } }
      if (request.status !== 'pending') return { success: false, error: { code: 'invalid_status', message: '该请求已处理' } }

      const updated = mcpStore.updateApprovalRequest(requestId, {
        status: 'approved',
        reviewed_by: auth.userId,
        reviewer_name: getUserName(auth.userId),
      })

      // Update the MCP server status to enabled
      if (updated) {
        mcpStore.setMcpServerStatus(auth.orgId, updated.mcp_server_id, 'enabled', auth.userId)
      }

      writeAudit(auth.orgId, auth.userId, 'approve_request', request.mcp_server_id, null, { request_id: requestId }, ip)
      return { success: true, data: updated }
    },

    rejectRequest(auth: AuthContext, requestId: string, reviewNote: string, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const request = mcpStore.getMcpApprovalRequest(requestId)
      if (!request) return { success: false, error: { code: 'not_found', message: '审批请求不存在' } }
      if (request.org_id !== auth.orgId) return { success: false, error: { code: 'forbidden', message: '无权操作' } }
      if (request.status !== 'pending') return { success: false, error: { code: 'invalid_status', message: '该请求已处理' } }

      const updated = mcpStore.updateApprovalRequest(requestId, {
        status: 'rejected',
        reviewed_by: auth.userId,
        reviewer_name: getUserName(auth.userId),
        review_note: reviewNote,
      })

      writeAudit(auth.orgId, auth.userId, 'reject_request', request.mcp_server_id, null, { request_id: requestId, reason: reviewNote }, ip)
      return { success: true, data: updated }
    },

    // ==================== Templates (Phase 2, §4.6 模板市场) ====================

    listTemplates(auth: AuthContext, filter?: McpTemplateListFilter) {
      authService.requireScope(auth, 'admin:mcp')
      const result = mcpStore.listTemplates(auth.orgId, filter)
      return { success: true, data: result.items, total: result.total, page: filter?.page ?? 1, page_size: filter?.page_size ?? 20 }
    },

    getTemplate(auth: AuthContext, id: string) {
      authService.requireScope(auth, 'admin:mcp')
      const template = mcpStore.getTemplate(auth.orgId, id)
      if (!template) return { success: false, error: { code: 'not_found', message: '模板不存在' } }
      return { success: true, data: template }
    },

    createTemplate(auth: AuthContext, input: McpTemplateInput, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      if (!input.name?.trim()) {
        const err = new Error('模板名称不能为空')
        Object.assign(err, { statusCode: 400 })
        throw err
      }
      if (!input.icon?.trim()) {
        const err = new Error('模板图标不能为空')
        Object.assign(err, { statusCode: 400 })
        throw err
      }
      const existing = mcpStore.getTemplateByName(auth.orgId, input.name)
      if (existing) {
        const err = new Error('模板名称已存在')
        Object.assign(err, { statusCode: 409 })
        throw err
      }
      if (input.config_json) {
        const validation = validateConfigJson(input.config_json)
        if (!validation.ok) {
          const err = new Error(validation.message!)
          Object.assign(err, { statusCode: 400 })
          throw err
        }
      }
      const template = mcpStore.createTemplate(auth.orgId, input, auth.userId)
      writeAudit(auth.orgId, auth.userId, 'create_template', template.id, template.name, undefined, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true, data: template }
    },

    updateTemplate(auth: AuthContext, id: string, input: Partial<McpTemplateInput>, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const existing = mcpStore.getTemplate(auth.orgId, id)
      if (!existing) {
        const err = new Error('模板不存在')
        Object.assign(err, { statusCode: 404 })
        throw err
      }
      if (input.name !== undefined && input.name !== existing.name) {
        const nameConflict = mcpStore.getTemplateByName(auth.orgId, input.name)
        if (nameConflict) {
          const err = new Error('模板名称已存在')
          Object.assign(err, { statusCode: 409 })
          throw err
        }
      }
      if (input.config_json !== undefined) {
        const validation = validateConfigJson(input.config_json)
        if (!validation.ok) {
          const err = new Error(validation.message!)
          Object.assign(err, { statusCode: 400 })
          throw err
        }
      }
      const template = mcpStore.updateTemplate(auth.orgId, id, input)
      writeAudit(auth.orgId, auth.userId, 'update_template', template.id, template.name, { updated_fields: Object.keys(input).filter(k => (input as Record<string, unknown>)[k] !== undefined) }, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true, data: template }
    },

    deleteTemplate(auth: AuthContext, id: string, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const existing = mcpStore.getTemplate(auth.orgId, id)
      if (!existing) {
        const err = new Error('模板不存在')
        Object.assign(err, { statusCode: 404 })
        throw err
      }
      mcpStore.deleteTemplate(auth.orgId, id)
      writeAudit(auth.orgId, auth.userId, 'delete_template', id, existing.name, undefined, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true }
    },

    installTemplate(auth: AuthContext, templateId: string, overrides?: Partial<McpServerInput>, ip?: string) {
      authService.requireScope(auth, 'admin:mcp:write')
      const template = mcpStore.getTemplate(auth.orgId, templateId)
      if (!template) return { success: false, error: { code: 'not_found', message: '模板不存在' } }

      // Build MCP server input from template
      const serverInput: McpServerInput = {
        name: overrides?.name ?? template.name,
        display_name: overrides?.display_name ?? template.name,
        description: overrides?.description ?? template.description,
        icon: overrides?.icon ?? template.icon,
        category: overrides?.category ?? template.category,
        risk_level: overrides?.risk_level ?? template.risk_level,
        scope: overrides?.scope ?? template.scope,
        owner_type: overrides?.owner_type ?? (template.scope === 'org' ? 'system' : 'department'),
        owner_id: overrides?.owner_id ?? (template.scope === 'org' ? auth.orgId : getUserDepartmentId(auth.userId) ?? ''),
        mcp_type: overrides?.mcp_type ?? template.mcp_type,
        url: overrides?.url ?? template.url,
        command: overrides?.command ?? template.command,
        args_json: overrides?.args_json ?? template.args_json,
        env_json: overrides?.env_json ?? template.env_json,
        timeout_ms: overrides?.timeout_ms ?? template.timeout_ms,
        auth_type: overrides?.auth_type ?? template.auth_type,
        template_id: templateId,
      }

      // Check name uniqueness
      const existing = mcpStore.getMcpServerByName(auth.orgId, serverInput.name)
      if (existing) {
        const err = new Error('MCP 名称已存在')
        Object.assign(err, { statusCode: 409 })
        throw err
      }

      assertCanManageMcp(auth, serverInput, 'install_template')

      // Auto-fill owner_id if still missing
      if (serverInput.scope === 'org' && serverInput.owner_type === 'system' && !serverInput.owner_id) {
        serverInput.owner_id = auth.orgId
      }

      const server = mcpStore.createMcpServer(auth.orgId, serverInput, auth.userId)

      // Increment template downloads
      mcpStore.incrementDownloads(auth.orgId, templateId)

      writeAudit(auth.orgId, auth.userId, 'create', server.id, server.name, { template_id: templateId, template_name: template.name }, ip)
      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true, data: server }
    },

    // ==================== MCP 配置解析 ====================

    async parseMcpConfig(auth: AuthContext, body: { json: string }) {
      authService.requireScope(auth, 'admin:mcp')
      const { parseMcpConfig } = await import('../mcp/mcpConfigParser.js')
      return parseMcpConfig(body.json)
    },
  }

  return api
}

export type McpAdminApi = ReturnType<typeof createMcpAdminApi>
