import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'crypto'
import { textToPinyin } from '../utils/pinyin.js'
import { resolveIconUrl } from '../utils/iconUrl.js'
import { hasScope } from '../auth/token.js'

type SqlRow = Record<string, unknown>

function now(): number {
  return Date.now()
}

// URL pattern validation (ported from sudowork-server)
function isValidUrlPattern(value: string): boolean {
  if (!value || !value.trim()) return true
  const trimmed = value.trim()
  if (trimmed.length > 256) return false
  if (!/^https?:\/\//.test(trimmed)) return false
  const afterScheme = trimmed.replace(/^https?:\/\//, '')
  const slashIdx = afterScheme.indexOf('/')
  const hostPart = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx)
  const pathPart = slashIdx === -1 ? '' : afterScheme.slice(slashIdx)
  if (!hostPart) return false
  // Host validation
  const colonIdx = hostPart.lastIndexOf(':')
  const hostNoPort = colonIdx > 0 ? hostPart.slice(0, colonIdx) : hostPart
  const port = colonIdx > 0 ? hostPart.slice(colonIdx + 1) : null
  if (port !== null) {
    if (!/^\d{1,5}$/.test(port)) return false
    const pn = parseInt(port, 10)
    if (pn < 1 || pn > 65535) return false
  }
  if (hostNoPort === '*') { /* ok */ }
  else if (hostNoPort.startsWith('*.')) {
    const domain = hostNoPort.slice(2)
    if (domain.split('.').length < 2) return false
  }
  else if (hostNoPort === 'localhost') { /* ok */ }
  else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostNoPort)) { /* ok */ }
  else {
    const labels = hostNoPort.split('.')
    if (labels.length < 2) return false
    for (const l of labels) {
      if (!l || l.length > 63 || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l)) return false
    }
  }
  // Path validation
  if (pathPart) {
    if (!pathPart.startsWith('/')) return false
    if (pathPart.includes('**') || /[\[\]{}]/.test(pathPart)) return false
    if (!/^[a-zA-Z0-9\-._~!$&'()*+,;=:%@?/]+$/.test(pathPart)) return false
  }
  return true
}

function mapConfigItem(row: SqlRow) {
  return {
    id: row.id as number,
    name: row.name as string,
    description: row.description as string | null,
    icon: resolveIconUrl(row.icon as string | null, 'config-items'),
    pinyin: row.pinyin as string,
    scope: row.scope as string,
    url_pattern: row.url_pattern as string | null,
    scheme: row.scheme as string | null,
    bearer_prefix: row.bearer_prefix as string | null,
    auth_type: (row.auth_type as string | null) ?? null,
    token_url: (row.token_url as string | null) ?? null,
    token_request_json: (row.token_request_json as string | null) ?? null,
    mint_script: (row.mint_script as string | null) ?? null,
    status: row.status as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  }
}

function mapConfigEntry(row: SqlRow) {
  return {
    id: row.id as number,
    config_item_id: row.config_item_id as number,
    config_key: row.config_key as string,
    name: row.name as string,
    config_desc: row.config_desc as string | null,
    required: row.required as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  }
}

export function createConfigItemsApi(db: {
  listConfigItems: (opts: { name?: string; scope?: string; status?: string; page?: number; pageSize?: number }) => { items: SqlRow[]; total: number }
  getConfigItem: (id: number) => SqlRow | null
  getConfigItemByPinyin: (pinyin: string) => SqlRow | null
  createConfigItem: (row: { name: string; description?: string; icon?: string; pinyin: string; scope: string; url_pattern?: string; scheme?: string; bearer_prefix?: string; status?: number; auth_type?: string; token_url?: string; token_request_json?: string; mint_script?: string }) => number
  updateConfigItem: (id: number, updates: Record<string, unknown>) => void
  deleteConfigItem: (id: number) => void
  getConfigEntries: (configItemId: number) => SqlRow[]
  replaceConfigEntries: (configItemId: number, entries: { config_key: string; name: string; config_desc?: string; required?: boolean }[]) => void
  getAllActiveConfigItems: () => SqlRow[]
  getDepartmentPolicies: (departmentId: string) => SqlRow[]
}) {
  const api = {
    list(orgId: string, userId: string, params: {
      page?: number
      page_size?: number
      name?: string
      scope?: string
      status?: string
    }) {
      const { items, total } = db.listConfigItems({
        name: params.name,
        scope: params.scope,
        status: params.status,
        page: params.page,
        pageSize: params.page_size,
      })
      const mapped = items.map(item => {
        const entries = db.getConfigEntries(item.id as number)
        return { ...mapConfigItem(item), entries: entries.map(mapConfigEntry) }
      })
      return {
        success: true,
        data: mapped,
        total,
        page: params.page ?? 1,
        page_size: params.page_size ?? 20,
      }
    },

    get(orgId: string, userId: string, id: number) {
      const item = db.getConfigItem(id)
      if (!item) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }
      const entries = db.getConfigEntries(id)
      return { success: true, data: { ...mapConfigItem(item), entries: entries.map(mapConfigEntry) } }
    },

    create(orgId: string, userId: string, body: {
      name: string
      pinyin?: string
      description?: string
      icon?: string
      scope: string
      url_pattern?: string
      scheme?: string
      bearer_prefix?: string
      auth_type?: string
      token_url?: string
      token_request_json?: string
      mint_script?: string
      entries: { config_key: string; name: string; config_desc?: string; required?: boolean }[]
    }) {
      if (!body.name?.trim()) {
        return { success: false, error: { code: 'validation_error', message: '名称不能为空' } }
      }
      // A URL-matched 凭据 needs an auth method: either a static injection
      // scheme (bearer/basic/header/query) OR a login-type auth_type that mints
      // a token (oauth2_* / script).
      const isLoginType = typeof body.auth_type === 'string' && body.auth_type !== '' && body.auth_type !== 'static'
      if (body.url_pattern?.trim() && !body.scheme && !isLoginType) {
        return { success: false, error: { code: 'validation_error', message: 'URL 模式已填写，请选择认证方案' } }
      }
      if (body.url_pattern?.trim() && !isValidUrlPattern(body.url_pattern.trim())) {
        return { success: false, error: { code: 'validation_error', message: 'URL 模式格式不正确，需以 http:// 或 https:// 开头，路径中可使用 * 和 ? 通配符' } }
      }
      if (body.scheme && body.scheme !== 'bearer' && body.bearer_prefix?.trim()) {
        return { success: false, error: { code: 'validation_error', message: '仅 Bearer 方案可以设置前缀' } }
      }
      if (['bearer', 'basic'].includes(body.scheme ?? '') && body.entries?.length > 1) {
        return { success: false, error: { code: 'validation_error', message: 'Bearer/Basic 方案只允许 1 个字段' } }
      }
      if (body.entries?.some((e: { config_key?: string; name?: string }) => !e.config_key?.trim() || !e.name?.trim())) {
        return { success: false, error: { code: 'validation_error', message: '请填写所有字段的标识和名称' } }
      }

      let pinyin = body.pinyin?.trim() || textToPinyin(body.name)
      // Validate custom pinyin format
      if (pinyin && !/^[a-z0-9_-]+$/.test(pinyin)) {
        return { success: false, error: { code: 'validation_error', message: '拼音标识仅允许小写字母、数字、下划线和连字符' } }
      }
      // Ensure unique pinyin
      let suffix = 0
      let candidate = pinyin
      while (db.getConfigItemByPinyin(candidate)) {
        suffix++
        candidate = `${pinyin}_${suffix}`
      }
      pinyin = candidate

      try {
        const id = db.createConfigItem({
          name: body.name.trim(),
          description: body.description,
          icon: body.icon,
          pinyin,
          scope: body.scope || 'system',
          url_pattern: body.url_pattern,
          scheme: body.scheme,
          bearer_prefix: body.bearer_prefix,
          auth_type: body.auth_type,
          token_url: body.token_url,
          token_request_json: body.token_request_json,
          mint_script: body.mint_script,
        })

        if (body.entries?.length > 0) {
          db.replaceConfigEntries(id, body.entries)
        }

        return api.get(orgId, userId, id)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('UNIQUE')) {
          return { success: false, error: { code: 'conflict', message: '配置项名称已存在' } }
        }
        throw error
      }
    },

    update(orgId: string, userId: string, id: number, body: {
      name?: string
      description?: string
      icon?: string
      pinyin?: string
      scope?: string
      url_pattern?: string
      scheme?: string
      bearer_prefix?: string
      auth_type?: string
      token_url?: string
      token_request_json?: string
      mint_script?: string
      entries?: { config_key: string; name: string; config_desc?: string; required?: boolean }[]
    }) {
      const existing = db.getConfigItem(id)
      if (!existing) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }

      if (body.url_pattern?.trim() && !isValidUrlPattern(body.url_pattern.trim())) {
        return { success: false, error: { code: 'validation_error', message: 'URL 模式格式不正确，需以 http:// 或 https:// 开头，路径中可使用 * 和 ? 通配符' } }
      }

      if (body.pinyin && body.pinyin !== existing.pinyin) {
        if (!/^[a-z0-9_-]+$/.test(body.pinyin)) {
          return { success: false, error: { code: 'validation_error', message: '拼音标识仅允许小写字母、数字、下划线和连字符' } }
        }
        if (body.pinyin.length > 128) {
          return { success: false, error: { code: 'validation_error', message: '拼音标识不能超过 128 个字符' } }
        }
        const conflict = db.getConfigItemByPinyin(body.pinyin)
        if (conflict && (conflict.id as number) !== id) {
          return { success: false, error: { code: 'conflict', message: '拼音标识已被占用' } }
        }
      }

      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name
      if (body.description !== undefined) updates.description = body.description
      if (body.icon !== undefined) updates.icon = body.icon
      if (body.pinyin !== undefined) updates.pinyin = body.pinyin
      if (body.scope !== undefined) updates.scope = body.scope
      if (body.url_pattern !== undefined) updates.url_pattern = body.url_pattern
      if (body.scheme !== undefined) updates.scheme = body.scheme
      if (body.bearer_prefix !== undefined) updates.bearer_prefix = body.bearer_prefix
      if (body.auth_type !== undefined) updates.auth_type = body.auth_type
      if (body.token_url !== undefined) updates.token_url = body.token_url
      if (body.token_request_json !== undefined) updates.token_request_json = body.token_request_json
      if (body.mint_script !== undefined) updates.mint_script = body.mint_script
      updates.updated_at = now()

      try {
        db.updateConfigItem(id, updates)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('UNIQUE')) {
          return { success: false, error: { code: 'conflict', message: '名称或拼音标识冲突' } }
        }
        throw error
      }

      if (body.entries) {
        db.replaceConfigEntries(id, body.entries)
      }

      return api.get(orgId, userId, id)
    },

    updateStatus(orgId: string, userId: string, id: number, status: number) {
      const existing = db.getConfigItem(id)
      if (!existing) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }
      db.updateConfigItem(id, { status, updated_at: now() })
      return { success: true, data: { id, status } }
    },

    delete(orgId: string, userId: string, id: number) {
      const existing = db.getConfigItem(id)
      if (!existing) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }
      db.deleteConfigItem(id)
      return { success: true }
    },

    /** Public endpoint: returns config items visible to the caller.
     *  - admin: all active items
     *  - non-admin: scope=system items (all) + scope=user items (all) + scope=department items (department-authorized only)
     *  - non-admin without department: scope=system items (all) + scope=user items (all)
     */
    listPublic(
      auth: { role: string; scopes: string[]; userId: string },
      getUserById: (userId: string) => { status: string; departmentId: string | null } | null,
    ) {
      const allItems = db.getAllActiveConfigItems()

      // Helper: map a raw item row to the public DTO
      const mapItem = (item: SqlRow) => {
        const entries = db.getConfigEntries(item.id as number)
        return {
          id: item.id as number,
          name: item.name as string,
          icon: resolveIconUrl(item.icon as string | null, 'config-items'),
          icon_url: resolveIconUrl(item.icon as string | null, 'config-items'),
          pinyin: item.pinyin as string,
          scope: item.scope as string,
          url_pattern: item.url_pattern as string | null,
          scheme: item.scheme as string | null,
          bearer_prefix: item.bearer_prefix as string | null,
          description: item.description as string | null,
          entries: entries.map(mapConfigEntry),
        }
      }

      // Rule 1: admin sees everything (excluding items with no entries)
      if (auth.role === 'admin' || hasScope(auth.scopes, '*')) {
        return { success: true, data: allItems.map(mapItem).filter(item => item.entries.length > 0) }
      }

      // Rule 2: non-admin — determine department-authorized config item IDs
      let authorizedDeptIds: Set<number> = new Set()
      const user = getUserById(auth.userId)
      const deptId = user?.departmentId ?? null
      if (deptId) {
        const policies = db.getDepartmentPolicies(deptId)
        authorizedDeptIds = new Set(policies.map(p => p.config_item_id as number))
      }

      // Rule 3: scope=user always visible; scope=system always visible; scope=department needs authorization
      const filtered = allItems.filter(item => {
        const scope = item.scope as string
        if (scope === 'user') return true
        if (scope === 'system') return true
        if (scope === 'department') return authorizedDeptIds.has(item.id as number)
        return false
      })

      return { success: true, data: filtered.map(mapItem).filter(item => item.entries.length > 0) }
    },
  }
  return api
}

export type ConfigItemsApi = ReturnType<typeof createConfigItemsApi>
