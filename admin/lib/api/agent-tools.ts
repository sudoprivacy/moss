import { authClient } from './client'

export interface AgentToolDescriptor { protocol: string; digest: string; tool: { name: string; description?: string; inputSchema: unknown; annotations?: unknown } }
export interface AgentToolReview extends AgentToolDescriptor {
  resource: string; revision: string; enabled: boolean; action: 'read' | 'write'; sensitive: boolean; outbound: boolean; reviewedBy: string; reviewedAt: number
}
export interface AgentToolCall {
  id: string; taskId: string; assetId: string; workerId: string; initiatedBy: string; tool: string; resource: string; descriptorDigest: string
  status: 'preparing' | 'dispatching' | 'completed' | 'tool_error' | 'rejected' | 'unknown'; errorCode?: string; updatedAt: number
}
type Envelope<T> = { success: boolean; data: T }
export function createAgentToolsApi(client: Pick<typeof authClient, 'get' | 'post'> = authClient, signal?: () => AbortSignal | undefined) {
  const base = (id: string) => `/api/v1/admin/mcp-servers/${encodeURIComponent(id)}/agent-tools`
  async function get<T>(path: string): Promise<T> { const active = signal?.(); const result = await client.get<Envelope<T>>(path, { signal: active }); active?.throwIfAborted(); return result.data }
  async function post<T>(path: string, body: unknown): Promise<T> { const active = signal?.(); const result = await client.post<Envelope<T>>(path, body, { signal: active }); active?.throwIfAborted(); return result.data }
  return {
    reviews: (id: string) => get<AgentToolReview[]>(base(id)),
    calls: (id: string) => get<AgentToolCall[]>(`${base(id)}/calls`),
    discover: (id: string) => post<AgentToolDescriptor[]>(`${base(id)}/discover`, {}),
    review: (id: string, body: { tool: string; digest: string; action: 'read' | 'write'; sensitive: boolean; outbound: boolean; enabled: boolean; expected_revision: string | null }) => post<AgentToolReview>(`${base(id)}/review`, body),
    disable: (id: string, review: AgentToolReview) => post<AgentToolReview>(`${base(id)}/disable`, { resource: review.resource, expected_revision: review.revision }),
  }
}
