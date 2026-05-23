import { authClient } from './client'

// ============================================================
// External Sources API — Document Center v2
// Connectors that pull content from external systems (WeCom Drive,
// filesystem mounts, etc.) into the document tree.
// ============================================================

export type ExternalSource = {
  id: string
  orgId: string
  type: string                    // 'filesystem' | 'wecom_drive' | ...
  name: string
  config: Record<string, unknown> // connector-specific (rootPath, mountedNodeId, etc.)
  hasCredentials: boolean
  syncIntervalSec: number
  autoBuildEnabled: boolean
  enabled: boolean
  lastSyncAt: number | null
  lastSyncStatus: 'success' | 'failed' | 'running' | null
  lastSyncError: string | null
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type TestConnectionResult = {
  ok: boolean
  message?: string
}

export async function listExternalSources(): Promise<ExternalSource[]> {
  const data = await authClient.get<{ sources: ExternalSource[] }>('/api/v1/external-sources')
  return data.sources
}

export async function listConnectorTypes(): Promise<string[]> {
  const data = await authClient.get<{ types: string[] }>('/api/v1/external-sources/connector-types')
  return data.types
}

export function getExternalSource(id: string): Promise<ExternalSource> {
  return authClient.get<ExternalSource>(`/api/v1/external-sources/${id}`)
}

export function createExternalSource(input: {
  type: string
  name: string
  config: Record<string, unknown>
  credentials?: Record<string, string>
  sync_interval_sec?: number
  auto_build_enabled?: boolean
}): Promise<ExternalSource> {
  return authClient.post<ExternalSource>('/api/v1/external-sources', input)
}

export function updateExternalSource(
  id: string,
  input: {
    name?: string
    config?: Record<string, unknown>
    credentials?: Record<string, string>
    sync_interval_sec?: number
    auto_build_enabled?: boolean
    enabled?: boolean
  },
): Promise<ExternalSource> {
  return authClient.patch<ExternalSource>(`/api/v1/external-sources/${id}`, input)
}

export function deleteExternalSource(id: string): Promise<{ ok: boolean }> {
  return authClient.delete(`/api/v1/external-sources/${id}`)
}

export function testExternalSource(id: string): Promise<TestConnectionResult> {
  return authClient.post<TestConnectionResult>(
    `/api/v1/external-sources/${id}/test`,
    undefined,
  )
}

export function syncExternalSource(id: string): Promise<{ ok: boolean; message: string }> {
  return authClient.post<{ ok: boolean; message: string }>(
    `/api/v1/external-sources/${id}/sync`,
    undefined,
  )
}
