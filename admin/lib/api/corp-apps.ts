import { authClient } from './client'

// ============================================================
// Corp App API — 企业应用管理 (Corp App Management)
// Multiple named instances per type (first type: 'wecomapp').
// ============================================================

export type CorpApp = {
  id: string
  orgId: string
  type: string                    // 'wecomapp' | ...
  name: string
  appKey: string                  // keyOf(config), e.g. corpId:agentId
  config: Record<string, unknown> // non-secret fields (corpId, agentId, ...)
  hasCredentials: boolean
  enabled: boolean
  capabilities?: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type CorpAppType = {
  type: string
  capabilities: string[]
}

export type TestConnectionResult = {
  ok: boolean
  message?: string
}

export async function listCorpApps(): Promise<CorpApp[]> {
  const data = await authClient.get<{ apps: CorpApp[] }>('/api/v1/corp-apps')
  return data.apps
}

export async function listCorpAppTypes(): Promise<CorpAppType[]> {
  const data = await authClient.get<{ types: CorpAppType[] }>('/api/v1/corp-apps/types')
  return data.types
}

export function getCorpApp(id: string): Promise<CorpApp> {
  return authClient.get<CorpApp>(`/api/v1/corp-apps/${id}`)
}

export function createCorpApp(input: {
  type: string
  name: string
  config: Record<string, unknown>
  credentials?: Record<string, string>
}): Promise<CorpApp> {
  return authClient.post<CorpApp>('/api/v1/corp-apps', input)
}

export function updateCorpApp(
  id: string,
  input: {
    name?: string
    config?: Record<string, unknown>
    credentials?: Record<string, string>
    enabled?: boolean
  },
): Promise<CorpApp> {
  return authClient.patch<CorpApp>(`/api/v1/corp-apps/${id}`, input)
}

export function deleteCorpApp(id: string): Promise<{ ok: boolean }> {
  return authClient.delete(`/api/v1/corp-apps/${id}`)
}

export function testCorpApp(id: string): Promise<TestConnectionResult> {
  return authClient.post<TestConnectionResult>(`/api/v1/corp-apps/${id}/test`, undefined)
}

/** Result of generating a 会话存档 RSA keypair (private key stays server-side). */
export type GenerateKeypairResult = {
  ok: boolean
  /** publickey_ver assigned to the new key. */
  version: number
  /** PEM public key — paste this into the WeCom console. */
  publicKey: string
  /** All private-key versions now held, oldest first. */
  versions: string[]
}

/**
 * Generate an RSA-2048 keypair for a 会话存档 instance. The private key is
 * stored in the encrypted credential blob and never returned; only the
 * public half comes back. Repeat calls APPEND a new version rather than
 * replacing, so records encrypted under an older key stay decryptable.
 */
export function generateCorpAppKeypair(id: string): Promise<GenerateKeypairResult> {
  return authClient.post<GenerateKeypairResult>(`/api/v1/corp-apps/${id}/generate-keypair`, undefined)
}
