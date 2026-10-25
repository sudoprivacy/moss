import { authClient } from './client'

export interface MossMemberAccess {
  orgId: string
  userId: string
  isEnabled: boolean
  isGranted: boolean
  source: 'role' | 'explicit'
  memberStatus: string
}

export function getMossMemberAccess(userId: string, signal?: AbortSignal): Promise<MossMemberAccess> {
  return authClient.get(`/api/v1/moss/member-access/${encodeURIComponent(userId)}`, { signal, cache: 'no-store' })
}

export function setMossMemberAccess(userId: string, isEnabled: boolean, signal?: AbortSignal): Promise<MossMemberAccess> {
  return authClient.put(`/api/v1/moss/member-access/${encodeURIComponent(userId)}`, { enabled: isEnabled }, { signal })
}
