import type { AgentCatalogGovernance } from './catalogGovernance.js'
import type { ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

/** Library authoring is separate from platform and release administration. */
export interface CatalogLibraryAccess {
  canCreate: boolean
  canReview: boolean
  canReviewOwner: (ownerId: string) => Promise<boolean>
}

export async function authorizeLibraryCatalog(g: AgentCatalogGovernance, actor: ExternalActor, access: CatalogLibraryAccess, method: string, url: URL, body: unknown): Promise<void> {
  const path = url.pathname.split('/admin/catalog/')[1]
  const deny = () => { throw new ExternalProviderError(403, 'CATALOG_PERMISSION_DENIED') }
  const agent = /^agents\/([\w-]+)(?:\/(draft))?$/.exec(path)
  if (agent && ((method === 'GET' && !agent[2]) || (method === 'POST' && agent[2] === 'draft'))) {
    if (method === 'POST' && !access.canReview) return deny()
    const source = await g.data.managed(actor, agent[1])
    if (source && ((access.canCreate && source.view.owner_id === actor.userId) || (access.canReview && await access.canReviewOwner(source.view.owner_id)))) return
    return deny()
  }
  if (method === 'GET' && ['sources', 'candidates'].includes(path)) {
    // Apply department/owner filtering to the returned page as well; a supplied
    // owner filter must never substitute for authorization.
    if (!access.canCreate && !access.canReview) deny()
    return
  }
  const match = /^(sources|candidates)\/([\w-]+)(?:\/(update|test|sync|decide|publication-preview))?$/.exec(path)
  if (!match) return deny()
  const [, kind, id, action] = match
  const source = kind === 'sources' ? await g.data.source(actor, id) : await g.data.source(actor, (await g.data.candidate(actor, id)).view.source_id)
  const isOwner = access.canCreate && source.view.owner_id === actor.userId
  if (method === 'GET' && (!action || (kind === 'sources' && action === 'publication-preview')) && (isOwner || (access.canReview && await access.canReviewOwner(source.view.owner_id)))) return
  if (method === 'POST' && kind === 'sources' && ['update', 'test', 'sync'].includes(action) && isOwner) {
    // A working-copy edit cannot disable the shared service or revoke releases.
    if (action === 'update' && body && typeof body === 'object' && 'enabled' in body) return deny()
    return
  }
  if (method === 'POST' && kind === 'candidates' && action === 'decide') {
    const decision = (body as { action?: unknown } | null)?.action
    if (decision === 'submit' && isOwner) return
    if (['approve', 'reject'].includes(String(decision)) && access.canReview && await access.canReviewOwner(source.view.owner_id)) return
  }
  return deny()
}

export async function filterLibraryCatalogPage(g: AgentCatalogGovernance, actor: ExternalActor, access: CatalogLibraryAccess, data: unknown): Promise<unknown> {
  const page = data as { items?: Array<{ owner_id?: string; source_id?: string }> }
  if (!Array.isArray(page?.items)) return data
  const decisions = await Promise.all(page.items.map(async item => {
    const owner = item.owner_id ?? (item.source_id ? (await g.data.source(actor, item.source_id)).view.owner_id : undefined)
    return owner !== undefined && ((access.canCreate && owner === actor.userId) || (access.canReview && await access.canReviewOwner(owner)))
  }))
  return { ...page, items: page.items.filter((_, index) => decisions[index]) }
}
