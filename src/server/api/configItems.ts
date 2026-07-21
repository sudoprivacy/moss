import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'crypto'
import { textToPinyin } from '../utils/pinyin.js'
import { resolveIconUrl } from '../utils/iconUrl.js'
import { hasScope } from '../auth/token.js'
import { parseBodyAuthCheck } from '../authProxy/bodyAuthCheck.js'

type SqlRow = Record<string, unknown>

function now(): number {
  return Date.now()
}

/**
 * Validate an admin-supplied `body_auth_check` recipe. Returns an error message
 * for a malformed value, or null when it's empty (feature off) or valid.
 * A recipe must be a JSON object; `field` (if present) a non-empty string and
 * `unauthorizedValues` (if present) a non-empty array of strings/numbers.
 */
function validateBodyAuthCheck(raw: string | null | undefined): string | null {
  if (raw == null || !raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'body_auth_check 必须是合法的 JSON'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'body_auth_check 必须是 JSON 对象，例如 {"field":"code","unauthorizedValues":[401]}'
  }
  const r = parsed as Record<string, unknown>
  if ('field' in r && (typeof r.field !== 'string' || !r.field.trim())) {
    return 'body_auth_check.field 必须是非空字符串'
  }
  if ('unauthorizedValues' in r) {
    if (!Array.isArray(r.unauthorizedValues) || r.unauthorizedValues.length === 0) {
      return 'body_auth_check.unauthorizedValues 必须是非空数组'
    }
    if (!r.unauthorizedValues.every(v => typeof v === 'string' || typeof v === 'number')) {
      return 'body_auth_check.unauthorizedValues 只能包含字符串或数字'
    }
  }
  return null
}

/**
 * Normalize a `body_auth_check` value for storage: empty → null (feature off);
 * a valid recipe is re-serialized via the shared parser so what's stored is
 * exactly what the auth proxy will honor (unknown keys dropped, whitespace
 * trimmed). Assumes validateBodyAuthCheck already passed.
 */
function normalizeBodyAuthCheck(raw: string | null | undefined): string | undefined {
  if (raw == null || !raw.trim()) return undefined
  const recipe = parseBodyAuthCheck(raw)
  return recipe ? JSON.stringify(recipe) : undefined
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
    body_auth_check: (row.body_auth_check as string | null) ?? null,
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
  listConfigItems: (opts: { name?: string; scope?: string; status?: string; page?: number; pageSize?: number; orgId?: string }) => { items: SqlRow[]; total: number }
  getConfigItem: (id: number, orgId?: string) => SqlRow | null
  getConfigItemByPinyin: (pinyin: string, orgId?: string) => SqlRow | null
  createConfigItem: (row: { name: string; description?: string; icon?: string; pinyin: string; scope: string; url_pattern?: string; scheme?: string; bearer_prefix?: string; status?: number; org_id?: string | null; auth_type?: string; token_url?: string; token_request_json?: string; mint_script?: string; body_auth_check?: string }) => number
  updateConfigItem: (id: number, updates: Record<string, unknown>, orgId?: string) => void
  deleteConfigItem: (id: number, orgId?: string) => void
  getConfigEntries: (configItemId: number) => SqlRow[]
  replaceConfigEntries: (configItemId: number, entries: { config_key: string; name: string; config_desc?: string; required?: boolean }[]) => void
  getAllActiveConfigItems: (orgId?: string) => SqlRow[]
  getDepartmentPolicies: (departmentId: string, orgId?: string) => SqlRow[]
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
        orgId,
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
      const item = db.getConfigItem(id, orgId)
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
      body_auth_check?: string
      entries: { config_key: string; name: string; config_desc?: string; required?: boolean }[]
    }) {
      if (!body.name?.trim()) {
        return { success: false, error: { code: 'validation_error', message: '名称不能为空' } }
      }
      const bodyAuthErr = validateBodyAuthCheck(body.body_auth_check)
      if (bodyAuthErr) {
        return { success: false, error: { code: 'validation_error', message: bodyAuthErr } }
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

      const scope = body.scope || 'system'
      // Non-user items are org-bound; user-scope definitions stay global.
      const itemOrgId = scope === 'user' ? null : orgId
      let pinyin = body.pinyin?.trim() || textToPinyin(body.name)
      // Validate custom pinyin format
      if (pinyin && !/^[a-z0-9_-]+$/.test(pinyin)) {
        return { success: false, error: { code: 'validation_error', message: '拼音标识仅允许小写字母、数字、下划线和连字符' } }
      }
      // Ensure unique pinyin within the relevant scope: per-org for non-user
      // items (so two orgs may reuse a pinyin), global for user-scope defs.
      let suffix = 0
      let candidate = pinyin
      while (db.getConfigItemByPinyin(candidate, itemOrgId ?? undefined)) {
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
          scope,
          org_id: itemOrgId,
          url_pattern: body.url_pattern,
          scheme: body.scheme,
          bearer_prefix: body.bearer_prefix,
          auth_type: body.auth_type,
          token_url: body.token_url,
          token_request_json: body.token_request_json,
          body_auth_check: normalizeBodyAuthCheck(body.body_auth_check),
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
      body_auth_check?: string | null
      entries?: { config_key: string; name: string; config_desc?: string; required?: boolean }[]
    }) {
      const existing = db.getConfigItem(id, orgId)
      if (!existing) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }

      if (body.url_pattern?.trim() && !isValidUrlPattern(body.url_pattern.trim())) {
        return { success: false, error: { code: 'validation_error', message: 'URL 模式格式不正确，需以 http:// 或 https:// 开头，路径中可使用 * 和 ? 通配符' } }
      }
      if (body.body_auth_check !== undefined && body.body_auth_check !== null) {
        const bodyAuthErr = validateBodyAuthCheck(body.body_auth_check)
        if (bodyAuthErr) {
          return { success: false, error: { code: 'validation_error', message: bodyAuthErr } }
        }
      }

      if (body.pinyin && body.pinyin !== existing.pinyin) {
        if (!/^[a-z0-9_-]+$/.test(body.pinyin)) {
          return { success: false, error: { code: 'validation_error', message: '拼音标识仅允许小写字母、数字、下划线和连字符' } }
        }
        if (body.pinyin.length > 128) {
          return { success: false, error: { code: 'validation_error', message: '拼音标识不能超过 128 个字符' } }
        }
        const conflictOrg = (existing.scope as string) === 'user' ? undefined : orgId
        const conflict = db.getConfigItemByPinyin(body.pinyin, conflictOrg)
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
      // Empty string clears the recipe (null); a non-empty value is normalized.
      if (body.body_auth_check !== undefined) {
        updates.body_auth_check = normalizeBodyAuthCheck(body.body_auth_check)
      }
      updates.updated_at = now()

      try {
        db.updateConfigItem(id, updates, orgId)
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
      const existing = db.getConfigItem(id, orgId)
      if (!existing) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }
      db.updateConfigItem(id, { status, updated_at: now() }, orgId)
      return { success: true, data: { id, status } }
    },

    delete(orgId: string, userId: string, id: number) {
      const existing = db.getConfigItem(id, orgId)
      if (!existing) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }
      db.deleteConfigItem(id, orgId)
      return { success: true }
    },

    /** Public endpoint: returns config items visible to the caller.
     *  - admin: all active items
     *  - non-admin: scope=system items (all) + scope=user items (all) + scope=department items (department-authorized only)
     *  - non-admin without department: scope=system items (all) + scope=user items (all)
     */
    listPublic(
      auth: { role: string; scopes: string[]; userId: string; orgId: string },
      getUserById: (userId: string) => { status: string; departmentId: string | null } | null,
    ) {
      // Org-scope: only this org's non-user items (+ global user-scope defs).
      const allItems = db.getAllActiveConfigItems(auth.orgId)

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

      // Rule 1: admin sees everything in their org (excluding items with no entries)
      if (auth.role === 'admin' || auth.role === 'super_admin' || hasScope(auth.scopes, '*')) {
        return { success: true, data: allItems.map(mapItem).filter(item => item.entries.length > 0) }
      }

      // Rule 2: non-admin — determine department-authorized config item IDs
      let authorizedDeptIds: Set<number> = new Set()
      const user = getUserById(auth.userId)
      const deptId = user?.departmentId ?? null
      if (deptId) {
        const policies = db.getDepartmentPolicies(deptId, auth.orgId)
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
