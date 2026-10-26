import type { IncomingMessage, ServerResponse } from 'node:http'
import { ZodError } from 'zod'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { readExecutionJson, TOOL_BODY_LIMIT } from '../agentFederation/executionGatewayRoutes.js'
import { writeJson } from '../httpRespond.js'
import { AGENT_CONTROL_PROTOCOL } from './contract.js'
import type { AgentControlService } from './service.js'

const PREFIX = '/api/v1/agent-control'
export function isAgentControlPath(path: string) { return path === PREFIX || path.startsWith(`${PREFIX}/`) }

/** Separate credential consumer: control bearers never enter normal HTTP auth. */
export async function dispatchAgentControl(req: IncomingMessage, res: ServerResponse, url: URL, service?: AgentControlService) {
  res.setHeader('cache-control', 'no-store')
  try {
    if (!service) throw new ResourceAccessError(503, 'Agent control is not configured')
    if (url.search) throw new ResourceAccessError(400, 'Agent control does not accept query credentials or parameters')
    const bearer = /^Bearer ([\x21-\x7e]{1,8192})$/i.exec(req.headers.authorization ?? '')?.[1]
    if (!bearer) throw new ResourceAccessError(401, 'A purpose-bound credential is required')
    const path = url.pathname.slice(PREFIX.length)
    let value: unknown
    if (path === '/delegations' && req.method === 'POST') value = await service.issue(bearer, await readExecutionJson(req, TOOL_BODY_LIMIT))
    else if (path === '/capabilities' && req.method === 'GET') value = await service.capabilities(bearer)
    else if (path === '/invoke' && req.method === 'POST') value = await service.invoke(bearer, await readExecutionJson(req, TOOL_BODY_LIMIT))
    else {
      const operation = /^\/operations\/([A-Za-z0-9_-]{1,128})$/.exec(path)
      const delegation = /^\/delegations\/([A-Za-z0-9_-]{1,128})$/.exec(path)
      if (operation && req.method === 'GET') value = await service.operation(bearer, operation[1]!)
      else if (delegation && req.method === 'DELETE') value = await service.revoke(bearer, delegation[1]!)
      else throw new ResourceAccessError(404, 'Agent control operation is not available')
    }
    writeJson(res, 200, value)
  } catch (error) {
    const status = error instanceof ResourceAccessError ? error.statusCode : error instanceof ZodError ? 400
      : error instanceof ExternalProviderError ? error.status : 500
    // A refused HTTP attempt says nothing about a previous attempt with an
    // already-used operation ID. Only a durable rejected receipt proves that
    // the original operation was not submitted; transport errors stay Unknown.
    writeJson(res, status, { protocol: AGENT_CONTROL_PROTOCOL, outcome: 'unknown',
      errorCode: status >= 500 ? 'CONTROL_UNAVAILABLE' : 'CONTROL_REQUEST_REFUSED' })
  }
}
