import { dcClient } from './client'

export interface ManagedAgent {
  name: string
  path: string
  ownerId: string
  ownerName: string
  displayName: string
  reference?: string
  origin: 'moss' | 'nexus'
  state: string
  isPresent: boolean
  canStart: boolean
  isOwnerActive: boolean
}

export interface ManagedAgentList {
  agents: ManagedAgent[]
  unavailableOwners: string[]
  isWorkspaceAvailable: boolean
  nextCursor?: string | null
  runtimeStates: UserRuntimeState[]
}

export interface UserRuntimeState {
  ownerId: string
  isPresent: boolean
  isDrifted: boolean
  phase: string
  releaseId?: string | null
  expectedImage?: string
  observedImageDigest?: string | null
}

export interface ManagedAgentDetail {
  agent: ManagedAgent
  sessions: Array<{ sessionId: string; status: string; createdAt: number; title: string | null; workspaceUrl: string | null }>
  isWorkspaceAvailable: boolean
  runtime: UserRuntimeState
  canUpgrade: boolean
}

function agentUrl(ownerId: string, name: string): string {
  return `/api/v1/agent-manager/agents/${encodeURIComponent(name)}?owner_id=${encodeURIComponent(ownerId)}`
}

export function getManagedAgents(after?: string): Promise<ManagedAgentList> {
  return dcClient.get<ManagedAgentList>(`/api/v1/agent-manager/agents${after ? `?after=${encodeURIComponent(after)}` : ''}`)
}

export function upgradeUserRuntime(ownerId: string): Promise<{ runtime: UserRuntimeState }> {
  return dcClient.post(`/api/v1/agent-runtimes/${encodeURIComponent(ownerId)}/upgrade`)
}

export function getManagedAgent(ownerId: string, name: string): Promise<ManagedAgentDetail> {
  return dcClient.get<ManagedAgentDetail>(agentUrl(ownerId, name))
}

export function startManagedAgent(ownerId: string, name: string): Promise<{ sessionId: string; workspaceUrl: string }> {
  return dcClient.post(`/api/v1/agent-manager/agents/${encodeURIComponent(name)}/sessions`, { owner_id: ownerId })
}
