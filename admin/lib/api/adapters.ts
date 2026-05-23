import { authClient } from './client'
import type {
  AdapterConfigsResponse,
  AdapterConfigRow,
  AdapterPlatformConfig,
  AdapterProcessStatus,
} from './types'

export function getAdapterConfig(userId?: string): Promise<AdapterConfigsResponse> {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : ''
  return authClient.get<AdapterConfigsResponse>(`/api/v1/adapters${query}`)
}

export function updateAdapterConfig(
  platform: 'telegram' | 'feishu',
  data: Record<string, unknown>,
): Promise<{ platform: string; config: AdapterPlatformConfig | null }> {
  return authClient.put<{ platform: string; config: AdapterPlatformConfig | null }>(
    `/api/v1/adapters/${platform}`,
    data,
  )
}

export function deleteAdapterConfig(platform: 'telegram' | 'feishu'): Promise<{ ok: boolean }> {
  return authClient.delete<{ ok: boolean }>(`/api/v1/adapters/${platform}`)
}

export function getAdapterProcesses(): Promise<Record<string, AdapterProcessStatus>> {
  return authClient.get<Record<string, AdapterProcessStatus>>('/api/v1/adapters/processes')
}

export function startAdapterProcess(adapter: 'telegram' | 'feishu', userId?: string): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>('/api/v1/adapters/processes/start', { adapter, userId })
}

export function stopAdapterProcess(adapter: 'telegram' | 'feishu', userId?: string): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>('/api/v1/adapters/processes/stop', { adapter, userId })
}

export function restartAdapterProcess(adapter: 'telegram' | 'feishu', userId?: string): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>('/api/v1/adapters/processes/restart', { adapter, userId })
}

export function listAllAdapterConfigs(): Promise<AdapterConfigRow[]> {
  return authClient.get<AdapterConfigRow[]>('/api/v1/adapters/all')
}
