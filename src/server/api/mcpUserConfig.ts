import type { NexusClient } from '../nexus/nexusClient.js'
import type { McpStore } from '../mcp/db.js'
import type { AuthContext } from '../auth/token.js'
import { isVisibleTo, buildVisibilityFilter } from '../visibilityFilter.js'

export interface UserConfigItem {
  name: string
  target: 'env' | 'headers'
  key: string
  description?: string
  required?: boolean
}

interface McpUserConfigDeps {
  nexusClient: NexusClient
  mcpStore: McpStore
  getUserByIdAndOrg: (userId: string, orgId: string) => Promise<{ role: string; departmentId: string | null } | null>
  listDepartmentsByOrg: (orgId: string) => Promise<Array<{ id: string; parentId: string | null }>>
}

export function createMcpUserConfigApi(deps: McpUserConfigDeps) {
  const { nexusClient, mcpStore, getUserByIdAndOrg, listDepartmentsByOrg } = deps

  async function checkVisibility(auth: AuthContext, server: { visible_to: unknown }) {
    const filter = await buildVisibilityFilter(auth, getUserByIdAndOrg, listDepartmentsByOrg)
    if (!isVisibleTo(server.visible_to, filter)) {
      const err = new Error('无权访问此 MCP 服务')
      Object.assign(err, { statusCode: 403 })
      throw err
    }
  }

  async function getSchemaForServer(server: { template_id: string | null; org_id: string }): Promise<UserConfigItem[]> {
    if (!server.template_id) return []
    const template = await mcpStore.getTemplate(server.org_id, server.template_id)
    if (!template?.config_json) return []
    try {
      const parsed = JSON.parse(template.config_json)
      if (parsed?.user_config_items && Array.isArray(parsed.user_config_items)) {
        return parsed.user_config_items as UserConfigItem[]
      }
      return []
    } catch {
      return []
    }
  }

  function namespace(userId: string, mcpServerId: string) {
    return `mcp:user:${userId}:${mcpServerId}`
  }

  const api = {
    async listForServer(auth: AuthContext, mcpServerId: string) {
      const server = await mcpStore.getMcpServer(auth.orgId, mcpServerId)
      if (!server) {
        const err = new Error('MCP 服务不存在')
        Object.assign(err, { statusCode: 404 })
        throw err
      }
      await checkVisibility(auth, server)

      const schema = await getSchemaForServer(server)
      if (schema.length === 0) return { success: true, data: { schema: [], values: {} } }

      const secrets = await nexusClient.listSecrets(namespace(auth.userId, mcpServerId), auth.userId)
      const values: Record<string, string> = {}
      for (const s of secrets) {
        if (s.value !== null) {
          values[s.key] = s.value
        }
      }
      return { success: true, data: { schema, values } }
    },

    async setValue(auth: AuthContext, mcpServerId: string, key: string, value: string) {
      const server = await mcpStore.getMcpServer(auth.orgId, mcpServerId)
      if (!server) {
        const err = new Error('MCP 服务不存在')
        Object.assign(err, { statusCode: 404 })
        throw err
      }
      await checkVisibility(auth, server)

      const schema = await getSchemaForServer(server)
      if (schema.length === 0) {
        return { success: false, error: { code: 'template_not_found', message: '该服务关联的模板不存在或无配置项' } }
      }
      if (!schema.some(item => item.key === key)) {
        const err = new Error(`配置项 ${key} 未在模板 schema 中声明`)
        Object.assign(err, { statusCode: 400 })
        throw err
      }

      await nexusClient.putSecret(namespace(auth.userId, mcpServerId), key, value, auth.userId)
      return { success: true }
    },

    async deleteValue(auth: AuthContext, mcpServerId: string, key: string) {
      const server = await mcpStore.getMcpServer(auth.orgId, mcpServerId)
      if (!server) {
        const err = new Error('MCP 服务不存在')
        Object.assign(err, { statusCode: 404 })
        throw err
      }
      await checkVisibility(auth, server)

      const schema = await getSchemaForServer(server)
      if (!schema.some(item => item.key === key)) {
        const err = new Error(`配置项 ${key} 未在模板 schema 中声明`)
        Object.assign(err, { statusCode: 400 })
        throw err
      }

      await nexusClient.deleteSecret(namespace(auth.userId, mcpServerId), key, auth.userId)
      return { success: true }
    },

    async batchUpdate(auth: AuthContext, mcpServerId: string, configValues: Record<string, string>) {
      const server = await mcpStore.getMcpServer(auth.orgId, mcpServerId)
      if (!server) {
        return { success: false, error: { code: 'not_found', message: 'MCP 服务不存在' } }
      }
      if (server.scope !== 'user' || server.owner_id !== auth.userId) {
        return { success: false, error: { code: 'forbidden', message: '只能修改自己的个人 MCP 配置' } }
      }

      const schema = await getSchemaForServer(server)
      if (schema.length === 0) {
        return { success: false, error: { code: 'template_not_found', message: '该服务关联的模板不存在或无配置项' } }
      }

      const missing: string[] = []
      for (const item of schema) {
        if (item.required) {
          const v = configValues[item.key]
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

      const declaredKeys = new Set(schema.map(s => s.key))
      const valuesToWrite: Array<{ key: string; value: string }> = []
      for (const [k, v] of Object.entries(configValues)) {
        if (declaredKeys.has(k) && typeof v === 'string' && v.length > 0) {
          valuesToWrite.push({ key: k, value: v })
        }
      }
      const newKeys = new Set(valuesToWrite.map(v => v.key))

      const ns = namespace(auth.userId, mcpServerId)
      const existingSecrets = await nexusClient.listSecrets(ns, auth.userId)
      for (const s of existingSecrets) {
        if (!newKeys.has(s.key)) {
          await nexusClient.deleteSecret(ns, s.key, auth.userId)
        }
      }
      for (const { key, value } of valuesToWrite) {
        await nexusClient.putSecret(ns, key, value, auth.userId)
      }

      return { success: true }
    },

    async getResolvedEnvAndHeaders(server: { template_id: string | null; org_id: string }, userId: string): Promise<{ env: Record<string, string>; headers: Record<string, string> }> {
      const schema = await getSchemaForServer(server)
      if (schema.length === 0) return { env: {}, headers: {} }

      const ns = namespace(userId, server.id ?? '')
      const secrets = await nexusClient.listSecrets(ns, userId)
      const valueMap: Record<string, string> = {}
      for (const s of secrets) {
        if (s.value !== null) valueMap[s.key] = s.value
      }

      const env: Record<string, string> = {}
      const headers: Record<string, string> = {}
      for (const item of schema) {
        const val = valueMap[item.key]
        if (val === undefined) continue
        if (item.target === 'env') env[item.key] = val
        else headers[item.key] = val
      }
      return { env, headers }
    },
  }

  return api
}

export type McpUserConfigApi = ReturnType<typeof createMcpUserConfigApi>
