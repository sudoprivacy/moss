/**
 * Secrets Management API client.
 * Calls real backend endpoints.
 */

import { dcClient } from './client'

// ============================================================
// Types
// ============================================================

export interface ConfigEntry {
  id: number
  config_key: string
  name: string
  config_desc: string
  required: number
}

export interface ConfigItem {
  id: number
  name: string
  description: string
  icon: string | null
  icon_url: string | null
  pinyin: string
  scope: 'system' | 'user'
  url_pattern: string | null
  scheme: 'bearer' | 'basic' | 'header' | 'query' | null
  bearer_prefix: string | null
  status: number
  entries: ConfigEntry[]
  created_at: number
  updated_at: number
}

export interface SecretEntry {
  namespace: string
  key: string
  value: string | null
  status: 'enabled' | 'disabled'
  version: number
}

export interface SecretMetadata {
  config_item_id: number
  expires_at: number | null
}

export interface DepartmentPolicy {
  department_id: string
  department_name: string
  config_item_ids: number[]
}

export interface AuditLogEntry {
  id: string
  actor_id: string
  actor_name: string
  action: string
  config_item_id: number | null
  namespace: string
  key: string
  detail: Record<string, unknown> | null
  ip_address: string | null
  created_at: number
}

export interface Department {
  id: string
  name: string
  parent_id: string | null
  children?: Department[]
}

// ============================================================
// Helpers: map backend response to frontend types
// ============================================================

// Backend secret entry has different field names
interface BackendSecret {
  id?: string
  namespace: string
  key: string
  description?: string | null
  enabled: boolean
  current_version: number
  deleted_at?: string | null
  created_at?: string | number
  // For user secrets endpoint that includes value
  value?: string | null
}

function mapSecretEntry(s: BackendSecret, value?: string | null): SecretEntry {
  return {
    namespace: s.namespace,
    key: s.key,
    value: value ?? s.value ?? null,
    status: s.enabled ? 'enabled' : 'disabled',
    version: s.current_version ?? 0,
  }
}

// ============================================================
// Config Items API
// ============================================================

export async function getConfigItems(params?: {
  page?: number
  page_size?: number
  name?: string
  scope?: string
  status?: string
}): Promise<{ items: ConfigItem[]; total: number; page: number; page_size: number }> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.page_size) searchParams.set('page_size', String(params.page_size))
  if (params?.name) searchParams.set('name', params.name)
  if (params?.scope) searchParams.set('scope', params.scope)
  if (params?.status !== undefined && params?.status !== '') searchParams.set('status', params.status)
  const qs = searchParams.toString()
  // Backend returns: { success, data: ConfigItem[], total, page, page_size }
  const res = await dcClient.get<{
    success: boolean
    data?: ConfigItem[]
    total?: number
    page?: number
    page_size?: number
  }>(`/api/v1/config-items${qs ? `?${qs}` : ''}`)
  return {
    items: res.data ?? [],
    total: res.total ?? 0,
    page: res.page ?? 1,
    page_size: res.page_size ?? 20,
  }
}

export async function getConfigItem(id: number): Promise<ConfigItem | null> {
  const res = await dcClient.get<{ success: boolean; data?: ConfigItem }>(`/api/v1/config-items/${id}`)
  return res.data ?? null
}

export async function createConfigItem(data: {
  name: string
  pinyin?: string
  description?: string
  icon?: string
  scope: 'system' | 'user'
  url_pattern?: string
  scheme?: string
  bearer_prefix?: string
  entries?: { config_key: string; name: string; config_desc?: string; required?: number }[]
}): Promise<ConfigItem> {
  const res = await dcClient.post<{ success: boolean; data?: ConfigItem; error?: { code: string; message: string } }>('/api/v1/config-items', data)
  if (!res.success) throw new Error(res.error?.message || '创建失败')
  return res.data!
}

export async function updateConfigItem(id: number, data: {
  name?: string
  description?: string
  icon?: string
  scope?: 'system' | 'user'
  pinyin?: string
  url_pattern?: string
  scheme?: string
  bearer_prefix?: string
  entries?: { config_key: string; name: string; config_desc?: string; required?: number }[]
}): Promise<ConfigItem> {
  const res = await dcClient.put<{ success: boolean; data?: ConfigItem; error?: { code: string; message: string } }>(`/api/v1/config-items/${id}`, data)
  if (!res.success) throw new Error(res.error?.message || '更新失败')
  return res.data!
}

export async function updateConfigItemStatus(id: number, status: number): Promise<void> {
  await dcClient.put(`/api/v1/config-items/${id}/status`, { status })
}

export async function deleteConfigItem(id: number): Promise<void> {
  await dcClient.delete(`/api/v1/config-items/${id}`)
}

export async function uploadConfigItemIcon(file: File): Promise<{ icon: string }> {
  const buffer = await file.arrayBuffer()
  const res = await fetch('/api/v1/config-items/icon', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${localStorage.getItem('moss_access_token')}`,
      'Content-Type': file.type,
    },
    body: buffer,
  })
  if (!res.ok) throw new Error('上传图标失败')
  const data = await res.json()
  return { icon: data.icon }
}

// ============================================================
// Enterprise Secrets API
// ============================================================

export async function getEnterpriseSecrets(preloadedConfigItems?: ConfigItem[]): Promise<(SecretEntry & { config_item: ConfigItem })[]> {
  const [secretsRes, itemsRes] = await Promise.all([
    dcClient.get<{ success: boolean; data?: BackendSecret[] }>('/api/v1/secrets'),
    preloadedConfigItems
      ? Promise.resolve(preloadedConfigItems)
      : dcClient.get<{ success: boolean; data?: ConfigItem[] }>('/api/v1/config/items').then(r => r.data ?? []),
  ])
  const secrets = secretsRes.data ?? []
  const configItems = preloadedConfigItems ?? itemsRes as ConfigItem[]
  return secrets.map(s => {
    const pinyin = s.namespace.replace('system:', '')
    const configItem = configItems.find(c => c.pinyin === pinyin)
    if (!configItem) return null
    return { ...mapSecretEntry(s), config_item: configItem }
  }).filter((s): s is SecretEntry & { config_item: ConfigItem } => s !== null)
}

export async function getSecret(namespace: string, key: string): Promise<SecretEntry> {
  const res = await dcClient.get<{ success: boolean; data?: BackendSecret & { value?: string } }>(`/api/v1/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`)
  if (!res.data) throw new Error('凭据不存在')
  return mapSecretEntry(res.data, res.data.value)
}

export async function putSecret(namespace: string, key: string, value: string): Promise<void> {
  const res = await dcClient.put<{ success: boolean; error?: { code: string; message: string } }>(`/api/v1/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, { value })
  if (!res.success) throw new Error(res.error?.message || '写入失败')
}

export async function deleteSecret(namespace: string, key: string): Promise<void> {
  await dcClient.delete(`/api/v1/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`)
}

export async function enableSecret(namespace: string, key: string): Promise<void> {
  await dcClient.post(`/api/v1/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/enable`)
}

export async function disableSecret(namespace: string, key: string): Promise<void> {
  await dcClient.post(`/api/v1/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/disable`)
}

// ============================================================
// User Secrets API (me endpoints)
// ============================================================

export async function getUserSecrets(preloadedConfigItems?: ConfigItem[]): Promise<(SecretEntry & { config_item: ConfigItem })[]> {
  const [secretsRes, itemsRes] = await Promise.all([
    dcClient.get<{ success: boolean; data?: BackendSecret[] }>('/api/v1/me/secrets'),
    preloadedConfigItems
      ? Promise.resolve(preloadedConfigItems)
      : dcClient.get<{ success: boolean; data?: ConfigItem[] }>('/api/v1/config/items').then(r => r.data ?? []),
  ])
  const secrets = secretsRes.data ?? []
  const configItems = preloadedConfigItems ?? itemsRes as ConfigItem[]
  return secrets.map(s => {
    const parts = s.namespace.split(':')
    const pinyin = parts.slice(2).join(':')
    const configItem = configItems.find(c => c.pinyin === pinyin)
    if (!configItem) return null
    return { ...mapSecretEntry(s), config_item: configItem }
  }).filter((s): s is SecretEntry & { config_item: ConfigItem } => s !== null)
}

export async function putUserSecret(namespace: string, key: string, value: string): Promise<void> {
  await dcClient.put(`/api/v1/me/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, { value })
}

export async function deleteUserSecret(namespace: string, key: string): Promise<void> {
  await dcClient.delete(`/api/v1/me/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`)
}

export async function enableUserSecret(namespace: string, key: string): Promise<void> {
  await dcClient.post(`/api/v1/me/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/enable`)
}

export async function disableUserSecret(namespace: string, key: string): Promise<void> {
  await dcClient.post(`/api/v1/me/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/disable`)
}

// ============================================================
// Secret Metadata API
// ============================================================

export async function getSecretMetadata(preloadedConfigItems?: ConfigItem[]): Promise<(SecretMetadata & { config_item: ConfigItem })[]> {
  const [metaRes, itemsRes] = await Promise.all([
    dcClient.get<{ success: boolean; data?: SecretMetadata[] }>('/api/v1/secret-metadata'),
    preloadedConfigItems
      ? Promise.resolve(preloadedConfigItems)
      : dcClient.get<{ success: boolean; data?: ConfigItem[] }>('/api/v1/config/items').then(r => r.data ?? []),
  ])
  const metadata = metaRes.data ?? []
  const configItems = preloadedConfigItems ?? itemsRes as ConfigItem[]
  return metadata.map(m => {
    const configItem = configItems.find(c => c.id === m.config_item_id)
    if (!configItem) return null
    return { ...m, config_item: configItem }
  }).filter((m): m is SecretMetadata & { config_item: ConfigItem } => m !== null)
}

export async function updateSecretMetadata(configItemId: number, expiresAt: number | null): Promise<void> {
  await dcClient.put(`/api/v1/secret-metadata/${configItemId}`, { expires_at: expiresAt })
}

// ============================================================
// Department Policies API
// ============================================================

export async function getDepartmentPolicies(deptId: string): Promise<DepartmentPolicy | null> {
  const res = await dcClient.get<{ success: boolean; data?: DepartmentPolicy }>(`/api/v1/departments/${deptId}/secret-policies`)
  return res.data ?? null
}

export async function updateDepartmentPolicies(deptId: string, configItemIds: number[]): Promise<void> {
  await dcClient.put(`/api/v1/departments/${deptId}/secret-policies`, { config_item_ids: configItemIds })
}

// ============================================================
// Audit Log API
// ============================================================

export async function getAuditLog(params?: {
  page?: number
  page_size?: number
  actor_id?: string
  config_item_id?: number
  action?: string
  since?: number
  until?: number
}): Promise<{ items: AuditLogEntry[]; total: number; page: number; page_size: number }> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.page_size) searchParams.set('page_size', String(params.page_size))
  if (params?.actor_id) searchParams.set('actor_id', params.actor_id)
  if (params?.config_item_id) searchParams.set('config_item_id', String(params.config_item_id))
  if (params?.action) searchParams.set('action', params.action)
  if (params?.since) searchParams.set('since', String(params.since))
  if (params?.until) searchParams.set('until', String(params.until))
  const qs = searchParams.toString()
  // Backend returns: { success, data: AuditLogEntry[], total, page, page_size }
  const res = await dcClient.get<{
    success: boolean
    data?: AuditLogEntry[]
    total?: number
    page?: number
    page_size?: number
  }>(`/api/v1/secrets-audit${qs ? `?${qs}` : ''}`)
  return {
    items: res.data ?? [],
    total: res.total ?? 0,
    page: res.page ?? 1,
    page_size: res.page_size ?? 20,
  }
}

// ============================================================
// Rotation Alerts API
// ============================================================

export async function getRotationAlerts(): Promise<(SecretMetadata & { config_item: ConfigItem })[]> {
  const res = await dcClient.get<{ success: boolean; data?: (SecretMetadata & { config_item?: ConfigItem })[] }>('/api/v1/secret-rotation/alerts')
  return (res.data ?? []).filter((m): m is SecretMetadata & { config_item: ConfigItem } => !!m.config_item)
}

// ============================================================
// Authorized System Configs (for current user)
// ============================================================

export async function getAuthorizedSystemConfigs(): Promise<ConfigItem[]> {
  const res = await dcClient.get<{ success: boolean; data?: ConfigItem[] }>('/api/v1/me/authorized-system-configs')
  return res.data ?? []
}

// ============================================================
// Public Config Items (no admin scope required)
// ============================================================

export async function getPublicConfigItems(): Promise<ConfigItem[]> {
  const res = await dcClient.get<{ success: boolean; data?: ConfigItem[] }>('/api/v1/config/items')
  return res.data ?? []
}
