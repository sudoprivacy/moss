import { describe, expect, it } from 'bun:test'
import type { AuthContext } from '../auth/token.js'
import type { WikiRecord } from '../documentStore.js'
import type { VisibilityFilter, VisibleTo } from '../visibilityFilter.js'
import {
  NO_DELEGATION,
  agentDeliveredWikis,
  tenantDelegationPolicy,
  canAdministerWiki,
  canManageKnowledgeItem,
  canSeeWiki,
  isWikiUsableBy,
  sessionAdvertisedWikis,
} from '../wikiAccess.js'

/**
 * Wikis follow the agent/skill model: tenant wikis are 专属-like (managed in
 * the admin UI), private wikis are custom-like (owner-managed from SudoWork;
 * admins see / disable / delete but neither edit nor use them outside the
 * owner's scope). Through an agent, only admin-managed agents delegate tenant
 * wikis; private wikis are never delegated.
 */

const ORG = 'org-1'
const OWNER = 'owner-1'
const ADMIN_ONLY: VisibleTo = { department_ids: [], user_ids: [] }

function wiki(overrides: Partial<WikiRecord> = {}): WikiRecord {
  return {
    id: 'w1',
    orgId: ORG,
    nodeId: null,
    name: 'wiki',
    description: null,
    storagePath: '/tmp/w1',
    buildStatus: 'succeeded',
    sourceDocumentIds: [],
    lastBuiltAt: 1,
    lastBuildError: null,
    createdBy: OWNER,
    createdAt: 1,
    updatedAt: 1,
    sourceMode: 'dir',
    sourceNodeId: null,
    sourceNodeIds: ['n1'],
    sourceExcludeNodeIds: [],
    autoRebuild: false,
    needsRebuild: false,
    hasBuilt: true,
    scope: 'tenant',
    ownerId: OWNER,
    visibleTo: null,
    enabled: true,
    ...overrides,
  }
}

const member = (userId: string, departmentIds: string[] = []): VisibilityFilter => ({
  isAdmin: false,
  userId,
  departmentId: departmentIds[0] ?? null,
  visibleDepartmentIds: new Set(departmentIds),
})

const admin = (userId = 'admin-1', departmentIds: string[] = []): VisibilityFilter => ({
  isAdmin: true,
  userId,
  departmentId: null,
  visibleDepartmentIds: null,
  member: { departmentId: departmentIds[0] ?? null, visibleDepartmentIds: new Set(departmentIds) },
})

const auth = (userId: string, role: string, scopes: string[]): AuthContext => ({
  rawToken: '',
  userId,
  orgId: ORG,
  role,
  scopes,
  keyId: null,
  jti: '',
  exp: 0,
} as unknown as AuthContext)

const adminAuth = auth('admin-1', 'admin', ['*'])
const userAuth = (userId: string) => auth(userId, 'user', ['store:read'])
// isCreatorInScope stand-in: full admins manage everything, others only their own.
const creatorInScope = (_org: string, creator: string, a: AuthContext) => a.role === 'admin' || creator === a.userId

describe('tenant wiki use', () => {
  it('legacy admin-only wikis are usable by admins only', () => {
    const w = wiki({ ownerId: 'admin', visibleTo: ADMIN_ONLY })
    expect(isWikiUsableBy(w, admin())).toBe(true)
    expect(isWikiUsableBy(w, member('u1', ['d1']))).toBe(false)
    expect(canSeeWiki(w, member('u1'))).toBe(false)
  })

  it('a department scope reaches its members and sub-departments, plus the owner', () => {
    const w = wiki({ visibleTo: { department_ids: ['d1'], user_ids: null } })
    expect(isWikiUsableBy(w, member('u1', ['d1-child', 'd1']))).toBe(true)
    expect(isWikiUsableBy(w, member('u2', ['d2']))).toBe(false)
    expect(isWikiUsableBy(w, member(OWNER, ['d2']))).toBe(true)
  })

  it('a disabled wiki is usable by no one, admins included', () => {
    const w = wiki({ enabled: false })
    expect(isWikiUsableBy(w, admin())).toBe(false)
    expect(isWikiUsableBy(w, member(OWNER))).toBe(false)
    expect(canSeeWiki(w, member(OWNER))).toBe(true)
  })
})

describe('private wiki use', () => {
  const onlyMe = wiki({ scope: 'private', visibleTo: { department_ids: null, user_ids: [OWNER] } })

  it('only-me is usable by the owner alone — not by admins', () => {
    expect(isWikiUsableBy(onlyMe, member(OWNER))).toBe(true)
    expect(isWikiUsableBy(onlyMe, member('u2'))).toBe(false)
    expect(isWikiUsableBy(onlyMe, admin())).toBe(false)
  })

  it('admins still see it (to disable / delete)', () => {
    expect(canSeeWiki(onlyMe, admin())).toBe(true)
    expect(canSeeWiki(onlyMe, member('u2'))).toBe(false)
  })

  it('an admin inside the owner’s chosen scope may use it as a member', () => {
    const shared = wiki({ scope: 'private', visibleTo: { department_ids: ['d1'], user_ids: null } })
    expect(isWikiUsableBy(shared, admin('admin-1', ['d1']))).toBe(true)
    expect(isWikiUsableBy(shared, admin('admin-2', ['d9']))).toBe(false)
  })
})

describe('managing', () => {
  it('private: owner only, admins included in the restriction', () => {
    const w = wiki({ scope: 'private' })
    expect(canManageKnowledgeItem(w, userAuth(OWNER), creatorInScope)).toBe(true)
    expect(canManageKnowledgeItem(w, adminAuth, creatorInScope)).toBe(false)
    expect(canManageKnowledgeItem(w, userAuth('u2'), creatorInScope)).toBe(false)
  })

  it('private: admins may still disable / delete, other users may not', () => {
    const w = wiki({ scope: 'private' })
    expect(canAdministerWiki(w, adminAuth, creatorInScope)).toBe(true)
    expect(canAdministerWiki(w, userAuth(OWNER), creatorInScope)).toBe(true)
    expect(canAdministerWiki(w, userAuth('u2'), creatorInScope)).toBe(false)
  })

  it('tenant: needs admin:documents plus management scope over the owner', () => {
    const w = wiki({ ownerId: 'admin' })
    expect(canManageKnowledgeItem(w, adminAuth, creatorInScope)).toBe(true)
    // the creator alone isn't enough without admin:documents
    expect(canManageKnowledgeItem(wiki(), userAuth(OWNER), creatorInScope)).toBe(false)
    expect(canManageKnowledgeItem(wiki(), auth(OWNER, 'dept_admin', ['admin:documents']), creatorInScope)).toBe(true)
    expect(canManageKnowledgeItem(w, auth(OWNER, 'dept_admin', ['admin:documents']), creatorInScope)).toBe(false)
    // tenant wikis get no admin-only disable/delete bypass
    expect(canAdministerWiki(wiki(), userAuth('u2'), creatorInScope)).toBe(false)
  })
})

describe('through an agent', () => {
  const tenantAdminOnly = wiki({ id: 't1', ownerId: 'admin', visibleTo: ADMIN_ONLY })
  const privateOnlyMe = wiki({ id: 'p1', scope: 'private', visibleTo: { department_ids: null, user_ids: [OWNER] } })
  const privateDept = wiki({ id: 'p2', scope: 'private', visibleTo: { department_ids: ['d1'], user_ids: null } })
  const disabled = wiki({ id: 'x1', enabled: false })
  const foreign = wiki({ id: 'f1', orgId: 'org-2' })
  const byId = new Map([tenantAdminOnly, privateOnlyMe, privateDept, disabled, foreign].map(w => [w.id, w]))
  const get = (id: string) => byId.get(id) ?? null
  const bound = ['t1', 'p1', 'p2', 'x1', 'f1', 'missing', 't1']
  const managed = tenantDelegationPolicy({
    category: 'hub', meta: null, isFullAdminUser: () => false, isScopeWithin: () => false,
  })

  it('an admin-managed agent delegates tenant wikis, never private ones', () => {
    const ids = agentDeliveredWikis(bound, ORG, member('u1', ['d9']), get, managed).map(w => w.id)
    expect(ids).toEqual(['t1'])
  })

  it('delivers a private wiki to users inside its owner’s scope', () => {
    expect(agentDeliveredWikis(bound, ORG, member('u1', ['d1']), get, managed).map(w => w.id)).toEqual(['t1', 'p2'])
    expect(agentDeliveredWikis(bound, ORG, member(OWNER), get, managed).map(w => w.id)).toEqual(['t1', 'p1', 'p2'])
  })

  it('a non-admin’s custom agent delegates nothing — its owner can’t re-share a wiki', () => {
    const custom = tenantDelegationPolicy({
      category: 'custom', meta: { source_type: 'custom', author_id: OWNER, visible_to: null },
      isFullAdminUser: () => false, isScopeWithin: () => true,
    })
    expect(custom(tenantAdminOnly)).toBe(false)
    expect(agentDeliveredWikis(bound, ORG, member('u1', ['d9']), get, custom)).toEqual([])
    expect(agentDeliveredWikis(bound, ORG, admin(), get, NO_DELEGATION).map(w => w.id)).toEqual(['t1'])
  })

  it('an admin’s custom agent (admin UI 创建智能体) delegates tenant wikis — keeps existing agents working', () => {
    const policy = tenantDelegationPolicy({
      category: 'custom', meta: { source_type: 'custom', author_id: 'admin-1', visible_to: null },
      isFullAdminUser: id => id === 'admin-1', isScopeWithin: () => false,
    })
    expect(policy(tenantAdminOnly)).toBe(true)
    expect(policy(privateOnlyMe)).toBe(false)
    // legacy custom item without author_id: the lone visible_to user owns it
    const legacy = tenantDelegationPolicy({
      category: 'custom', meta: { source_type: 'custom', visible_to: { department_ids: null, user_ids: ['admin-1'] } },
      isFullAdminUser: id => id === 'admin-1', isScopeWithin: () => false,
    })
    expect(legacy(tenantAdminOnly)).toBe(true)
  })

  it('a 专属 agent delegates everything when an admin authored it', () => {
    const policy = tenantDelegationPolicy({
      category: 'tenant', meta: { source_type: 'tenant', author_id: 'admin-1', visible_to: null },
      isFullAdminUser: id => id === 'admin-1', isScopeWithin: () => false,
    })
    expect(policy(tenantAdminOnly)).toBe(true)
    expect(policy(privateOnlyMe)).toBe(false)
  })

  it('a non-admin’s 专属 agent delegates only wikis whose scope covers the agent', () => {
    const seen: Array<[unknown, unknown, string]> = []
    const policy = tenantDelegationPolicy({
      category: 'tenant', meta: { source_type: 'tenant', author_id: 'u1', visible_to: { department_ids: ['d1'], user_ids: null } },
      isFullAdminUser: () => false,
      isScopeWithin: (next, current, ownerId) => {
        seen.push([next, current, ownerId])
        return current === null
      },
    })
    expect(policy(wiki({ id: 'open', visibleTo: null }))).toBe(true)
    expect(policy(tenantAdminOnly)).toBe(false)
    // the agent's scope includes its author
    expect(seen[0][0]).toEqual({ department_ids: ['d1'], user_ids: ['u1'] })
  })

  it('a session adds the wikis picked for it that the user may use', () => {
    const everyone = wiki({ id: 'e1' })
    const map = new Map([...byId, ['e1', everyone]])
    const ids = sessionAdvertisedWikis({
      orgId: ORG,
      filter: member('u1', ['d9']),
      agentWikiIds: [],
      agentDelegates: NO_DELEGATION,
      requestedWikiIds: ['e1', 't1', 'p1', 'x1', 'f1'],
      getWikiById: id => map.get(id) ?? null,
    }).map(w => w.id)
    expect(ids).toEqual(['e1'])
  })

  it('does not duplicate a wiki both bound and picked', () => {
    const ids = sessionAdvertisedWikis({
      orgId: ORG,
      filter: admin(),
      agentWikiIds: ['t1'],
      agentDelegates: managed,
      requestedWikiIds: ['t1'],
      getWikiById: get,
    }).map(w => w.id)
    expect(ids).toEqual(['t1'])
  })
})
