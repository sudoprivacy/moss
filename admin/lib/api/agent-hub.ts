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

export interface InstalledAgentMeta {
  id?: string
  name?: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string | null
  category?: string
  categories?: string[]
  source_type?: 'hub' | 'upload'
  tag?: string
  is_builtin?: boolean
  enabled?: boolean
  installed_version?: string
  installed_at?: string
  ruleFile?: string
  skills?: string[]
  enabledSkills?: string[]
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
}

export interface InstallAgentRequest {
  assistantName: string
  sourceUrl: string
  version?: string
  checksum?: string
  assistantMeta?: AgentHubAssistant | null
  selectedSkillIds?: string[]
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

export function updateInstalledAgentMeta(data: {
  assistantName: string
  updates: Partial<
    Pick<InstalledAgentMeta, 'display_name' | 'description' | 'avatar'>
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
