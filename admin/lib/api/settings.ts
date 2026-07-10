import { authClient } from './client'
import type {
  SystemSettings,
  UpdateSystemSettingsRequest,
} from './types'

export function getSystemSettings(): Promise<SystemSettings> {
  return authClient.get<SystemSettings>('/api/v1/settings/system')
}

/** Non-secret store config (skillStore.tenantId) readable with store:read, for
 * the skills/agents pages — getSystemSettings() is admin:settings only. */
export type StoreConfig = { skillStore: { tenantId: string } }
export function getStoreConfig(): Promise<StoreConfig> {
  return authClient.get<StoreConfig>('/api/v1/store/config')
}

export function updateSystemSettings(
  data: UpdateSystemSettingsRequest,
): Promise<SystemSettings> {
  return authClient.patch<SystemSettings>('/api/v1/settings/system', data)
}
