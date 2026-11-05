import { dcClient } from './client'

export interface OwnerRuntime {
  ownerId: string
  ownerName: string | null
  orgId: string | null
  orgName: string | null
  ownerStatus: string
  allocations: number
  isPresent: boolean
  isDrifted: boolean
  phase: string
  releaseId?: string | null
  upgradeLock?: { createdAt: string | null } | null
  canUpgrade: boolean
  canRetire: boolean
  canRecoverLock: boolean
}

export interface RuntimeRollout {
  id: string
  actorUserId: string
  startedAt: number
  finishedAt: number | null
  owners: Array<{ ownerId: string; ownerName: string; orgId: string; outcome: 'pending' | 'upgraded' | 'busy' | 'failed'; error?: string }>
  stopped: { beforeOwnerId: string; controllerMemory: number | null } | null
}

export function listOwnerRuntimes(scope: 'org' | 'all'): Promise<{ runtimes: OwnerRuntime[] }> {
  return dcClient.get(`/api/v1/agent-runtimes?scope=${scope}`)
}

export function upgradeOwnerRuntime(ownerId: string): Promise<unknown> {
  return dcClient.post(`/api/v1/agent-runtimes/${encodeURIComponent(ownerId)}/upgrade`)
}

export function retireOwnerRuntime(ownerId: string): Promise<{ isRetired: boolean }> {
  return dcClient.post(`/api/v1/agent-runtimes/${encodeURIComponent(ownerId)}/retire`)
}

export function recoverOwnerRuntimeLock(ownerId: string): Promise<{ isRecovered: boolean }> {
  return dcClient.post(`/api/v1/agent-runtimes/${encodeURIComponent(ownerId)}/recover-lock`)
}

export function getRuntimeRollout(): Promise<{ rollout: RuntimeRollout | null; plan: OwnerRuntime[] }> {
  return dcClient.get('/api/v1/agent-runtimes/rollout')
}

export function startRuntimeRollout(ownerIds: string[]): Promise<{ rollout: RuntimeRollout }> {
  return dcClient.post('/api/v1/agent-runtimes/rollout', { owner_ids: ownerIds })
}
