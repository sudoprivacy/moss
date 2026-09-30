import type { AuthContext } from './auth/token.js'
import { hasScope } from './auth/token.js'
import type { DocumentTreeNode, DocumentRecord, WikiRecord } from './documentStore.js'
import {
  isUsableBy,
  isVisibleTo,
  itemCreatorId,
  withOwnerVisibility,
  type VisibilityFilter,
  type VisibleTo,
} from './visibilityFilter.js'

/**
 * Who may see, use and manage a wiki (and the documents it is built from).
 *
 * Two knowledge spaces, mirroring agents/skills:
 * - tenant (专属-like): the org knowledge base, managed in the admin UI by
 *   holders of `admin:documents` whose management scope covers the owner
 *   (isCreatorInScope). Legacy rows are owned by 'admin' → full admins only.
 * - private (custom-like): a user's 私有 space, managed from SudoWork by its
 *   owner only. Admins can see a private wiki (and disable / delete it) but
 *   neither edit it nor use it unless its owner's scope includes them.
 *
 * Using a wiki through an agent (`enabledWikis`). Binding is always allowed;
 * what a user outside the wiki's own scope gets depends on who controls the
 * binding (tenantDelegationPolicy):
 * - tenant wiki on an admin-controlled agent (hub / system, or a custom / 专属
 *   agent a full admin authored — the admin UI creates agents as custom) →
 *   delegated: the agent is the grant.
 * - tenant wiki on a 专属 agent a non-admin authored → delegated only when the
 *   wiki's scope already covers the agent's (the author can't widen it).
 * - tenant wiki on a non-admin's custom agent, and every private wiki → never
 *   delegated: only users who may use the wiki themselves get it, so no user
 *   can re-share what they were given.
 */

/** Owner who is always part of the wiki's effective scope ('admin' is a placeholder, not a user). */
function realOwnerId(wiki: Pick<WikiRecord, 'ownerId'>): string | null {
  return wiki.ownerId && wiki.ownerId !== 'admin' ? wiki.ownerId : null
}

/** The wiki's scope with its owner always included. */
export function wikiEffectiveVisibleTo(wiki: Pick<WikiRecord, 'visibleTo' | 'ownerId'>): VisibleTo {
  return withOwnerVisibility(wiki.visibleTo ?? undefined, realOwnerId(wiki))
}

/** May the viewer see the wiki (lists, admin UI)? Admins see every wiki. */
export function canSeeWiki(wiki: WikiRecord, filter: VisibilityFilter): boolean {
  return isVisibleTo(wikiEffectiveVisibleTo(wiki), filter)
}

/**
 * May the viewer use the wiki directly — pick it for a session, read or search
 * it through the `wiki` CLI? Disabled wikis are usable by no one. Admins may
 * use every tenant wiki, but a private one only when its owner's scope
 * includes them (like custom agents/skills).
 */
export function isWikiUsableBy(wiki: WikiRecord, filter: VisibilityFilter): boolean {
  if (!wiki.enabled) return false
  const effective = wikiEffectiveVisibleTo(wiki)
  if (wiki.scope === 'private') return isUsableBy(effective, wiki.ownerId, filter)
  return isVisibleTo(effective, filter)
}

/** Whether an agent hands a bound wiki to users outside the wiki's own scope. */
export type DelegationPolicy = (wiki: WikiRecord) => boolean

/** No delegation: every bound wiki follows its own scope. */
export const NO_DELEGATION: DelegationPolicy = () => false

/**
 * Delegation policy of one agent, from its meta and where it's installed. The
 * question is who controls its bindings:
 * - hub / system (admin-only to edit) → every tenant wiki;
 * - custom or tenant (专属) authored by a full admin → every tenant wiki (the
 *   admin UI's 创建智能体 stores agents as custom, owned by that admin);
 * - tenant authored by anyone else → only tenant wikis whose scope already
 *   covers the agent's (binding can't widen a wiki beyond what admins set);
 * - custom authored by anyone else → none: a user must not re-share, through
 *   an agent they scope themselves, a wiki they were only given.
 * The author counts by their *current* role. Private wikis are never delegated.
 */
export function tenantDelegationPolicy(input: {
  category: string | null | undefined
  meta: { source_type?: unknown; author_id?: unknown; visible_to?: VisibleTo } | null | undefined
  isFullAdminUser: (userId: string) => boolean
  isScopeWithin: (next: VisibleTo, current: VisibleTo, ownerId: string) => boolean
}): DelegationPolicy {
  const kind = input.meta?.source_type === 'custom' || input.category === 'custom'
    ? 'custom'
    : input.meta?.source_type === 'tenant' || input.category === 'tenant'
      ? 'tenant'
      : 'managed'
  // Legacy custom items predate author_id; their lone visible_to user is the owner.
  const authorId = itemCreatorId(
    kind === 'custom' ? { ...input.meta, source_type: 'custom' } : input.meta,
  ) ?? (typeof input.meta?.author_id === 'string' && input.meta.author_id ? input.meta.author_id : null)
  if (kind === 'managed' || (authorId && input.isFullAdminUser(authorId))) {
    return wiki => wiki.scope === 'tenant'
  }
  if (kind === 'custom') return NO_DELEGATION
  const agentScope = withOwnerVisibility(input.meta?.visible_to ?? undefined, authorId)
  return wiki =>
    wiki.scope === 'tenant' && input.isScopeWithin(agentScope, wikiEffectiveVisibleTo(wiki), wiki.ownerId)
}

/**
 * Wikis an agent delivers to a session user: what the agent's delegation
 * policy hands out, plus any bound wiki the user may use anyway. Unknown,
 * foreign-org and disabled wikis are dropped. Order follows `wikiIds`.
 */
export function agentDeliveredWikis(
  wikiIds: string[],
  orgId: string,
  filter: VisibilityFilter,
  getWikiById: (id: string) => WikiRecord | null,
  delegates: DelegationPolicy,
): WikiRecord[] {
  const out: WikiRecord[] = []
  const seen = new Set<string>()
  for (const id of wikiIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const wiki = getWikiById(id)
    if (!wiki || wiki.orgId !== orgId || !wiki.enabled) continue
    if (delegates(wiki) || isWikiUsableBy(wiki, filter)) out.push(wiki)
  }
  return out
}

/**
 * The wikis a session advertises to the model: what its agent delivers, plus
 * the wikis the user picked for the session (`enabled_wikis`) that they may use.
 */
export function sessionAdvertisedWikis(input: {
  orgId: string
  filter: VisibilityFilter
  agentWikiIds: string[]
  agentDelegates: DelegationPolicy
  requestedWikiIds: string[]
  getWikiById: (id: string) => WikiRecord | null
}): WikiRecord[] {
  const out = agentDeliveredWikis(input.agentWikiIds, input.orgId, input.filter, input.getWikiById, input.agentDelegates)
  const have = new Set(out.map(w => w.id))
  for (const id of input.requestedWikiIds) {
    if (have.has(id)) continue
    const wiki = input.getWikiById(id)
    if (!wiki || wiki.orgId !== input.orgId || !isWikiUsableBy(wiki, input.filter)) continue
    have.add(id)
    out.push(wiki)
  }
  return out
}

/** Does the caller manage tenant knowledge at all (the admin UI 文档中心)? */
export function hasDocumentsScope(auth: AuthContext): boolean {
  return hasScope(auth.scopes ?? [], 'admin:documents')
}

type CreatorScopeCheck = (orgId: string, creatorUserId: string, auth: AuthContext) => boolean

/**
 * May the caller edit / rebuild / change the scope of a wiki, or rename /
 * move / delete a folder or document? Private: the owner only (admins
 * included — they may only disable or delete, see canAdministerWiki).
 * Tenant: `admin:documents` plus management scope over the owner.
 */
export function canManageKnowledgeItem(
  item: Pick<WikiRecord | DocumentTreeNode | DocumentRecord, 'scope' | 'ownerId' | 'orgId'>,
  auth: AuthContext,
  isCreatorInScope: CreatorScopeCheck,
): boolean {
  if (item.scope === 'private') return item.ownerId === auth.userId
  return hasDocumentsScope(auth) && isCreatorInScope(item.orgId, item.ownerId, auth)
}

/**
 * May the caller disable / delete a wiki? Everything canManageKnowledgeItem
 * allows, plus an admin on someone else's private wiki (see, toggle, delete —
 * never edit, like custom agents/skills).
 */
export function canAdministerWiki(
  wiki: WikiRecord,
  auth: AuthContext,
  isCreatorInScope: CreatorScopeCheck,
): boolean {
  if (canManageKnowledgeItem(wiki, auth, isCreatorInScope)) return true
  return wiki.scope === 'private' && hasDocumentsScope(auth)
}

/**
 * tenantDelegationPolicy wired to the auth service: the author counts as an
 * admin by their *current* role, and scope coverage is department-tree aware.
 */
export function agentDelegationPolicy(
  agent: { category?: string | null } | null,
  meta: { source_type?: unknown; author_id?: unknown; visible_to?: VisibleTo } | null | undefined,
  orgId: string,
  authService: {
    getUserOrNull(userId: string, orgId: string): { role: string } | null
    isScopeWithin(orgId: string, next: VisibleTo, current: VisibleTo, ownerId: string): boolean
  },
): DelegationPolicy {
  if (!agent && !meta) return NO_DELEGATION
  return tenantDelegationPolicy({
    category: agent?.category,
    meta,
    isFullAdminUser: userId => {
      const role = authService.getUserOrNull(userId, orgId)?.role
      return role === 'admin' || role === 'super_admin'
    },
    isScopeWithin: (next, current, ownerId) => authService.isScopeWithin(orgId, next, current, ownerId),
  })
}
