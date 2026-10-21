import type { AuthContext } from '../auth/token.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import type { AgentInventoryService } from './inventoryService.js'
import { DifySourceError } from './registryClient.js'

export const isAgentInventoryRoute = (path: string) => /^\/api\/v1\/agent-inventory(?:\/|$)/.test(path)

export async function dispatchAgentInventory(
  service: AgentInventoryService,
  actor: AuthContext,
  method: string,
  url: URL,
  body: unknown,
) {
  try {
    const base = '/api/v1/agent-inventory',
      path = url.pathname
    const match = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)(\/history)?$/.exec(path)
    const hosted = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/artifacts$/.exec(path)
    let data
    if (method === 'GET' && path === `${base}/access`) data = await service.access(actor)
    else if (method === 'GET' && path === `${base}/members`)
      data = await service.members(actor, url.searchParams.get('after') ?? '', url.searchParams.get('q') ?? '')
    else if (method === 'GET' && path === `${base}/assets`)
      data = await service.list(actor, url.searchParams.get('after') ?? '')
    else if (method === 'GET' && path === `${base}/discovered`)
      data = await service.discovered(actor, url.searchParams.get('after') ?? '')
    else if (method === 'GET' && path === `${base}/sources`) data = await service.listSources(actor)
    else if (method === 'POST' && path === `${base}/sources`) data = await service.createSource(actor, body)
    else if (method === 'POST' && path === `${base}/discover`) data = await service.discover(actor, body)
    else if (method === 'POST' && /^\/api\/v1\/agent-inventory\/sources\/[A-Za-z0-9-]+\/disable$/.test(path))
      data = await service.disableSource(actor, path.split('/').at(-2)!)
    else if (method === 'GET' && match)
      data = match[2]
        ? await service.history(actor, match[1], Number(url.searchParams.get('after') ?? 0))
        : await service.get(actor, match[1])
    else if (method === 'POST' && path === `${base}/commands`) data = await service.command(actor, body)
    else if (method === 'GET' && hosted) data = await service.hostedList(actor, hosted[1], url.searchParams.get('after') ?? '')
    else if (method === 'GET' && /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/datasets$/.test(path)) data = await service.datasetList(actor, path.split('/')[5], url.searchParams.get('after') ?? '')
    else if (method === 'POST' && path === `${base}/hosted/datasets`) data = await service.datasetRegister(actor, body)
    else if (method === 'POST' && path === `${base}/hosted/dify/inspect`) data = await service.hostedInspect(actor, body)
    else if (method === 'POST' && path === `${base}/hosted/artifacts`) data = await service.hostedRegister(actor, body)
    else throw new ExternalProviderError(404, 'NOT_FOUND')
    return { status: 200, body: { success: true, data } }
  } catch (error) {
    return {
      status: error instanceof ExternalProviderError ? error.status : 503,
      body: {
        success: false,
        error: { code: error instanceof ExternalProviderError ? error.code : 'AGENT_INVENTORY_UNAVAILABLE',
          ...(error instanceof DifySourceError ? { message: `DSL_FIELD:${error.fieldPath}` } : {}),
        },
      },
    }
  }
}
