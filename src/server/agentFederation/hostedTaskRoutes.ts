import type { DbDriver } from '../db/driver.js'
import type { ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { object } from '../externalProviders/administration.js'
import { parseTaskSubmission } from './taskContract.js'
import type { HostedTaskService } from './hostedTaskService.js'

export const isHostedTaskRoute = (path: string) => /^\/api\/v1\/(hosted-agents|hosted-sessions)(?:\/|$)/.test(path)
/** Returns null for the existing external adapter. Runtime selection follows durable idempotency first. */
export async function dispatchHostedTask(service: HostedTaskService | undefined, db: DbDriver, actor: ExternalActor, method: string, url: URL, body: unknown) {
  try {
    const path = url.pathname
    let hosted = isHostedTaskRoute(path)
    const taskPath = /^\/api\/v1\/tasks\/([\w-]+)(?:\/(events|cancel|specification|evidence|reconcile|close))?$/.exec(path)
    if (path === '/api/v1/tasks' && method === 'POST' && body && typeof body === 'object' && 'kind' in body && body.kind === 'SubmitTask') {
      const input = parseTaskSubmission(body)
      const existing = await db.get(`SELECT s.runtime_type FROM tasks t JOIN sessions s ON s.session_id = t.session_id
        WHERE t.org_id = ? AND t.user_id = ? AND t.idempotency_key = ? AND s.org_id = t.org_id AND s.user_id = t.user_id`, [actor.orgId, actor.userId, input.constraints.idempotency_key])
      if (existing) hosted = existing.runtime_type === 'hosted'
      else {
        const item = await db.get('SELECT provider_binding FROM tenant_assistants WHERE id = ? AND org_id = ?', [input.agent.catalog_id, actor.orgId])
        hosted = !!item?.provider_binding && JSON.parse(String(item.provider_binding)).executionMode === 'internal_hosted'
      }
    } else if (taskPath) {
      const row = await db.get(`SELECT s.runtime_type FROM tasks t JOIN sessions s ON s.session_id = t.session_id
        WHERE t.id = ? AND t.org_id = ? AND t.user_id = ? AND s.org_id = t.org_id AND s.user_id = t.user_id`, [taskPath[1], actor.orgId, actor.userId])
      hosted = row?.runtime_type === 'hosted'
    }
    if (!hosted) return null
    if (!service && path === '/api/v1/hosted-agents' && method === 'GET') {
      const rows = await db.all("SELECT provider_binding FROM tenant_assistants WHERE org_id = ? AND status = 'approved' AND enabled = 1", [actor.orgId])
      if (!rows.some(row => row.provider_binding && JSON.parse(String(row.provider_binding)).executionMode === 'internal_hosted')) {
        return { status: 200, body: { success: true, data: { items: [], next_cursor: null } } }
      }
    }
    if (!service) throw new ExternalProviderError(503, 'HOSTED_TASKS_UNAVAILABLE')
    await service.authorize(actor)
    let data: unknown, status = 200
    const agent = /^\/api\/v1\/hosted-agents\/([\w-]+)\/versions$/.exec(path)
    const session = /^\/api\/v1\/hosted-sessions\/([\w-]+)\/tasks$/.exec(path)
    if (path === '/api/v1/hosted-agents' && method === 'GET') data = await service.list(actor, url.searchParams.get('after') ?? '')
    else if (agent && method === 'GET') data = await service.versions(actor, agent[1], url.searchParams.get('after') ?? '')
    else if (path === '/api/v1/hosted-sessions' && method === 'GET') data = await service.store.sessions(actor)
    else if (session && method === 'GET') data = await service.store.history(actor, session[1])
    else if (path === '/api/v1/tasks' && method === 'POST') { data = await service.create(actor, body); status = 202 }
    else if (taskPath && method === 'GET' && !taskPath[2]) data = await service.store.get(actor, taskPath[1])
    else if (taskPath && method === 'GET' && taskPath[2] === 'evidence') data = await service.evidence(actor, taskPath[1], Number(url.searchParams.get('cursor') ?? 0))
    else if (taskPath && method === 'GET' && taskPath[2] === 'specification') data = await service.store.record(actor, taskPath[1])
    else if (taskPath && method === 'GET' && taskPath[2] === 'events') data = await service.store.events(actor, taskPath[1], Number(url.searchParams.get('cursor') ?? 0))
    else if (taskPath && method === 'POST' && taskPath[2] === 'cancel') { object(body, []); data = await service.coordinator.cancel(actor, taskPath[1]) }
    else if (taskPath && method === 'POST' && taskPath[2] === 'reconcile') { object(body, []); data = await service.coordinator.reconcile(actor, taskPath[1]) }
    else if (taskPath && method === 'POST' && taskPath[2] === 'close') {
      const input = object(body, ['note'])
      if (typeof input.note !== 'string') throw new ExternalProviderError(400, 'INVALID_RECONCILIATION')
      data = await service.store.closeUnknown(actor, taskPath[1], input.note)
    } else throw new ExternalProviderError(404, 'NOT_FOUND')
    return { status, body: { success: true, data } }
  } catch (error) {
    return { status: error instanceof ExternalProviderError ? error.status : 503,
      body: { success: false, error: { code: error instanceof ExternalProviderError ? error.code : 'HOSTED_TASKS_UNAVAILABLE' } } }
  }
}
