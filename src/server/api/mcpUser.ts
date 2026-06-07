import { randomBytes } from 'crypto'
import type { McpStore } from '../mcp/db.js'
import type { AuthContext } from '../auth/token.js'
import type { McpServer, McpServerInput, McpTemplate, McpTemplateListFilter } from '../mcp/types.js'
import { extractAuthUserItems, convertTemplateAuthToServerAuth, validateRequiredCredentials } from '../mcp/templateAuthConverter.js'
import { isVisibleTo, buildVisibilityFilter } from '../visibilityFilter.js'
import type { AuthService } from '../auth/service.js'
import type { NexusClient } from '../nexus/nexusClient.js'
import { testMcpConnection } from '../mcp/testConnection.js'
import { broadcastMcpEvent } from './mcpEvents.js'
import { parseMcpConfig } from '../mcp/mcpConfigParser.js'

/** Default icon for personal MCP installed via JSON API */
const DEFAULT_MCP_ICON = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzgwMTA2MjI4MzE4IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjMwNzkiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTk2NS41NDc1MiA3NTcuMzMzMzMzYTUxLjIgNTEuMiAwIDAgMSA1MS4xMTQ2NjcgNTEuMzcwNjY3djE2My44NGE1MS4yIDUxLjIgMCAwIDEtNTEuMTE0NjY3IDUxLjQ1Nkg1MS4wMzAxODdBNTEuMiA1MS4yIDAgMCAxIDAuMDAwODUzIDk3Mi41NDR2LTE2My44NGE1MS4yIDUxLjIgMCAwIDEgNTEuMDI5MzM0LTUxLjM3MDY2NyA1MS4yIDUxLjIgMCAwIDEgNTEuMTE0NjY2IDUxLjM3MDY2N3YxMTIuNDY5MzMzaDgxMi4zNzMzMzRWODA4LjcwNGMwLTI4LjMzMDY2NyAyMi44NjkzMzMtNTEuMzcwNjY3IDUxLjAyOTMzMy01MS4zNzA2Njd6TTYxOS4wOTQxODcgMzU5LjI1MzMzM2MxOC40MzIgMS4xOTQ2NjcgMzQuOTAxMzMzIDQuMjY2NjY3IDQ5LjE1MiA5LjM4NjY2NyA5LjcyOCAzLjQxMzMzMyAxOC45NDQgNy41OTQ2NjcgMjcuNzMzMzMzIDEyLjQ1ODY2NyAxNy4wNjY2NjcgOS42NDI2NjcgMTkuNzEyIDMwLjgwNTMzMyAxMC4wNjkzMzMgNDUuOTA5MzMzYTQwLjk2IDQwLjk2IDAgMCAxLTI3LjY0OCAxNy41Nzg2NjcgNjUuMTk0NjY3IDY1LjE5NDY2NyAwIDAgMS0zMy4wMjQtMi44MTZsLTAuNTk3MzMzLTAuMjU2YTExNC4xNzYgMTE0LjE3NiAwIDAgMC0yOS4zNTQ2NjctNS44MDI2NjdMNjA0LjUwMjE4NyA0MzUuMmMtMTEuNTIgMC0yMS45MzA2NjcgMS4yOC0zMS40ODggMy43NTQ2NjdsLTkuMTMwNjY3IDIuODE2YTc3LjE0MTMzMyA3Ny4xNDEzMzMgMCAwIDAtNDQuOCAzOC44MjY2NjZsLTMuNzU0NjY3IDguMTkyYTEwMC42OTMzMzMgMTAwLjY5MzMzMyAwIDAgMC02LjA1ODY2NiAyNy45ODkzMzRsLTAuNDI2NjY3IDEwLjU4MTMzM2MwIDE5Ljg4MjY2NyA0LjAxMDY2NyAzNi41MjI2NjcgMTEuNjA1MzMzIDUwLjA5MDY2N2E3OC41MDY2NjcgNzguNTA2NjY3IDAgMCAwIDMzLjEwOTMzNCAzMC45NzZjMTQuNTA2NjY3IDcuMzM4NjY3IDMyIDExLjA5MzMzMyA1Mi43MzYgMTEuMDkzMzMzIDE0LjMzNiAwIDI4LjQxNi0yLjA0OCA0Mi4wNjkzMzMtNi4zMTQ2NjdsOC4xOTItMi43MzA2NjZjMjAuMzA5MzMzLTcuOTM2IDQ3LjE4OTMzMy00LjA5NiA1OC43OTQ2NjcgMTYuNDY5MzMzIDguOTYgMTUuOTU3MzMzIDUuMTIgMzcuMTItMTIuNTQ0IDQ2LjMzNi05LjcyOCA0Ljk0OTMzMy0yMC4xMzg2NjcgOS4zODY2NjctMzEuMzE3MzM0IDEzLjA1Ni0yMS4wNzczMzMgNi44MjY2NjctNDUuMzk3MzMzIDEwLjA2OTMzMy03Mi41MzMzMzMgMTAuMDY5MzMzLTI5Ljg2NjY2NyAwLTU2LjgzMi01LjEyLTgwLjcyNTMzMy0xNS43MDEzMzNsLTEwLjA2OTMzNC00Ljg2NGExNTIuMDY0IDE1Mi4wNjQgMCAwIDEtNjEuNjEwNjY2LTU4Ljc5NDY2NyAxNjkuODEzMzMzIDE2OS44MTMzMzMgMCAwIDEtMjEuNjc0NjY3LTc2LjQ1ODY2NmwtMC4yNTYtMTIuNDU4NjY3YzAtMjQuNTc2IDQuMjY2NjY3LTQ3LjI3NDY2NyAxMi44LTY3LjkyNTMzMyA2LjQ4NTMzMy0xNS41MzA2NjcgMTQuOTMzMzMzLTI5LjYxMDY2NyAyNS40MjkzMzMtNDEuOTg0bDExLjE3ODY2Ny0xMS45NDY2NjdjMTUuODcyLTE1LjI3NDY2NyAzNC4zODkzMzMtMjYuOTY1MzMzIDU1LjYzNzMzMy0zNS4xNTczMzNsMTYuNDY5MzM0LTUuNDYxMzM0YzE2Ljg5Ni00LjY5MzMzMyAzNC44MTYtNi45OTczMzMgNTMuNzYtNi45OTczMzNsMTkuMiAwLjU5NzMzM3ogbS01NDMuNDg4IDYuMTQ0YzExLjI2NCAwIDIxLjU4OTMzMyA1LjcxNzMzMyAyNy40NzczMzMgMTUuMDE4NjY3TDIwMS4zODc1MiA1MzcuMzQ0bDkzLjI2OTMzMy0xNTYuNTAxMzMzYTMyIDMyIDAgMCAxIDI3LjU2MjY2Ny0xNS4zNmgxNS45NTczMzNjMjIuNjEzMzMzIDAgNDAuOTYgMTcuODM0NjY3IDQwLjk2IDM5Ljc2NTMzM3YyNDYuMzU3MzMzYTM4LjU3MDY2NyAzOC41NzA2NjcgMCAwIDEtMzEuNDAyNjY2IDM3LjU0NjY2N2wtNy45MzYgMC42ODI2NjdhMzguNzQxMzMzIDM4Ljc0MTMzMyAwIDAgMS0zOS4zMzg2NjctMzguMzE0NjY3bDAuNjgyNjY3LTE0Ni45NDQtNjEuNzgxMzM0IDEwMS4yMDUzMzNhNDcuNTMwNjY3IDQ3LjUzMDY2NyAwIDAgMS0zNC42NDUzMzMgMjIuMTg2NjY3bC02LjIyOTMzMyAwLjQyNjY2N2E0Ny43ODY2NjcgNDcuNzg2NjY3IDAgMCAxLTQwLjUzMzMzNC0yMi4xODY2NjdsLTY1LjYyMTMzMy0xMDQuMTA2NjY3IDAuODUzMzMzIDE1MS4wNGEzNi43Nzg2NjcgMzYuNzc4NjY3IDAgMCAxLTI5Ljk1MiAzNi4wMTA2NjdsLTcuNjggMC42ODI2NjdhMzcuMDM0NjY3IDM3LjAzNDY2NyAwIDAgMS0zNy41NDY2NjYtMzYuMzUydi0yNDguMzJjMC0yMS44NDUzMzMgMTguNDMyLTM5LjY4IDQxLjA0NTMzMy0zOS42OGgxNi41NTQ2Njd6TTg5Ni4zNDIxODcgMzY1LjQ4MjY2N2MyNC4zMiAwIDQ2LjA4IDQuMDk2IDY1LjI4IDEyLjU0NCAxOC40MzIgNy42OCAzNC4zMDQgMjAuMzk0NjY3IDQ1LjczODY2NiAzNi42OTMzMzNsNC4wMTA2NjcgNi4zMTQ2NjdjOC41MzMzMzMgMTQuODQ4IDEyLjYyOTMzMyAzMi4wODUzMzMgMTIuNjI5MzMzIDUxLjQ1NiAwIDIyLjM1NzMzMy00Ljk0OTMzMyA0MS44MTMzMzMtMTUuMzYgNTguMDI2NjY2LTEwLjQxMDY2NyAxNi4wNDI2NjctMjUuNiAyOC4yNDUzMzMtNDQuODg1MzMzIDM2LjYwOGExNzYuMjk4NjY3IDE3Ni4yOTg2NjcgMCAwIDEtNjkuMTIgMTIuMDMyaC00OC40NjkzMzN2NzEuMzM4NjY3YTM5Ljc2NTMzMyAzOS43NjUzMzMgMCAwIDEtMzIuNDI2NjY3IDM4LjY1NmwtOC4xMDY2NjcgMC42ODI2NjdhMzkuOTM2IDM5LjkzNiAwIDAgMS00MC41MzMzMzMtMzkuMjUzMzM0VjQxNC43MmMwLTI3LjMwNjY2NyAyMi43ODQtNDkuMzIyNjY3IDUwLjg1ODY2Ny00OS4zMjI2NjdoODAuMzg0eiBtLTQzLjUyIDY5LjQ2MTMzM2E2LjU3MDY2NyA2LjU3MDY2NyAwIDAgMC02LjY1NiA2LjR2NjkuNzE3MzMzaDQ3LjM2YzE2LjgxMDY2NyAwIDI5LjAxMzMzMy0zLjQxMzMzMyAzNy4yOTA2NjYtOS4zMDEzMzMgNy42OC01LjQ2MTMzMyAxMi4yODgtMTQuMzM2IDEyLjI4OC0yOC4wNzQ2NjdzLTQuNjA4LTIyLjk1NDY2Ny0xMi43MTQ2NjYtMjguOTI4Yy04LjUzMzMzMy02LjMxNDY2Ny0yMC40OC05LjgxMzMzMy0zNi4zNTItOS44MTMzMzNoLTQxLjMwMTMzNHpNOTY1LjU0NzUyIDBhNTEuMiA1MS4yIDAgMCAxIDUxLjExNDY2NyA1MS40NTZ2MTYzLjg0YTUxLjIgNTEuMiAwIDAgMS01MS4xMTQ2NjcgNTEuMzcwNjY3IDUxLjIgNTEuMiAwIDAgMS01MS4wMjkzMzMtNTEuMzcwNjY3VjEwMi44MjY2NjdoLTgxMi4zNzMzMzR2MTEyLjQ2OTMzM2E1MS4yIDUxLjIgMCAwIDEtNTEuMTE0NjY2IDUxLjM3MDY2N0E1MS4yIDUxLjIgMCAwIDEgMC4wMDA4NTMgMjE1LjI5NlY1MS40NTZBNTEuMiA1MS4yIDAgMCAxIDUxLjAzMDE4NyAwaDkxNC41MTczMzN6IiBwLWlkPSIzMDgwIiBmaWxsPSIjMGJhMmYxIj48L3BhdGg+PC9zdmc+'

interface McpUserDeps {
  mcpStore: McpStore
  authService: AuthService
  getUserName: (userId: string) => string | undefined
  getUserDepartmentId: (userId: string) => string | null
  getUserByIdAndOrg: (userId: string, orgId: string) => { role: string; departmentId: string | null } | null
  listDepartmentsByOrg: (orgId: string) => { id: string; parentId: string | null }[]
  nexusClient?: NexusClient
}

// Plan §2.2 step 6: user-side response is a strict whitelist of 16 fields.
const USER_VISIBLE_FIELDS = [
  'id', 'name', 'display_name', 'description', 'icon', 'category',
  'scope', 'mcp_type', 'url', 'risk_level',
  'bound_assistants', 'bound_skills',
  'allow_read', 'allow_write',
  'require_confirmation_for_write', 'allow_read_sensitive_fields',
  'allow_outbound_network', 'allow_scheduled_task',
  'audit_request', 'audit_response_summary',
  'redact_sensitive_fields', 'allow_user_disable',
  'enabled', 'status', 'template_id',
] as const

function sanitizeForUser(server: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const key of USER_VISIBLE_FIELDS) {
    if (key in server) result[key] = server[key]
  }
  return result
}

/** A user-fillable config item declaration exposed to third parties (no secret values). */
interface TemplateUserConfigItemDto {
  name: string
  key: string
  required: boolean
  description?: string
  target: 'env' | 'headers'
}

/**
 * Parse a template's config_json and extract only the user_config_items schema.
 * Returns [] when absent or malformed. Never exposes any stored secret values.
 */
function parseTemplateUserConfigItems(configJson: string | null): TemplateUserConfigItemDto[] {
  if (!configJson) return []
  let parsed: unknown
  try { parsed = JSON.parse(configJson) } catch { return [] }
  const items = (parsed as Record<string, unknown> | null)?.user_config_items
  if (!Array.isArray(items)) return []
  const result: TemplateUserConfigItemDto[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.key !== 'string') continue
    if (item.target !== 'env' && item.target !== 'headers') continue
    result.push({
      name: item.name,
      key: item.key,
      required: item.required === true,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      target: item.target,
    })
  }
  return result
}

/**
 * Sanitize a template for third-party / user consumption.
 * Explicit allowlist: connection/infra fields (url, command, args_json, env_json,
 * auth_type, raw config_json, owner) are deliberately excluded.
 */
function sanitizeTemplateForUser(t: McpTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    category: t.category,
    tags: t.tags_json ?? [],
    mcp_type: t.mcp_type,
    scope: t.scope,
    risk_level: t.risk_level,
    responsible_person: t.responsible_person ?? null,
    downloads: t.downloads,
    rating: t.rating,
    user_config_items: parseTemplateUserConfigItems(t.config_json),
    auth_user_items: extractAuthUserItems(t.auth_config_json ?? null),
    created_at: t.created_at,
    updated_at: t.updated_at,
  }
}

export function createMcpUserApi(deps: McpUserDeps) {
  const { mcpStore, authService, getUserName, getUserDepartmentId, getUserByIdAndOrg, listDepartmentsByOrg, nexusClient } = deps

  const api = {
    /**
     * GET /api/v1/me/mcp-servers
     * Returns all MCP servers visible to the current user.
     */
    async listMyMcpServers(auth: AuthContext) {
      const userDeptId = getUserDepartmentId(auth.userId)
      const filter = buildVisibilityFilter(
        auth,
        getUserByIdAndOrg,
        listDepartmentsByOrg,
      )

      // Get all enabled MCP servers for this org
      const allServers = mcpStore.listVisibleMcpServers(auth.orgId, auth.userId, userDeptId)

      // Filter by visibility and status (only connection-verified MCPs)
      const visibleServers = allServers.filter(server => isVisibleTo(server.visible_to, filter) && server.status === 'enabled')

      // Attach per-user disabled state
      const userDisabledIds = new Set(mcpStore.getUserDisabledMcpIds(auth.orgId, auth.userId))

      // Sanitize sensitive fields
      const sanitized = visibleServers.map(s => {
        const dto = sanitizeForUser(s as unknown as Record<string, unknown>)
        dto.user_disabled = userDisabledIds.has(s.id)
        return dto
      })

      return { success: true, data: sanitized }
    },

    /**
     * GET /api/v1/me/mcp-templates
     * Third-party / user-facing MCP template catalog for the caller's org.
     * Auth identical to listMyMcpServers: valid token only, no scope check.
     * Returns a sanitized DTO; user_config_items is always present (the data
     * third parties need to render a config form).
     */
    listAvailableTemplates(auth: AuthContext, filter?: McpTemplateListFilter) {
      const policy = mcpStore.getMcpPolicy(auth.orgId)
      if (!policy.allow_personal_mcp) {
        return { success: true, data: [], total: 0, page: filter?.page ?? 1, page_size: filter?.page_size ?? 20 }
      }
      // Fetch all templates without pagination for visibility filtering
      const result = mcpStore.listTemplates(auth.orgId, { ...filter, page: 1, page_size: 9999 })

      // Build visibility filter
      const visFilter = buildVisibilityFilter(auth, getUserByIdAndOrg, listDepartmentsByOrg)

      // Filter by visibility
      const visibleItems = result.items.filter(template => {
        let visibleTo: Record<string, unknown> | null = null
        if (template.visible_to_json) {
          try { visibleTo = JSON.parse(template.visible_to_json) } catch { /* treat as null */ }
        }
        return isVisibleTo(visibleTo as Parameters<typeof isVisibleTo>[0], visFilter)
      })

      // Re-compute pagination after filtering
      const page = filter?.page ?? 1
      const pageSize = filter?.page_size ?? 20
      const total = visibleItems.length
      const start = (page - 1) * pageSize
      const pagedItems = visibleItems.slice(start, start + pageSize)

      return {
        success: true,
        data: pagedItems.map(sanitizeTemplateForUser),
        total,
        page,
        page_size: pageSize,
      }
    },

    // ==================== Personal MCP CRUD (Phase 2) ====================

    /**
     * POST /api/v1/me/mcp-servers/install-json
     * Install a personal MCP by uploading a JSON config string.
     */
    async installByJson(
      auth: AuthContext,
      body: { json_config: string; name?: string },
      ip?: string,
    ) {
      // Step 1: Get policy
      const policy = mcpStore.getMcpPolicy(auth.orgId)

      // Step 2: Policy check - allow_personal_mcp
      if (!policy.allow_personal_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许安装个人MCP' } }
      }

      // Step 3: Parse JSON config
      const parseResult = parseMcpConfig(body.json_config)
      if (!parseResult.success || !parseResult.data) {
        return { success: false, error: { code: 'bad_request', message: parseResult.error ?? '无效的JSON配置' } }
      }

      // Step 4: Policy check - mcp_type
      if (parseResult.data.mcp_type === 'stdio' && !policy.allow_stdio_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许安装 STDIO 类型的个人MCP' } }
      }
      if ((parseResult.data.mcp_type === 'http' || parseResult.data.mcp_type === 'sse') && !policy.allow_http_sse_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许安装 HTTP/SSE 类型的个人MCP' } }
      }

      // Step 5: Determine display_name
      const displayName = body.name ?? parseResult.data.name
      if (!displayName) {
        return { success: false, error: { code: 'bad_request', message: '无法提取MCP名称，请提供 name 参数' } }
      }

      // Step 6: Generate unique name (reuse installFromTemplate pattern)
      let serverName: string | null = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `${displayName}-${randomBytes(4).toString('hex')}`
        if (!mcpStore.getMcpServerByName(auth.orgId, candidate)) {
          serverName = candidate
          break
        }
      }
      if (!serverName) {
        return { success: false, error: { code: 'name_conflict', message: '生成唯一名称失败，请重试' } }
      }

      // Step 7: Assemble McpServerInput
      const input: McpServerInput = {
        name: serverName,
        display_name: displayName,
        description: null,
        icon: DEFAULT_MCP_ICON,
        scope: 'user',
        owner_type: 'user',
        owner_id: auth.userId,
        mcp_type: parseResult.data.mcp_type,
        url: parseResult.data.url,
        command: parseResult.data.command,
        args_json: parseResult.data.args_json,
        env_json: parseResult.data.env_json,
        auth_config_json: parseResult.data.auth_config_json,
        timeout_ms: parseResult.data.timeout_ms,
        visible_to: { user_ids: [auth.userId] },
      }

      // Step 8: Connection test before creating
      const testServer = {
        id: '',
        org_id: auth.orgId,
        name: input.name,
        display_name: input.display_name ?? null,
        description: input.description ?? null,
        icon: input.icon ?? null,
        category: input.category ?? null,
        risk_level: input.risk_level ?? 'low',
        responsible_person: input.responsible_person ?? null,
        scope: input.scope,
        owner_type: input.owner_type,
        owner_id: input.owner_id,
        mcp_type: input.mcp_type,
        url: input.url ?? null,
        command: input.command ?? null,
        args_json: input.args_json ?? null,
        env_json: input.env_json ?? null,
        timeout_ms: input.timeout_ms ?? 30000,
        health_check_url: input.health_check_url ?? null,
        use_proxy: input.use_proxy ?? false,
        auth_type: input.auth_type ?? 'none',
        secret_ref: input.secret_ref ?? null,
        auth_config_json: input.auth_config_json ?? null,
        visible_to: input.visible_to ?? null,
        bound_assistants: input.bound_assistants ?? null,
        bound_skills: input.bound_skills ?? null,
        allow_read: input.allow_read ?? true,
        allow_write: input.allow_write ?? true,
        require_confirmation_for_write: input.require_confirmation_for_write ?? false,
        allow_read_sensitive_fields: input.allow_read_sensitive_fields ?? false,
        allow_outbound_network: input.allow_outbound_network ?? true,
        allow_scheduled_task: input.allow_scheduled_task ?? false,
        audit_request: input.audit_request ?? false,
        audit_response_summary: input.audit_response_summary ?? false,
        redact_sensitive_fields: input.redact_sensitive_fields ?? false,
        allow_user_disable: input.allow_user_disable ?? true,
        status: 'pending' as const,
        enabled: true,
        last_invocation_at: null,
        template_id: input.template_id ?? null,
        created_by: auth.userId,
        updated_by: null,
        created_at: 0,
        updated_at: 0,
      } satisfies McpServer

      const testResult = await testMcpConnection(testServer)
      if (!testResult.ok) {
        return { success: false, error: { code: 'connection_test_failed', message: `MCP 连接测试失败：${testResult.message}` } }
      }

      // Step 9: Delegate to createPersonalMcp (handles audit log, approval, etc.)
      return this.createPersonalMcp(auth, input, ip)
    },

    /**
     * POST /api/v1/me/mcp-servers
     * Create a personal MCP server (scope=user).
     */
    async createPersonalMcp(auth: AuthContext, input: McpServerInput, ip?: string) {
      // Check policy: is personal MCP allowed?
      const policy = mcpStore.getMcpPolicy(auth.orgId)
      if (!policy.allow_personal_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许创建个人 MCP' } }
      }

      // Enforce scope=user; default visible_to to only the owner so that even if
      // the SQL filter is bypassed, isVisibleTo() will still gate cross-user visibility.
      const personalInput: McpServerInput = {
        ...input,
        scope: 'user',
        owner_type: 'user',
        owner_id: auth.userId,
        visible_to: input.visible_to ?? { user_ids: [auth.userId] },
      }

      // Check policy constraints
      if (input.mcp_type === 'stdio' && !policy.allow_stdio_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许使用 STDIO 类型 MCP' } }
      }
      if ((input.mcp_type === 'http' || input.mcp_type === 'sse') && !policy.allow_http_sse_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许使用 HTTP/SSE 类型 MCP' } }
      }

      // Check name uniqueness
      const existing = mcpStore.getMcpServerByName(auth.orgId, input.name)
      if (existing) {
        return { success: false, error: { code: 'conflict', message: 'MCP 名称已存在' } }
      }

      const server = mcpStore.createMcpServer(auth.orgId, personalInput, auth.userId)

      // Write audit log
      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: server.id,
          mcp_server_name: server.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'create_personal',
          ip_address: ip,
        })
      } catch { /* ignore */ }

      // If policy requires approval, create approval request and set status to pending
      if (policy.require_approval) {
        mcpStore.setMcpServerStatus(auth.orgId, server.id, 'pending', null)
        mcpStore.createApprovalRequest({
          org_id: auth.orgId,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          mcp_server_id: server.id,
          mcp_server_snapshot: JSON.stringify(sanitizeForUser(server as unknown as Record<string, unknown>)),
        })
        const sanitized = sanitizeForUser({ ...server, status: 'pending' } as unknown as Record<string, unknown>)
        return { success: true, data: { ...sanitized, _requires_approval: true } }
      }

      // No approval required — activate immediately
      mcpStore.setMcpServerStatus(auth.orgId, server.id, 'enabled', null)
      return { success: true, data: sanitizeForUser({ ...server, status: 'enabled' } as unknown as Record<string, unknown>) }
    },

    /**
     * PATCH /api/v1/me/mcp-servers/:id
     * Update a personal MCP server.
     */
    async updatePersonalMcp(auth: AuthContext, id: string, input: Partial<McpServerInput>, ip?: string) {
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      // Can only update own personal MCPs
      if (server.scope !== 'user' || server.owner_id !== auth.userId) {
        return { success: false, error: { code: 'forbidden', message: '只能修改自己的个人 MCP' } }
      }

      // Enforce scope stays as user
      if (input.scope && input.scope !== 'user') {
        return { success: false, error: { code: 'forbidden', message: '个人 MCP 作用域不可更改' } }
      }

      const updated = mcpStore.updateMcpServer(auth.orgId, id, input, auth.userId)

      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: id,
          mcp_server_name: updated.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'update_personal',
          request_params_json: JSON.stringify({ updated_fields: Object.keys(input) }),
          ip_address: ip,
        })
      } catch { /* ignore */ }

      return { success: true, data: sanitizeForUser(updated as unknown as Record<string, unknown>) }
    },

    /**
     * DELETE /api/v1/me/mcp-servers/:id
     * Delete a personal MCP server.
     */
    async deletePersonalMcp(auth: AuthContext, id: string, ip?: string) {
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      if (server.scope !== 'user' || server.owner_id !== auth.userId) {
        return { success: false, error: { code: 'forbidden', message: '只能删除自己的个人 MCP' } }
      }

      const deleted = mcpStore.deleteMcpServer(auth.orgId, id)

      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: null,
          mcp_server_name: server.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'delete_personal',
          ip_address: ip,
        })
      } catch { /* ignore */ }

      return { success: true }
    },

    /**
     * POST /api/v1/me/mcp-servers/:id/test
     * Test personal MCP connection.
     */
    async testPersonalMcpConnection(auth: AuthContext, id: string, ip?: string) {
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      if (server.scope !== 'user' || server.owner_id !== auth.userId) {
        return { success: false, error: { code: 'forbidden', message: '只能测试自己的个人 MCP' } }
      }

      const result = await testMcpConnection(server)

      // Update status
      if (result.ok) {
        mcpStore.setMcpServerStatus(auth.orgId, id, 'enabled', auth.userId)
      } else {
        mcpStore.setMcpServerStatus(auth.orgId, id, 'error', auth.userId)
      }

      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: id,
          mcp_server_name: server.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'test_connection',
          request_params_json: JSON.stringify({ ok: result.ok, latency_ms: result.latency_ms }),
          ip_address: ip,
        })
      } catch { /* ignore */ }

      return { success: true, data: result }
    },

    /**
     * POST /api/v1/me/mcp-templates/:id/install
     * Install a personal MCP from a template. Atomic: validates required user-config
     * values up front, then creates the server with template connection info, writes
     * user-config secrets keyed by the new serverId, and sets status='enabled'.
     * Rolls back the created server if writing a config value fails.
     */
    async installFromTemplate(
      auth: AuthContext,
      templateId: string,
      body: { config_values?: Record<string, string>; auth_credentials?: Record<string, string>; display_name?: string },
      ip?: string,
    ) {
      const policy = mcpStore.getMcpPolicy(auth.orgId)
      if (!policy.allow_personal_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许创建个人 MCP' } }
      }

      const template = mcpStore.getTemplate(auth.orgId, templateId)
      if (!template) {
        return { success: false, error: { code: 'not_found', message: '模板不存在' } }
      }

      // Visibility check
      const visFilter = buildVisibilityFilter(auth, getUserByIdAndOrg, listDepartmentsByOrg)
      let templateVisibleTo: Parameters<typeof isVisibleTo>[0] = null
      if (template.visible_to_json) {
        try { templateVisibleTo = JSON.parse(template.visible_to_json) } catch { /* treat as null */ }
      }
      if (!isVisibleTo(templateVisibleTo, visFilter)) {
        return { success: false, error: { code: 'not_found', message: '该模板不可用' } }
      }

      if (template.mcp_type === 'stdio' && !policy.allow_stdio_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许使用 STDIO 类型 MCP' } }
      }
      if ((template.mcp_type === 'http' || template.mcp_type === 'sse') && !policy.allow_http_sse_mcp) {
        return { success: false, error: { code: 'forbidden', message: '企业策略不允许使用 HTTP/SSE 类型 MCP' } }
      }

      if (mcpStore.hasUserInstalledTemplate(auth.orgId, auth.userId, templateId)) {
        return { success: false, error: { code: 'already_installed', message: '你已经安装了此模板' } }
      }

      const schema = parseTemplateUserConfigItems(template.config_json)
      const providedValues = body.config_values ?? {}

      const missing: string[] = []
      for (const item of schema) {
        if (item.required) {
          const v = providedValues[item.key]
          if (typeof v !== 'string' || v.length === 0) {
            missing.push(item.key)
          }
        }
      }
      if (missing.length > 0) {
        return {
          success: false,
          error: {
            code: 'missing_config',
            message: `缺少必填配置项: ${missing.join(', ')}`,
            missing_keys: missing,
          },
        }
      }

      // Validate auth credentials
      const authCredentials = body.auth_credentials ?? {}
      const missingAuth = validateRequiredCredentials(template.auth_config_json ?? null, authCredentials)
      if (missingAuth.length > 0) {
        return {
          success: false,
          error: {
            code: 'missing_auth_credentials',
            message: `缺少必填鉴权凭据: ${missingAuth.join(', ')}`,
            missing_keys: missingAuth,
          },
        }
      }

      const declaredKeys = new Set(schema.map(s => s.key))
      const valuesToWrite: Array<{ key: string; value: string }> = []
      for (const [k, v] of Object.entries(providedValues)) {
        if (declaredKeys.has(k) && typeof v === 'string' && v.length > 0) {
          valuesToWrite.push({ key: k, value: v })
        }
      }
      if (valuesToWrite.length > 0 && !nexusClient) {
        return {
          success: false,
          error: { code: 'user_config_unavailable', message: '用户配置服务当前不可用，无法保存配置值' },
        }
      }

      // Generate unique name: {template.name}-{8 hex chars}
      let serverName: string | null = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `${template.name}-${randomBytes(4).toString('hex')}`
        if (!mcpStore.getMcpServerByName(auth.orgId, candidate)) {
          serverName = candidate
          break
        }
      }
      if (!serverName) {
        return { success: false, error: { code: 'name_conflict', message: '生成唯一名称失败，请重试' } }
      }

      // Auth config format conversion: template layered → McpServer flat
      const authConversion = convertTemplateAuthToServerAuth(template.auth_config_json ?? null, authCredentials)

      // Security policy mapping: JSON → 9 boolean columns
      const sp: Record<string, boolean> = {}
      if (template.security_policy_json) {
        try {
          const policyObj = JSON.parse(template.security_policy_json) as Record<string, unknown>
          for (const [k, v] of Object.entries(policyObj)) {
            if (typeof v === 'boolean') sp[k] = v
          }
        } catch { /* ignore */ }
      }

      const serverInput: McpServerInput = {
        name: serverName,
        display_name: body.display_name ?? template.name,
        description: template.description,
        icon: template.icon,
        category: template.category,
        risk_level: template.risk_level,
        responsible_person: template.responsible_person ?? null,
        scope: 'user',
        owner_type: 'user',
        owner_id: auth.userId,
        visible_to: { user_ids: [auth.userId] },
        mcp_type: template.mcp_type,
        url: template.url,
        command: template.command,
        args_json: template.args_json,
        env_json: template.env_json,
        timeout_ms: template.timeout_ms,
        auth_type: template.auth_type,
        auth_config_json: authConversion.auth_config_json,
        secret_ref: authConversion.secret_ref,
        template_id: templateId,
        allow_user_disable: true,
        // Copy bound assistants/skills from template
        bound_assistants: (() => { try { return template.bound_assistants_json ? JSON.parse(template.bound_assistants_json) : null } catch { return null } })(),
        bound_skills: (() => { try { return template.bound_skills_json ? JSON.parse(template.bound_skills_json) : null } catch { return null } })(),
        // Security policy
        ...(sp.allow_read !== undefined ? { allow_read: sp.allow_read } : {}),
        ...(sp.allow_write !== undefined ? { allow_write: sp.allow_write } : {}),
        ...(sp.require_confirmation_for_write !== undefined ? { require_confirmation_for_write: sp.require_confirmation_for_write } : {}),
        ...(sp.allow_read_sensitive_fields !== undefined ? { allow_read_sensitive_fields: sp.allow_read_sensitive_fields } : {}),
        ...(sp.allow_outbound_network !== undefined ? { allow_outbound_network: sp.allow_outbound_network } : {}),
        ...(sp.allow_scheduled_task !== undefined ? { allow_scheduled_task: sp.allow_scheduled_task } : {}),
        ...(sp.audit_request !== undefined ? { audit_request: sp.audit_request } : {}),
        ...(sp.audit_response_summary !== undefined ? { audit_response_summary: sp.audit_response_summary } : {}),
        ...(sp.redact_sensitive_fields !== undefined ? { redact_sensitive_fields: sp.redact_sensitive_fields } : {}),
      }

      const server = mcpStore.createMcpServer(auth.orgId, serverInput, auth.userId)

      // Write user-config secrets; on any failure, roll back the server
      for (const { key, value } of valuesToWrite) {
        try {
          await nexusClient!.putSecret(`mcp:user:${auth.userId}:${server.id}`, key, value, auth.userId)
        } catch (err) {
          try { mcpStore.deleteMcpServer(auth.orgId, server.id) } catch { /* best effort */ }
          return {
            success: false,
            error: {
              code: 'config_write_failed',
              message: `保存配置失败: ${err instanceof Error ? err.message : String(err)}`,
            },
          }
        }
      }

      mcpStore.setMcpServerStatus(auth.orgId, server.id, 'enabled', auth.userId)
      mcpStore.incrementDownloads(auth.orgId, templateId)

      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: server.id,
          mcp_server_name: server.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'install_template',
          request_params_json: JSON.stringify({ template_id: templateId, template_name: template.name }),
          ip_address: ip,
        })
      } catch { /* ignore */ }

      const fresh = mcpStore.getMcpServer(auth.orgId, server.id) ?? server
      return { success: true, data: sanitizeForUser(fresh as unknown as Record<string, unknown>) }
    },

    /**
     * PUT /api/v1/me/mcp-servers/:id/disable
     * User disables an MCP for themselves.
     */
    async disableUserMcp(auth: AuthContext, id: string, ip?: string) {
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      if (!server.enabled) {
        return { success: false, error: { code: 'forbidden', message: '该 MCP 已被管理员禁用' } }
      }

      // Visibility check
      if (server.scope === 'user') {
        if (server.owner_id !== auth.userId) {
          return { success: false, error: { code: 'forbidden', message: '只能操作自己的个人 MCP' } }
        }
      } else {
        const filter = buildVisibilityFilter(auth, getUserByIdAndOrg, listDepartmentsByOrg)
        if (!isVisibleTo(server.visible_to, filter)) {
          return { success: false, error: { code: 'forbidden', message: '无权操作该 MCP' } }
        }
        // Org/department MCP: check allow_user_disable
        if (!server.allow_user_disable) {
          return { success: false, error: { code: 'forbidden', message: '该 MCP 不允许用户禁用' } }
        }
      }

      mcpStore.addUserDisabledMcp(auth.orgId, auth.userId, id)

      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: id,
          mcp_server_name: server.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'user_disable_mcp',
          ip_address: ip,
        })
      } catch { /* ignore */ }

      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true }
    },

    /**
     * PUT /api/v1/me/mcp-servers/:id/enable
     * User re-enables an MCP for themselves.
     */
    async enableUserMcp(auth: AuthContext, id: string, ip?: string) {
      const server = mcpStore.getMcpServer(auth.orgId, id)
      if (!server) return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }

      if (!server.enabled) {
        return { success: false, error: { code: 'forbidden', message: '该 MCP 已被管理员禁用' } }
      }

      // Visibility check
      if (server.scope === 'user') {
        if (server.owner_id !== auth.userId) {
          return { success: false, error: { code: 'forbidden', message: '只能操作自己的个人 MCP' } }
        }
      } else {
        const filter = buildVisibilityFilter(auth, getUserByIdAndOrg, listDepartmentsByOrg)
        if (!isVisibleTo(server.visible_to, filter)) {
          return { success: false, error: { code: 'forbidden', message: '无权操作该 MCP' } }
        }
        // Org/department MCP: check allow_user_disable
        if (!server.allow_user_disable) {
          return { success: false, error: { code: 'forbidden', message: '该 MCP 不允许用户控制' } }
        }
      }

      mcpStore.removeUserDisabledMcp(auth.orgId, auth.userId, id)

      try {
        mcpStore.insertAuditLog({
          org_id: auth.orgId,
          mcp_server_id: id,
          mcp_server_name: server.name,
          user_id: auth.userId,
          user_name: getUserName(auth.userId),
          action: 'user_enable_mcp',
          ip_address: ip,
        })
      } catch { /* ignore */ }

      broadcastMcpEvent({ org_id: auth.orgId, type: 'mcp.changed' })
      return { success: true }
    },
  }

  return api
}

export type McpUserApi = ReturnType<typeof createMcpUserApi>
