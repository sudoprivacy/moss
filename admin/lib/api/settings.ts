import { authClient } from './client'
import type {
  ConfigScope,
  SystemSettings,
  UpdateSystemSettingsRequest,
} from './types'

export function getSystemSettings(scope: ConfigScope = 'organization'): Promise<SystemSettings> {
  return authClient.get<SystemSettings>(`/api/v1/settings/system?scope=${scope}`)
}

/** Non-secret store config (skillStore.tenantId) readable with store:read, for
 * the skills/agents pages — getSystemSettings() is admin:settings only. */
export type StoreConfig = { skillStore: { tenantId: string } }
export function getStoreConfig(): Promise<StoreConfig> {
  return authClient.get<StoreConfig>('/api/v1/store/config')
}

export function updateSystemSettings(
  data: UpdateSystemSettingsRequest,
  scope: ConfigScope = 'organization',
): Promise<SystemSettings> {
  return authClient.patch<SystemSettings>(`/api/v1/settings/system?scope=${scope}`, data)
}

export function refreshModelCache(scope: ConfigScope = 'organization'): Promise<{ success: boolean; data: unknown }> {
  return authClient.post(`/api/v1/models/refresh-cache?scope=${scope}`)
}
