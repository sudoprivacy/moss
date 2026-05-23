import { authClient } from './client'
import type {
  ChannelPluginsResponse,
  ChannelUsersResponse,
  ChannelPendingPairingsResponse,
  IChannelPluginConfig,
  ChannelPlatform,
} from './types'

export async function getPlugins(): Promise<ChannelPluginsResponse> {
  return authClient.get<ChannelPluginsResponse>('/api/v1/channels/plugins')
}

export async function getPlugin(pluginId: string): Promise<IChannelPluginConfig | null> {
  return authClient.get<IChannelPluginConfig | null>(`/api/v1/channels/plugins/${pluginId}`)
}

export async function getPluginCredentials(pluginId: string): Promise<Record<string, any>> {
  return authClient.get<Record<string, any>>(`/api/v1/channels/plugins/${pluginId}/credentials`)
}

export async function enablePlugin(
  pluginId: string,
  config: Record<string, any>,
): Promise<IChannelPluginConfig> {
  return authClient.post<IChannelPluginConfig>(`/api/v1/channels/plugins/${pluginId}/enable`, config)
}

export async function disablePlugin(pluginId: string): Promise<IChannelPluginConfig> {
  return authClient.post<IChannelPluginConfig>(`/api/v1/channels/plugins/${pluginId}/disable`)
}

export async function testPlugin(
  pluginId: string,
  config: Record<string, any>,
): Promise<{ ok: boolean; message?: string }> {
  return authClient.post<{ ok: boolean; message?: string }>(
    `/api/v1/channels/plugins/${pluginId}/test`,
    config,
  )
}

export async function getPendingPairings(): Promise<ChannelPendingPairingsResponse> {
  return authClient.get<ChannelPendingPairingsResponse>('/api/v1/channels/pairings/pending')
}

export async function approvePairing(pairingId: string): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>(`/api/v1/channels/pairings/${pairingId}/approve`)
}

export async function rejectPairing(pairingId: string): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>(`/api/v1/channels/pairings/${pairingId}/reject`)
}

export async function getUsers(platform?: ChannelPlatform): Promise<ChannelUsersResponse> {
  const query = platform ? `?platform=${platform}` : ''
  return authClient.get<ChannelUsersResponse>(`/api/v1/channels/users${query}`)
}

export async function deleteUser(userId: string): Promise<{ ok: boolean }> {
  return authClient.delete<{ ok: boolean }>(`/api/v1/channels/users/${userId}`)
}

export async function syncChannelSettings(
  platform: string,
  agent?: { backend: string; customAgentId?: string; name?: string },
  model?: { id: string; useModel: string },
): Promise<{ ok: boolean }> {
  return authClient.post<{ ok: boolean }>('/api/v1/channels/settings/sync', { platform, agent, model })
}

export async function startWechatQrLogin(): Promise<{ ok: boolean; qrcode?: string; qrcodeImgContent?: string; error?: string }> {
  return authClient.post<{ ok: boolean; qrcode?: string; qrcodeImgContent?: string; error?: string }>('/api/v1/channels/wechat/qr-start')
}

export async function pollWechatQrStatus(qrcodeToken: string): Promise<{ ok: boolean; status?: string; botToken?: string; accountId?: string; error?: string }> {
  return authClient.get<{ ok: boolean; status?: string; botToken?: string; accountId?: string; error?: string }>(`/api/v1/channels/wechat/qr-poll?qrcode=${encodeURIComponent(qrcodeToken)}`)
}
