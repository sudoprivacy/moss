import type { ExternalProviderService } from './service.js'
import { ExternalProviderError } from './policy.js'
import type { ExternalActor } from './store.js'

export function isExternalProviderRoute(path: string): boolean {
  return /^\/api\/v1\/(external-agents|external-sessions|tasks)(\/|$)/.test(path)
}

export async function dispatchExternalProvider(service: ExternalProviderService | null, actor: ExternalActor, method: string, url: URL, body: unknown, requireAdmin: () => void, requirePlatformAdmin: () => void = () => { throw new ExternalProviderError(403, 'PLATFORM_ADMIN_REQUIRED') }) {
  try {
    if (url.pathname === '/api/v1/external-agents/access' && method === 'GET') {
      let can_manage = true, can_manage_policy = true
      try { requireAdmin() } catch { can_manage = false }
      try { requirePlatformAdmin() } catch { can_manage_policy = false }
      return { status: 200, body: { success: true, data: { can_manage, can_manage_policy, credential_storage_available: service?.administration.credentialStorageAvailable ?? false } } }
    }
    if (!service) throw new ExternalProviderError(503, 'EXTERNAL_PROVIDER_UNAVAILABLE')
    await service.authorize(actor)
    const path = url.pathname, base = '/api/v1'
    if (service.isRegistryMaintenance && method === 'POST' && !path.endsWith('/registry-migrate')) throw new ExternalProviderError(503, 'REGISTRY_MAINTENANCE_REQUIRED')
    const after = url.searchParams.get('after') ?? ''
    if (after.length > 200 || (after && !/^[\w.-]+$/.test(after))) throw new ExternalProviderError(400, 'INVALID_CURSOR')
    let data: unknown, status = 200
    if (path.startsWith(`${base}/external-agents/admin/`)) {
      requireAdmin()
      const action = path.slice(`${base}/external-agents/admin/`.length)
      const admin = service.administration
      if (action === 'policy' && method === 'GET') data = await admin.policy(actor)
      else if (action === 'policy' && method === 'POST') { requirePlatformAdmin(); data = await admin.setPolicy(actor, body) }
      else if (action === 'endpoint-requests' && method === 'GET') data = await admin.endpointRequests.list(actor, after)
      else if (action === 'endpoint-requests' && method === 'POST') data = await admin.endpointRequests.submit(actor, body)
      else if (action === 'endpoint-requests/review' && method === 'POST') { requirePlatformAdmin(); data = await admin.endpointRequests.review(actor, body) }
      else if (action === 'endpoints/approve' && method === 'POST') { requirePlatformAdmin(); data = await admin.endpointRequests.approve(actor, body) }
      else if (action === 'members-page' && method === 'GET') data = await admin.memberPage(actor, url.searchParams.get('after') ?? '', url.searchParams.get('q') ?? '')
      else if (action === 'members' && method === 'GET') data = await admin.members(actor)
      else if (action === 'agents' && method === 'GET') data = url.searchParams.get('paged') === '1' ? await admin.listPage(actor, after) : await admin.list(actor)
      else if (action === 'unknown-tasks' && method === 'GET') data = await service.store.unresolved(actor.orgId)
      else if (action === 'reconcile-task' && method === 'POST') {
        const input = body as { task_id?: unknown; note?: unknown; action?: unknown } | null
        if (!input || input.action !== 'close' || typeof input.task_id !== 'string' || typeof input.note !== 'string' || input.note.trim().length < 10 || input.note.length > 2000 || Object.keys(input).some(key => !['task_id', 'note', 'action'].includes(key))) throw new ExternalProviderError(400, 'INVALID_RECONCILIATION')
        data = await service.store.reconcileUnknown(actor, input.task_id, input.note.trim())
      }
      else if (action === 'inspect' && method === 'POST') data = await admin.inspect(actor, body)
      else if (action === 'onboard' && method === 'POST') { data = await service.onboard(actor, body); status = 201 }
      else {
        const release = /^([\w-]+)\/(versions|channels|revoke-version|registry-status|registry-plan|registry-migrate)$/.exec(action)
        if (release) {
          await service.store.binding(actor, release[1])
          if (release[2] === 'registry-status' && method === 'GET') data = await service.registryMigration.status(actor, release[1])
          else if (release[2] === 'registry-plan' && method === 'GET') {
            const plan = await service.registryMigration.plan(actor, release[1])
            data = { plan_digest: plan.plan_digest, version_count: plan.source.items.length, active_tasks: plan.active_tasks, principal: plan.source.principal }
          } else if (release[2] === 'registry-migrate' && method === 'POST') {
            const input = body as { plan_digest?: unknown; old_writers_stopped?: unknown }
            if (!input || typeof input.plan_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.plan_digest) || input.old_writers_stopped !== true
              || Object.keys(input).some(key => !['plan_digest', 'old_writers_stopped'].includes(key))) throw new ExternalProviderError(400, 'INVALID_REGISTRY_MIGRATION')
            data = await service.registryMigration.apply(actor, release[1], { plan_digest: input.plan_digest, old_writers_stopped: true })
          } else if (release[2] === 'versions' && method === 'GET') data = await service.releases.list(actor, release[1], after)
          else if (release[2] === 'versions' && method === 'POST') { data = await service.publishVersion(actor, release[1], body); status = 201 }
          else if (release[2] === 'channels' && method === 'POST') {
            const input = body as { name?: unknown; version?: unknown; revision?: unknown }
            if (!input || !['stable', 'canary'].includes(String(input.name)) || typeof input.version !== 'string' || !Number.isSafeInteger(input.revision) || Object.keys(input).some(key => !['name', 'version', 'revision'].includes(key))) throw new ExternalProviderError(400, 'INVALID_CHANNEL_INPUT')
            data = await service.releases.moveChannel(actor, release[1], input.name as 'stable' | 'canary', input.version, Number(input.revision))
          } else if (release[2] === 'revoke-version' && method === 'POST') {
            const input = body as { version?: unknown; note?: unknown }
            if (!input || typeof input.version !== 'string' || typeof input.note !== 'string' || Object.keys(input).some(key => !['version', 'note'].includes(key))) throw new ExternalProviderError(400, 'INVALID_RELEASE_INPUT')
            await service.releases.revoke(actor, release[1], input.version, input.note); data = { revoked: true }
          } else throw new ExternalProviderError(404, 'NOT_FOUND')
          return { status, body: { success: true, data } }
        }
        const match = /^([\w-]+)\/(update|test|rotate|archive)$/.exec(action)
        if (!match || method !== 'POST') throw new ExternalProviderError(404, 'NOT_FOUND')
        if (match[2] === 'test') data = await admin.testSaved(actor, match[1])
        else if (match[2] === 'update') data = await admin.update(actor, match[1], body)
        else if (match[2] === 'rotate') data = await admin.rotate(actor, match[1], body)
        else data = await admin.archive(actor, match[1], body)
      }
    } else if (path === `${base}/external-agents` && method === 'GET') data = url.searchParams.get('paged') === '1' ? await service.listPage(actor, after) : await service.list(actor)
    else if (path === `${base}/external-agents` && method === 'POST') {
      requireAdmin(); data = await service.register(actor, body); status = 201
    } else if (path === `${base}/tasks` && method === 'POST') {
      data = await service.create(actor, body); status = 202
    } else if (path === `${base}/external-sessions` && method === 'GET') data = await service.store.sessions(actor)
    else {
      const review = /^\/api\/v1\/external-agents\/([\w-]+)\/review$/.exec(path)
      const versions = /^\/api\/v1\/external-agents\/([\w-]+)\/versions$/.exec(path)
      const session = /^\/api\/v1\/external-sessions\/([\w-]+)\/tasks$/.exec(path)
      const task = /^\/api\/v1\/tasks\/([\w-]+)(?:\/(events|cancel|external-run|specification|evidence))?$/.exec(path)
      if (review && method === 'POST') {
        requireAdmin()
        if (!body || typeof body !== 'object' || typeof (body as { approved?: unknown }).approved !== 'boolean' || !Number.isSafeInteger((body as { revision?: unknown }).revision) || Number((body as { revision?: unknown }).revision) < 1 || Object.keys(body).some(key => !['approved', 'revision', 'review_days'].includes(key))) throw new ExternalProviderError(400, 'INVALID_REVIEW')
        data = await service.review(actor, review[1], (body as { approved: boolean }).approved, (body as { revision: number }).revision, (body as { review_days?: number }).review_days)
      } else if (versions && method === 'GET') data = await service.releaseOptions(actor, versions[1], after)
      else if (session && method === 'GET') data = await service.store.history(actor, session[1])
      else if (task && method === 'GET' && !task[2]) data = await service.store.task(actor, task[1])
      else if (task && method === 'GET' && task[2] === 'specification') data = await service.store.taskRecord(actor, task[1])
      else if (task && method === 'GET' && task[2] === 'evidence') data = await service.evidence(actor, task[1])
      else if (task && method === 'GET' && task[2] === 'external-run') data = await service.store.runBinding(actor, task[1])
      else if (task && method === 'GET' && task[2] === 'events') {
        const cursor = Number(url.searchParams.get('cursor') ?? 0)
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ExternalProviderError(400, 'INVALID_CURSOR')
        data = await service.store.events(actor, task[1], cursor)
      } else if (task && method === 'POST' && task[2] === 'cancel') {
        await service.store.task(actor, task[1])
        throw new ExternalProviderError(409, 'CANCELLATION_UNSUPPORTED')
      } else throw new ExternalProviderError(404, 'NOT_FOUND')
    }
    return { status, body: { success: true, data } }
  } catch (error) {
    if (error instanceof ExternalProviderError) return { status: error.status, body: { success: false, error: { code: error.code } } }
    // Provider/Secret/DB error text must never cross the API boundary.
    return { status: 503, body: { success: false, error: { code: 'EXTERNAL_PROVIDER_UNAVAILABLE' } } }
  }
}
