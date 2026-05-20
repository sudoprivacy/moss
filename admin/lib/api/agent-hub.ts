import { authClient } from './client'
import type { SkillHubSkill } from './skill-store'

export interface AgentHubAssistant {
  id: string
  name: string
  display_name: string
  description?: string
  avatar?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  skills?: string[]
  core_features?: unknown
  applicable_scenarios?: unknown
  sourceUrl?: string
  [key: string]: unknown
}

export interface AgentHubDetail extends AgentHubAssistant {
  versions?: Array<Record<string, unknown>>
}

export interface AgentHubListResponse {
  assistants: AgentHubAssistant[]
  next_cursor: string | null
  has_more: boolean
}

export interface VisibleTo {
  department_ids: string[] | null
  user_ids: string[] | null
}

export interface InstalledAgentMeta {
  id?: string
  name?: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  source_type?: 'hub' | 'upload' | 'custom'
  tag?: string
  is_builtin?: boolean
  enabled?: boolean
  installed_version?: string
  installed_at?: string
  ruleFile?: string
  skills?: string[]
  enabledSkills?: string[]
  /** Document Center: Wiki IDs this assistant is authorised to query via wikiCli. */
  enabledWikis?: string[]
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: {
    trigger: 'cron' | 'webhook' | 'manual'
    cron?: string
    webhook_path?: string
    output_targets?: string[]
    output_webhook?: string
    timeout_minutes?: number
  } | null
  [key: string]: unknown
}

export interface InstalledAgentInfo {
  id: string
  name: string
  displayName: string
  description: string
  avatar: string
  emoji: string
  category: string
  categories: string[]
  version: string
  source: string
  isBuiltin: boolean
  isHubInstalled: boolean
  enabled: boolean
  tag: string
  skills: string[]
  enabledSkills: string[]
  meta: InstalledAgentMeta | null
  agentType: 'chat' | 'workflow'
  memoryMode: 'session' | 'user'
  visibleTo: VisibleTo | null
  workflow: InstalledAgentMeta['workflow']
}

export interface InstallAgentRequest {
  assistantName: string
  sourceUrl: string
  version?: string
  checksum?: string
  assistantMeta?: AgentHubAssistant | null
  selectedSkillIds?: string[]
}

export interface CreateAssistantRequest {
  name: string
  displayName: string
  description?: string
  avatar?: string
  emoji?: string
  rules: string
  skills?: string[]
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: InstalledAgentMeta['workflow']
}

export function getAgentHubAssistants(params: {
  cursor?: string
  limit?: number
  query?: string
  category?: string
}): Promise<AgentHubListResponse> {
  const searchParams = new URLSearchParams()
  if (params.cursor) searchParams.set('cursor', params.cursor)
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.query) searchParams.set('query', params.query)
  if (params.category) searchParams.set('category', params.category)

  const queryString = searchParams.toString()
  return authClient.get<AgentHubListResponse>(
    `/api/v1/agent-hub/assistants/cursor${queryString ? `?${queryString}` : ''}`,
  )
}

export function getAgentHubCategories(): Promise<string[]> {
  return authClient.get<string[]>('/api/v1/agent-hub/categories')
}

export function getAgentHubDetail(
  assistantId: string,
): Promise<AgentHubDetail | null> {
  return authClient.get<AgentHubDetail | null>(
    `/api/v1/agent-hub/assistants/${encodeURIComponent(assistantId)}`,
  )
}

export function getInstalledAgents(): Promise<InstalledAgentInfo[]> {
  return authClient.get<InstalledAgentInfo[]>('/api/v1/agents/installed')
}

export function installAgent(
  data: InstallAgentRequest,
): Promise<{
  assistantName: string
  version: string
  installedSkills: string[]
  failedSkills: string[]
}> {
  return authClient.post<{
    assistantName: string
    version: string
    installedSkills: string[]
    failedSkills: string[]
  }>('/api/v1/agents/install', data)
}

export function uninstallAgent(data: {
  assistantName: string
  sourcePath?: string
}): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>('/api/v1/agents/uninstall', data)
}

export function createCustomAssistant(
  data: CreateAssistantRequest,
): Promise<{ success: boolean; data: InstalledAgentInfo }> {
  return authClient.post<{ success: boolean; data: InstalledAgentInfo }>(
    '/api/v1/agents/create',
    data,
  )
}

export function updateInstalledAgentMeta(data: {
  assistantName: string
  updates: Partial<
    Pick<
      InstalledAgentMeta,
      'display_name' | 'description' | 'avatar' | 'emoji' | 'agent_type' | 'memory_mode' | 'visible_to' | 'workflow' | 'enabledSkills' | 'enabledWikis' | 'skills'
    >
  >
}): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>('/api/v1/agents/meta', data)
}

export function fetchAgentHubSkillDetailsByIds(
  skillIds: string[],
): Promise<SkillHubSkill[]> {
  return authClient.post<SkillHubSkill[]>('/api/v1/agent-hub/skills/by-ids', {
    skillIds,
  })
}

export interface BatchSyncAgentResult {
  installed: Array<{ assistantName: string; version: string }>
  updated: Array<{ assistantName: string; version: string }>
  skipped: Array<{ assistantName: string; reason: string }>
  failed: Array<{ assistantName: string; error: string }>
}

export function batchSyncAgents(): Promise<{ started: boolean }> {
  return authClient.post<{ started: boolean }>('/api/v1/agents/sync-from-hub')
}

export interface AgentSyncProgress {
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

export function getAgentSyncStatus(): Promise<AgentSyncProgress> {
  return authClient.get<AgentSyncProgress>('/api/v1/agents/sync-status')
}

export function updateAgentVisibility(
  assistantName: string,
  visible_to: VisibleTo | null,
): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>('/api/v1/agents/visibility', {
    assistantName,
    visible_to,
  })
}

// ==================== Tenant Assistants ====================

export interface TenantAssistantInfo {
  id: string
  name: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string
  version?: string
  author_id: string
  author_name?: string
  status: 'pending' | 'approved' | 'rejected'
  source_url?: string
  checksum?: string
  file_path?: string
  skills?: string[]
  enabled_skills?: string[]
  enabled_wikis?: string[]
  memory_mode?: 'session' | 'user'
  agent_type?: 'chat' | 'workflow'
  publish_note?: string
  review_note?: string
  reviewed_by?: string
  reviewed_at?: number
  enabled: number
  visible_to?: VisibleTo | null
  workflow?: {
    trigger?: 'cron' | 'webhook' | 'manual'
    cron?: string
    webhook_path?: string
    output_webhook?: string
    timeout_minutes?: number
    output_targets?: string[]
  } | null
  created_at: number
  updated_at: number
}

export function getTenantAssistants(status?: string): Promise<TenantAssistantInfo[]> {
  const queryString = status ? `?status=${encodeURIComponent(status)}` : ''
  return authClient.get<TenantAssistantInfo[]>(`/api/v1/agents/tenant${queryString}`)
}

export function approveTenantAssistant(
  id: string,
  approved: boolean,
  reviewNote?: string,
): Promise<{ id: string; status: string }> {
  return authClient.post<{ id: string; status: string }>(
    `/api/v1/admin/agents/tenant/${encodeURIComponent(id)}/approve`,
    { approved, reviewNote },
  )
}

export interface CreateTenantAssistantRequest {
  name: string
  display_name: string
  description?: string
  avatar?: string
  emoji?: string
  skills?: string[]
  enabled_skills?: string[]
  enabled_wikis?: string[]
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: TenantAssistantInfo['workflow']
}

export function createTenantAssistant(
  data: CreateTenantAssistantRequest,
): Promise<{ success: boolean; data: TenantAssistantInfo }> {
  return authClient.post<{ success: boolean; data: TenantAssistantInfo }>(
    '/api/v1/agents/tenant/create',
    data,
  )
}

export function updateTenantAssistantMeta(params: {
  id: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: TenantAssistantInfo['workflow']
  enabled?: boolean
  enabledSkills?: string[]
  enabledWikis?: string[]
  skills?: string[]
}): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>(
    `/api/v1/agents/tenant/${encodeURIComponent(params.id)}`,
    params,
  )
}

export function deleteTenantAssistant(id: string): Promise<{ ok: boolean }> {
  return authClient.delete<{ ok: boolean }>(
    `/api/v1/agents/tenant/${encodeURIComponent(id)}`,
  )
}

export function downloadAssistant(assistantId: string, type: 'installed' | 'tenant'): Promise<Blob> {
  const path = type === 'installed'
    ? `/api/v1/agents/installed/${encodeURIComponent(assistantId)}/download`
    : `/api/v1/agents/tenant/${encodeURIComponent(assistantId)}/download`
  return authClient.getBlob(path)
}
