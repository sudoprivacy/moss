import { authClient } from './client'
import type { VisibleTo } from './agent-hub'

export type SkillStoreTab = 'store' | 'exclusive' | 'custom'

export interface SkillHubVersion {
  version: string
  source_url: string
  checksum: string
  [key: string]: unknown
}

export interface SkillHubSkill {
  id: string
  name: string
  display_name: string
  description?: string
  icon?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  applicable_scenarios?: unknown
  core_features?: unknown
  homepage?: string | null
  author_id?: string
  star_count?: number
  created_at?: string | number
  updated_at?: string | number
  [key: string]: unknown
}

export interface SkillHubDetail extends SkillHubSkill {
  versions?: SkillHubVersion[]
}

export interface SkillHubListResponse {
  skills: SkillHubSkill[]
  next_cursor: string | null
  has_more: boolean
}

export interface InstalledSkillMeta {
  id?: string
  name?: string
  display_name?: string
  description?: string
  icon?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  applicable_scenarios?: unknown
  core_features?: unknown
  homepage?: string | null
  author_id?: string
  source_type?: 'hub' | 'upload'
  is_builtin?: boolean
  enabled?: boolean
  installed_version?: string
  installed_at?: string
  visible_to?: VisibleTo | null
  [key: string]: unknown
}

export interface InstalledSkillInfo {
  id: string
  name: string
  displayName: string
  description: string
  version: string
  icon: string
  emoji: string
  category: string
  categories: string[]
  isBuiltin: boolean
  isHubInstalled: boolean
  isUploaded: boolean
  enabled: boolean
  source: string
  meta: InstalledSkillMeta | null
  visibleTo: VisibleTo | null
}

export interface InstallSkillRequest {
  skillName: string
  sourceUrl: string
  version?: string
  checksum?: string
  skillMeta?: SkillHubSkill | null
}

export interface ImportDirectoryEntry {
  path: string
  contentBase64: string
}

export function resolveSkillTenantId(
  tab: SkillStoreTab,
  tenantId?: string,
): string | undefined {
  const normalized = tenantId?.trim()
  if (tab !== 'exclusive' || !normalized) {
    return undefined
  }
  return normalized
}

export function getSkillHubSkills(params: {
  cursor?: string
  limit?: number
  query?: string
  category?: string
  tenantId?: string
}): Promise<SkillHubListResponse> {
  const searchParams = new URLSearchParams()
  if (params.cursor) searchParams.set('cursor', params.cursor)
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.query) searchParams.set('query', params.query)
  if (params.category) searchParams.set('categories', params.category)
  if (params.tenantId) searchParams.set('tenant_id', params.tenantId)

  const queryString = searchParams.toString()
  return authClient.get<SkillHubListResponse>(
    `/api/v1/skill-hub/skills/cursor${queryString ? `?${queryString}` : ''}`,
  )
}

export function getSkillHubCategories(): Promise<string[]> {
  return authClient.get<string[]>('/api/v1/skill-hub/categories')
}

export function getSkillHubDetail(skillId: string): Promise<SkillHubDetail | null> {
  return authClient.get<SkillHubDetail | null>(
    `/api/v1/skill-hub/skills/${encodeURIComponent(skillId)}`,
  )
}

export function getInstalledSkills(): Promise<InstalledSkillInfo[]> {
  return authClient.get<InstalledSkillInfo[]>('/api/v1/skills/installed')
}

export function installSkill(
  data: InstallSkillRequest,
): Promise<{ skillName: string; version: string }> {
  return authClient.post<{ skillName: string; version: string }>(
    '/api/v1/skills/install',
    data,
  )
}

export function uninstallSkill(data: {
  skillName: string
  sourcePath?: string
}): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>('/api/v1/skills/uninstall', data)
}

export function setInstalledSkillEnabled(data: {
  skillName: string
  enabled: boolean
  sourcePath?: string
}): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>('/api/v1/skills/enabled', data)
}

export function importSkillArchive(data: {
  fileName: string
  archiveBase64: string
}): Promise<{ skillName: string; installedVersion: string }> {
  return authClient.post<{ skillName: string; installedVersion: string }>(
    '/api/v1/skills/import/archive',
    data,
  )
}

export function importSkillDirectory(data: {
  entries: ImportDirectoryEntry[]
}): Promise<{ skillName: string; installedVersion: string }> {
  return authClient.post<{ skillName: string; installedVersion: string }>(
    '/api/v1/skills/import/directory',
    data,
  )
}

export interface BatchSyncResult {
  installed: Array<{ skillName: string; version: string }>
  updated: Array<{ skillName: string; version: string }>
  skipped: Array<{ skillName: string; reason: string }>
  failed: Array<{ skillName: string; error: string }>
}

export function batchSyncSkills(tenantId?: string): Promise<{ started: boolean }> {
  return authClient.post<{ started: boolean }>('/api/v1/skills/sync-from-hub', {
    tenantId: tenantId || undefined,
  })
}

export interface SkillSyncProgress {
  status: 'idle' | 'running' | 'done' | 'error'
  total: number
  processed: number
  installed: number
  updated: number
  skipped: number
  failed: number
  error?: string
  startedAt: number
}

export function getSkillSyncStatus(): Promise<SkillSyncProgress> {
  return authClient.get<SkillSyncProgress>('/api/v1/skills/sync-status')
}

export function updateSkillVisibility(
  skillName: string,
  visible_to: VisibleTo | null,
): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>('/api/v1/skills/visibility', {
    skillName,
    visible_to,
  })
}

// ==================== Tenant Skills ====================

export interface TenantSkillInfo {
  id: string
  name: string
  display_name?: string
  description?: string
  version?: string
  author_id: string
  author_name?: string
  status: 'pending' | 'approved' | 'rejected'
  source_url?: string
  checksum?: string
  file_path?: string
  publish_note?: string
  review_note?: string
  reviewed_by?: string
  reviewed_at?: number
  enabled: number
  visible_to?: VisibleTo | null
  created_at: number
  updated_at: number
}

export function getTenantSkills(status?: string): Promise<TenantSkillInfo[]> {
  const queryString = status ? `?status=${encodeURIComponent(status)}` : ''
  return authClient.get<TenantSkillInfo[]>(`/api/v1/skills/tenant${queryString}`)
}

export function approveTenantSkill(
  id: string,
  approved: boolean,
  reviewNote?: string,
): Promise<{ id: string; status: string }> {
  return authClient.post<{ id: string; status: string }>(
    `/api/v1/admin/skills/tenant/${encodeURIComponent(id)}/approve`,
    { approved, reviewNote },
  )
}

export function updateTenantSkillMeta(params: {
  id: string
  enabled?: boolean
  visible_to?: VisibleTo | null
}): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>(
    `/api/v1/skills/tenant/${encodeURIComponent(params.id)}`,
    params,
  )
}

export function deleteTenantSkill(id: string): Promise<{ ok: boolean }> {
  return authClient.delete<{ ok: boolean }>(
    `/api/v1/skills/tenant/${encodeURIComponent(id)}`,
  )
}

export function uploadTenantSkillArchive(data: {
  fileName: string
  archiveBase64: string
}): Promise<{ skillName: string; id: string; status: string; version: string }> {
  return authClient.post<{ skillName: string; id: string; status: string; version: string }>(
    '/api/v1/skills/tenant/upload',
    data,
  )
}

export function uploadTenantSkillDirectory(data: {
  entries: ImportDirectoryEntry[]
}): Promise<{ skillName: string; id: string; status: string; version: string }> {
  return authClient.post<{ skillName: string; id: string; status: string; version: string }>(
    '/api/v1/skills/tenant/upload',
    data,
  )
}

export function downloadSkill(skillId: string, type: 'installed' | 'tenant'): Promise<Blob> {
  const path = type === 'installed'
    ? `/api/v1/skills/installed/${encodeURIComponent(skillId)}/download`
    : `/api/v1/skills/tenant/${encodeURIComponent(skillId)}/download`
  return authClient.getBlob(path)
}
