import { authClient } from './client'

export interface MossImBinding {
  id: string
  senderId: string
  pluginId: string
  appId: string
  isCurrent: boolean
}

export function getMyMossAgent(signal?: AbortSignal): Promise<{ ownerId: string; orgId: string; agentName: string }> {
  return authClient.get('/api/v1/moss/agent', { signal, cache: 'no-store' })
}

export function getMossImBindings(signal?: AbortSignal): Promise<{ bindings: MossImBinding[] }> {
  return authClient.get('/api/v1/moss/im/bindings', { signal, cache: 'no-store' })
}

export function bindMossIm(code: string, signal?: AbortSignal): Promise<{ success: boolean }> {
  return authClient.post('/api/v1/moss/im/bind', { code }, { signal })
}

export function unlinkMossIm(id: string): Promise<{ success: boolean }> {
  return authClient.delete(`/api/v1/moss/im/bindings/${encodeURIComponent(id)}`)
}
