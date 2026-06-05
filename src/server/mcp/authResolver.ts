/**
 * MCP 鉴权解析模块（高内聚）
 *
 * 将所有 auth_type 相关的解析、验证、格式化逻辑集中在此模块，
 * 供 scodeMcpInjector.ts、testConnection.ts、mcpAdmin.ts 三处复用。
 *
 * parseHeaders 从 testConnection.ts 迁入此模块，以消除循环依赖：
 *   旧：authResolver → testConnection (parseHeaders) + testConnection → authResolver (resolveAuthHeaders) = 循环
 *   新：testConnection → authResolver（单向）
 */

import { SYSTEM_SECRET_SUBJECT } from '../secrets/secretSubject.js'

// ============================================================
// 类型定义
// ============================================================

/** Bearer 鉴权配置 */
export interface BearerAuthConfig {
  header_name: string   // 默认 "Authorization"
  prefix: string        // 默认 "Bearer"，可为空字符串
  token: string
}

/** Basic Auth 鉴权配置 */
export interface BasicAuthConfig {
  header_name: string   // 默认 "Authorization"
  username: string
  password: string
}

/** API Key 鉴权配置 */
export interface ApiKeyAuthConfig {
  header_name: string   // 默认 "X-API-Key"
  api_key: string
}

/** OAuth 鉴权配置 */
export interface OAuthAuthConfig {
  client_id: string
  client_secret: string
  authorization_url: string
  token_url: string
  scopes?: string
}

/**
 * ConfigItem 最小接口——后端不依赖前端 ConfigItem 完整类型，
 * 仅定义 resolveSecretRefHeaders 实际需要的字段。
 */
export interface ConfigItemLike {
  pinyin: string
  scheme: 'bearer' | 'basic' | 'header' | 'query' | null
  bearer_prefix: string | null
  entries: Array<{ config_key: string }>
}

/**
 * secretsApi 依赖注入接口。
 * 命名为 McpAuthSecretsApi 避免与 createSecretsApi（src/server/api/secrets.ts）混淆。
 */
export interface McpAuthSecretsApi {
  getConfigItemByPinyin(pinyin: string): ConfigItemLike | null
  listSecrets(namespace: string, subject: string): Promise<{ key: string; value: string | null }[]>
}

// ============================================================
// parseHeaders（从 testConnection.ts 迁入）
// ============================================================

/**
 * 将 flat KV JSON 字符串解析为 headers 对象。
 * 用于 custom_header 类型和旧格式数据兜底。
 */
export function parseHeaders(authConfigJson: string | null): Record<string, string> | undefined {
  if (!authConfigJson) return undefined
  try {
    const parsed = JSON.parse(authConfigJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') headers[k] = v
      }
      return Object.keys(headers).length > 0 ? headers : undefined
    }
  } catch { /* ignore malformed headers */ }
  return undefined
}

// ============================================================
// resolveAuthHeaders
// ============================================================

/**
 * 根据 auth_type 将 auth_config_json 解析为 HTTP headers。
 *
 * - bearer/basic/api_key：按结构化 JSON 解析，自动做协议级格式化
 * - custom_header / oauth / 旧数据：走 parseHeaders 兜底
 * - bearer/basic/api_key 分支通过 `!('header_name' in c)` 检测旧 flat KV 格式并兜底
 */
export function resolveAuthHeaders(
  authType: string,
  authConfigJson: string | null,
): Record<string, string> {
  if (!authConfigJson || authType === 'none' || authType === 'secret_ref') {
    return {}
  }

  let config: Record<string, unknown>
  try {
    config = JSON.parse(authConfigJson)
  } catch {
    // JSON 格式错误时静默降级，避免单个坏配置导致整个 MCP settings 解析失败
    return {}
  }
  // 防御 null / 非对象值（如 JSON.parse("null") 或 JSON.parse("123")）
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}

  switch (authType) {
    case 'bearer': {
      const c = config as BearerAuthConfig
      // 旧 flat KV 格式（无 header_name 字段）→ 走 parseHeaders 兜底
      if (!('header_name' in c)) return parseHeaders(authConfigJson) ?? {}
      const value = c.prefix ? `${c.prefix} ${c.token}` : c.token
      return { [c.header_name]: value }
    }
    case 'basic': {
      const c = config as BasicAuthConfig
      if (!('header_name' in c)) return parseHeaders(authConfigJson) ?? {}
      const encoded = Buffer.from(`${c.username}:${c.password}`).toString('base64')
      return { [c.header_name]: `Basic ${encoded}` }
    }
    case 'api_key': {
      const c = config as ApiKeyAuthConfig
      if (!('header_name' in c)) return parseHeaders(authConfigJson) ?? {}
      return { [c.header_name]: c.api_key }
    }
    case 'custom_header':
      // 原逻辑：flat KV 直接作为 headers
      return parseHeaders(authConfigJson) ?? {}
    case 'oauth':
      // OAuth 暂按 custom_header 处理，等后续实现 token 获取流程
      return parseHeaders(authConfigJson) ?? {}
    default:
      // 未知 auth_type 兜底：flat KV 当 headers 用
      return parseHeaders(authConfigJson) ?? {}
  }
}

// ============================================================
// resolveSecretRefHeaders
// ============================================================

/**
 * 当 auth_type === 'secret_ref' 时，从 ConfigItem + Nexus 读取凭据并格式化。
 * 兼容旧格式 system:xxx 和新格式纯 pinyin。
 */
export async function resolveSecretRefHeaders(
  secretRef: string,
  getConfigItemByPinyin: (pinyin: string) => ConfigItemLike | null,
  listSecrets: (namespace: string, subject: string) => Promise<{ key: string; value: string | null }[]>,
): Promise<Record<string, string>> {
  if (!secretRef) return {}

  // 兼容旧格式 system:xxx 和新格式纯 pinyin
  const pinyin = secretRef.includes(':') ? secretRef.split(':').slice(-1)[0] : secretRef
  const configItem = getConfigItemByPinyin(pinyin)
  if (!configItem) return {}

  const namespace = `system:${configItem.pinyin}`
  const secrets = await listSecrets(namespace, SYSTEM_SECRET_SUBJECT)
  const valueMap: Record<string, string> = {}
  for (const s of secrets) {
    if (s.value !== null) valueMap[s.key] = s.value
  }

  switch (configItem.scheme) {
    case 'bearer': {
      const prefix = configItem.bearer_prefix ?? 'Bearer'
      const entry = configItem.entries[0]
      if (!entry || !valueMap[entry.config_key]) return {}
      return { 'Authorization': `${prefix} ${valueMap[entry.config_key]}` }
    }
    case 'basic': {
      // Secret Center 约束 basic 方案只有 1 个 entry（config-items-page.tsx:196）
      const entry = configItem.entries[0]
      if (!entry || !valueMap[entry.config_key]) return {}
      // ⚠️ 实施前需确认 basic 方案的 entry 实际存储格式
      const encoded = Buffer.from(valueMap[entry.config_key]).toString('base64')
      return { 'Authorization': `Basic ${encoded}` }
    }
    case 'header': {
      const headers: Record<string, string> = {}
      for (const entry of configItem.entries) {
        const val = valueMap[entry.config_key]
        if (val !== undefined) headers[entry.config_key] = val
      }
      return headers
    }
    default:
      return {}
  }
}

// ============================================================
// validateAuthConfig
// ============================================================

/**
 * 校验 auth_config_json 结构是否符合 auth_type 要求。
 * 供 mcpAdmin.ts 的 createMcpServer / updateMcpServer 调用。
 *
 * - 旧 flat KV 数据（无 header_name）跳过结构校验
 * - 有意容忍 auth_config_json 为 null（旧数据或 API 直接提交）
 */
export function validateAuthConfig(
  authType: string,
  authConfigJson: string | null,
  secretRef?: string | null,
): string | null {
  if (authType === 'none') return null

  // secret_ref 模式：单独校验 secretRef 字段
  if (authType === 'secret_ref') {
    if (!secretRef) return 'secret_ref 模式下 secret_ref 不能为空'
    return null
  }

  // 有意容忍 auth_config_json 为 null：旧数据或通过 API 直接提交时可能为空
  if (!authConfigJson) return null

  try {
    const config = JSON.parse(authConfigJson)
    switch (authType) {
      case 'bearer':
        if (!('header_name' in config)) break
        if (!config.header_name) return 'bearer 缺少必填字段 header_name'
        if (!config.token) return 'bearer 缺少必填字段 token'
        break
      case 'basic':
        if (!('header_name' in config)) break
        if (!config.header_name) return 'basic 缺少必填字段 header_name'
        if (!config.username || !config.password) return 'basic 缺少必填字段 username 或 password'
        break
      case 'api_key':
        if (!('header_name' in config)) break
        if (!config.header_name) return 'api_key 缺少必填字段 header_name'
        if (!config.api_key) return 'api_key 缺少必填字段 api_key'
        break
      case 'custom_header':
        break  // flat KV，不做结构验证
      case 'oauth':
        if (!config.client_id || !config.client_secret || !config.authorization_url || !config.token_url)
          return 'oauth 缺少必填字段 (client_id, client_secret, authorization_url, token_url)'
        break
    }
    return null
  } catch {
    return 'auth_config_json 格式错误'
  }
}
