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
  source_type?: 'hub' | 'upload' | 'custom' | 'tenant'
  feature?: string
  tag?: string
  is_builtin?: boolean
  enabled?: boolean
  installed_version?: string
  installed_at?: string
  ruleFile?: string
  rules?: string
  skills?: string[]
  enabledSkills?: string[]
  /** Document Center: Wiki IDs this assistant is authorised to query via wikiCli. */
  enabledWikis?: string[]
  /** 企业应用管理: Corp App instance IDs this assistant may use via the corpapp CLI. */
  enabledCorpApps?: string[]
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
  enabledWikis?: string[]
  enabledCorpApps?: string[]
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
      'display_name' | 'description' | 'avatar' | 'emoji' | 'rules' | 'agent_type' | 'memory_mode' | 'visible_to' | 'workflow' | 'enabledSkills' | 'enabledWikis' | 'enabledCorpApps' | 'skills'
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
  default_init_prompt?: string
  prompts_i18n?: Record<string, string[]>
  categories?: string[]
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
  enabled_corp_apps?: string[]
  memory_mode?: 'session' | 'user'
  agent_type?: 'chat' | 'workflow'
  publish_note?: string
  review_note?: string
  reviewed_by?: string
  reviewed_at?: number
  enabled: number
  visible_to?: VisibleTo | null
  rules?: string
  workflow?: {
    trigger?: 'cron' | 'webhook' | 'manual'
    cron?: string
    webhook_path?: string
    output_webhook?: string
    timeout_minutes?: number
    output_targets?: string[]
  } | null
  /** Server-computed: whether the current viewer may edit/delete this tenant
   *  agent (admin, or the author is in the viewer's scope). Drives button
   *  visibility so the client doesn't re-derive subtree membership. */
  can_manage?: boolean
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
  // When approving, the admin may override the requested visibility. Omit to
  // preserve the value the publisher requested.
  visible_to?: VisibleTo | null,
): Promise<{ id: string; status: string }> {
  return authClient.post<{ id: string; status: string }>(
    `/api/v1/admin/agents/tenant/${encodeURIComponent(id)}/approve`,
    visible_to !== undefined ? { approved, reviewNote, visible_to } : { approved, reviewNote },
  )
}

export interface CreateTenantAssistantRequest {
  name: string
  display_name: string
  description?: string
  default_init_prompt?: string
  promptsI18n?: Record<string, string[]>
  categories?: string[]
  avatar?: File | null
  emoji?: string
  rules?: string
  skills?: string[]
  enabled_skills?: string[]
  enabled_wikis?: string[]
  enabled_corp_apps?: string[]
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: TenantAssistantInfo['workflow']
}

function appendTenantAssistantFormData(form: FormData, data: Omit<CreateTenantAssistantRequest, 'name' | 'display_name'>): void {
  if (data.description !== undefined) form.set('description', data.description)
  if (data.default_init_prompt !== undefined) form.set('default_init_prompt', data.default_init_prompt)
  if (data.promptsI18n !== undefined) form.set('promptsI18n', JSON.stringify(data.promptsI18n))
  if (data.categories !== undefined) form.set('categories', JSON.stringify(data.categories))
  if (data.avatar) form.set('avatar', data.avatar)
  if (data.emoji !== undefined) form.set('emoji', data.emoji)
  if (data.rules !== undefined) form.set('rules', data.rules)
  if (data.skills !== undefined) form.set('skills', JSON.stringify(data.skills))
  if (data.enabled_skills !== undefined) form.set('enabled_skills', JSON.stringify(data.enabled_skills))
  if (data.enabled_wikis !== undefined) form.set('enabled_wikis', JSON.stringify(data.enabled_wikis))
  if (data.enabled_corp_apps !== undefined) form.set('enabled_corp_apps', JSON.stringify(data.enabled_corp_apps))
  if (data.agent_type !== undefined) form.set('agent_type', data.agent_type)
  if (data.memory_mode !== undefined) form.set('memory_mode', data.memory_mode)
  if (data.visible_to !== undefined) form.set('visible_to', JSON.stringify(data.visible_to))
  if (data.workflow !== undefined) form.set('workflow', JSON.stringify(data.workflow))
}

export function createTenantAssistant(
  data: CreateTenantAssistantRequest,
): Promise<{ success: boolean; data: TenantAssistantInfo; status?: 'approved' | 'pending'; message?: string }> {
  const form = new FormData()
  form.set('name', data.name)
  form.set('display_name', data.display_name)
  appendTenantAssistantFormData(form, data)
  return authClient.post<{ success: boolean; data: TenantAssistantInfo; status?: 'approved' | 'pending'; message?: string }>(
    '/api/v1/agents/tenant/create',
    form,
  )
}

export type UpdateTenantAssistantRequest = Omit<Partial<CreateTenantAssistantRequest>, 'name'> & {
  id: string
  enabled?: boolean
  enabledSkills?: string[]
  enabledWikis?: string[]
  enabledCorpApps?: string[]
  enableCorpAuth?: boolean
}

export function updateTenantAssistantMeta(params: UpdateTenantAssistantRequest): Promise<{ ok: boolean }> {
  const form = new FormData()
  if (params.display_name !== undefined) form.set('display_name', params.display_name)
  appendTenantAssistantFormData(form, params)
  if (params.enabledSkills !== undefined) form.set('enabledSkills', JSON.stringify(params.enabledSkills))
  if (params.enabledWikis !== undefined) form.set('enabledWikis', JSON.stringify(params.enabledWikis))
  if (params.enabledCorpApps !== undefined) form.set('enabledCorpApps', JSON.stringify(params.enabledCorpApps))
  if (params.enableCorpAuth !== undefined) form.set('enableCorpAuth', String(params.enableCorpAuth))
  if (params.enabled !== undefined) form.set('enabled', String(params.enabled))
  return authClient.patch<{ ok: boolean }>(
    `/api/v1/agents/tenant/${encodeURIComponent(params.id)}`,
    form,
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

export function getInstalledAgentRules(assistantName: string): Promise<{ rules: string }> {
  return authClient.get<{ rules: string }>(
    `/api/v1/agents/installed/${encodeURIComponent(assistantName)}/rules`,
  )
}

/**
 * The system prompt is readable by anyone the agent is visible to; `can_edit`
 * reports whether this caller may also save changes back (creator/subtree or
 * store admin). Older servers omit it — treat a missing value as editable and
 * let the PATCH be the authority.
 */
export function getTenantAssistantRules(
  id: string,
): Promise<{ rules: string; can_edit?: boolean }> {
  return authClient.get<{ rules: string; can_edit?: boolean }>(
    `/api/v1/agents/tenant/${encodeURIComponent(id)}/rules`,
  )
}
