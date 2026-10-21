import { hasScope, type AuthContext } from '../auth/token.js'
import type { AgentToolGateway } from './toolGateway.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

export function assertAgentToolManager(actor: AuthContext, current: { status: string; role: string } | null) {
  if (current?.status !== 'active' || !['admin', 'super_admin'].includes(current.role) || !['admin', 'super_admin'].includes(actor.role)
    || !hasScope(actor.scopes, 'admin:users') || !hasScope(actor.scopes, 'admin:mcp')) throw new ExternalProviderError(403, 'ADMIN_REQUIRED')
}

export const toolInvocationRoute = /^\/api\/v1\/agent-tools\/([A-Za-z0-9_.:@-]+)\/invoke$/
export const toolManagementRoute = /^\/api\/v1\/admin\/mcp-servers\/([A-Za-z0-9_-]+)\/agent-tools(?:\/(discover|review|disable|calls))?$/
export type ToolManagement = { gateway: AgentToolGateway; authorize(actor: AuthContext): Promise<void> }
export async function dispatchToolManagement(service: ToolManagement | undefined, actor: AuthContext, method: string, path: string, body: unknown) {
  if (!service) throw new ExternalProviderError(503, 'TOOL_GATEWAY_NOT_CONFIGURED')
  await service.authorize(actor)
  const match = toolManagementRoute.exec(path)
  if (!match) throw new ExternalProviderError(404, 'NOT_FOUND')
  const [, id, action] = match
  if (method === 'GET' && !action) return service.gateway.store.reviews(actor.orgId, id)
  if (method === 'GET' && action === 'calls') return (await service.gateway.store.calls(actor.orgId, id)).map(({ result: _result, ...audit }) => audit)
  if (method === 'POST' && action === 'discover') {
    if (!body || typeof body !== 'object' || Object.keys(body).length) throw new ExternalProviderError(400, 'INVALID_TOOL_REQUEST')
    return service.gateway.discover(actor.orgId, id)
  }
  if (method === 'POST' && action === 'disable') return service.gateway.disable(actor.orgId, id, actor.userId, body)
  if (method === 'POST' && action === 'review') return service.gateway.approve(actor.orgId, id, actor.userId, body)
  throw new ExternalProviderError(405, 'METHOD_NOT_ALLOWED')
}
