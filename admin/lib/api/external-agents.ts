import { dcClient } from './client'
import type { AgentVersionsPage, AgentVersionManifest, AgentChannel } from '../../../contracts/agent-federation/v1alpha1/contract'
export type { AgentVersionsPage, AgentVersionManifest, AgentChannel } from '../../../contracts/agent-federation/v1alpha1/contract'
import type {
  ExternalAgentAdmin,
  ExternalTask,
  ExternalConnectionInspection,
  ExternalPilotPolicy,
  ExternalProviderAccess,
  ExternalProviderMember,
  InspectExternalConnection,
  OnboardExternalAgent,
  UpdateExternalAgent,
} from '../../../contracts/external-provider/v1/contract'

export type {
  ExternalTask,
  ExternalAgentAdmin,
  ExternalPilotPolicy,
  ExternalProviderAccess,
  ExternalProviderMember,
  OnboardExternalAgent,
} from '../../../contracts/external-provider/v1/contract'

interface ExternalHttpClient {
  get<T>(path: string, options?: Partial<RequestInit>): Promise<T>
  post<T>(path: string, body?: unknown, options?: Partial<RequestInit>): Promise<T>
}

/** Keep the existing Moss contract and organization-scoped authentication. */
export function createExternalAgentsApi(
  client: ExternalHttpClient = dcClient,
  signal?: AbortSignal | (() => AbortSignal),
) {
  async function unwrap<T>(request: Promise<{ success: boolean; data?: T }>, requestSignal?: AbortSignal): Promise<T> {
    const result = await request
    requestSignal?.throwIfAborted()
    if (!result.success || result.data === undefined) throw new Error('EXTERNAL_PROVIDER_UNAVAILABLE')
    return result.data
  }
  const get = <T>(path: string) => {
    const requestSignal = typeof signal === 'function' ? signal() : signal
    return unwrap(client.get<{ success: boolean; data: T }>(path, { signal: requestSignal }), requestSignal)
  }
  const post = <T>(path: string, body?: unknown) => {
    const requestSignal = typeof signal === 'function' ? signal() : signal
    return unwrap(client.post<{ success: boolean; data: T }>(path, body, { signal: requestSignal }), requestSignal)
  }
  const base = '/api/v1/external-agents'
  const agentPath = (id: string, action: string) => `${base}/admin/${encodeURIComponent(id)}/${action}`
  return {
    access: () => get<ExternalProviderAccess>(`${base}/access`),
    list: () => get<ExternalAgentAdmin[]>(`${base}/admin/agents`),
    listPage: (after = '') => get<{ items: ExternalAgentAdmin[]; next_cursor: string | null }>(`${base}/admin/agents?paged=1&after=${encodeURIComponent(after)}`),
    unknownTasks: () => get<ExternalTask[]>(`${base}/admin/unknown-tasks`),
    reconcileTask: (taskId: string, note: string) =>
      post<ExternalTask>(`${base}/admin/reconcile-task`, { task_id: taskId, action: 'close', note }),
    members: () => get<ExternalProviderMember[]>(`${base}/admin/members`),
    membersPage: (search = '', after = '') => get<{ items: ExternalProviderMember[]; next_cursor: string | null }>(`${base}/admin/members-page?q=${encodeURIComponent(search)}&after=${encodeURIComponent(after)}`),
    policy: () => get<ExternalPilotPolicy>(`${base}/admin/policy`),
    savePolicy: (body: ExternalPilotPolicy) => post<ExternalPilotPolicy>(`${base}/admin/policy`, body),
    inspect: (body: InspectExternalConnection) => post<ExternalConnectionInspection>(`${base}/admin/inspect`, body),
    onboard: (body: OnboardExternalAgent) => post<ExternalAgentAdmin>(`${base}/admin/onboard`, body),
    update: (id: string, body: UpdateExternalAgent) => post<ExternalAgentAdmin>(agentPath(id, 'update'), body),
    test: (id: string) => post<ExternalConnectionInspection>(agentPath(id, 'test')),
    rotate: (id: string, body: { revision: number; api_key: string }) =>
      post<ExternalAgentAdmin>(agentPath(id, 'rotate'), body),
    archive: (id: string, revision: number) => post<ExternalAgentAdmin>(agentPath(id, 'archive'), { revision }),
    versions: (id: string, after = '') => get<AgentVersionsPage>(`${agentPath(id, 'versions')}?after=${encodeURIComponent(after)}`),
    publishVersion: (id: string, body: { revision: number; version: string; note: string }) => post<AgentVersionManifest>(agentPath(id, 'versions'), body),
    moveChannel: (id: string, body: { name: 'stable' | 'canary'; version: string; revision: number }) => post<AgentChannel>(agentPath(id, 'channels'), body),
    revokeVersion: (id: string, body: { version: string; note: string }) => post<{ revoked: boolean }>(agentPath(id, 'revoke-version'), body),
    review: (id: string, body: { approved: boolean; revision: number; review_days?: number }) =>
      post<ExternalAgentAdmin>(`${base}/${encodeURIComponent(id)}/review`, body),
  }
}
