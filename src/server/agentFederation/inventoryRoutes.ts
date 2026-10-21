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
    const release = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/releases$/.exec(path)
    const hosted = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/artifacts$/.exec(path)
    const evaluations = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/evaluations$/.exec(path)
    const evaluation = /^\/api\/v1\/agent-inventory\/hosted\/evaluations\/([A-Za-z0-9_.:@-]+)(?:\/(cases|resume|stop|reconcile|compare))?$/.exec(path)
    const policies = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/migration-policies$/.exec(path)
    const comparison = /^\/api\/v1\/agent-inventory\/hosted\/migration\/comparisons\/([A-Za-z0-9_.:@-]+)$/.exec(path)
    const suspension = /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/suspension$/.exec(path)
    const managedTask = /^\/api\/v1\/agent-inventory\/hosted\/tasks\/([\w-]+)\/(reconcile|close)$/.exec(path)
    let data
    if (method === 'GET' && path === `${base}/access`) data = await service.access(actor)
    else if (method === 'GET' && path === `${base}/usage`) data = await service.usage(actor, url.searchParams)
    else if (method === 'GET' && path === `${base}/hosted/tasks/unknown`) data = await service.hostedUnknown(actor, url.searchParams.get('after') ?? '')
    else if (suspension && (method === 'GET' || method === 'POST')) {
      if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw new ExternalProviderError(400, 'INVALID_SUSPENSION')
      data = await service.suspension(actor, suspension[1], method === 'POST')
    }
    else if (method === 'POST' && managedTask) data = await service.hostedTaskAction(actor, managedTask[1], managedTask[2] as 'reconcile' | 'close', body)
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
    else if (method === 'GET' && release) data = await service.hostedReleases(actor, release[1], url.searchParams.get('after') ?? '')
    else if (method === 'POST' && release) data = await service.hostedReleaseAction(actor, release[1], body)
    else if (method === 'GET' && hosted) data = await service.hostedList(actor, hosted[1], url.searchParams.get('after') ?? '')
    else if (method === 'GET' && /^\/api\/v1\/agent-inventory\/assets\/([A-Za-z0-9_.:@-]+)\/datasets$/.test(path)) data = await service.datasetList(actor, path.split('/')[5], url.searchParams.get('after') ?? '')
    else if (method === 'GET' && policies) data = await service.migrationPolicies(actor, policies[1], url.searchParams.get('after') ?? '')
    else if (method === 'POST' && path === `${base}/hosted/migration/policies`) data = await service.migrationPolicyCreate(actor, body)
    else if (method === 'GET' && comparison) data = await service.migrationComparison(actor, comparison[1])
    else if (method === 'POST' && evaluation?.[2] === 'compare') data = await service.migrationCompare(actor, evaluation[1], body)
    else if (method === 'GET' && evaluations) data = await service.evaluationList(actor, evaluations[1], url.searchParams.get('after') ?? '')
    else if (method === 'GET' && evaluation && !evaluation[2]) data = await service.evaluationGet(actor, evaluation[1])
    else if (method === 'GET' && evaluation?.[2] === 'cases') data = await service.evaluationCases(actor, evaluation[1], url.searchParams.get('after') ?? '')
    else if (method === 'POST' && evaluation && ['resume', 'stop', 'reconcile'].includes(evaluation[2])) data = await service.evaluationAction(actor, evaluation[1], evaluation[2] as 'resume' | 'stop' | 'reconcile', body)
    else if (method === 'POST' && path === `${base}/hosted/evaluations`) data = await service.evaluationStart(actor, body)
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
