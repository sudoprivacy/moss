import { randomUUID } from 'crypto'
import type { NexusClient } from '../nexus/nexusClient.js'

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

function buildNamespace(scope: string, pinyin: string): string {
  return scope === 'system' ? `system:${pinyin}` : `user:{userId}:${pinyin}`
}

export function createSecretsApi(db: {
  getConfigItem: (id: number) => SqlRow | null
  getConfigItemByPinyin: (pinyin: string) => SqlRow | null
  getConfigEntries: (configItemId: number) => SqlRow[]
  upsertSecretMetadata: (configItemId: number, expiresAt: number | null) => void
  getSecretMetadata: (configItemId: number) => SqlRow | null
  getAllSecretMetadata: () => SqlRow[]
  getExpiringSecretMetadata: (beforeTs: number) => SqlRow[]
  insertAuditLog: (row: { id: string; actor_id: string; actor_name?: string; action: string; config_item_id?: number; namespace: string; key: string; detail?: string; ip_address?: string }) => void
  queryAuditLog: (opts: { actor_id?: string; config_item_id?: number; action?: string; since?: number; until?: number; page?: number; pageSize?: number }) => { items: SqlRow[]; total: number }
  getDepartmentPolicies: (departmentId: string) => SqlRow[]
  replaceDepartmentPolicies: (departmentId: string, configItemIds: number[]) => void
}, nexus: NexusClient, getUserName: (userId: string) => string | undefined) {

  const resolveConfigItemId = (namespace: string): number | undefined => {
    const parts = namespace.split(':')
    if (parts[0] === 'system') {
      const item = db.getConfigItemByPinyin(parts.slice(1).join(':'))
      return item ? (item.id as number) : undefined
    }
    if (parts[0] === 'user' && parts.length >= 3) {
      const item = db.getConfigItemByPinyin(parts.slice(2).join(':'))
      return item ? (item.id as number) : undefined
    }
    return undefined
  }

  const writeAudit = (actorId: string, actorName: string | undefined, action: string, configItemId: number | undefined, namespace: string, key: string, detail?: Record<string, unknown>, ip?: string) => {
    try {
      db.insertAuditLog({
        id: randomUUID(),
        actor_id: actorId,
        actor_name: actorName ?? getUserName(actorId),
        action,
        config_item_id: configItemId ?? resolveConfigItemId(namespace),
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
        const secrets = await nexus.listSecrets(undefined, userId)
        // Filter to system:* namespace
        const systemSecrets = secrets.filter(s => s.namespace.startsWith('system:'))
        // Enrich with config item data
        const enriched = systemSecrets.map(s => {
          const pinyin = s.namespace.replace('system:', '')
          // We don't look up config items here for performance, frontend handles it
          return { ...s, config_item: { pinyin } }
        })
        return { success: true, data: enriched }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async getSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        const secret = await nexus.getSecret(namespace, key, userId)
        if (!secret) return { success: false, error: { code: 'not_found', message: '凭据不存在' } }
        writeAudit(userId, undefined, 'read', undefined, namespace, key, undefined, ip)
        return { success: true, data: secret }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async putSecret(orgId: string, userId: string, namespace: string, key: string, value: string, metadata?: { expires_at?: number | null }, ip?: string) {
      try {
        const existing = await nexus.getSecret(namespace, key, userId).catch(() => null)
        const action = existing && existing.version > 0 ? 'updated' : 'created'
        await nexus.putSecret(namespace, key, value, userId)
        writeAudit(userId, undefined, action, undefined, namespace, key, { value_length: value.length }, ip)
        // Handle metadata if provided
        if (metadata && metadata.expires_at !== undefined) {
          // Extract config item from namespace
          const parts = namespace.split(':')
          const pinyin = parts.slice(1).join(':')
          // Find config item by pinyin - not available here, handled by route
        }
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async deleteSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        await nexus.deleteSecret(namespace, key, userId)
        writeAudit(userId, undefined, 'deleted', undefined, namespace, key, undefined, ip)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async enableSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        await nexus.enableSecret(namespace, key, userId)
        writeAudit(userId, undefined, 'enabled', undefined, namespace, key, undefined, ip)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    async disableSecret(orgId: string, userId: string, namespace: string, key: string, ip?: string) {
      try {
        await nexus.disableSecret(namespace, key, userId)
        writeAudit(userId, undefined, 'disabled', undefined, namespace, key, undefined, ip)
        return { success: true }
      } catch {
        return { success: false, error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' } }
      }
    },

    // --- Secret Metadata (expiry) ---

    listMetadata(orgId: string, userId: string) {
      const rows = db.getAllSecretMetadata()
      const data = rows.map(r => ({
        config_item_id: r.config_item_id as number,
        expires_at: r.expires_at as number | null,
      }))
      return { success: true, data }
    },

    updateMetadata(orgId: string, userId: string, configItemId: number, expiresAt: number | null) {
      db.upsertSecretMetadata(configItemId, expiresAt)
      return { success: true }
    },

    // --- Department Policies ---

    getDepartmentPolicies(orgId: string, userId: string, departmentId: string) {
      const rows = db.getDepartmentPolicies(departmentId)
      const configItemIds = rows.map(r => r.config_item_id as number)
      return { success: true, data: { department_id: departmentId, config_item_ids: configItemIds } }
    },

    updateDepartmentPolicies(orgId: string, userId: string, departmentId: string, configItemIds: number[]) {
      db.replaceDepartmentPolicies(departmentId, configItemIds)
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
      const rows = db.getExpiringSecretMetadata(oneDayFromNow)
      const data = rows.map(r => {
        const itemId = r.config_item_id as number
        const item = db.getConfigItem(itemId)
        const entries = item ? db.getConfigEntries(itemId) : []
        return {
          config_item_id: itemId,
          expires_at: r.expires_at as number,
          config_item: item ? {
            id: item.id as number,
            name: item.name as string,
            description: item.description as string | null,
            icon: item.icon as string | null,
            icon_url: item.icon as string | null,
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
        const secrets = await nexus.listSecrets(undefined, userId)
        const userSecrets = secrets.filter(s => s.namespace.startsWith(`user:${userId}:`))
        return { success: true, data: userSecrets }
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
