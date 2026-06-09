import { randomUUID } from 'crypto'
import type { NexusClient } from '../nexus/nexusClient.js'
import {
  secretSubject,
  SYSTEM_SECRET_SUBJECT,
  DEPT_SECRET_SUBJECT,
  orgScopedNamespace,
  orgNamespacePrefix,
  stripOrgPrefix,
} from '../secrets/secretSubject.js'
import { resolveIconUrl } from '../utils/iconUrl.js'

type SqlRow = Record<string, unknown>

function now(): number {
  return Date.now()
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

function buildNamespace(scope: string, pinyin: string, orgId?: string): string {
  // Non-user (system/role) namespaces are org-bound; user namespaces already
  // isolated by userId. orgScopedNamespace() applies the org prefix when given.
  const base =
    scope === 'system' ? `system:${pinyin}`
      : scope === 'department' ? `role:${pinyin}`
        : `user:{userId}:${pinyin}`
  return orgId ? orgScopedNamespace(base, orgId) : base
}

export function createSecretsApi(db: {
  getConfigItem: (id: number, orgId?: string) => SqlRow | null
  getConfigItemByPinyin: (pinyin: string, orgId?: string) => SqlRow | null
  getConfigEntries: (configItemId: number) => SqlRow[]
  upsertSecretMetadata: (configItemId: number, expiresAt: number | null, orgId?: string | null) => void
  getSecretMetadata: (configItemId: number) => SqlRow | null
  getAllSecretMetadata: (orgId?: string) => SqlRow[]
  getExpiringSecretMetadata: (beforeTs: number, orgId?: string) => SqlRow[]
  insertAuditLog: (row: { id: string; actor_id: string; actor_name?: string; action: string; config_item_id?: number; org_id?: string | null; namespace: string; key: string; detail?: string; ip_address?: string }) => void
  queryAuditLog: (opts: { actor_id?: string; config_item_id?: number; action?: string; since?: number; until?: number; page?: number; pageSize?: number; orgId?: string }) => { items: SqlRow[]; total: number }
  getDepartmentPolicies: (departmentId: string, orgId?: string) => SqlRow[]
  replaceDepartmentPolicies: (departmentId: string, configItemIds: number[], orgId?: string | null) => void
}, nexus: NexusClient, getUserName: (userId: string) => string | undefined) {

  // Resolve a config item id from a (possibly org-prefixed) namespace, scoping
  // the pinyin lookup to the namespace's org so two orgs' same-pinyin items
  // don't collide.
  const resolveConfigItemId = (namespace: string, orgId?: string): number | undefined => {
    const base = stripOrgPrefix(namespace)
    const parts = base.split(':')
    if (parts[0] === 'system' || parts[0] === 'role') {
      const item = db.getConfigItemByPinyin(parts.slice(1).join(':'), orgId)
      return item ? (item.id as number) : undefined
    }
    if (parts[0] === 'user' && parts.length >= 3) {
      const item = db.getConfigItemByPinyin(parts.slice(2).join(':'), orgId)
      return item ? (item.id as number) : undefined
    }
    return undefined
  }

  const writeAudit = (actorId: string, actorName: string | undefined, action: string, configItemId: number | undefined, namespace: string, key: string, detail?: Record<string, unknown>, ip?: string, orgId?: string) => {
    try {
      db.insertAuditLog({
        id: randomUUID(),
        actor_id: actorId,
        actor_name: actorName ?? getUserName(actorId),
        action,
        config_item_id: configItemId ?? resolveConfigItemId(namespace, orgId),
        org_id: orgId ?? null,
        namespace,
        key,
        detail: detail ? JSON.stringify(detail) : undefined,
        ip_address: ip,
      })
    } catch {
      // Audit log failure should not block operations
    }
  }

  const api = {
    // --- Enterprise Secrets (system scope) ---

    async listEnterpriseSecrets(orgId: string, userId: string) {
      try {
        // Enterprise secrets are org-bound: list only this org's namespace.
        const secrets = await nexus.listSecrets(`${orgNamespacePrefix(orgId)}system`)
        // Enrich with config item data
        const enriched = secrets.map(s => {
          const pinyin = stripOrgPrefix(s.namespace).replace('system:', '')
          // We don't look up config items here for performance, frontend handles it
          // Expose a normalized `enabled` boolean alongside the raw `status` so
          // clients don't have to know the internal 'enabled'/'disabled' string.
          return { ...s, enabled: s.status === 'enabled', config_item: { pinyin } }
        })
        return { success: true, data: enriched }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    // --- Department Secrets (role scope) ---

    async listDepartmentSecrets(orgId: string, userId: string) {
      try {
        // Department secrets are org-bound: list only this org's namespace.
        const secrets = await nexus.listSecrets(`${orgNamespacePrefix(orgId)}role`)
        const enriched = secrets.map(s => {
          const pinyin = stripOrgPrefix(s.namespace).replace('role:', '')
          return { ...s, enabled: s.status === 'enabled', config_item: { pinyin } }
        })
        return { success: true, data: enriched }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async getSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        const ns = orgScopedNamespace(namespace, orgId)
        const secret = await nexus.getSecret(ns, key, secretSubject(ns, userId))
        if (!secret) return { success: false, error: { code: 'not_found', message: '凭据不存在' } }
        writeAudit(userId, undefined, 'read', undefined, ns, key, undefined, ip, orgId)
        return { success: true, data: secret }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async putSecret(orgId: string, userId: string, namespace: string, key: string, value: string, metadata?: { expires_at?: number | null }, ip?: string) {
      try {
        const ns = orgScopedNamespace(namespace, orgId)
        const configItemId = resolveConfigItemId(ns, orgId)
        if (configItemId) {
          const entries = db.getConfigEntries(configItemId)
          const matched = entries.find(e => (e.config_key as string) === key)
          if (matched && (matched.required as number) === 1 && (!value || !value.trim())) {
            return { success: false, error: { code: 'validation_error', message: `必填项"${matched.name as string}"不能为空` } }
          }
        }
        const existing = await nexus.getSecret(ns, key, secretSubject(ns, userId)).catch(() => null)
        const action = existing && existing.version > 0 ? 'updated' : 'created'
        await nexus.putSecret(ns, key, value, secretSubject(ns, userId))
        writeAudit(userId, undefined, action, undefined, ns, key, { value_length: value.length }, ip, orgId)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async deleteSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        const ns = orgScopedNamespace(namespace, orgId)
        await nexus.deleteSecret(ns, key, secretSubject(ns, userId))
        writeAudit(userId, undefined, 'deleted', undefined, ns, key, undefined, ip, orgId)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async enableSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        const ns = orgScopedNamespace(namespace, orgId)
        await nexus.enableSecret(ns, key, secretSubject(ns, userId))
        writeAudit(userId, undefined, 'enabled', undefined, ns, key, undefined, ip, orgId)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async disableSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        const ns = orgScopedNamespace(namespace, orgId)
        await nexus.disableSecret(ns, key, secretSubject(ns, userId))
        writeAudit(userId, undefined, 'disabled', undefined, ns, key, undefined, ip, orgId)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    // --- Secret Metadata (expiry) ---

    listMetadata(orgId: string, userId: string) {
      const rows = db.getAllSecretMetadata(orgId)
      const data = rows.map(r => ({
        config_item_id: r.config_item_id as number,
        expires_at: r.expires_at as number | null,
      }))
      return { success: true, data }
    },

    updateMetadata(orgId: string, userId: string, configItemId: number, expiresAt: number | null) {
      // Org guard: only touch metadata for a config item the caller's org owns.
      const item = db.getConfigItem(configItemId, orgId)
      if (!item) return { success: false, error: { code: 'not_found', message: '配置项不存在' } }
      db.upsertSecretMetadata(configItemId, expiresAt, orgId)
      return { success: true }
    },

    // --- Department Policies ---

    getDepartmentPolicies(orgId: string, userId: string, departmentId: string) {
      const rows = db.getDepartmentPolicies(departmentId, orgId)
      const configItemIds = rows.map(r => r.config_item_id as number)
      return { success: true, data: { department_id: departmentId, config_item_ids: configItemIds } }
    },

    updateDepartmentPolicies(orgId: string, userId: string, departmentId: string, configItemIds: number[]) {
      db.replaceDepartmentPolicies(departmentId, configItemIds, orgId)
      return { success: true }
    },

    // --- Audit Log ---

    listAuditLog(orgId: string, userId: string, params: {
      actor_id?: string
      config_item_id?: number
      action?: string
      since?: number
      until?: number
      page?: number
      page_size?: number
    }) {
      const { items, total } = db.queryAuditLog({
        actor_id: params.actor_id,
        config_item_id: params.config_item_id,
        action: params.action,
        since: params.since,
        until: params.until,
        page: params.page,
        pageSize: params.page_size,
        orgId,
      })
      const mapped = items.map(r => ({
        id: r.id as string,
        actor_id: r.actor_id as string,
        actor_name: r.actor_name as string | null,
        action: r.action as string,
        config_item_id: r.config_item_id as number | null,
        namespace: r.namespace as string,
        key: r.key as string,
        detail: r.detail ? JSON.parse(r.detail as string) : null,
        ip_address: r.ip_address as string | null,
        created_at: r.created_at as number,
      }))
      return { success: true, data: mapped, total, page: params.page ?? 1, page_size: params.page_size ?? 20 }
    },

    // --- Rotation Alerts ---

    listRotationAlerts(orgId: string, userId: string) {
      const oneDayFromNow = Date.now() + 86400000
      const rows = db.getExpiringSecretMetadata(oneDayFromNow, orgId)
      const data = rows.map(r => {
        const itemId = r.config_item_id as number
        const item = db.getConfigItem(itemId, orgId)
        const entries = item ? db.getConfigEntries(itemId) : []
        return {
          config_item_id: itemId,
          expires_at: r.expires_at as number,
          config_item: item ? {
            id: item.id as number,
            name: item.name as string,
            description: item.description as string | null,
            icon: resolveIconUrl(item.icon as string | null, 'config-items'),
            icon_url: resolveIconUrl(item.icon as string | null, 'config-items'),
            pinyin: item.pinyin as string,
            scope: item.scope as string,
            url_pattern: item.url_pattern as string | null,
            scheme: item.scheme as string | null,
            bearer_prefix: item.bearer_prefix as string | null,
            status: item.status as number,
            entries: entries.map(mapConfigEntry),
            created_at: item.created_at as number,
            updated_at: item.updated_at as number,
          } : null,
        }
      }).filter(r => r.config_item !== null)
      return { success: true, data }
    },

    // --- User Secrets (me endpoints) ---

    async listUserSecrets(orgId: string, userId: string) {
      try {
        const secrets = await nexus.listSecrets(`user:${userId}`)
        // Expose a normalized `enabled` boolean alongside the raw `status`.
        // nexus stores enablement as status: 'enabled'|'disabled'; clients toggle
        // on a boolean, so derive it here to keep the contract explicit.
        const withEnabled = secrets.map(s => ({ ...s, enabled: s.status === 'enabled' }))
        return { success: true, data: withEnabled }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async getUserSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      // Verify namespace belongs to user
      if (!namespace.startsWith(`user:${userId}:`)) {
        return { success: false, error: { code: 'forbidden', message: '无权访问该凭据' } }
      }
      return api.getSecret(orgId, userId, namespace, key, ip)
    },

    async putUserSecret(orgId: string, userId: string, namespace: string, key: string, value: string, ip?: string) {
      if (!namespace.startsWith(`user:${userId}:`)) {
        return { success: false, error: { code: 'forbidden', message: '无权写入该凭据' } }
      }
      return api.putSecret(orgId, userId, namespace, key, value, undefined, ip)
    },

    async deleteUserSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      if (!namespace.startsWith(`user:${userId}:`)) {
        return { success: false, error: { code: 'forbidden', message: '无权删除该凭据' } }
      }
      return api.deleteSecret(orgId, userId, namespace, key, ip)
    },

    async enableUserSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      if (!namespace.startsWith(`user:${userId}:`)) {
        return { success: false, error: { code: 'forbidden', message: '无权操作该凭据' } }
      }
      return api.enableSecret(orgId, userId, namespace, key, ip)
    },

    async disableUserSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      if (!namespace.startsWith(`user:${userId}:`)) {
        return { success: false, error: { code: 'forbidden', message: '无权操作该凭据' } }
      }
      return api.disableSecret(orgId, userId, namespace, key, ip)
    },
  }

  return api
}

export type SecretsApi = ReturnType<typeof createSecretsApi>
