import { authClient } from './client'
export interface PlatformField {
  key: string; label: string; type: 'text' | 'url' | 'number' | 'boolean' | 'lines' | 'secret'; required?: boolean; min?: number; max?: number
}
export interface PlatformConfigItem {
  id: string; label: string; description: string; fields: PlatformField[]
  config: Record<string, string | number | boolean | string[]>
  secrets: Record<string, boolean>; sources: Record<string, string>; conflicts: string[]; issues: string[]
  managed: boolean; version: string | null; activeVersion: string | null; restartRequired: boolean; updatedAt: number | null
}
export interface PlatformConfigResponse {
  items: PlatformConfigItem[]; instanceId: string
  instances: Array<{ instanceId: string; seenAt: number; versions: Record<string, string | null> }>
}
export interface PlatformConfigInput {
  expectedVersion: string | null; config: PlatformConfigItem['config']; secrets: Record<string, string | null>
}
export const getPlatformConfig = () => authClient.get<PlatformConfigResponse>('/api/v1/platform-config')
export const savePlatformConfig = (id: string, input: PlatformConfigInput) => authClient.put<{ version: string; restartRequired: boolean }>(`/api/v1/platform-config/${encodeURIComponent(id)}`, input)
export const checkPlatformConfig = (id: string, input: PlatformConfigInput) => authClient.post<{ ready: boolean; issues: string[] }>(`/api/v1/platform-config/${encodeURIComponent(id)}/check`, input)
export interface PasswordMigrationPreview { fingerprint: string; eligible: number; skipped: number; updated: number }
export const previewPhonePasswords = () => authClient.get<PasswordMigrationPreview>('/api/v1/platform-config/password-migration')
export const applyPhonePasswords = (fingerprint: string) => authClient.post<PasswordMigrationPreview>('/api/v1/platform-config/password-migration', { fingerprint })
