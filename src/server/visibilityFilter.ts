import type { AuthContext } from './auth/token.js'
import { hasScope } from './auth/token.js'

export type VisibleTo = {
  department_ids?: string[] | null
  user_ids?: string[] | null
} | null

export type VisibilityFilter = {
  isAdmin: boolean
  userId: string
  departmentId: string | null
  visibleDepartmentIds: Set<string> | null
  /**
   * Admins only: their own department chain, i.e. how they'd be evaluated as
   * a regular member. Used where admin rights don't apply — using someone
   * else's custom skill/agent (see isUsableBy).
   */
  member?: { departmentId: string | null; visibleDepartmentIds: Set<string> }
}

export function isVisibleTo(
  visibleTo: VisibleTo | null | undefined,
  filter: VisibilityFilter,
): boolean {
  // 1. 管理员始终可见
  if (filter.isAdmin) return true

  // 2. visible_to 为 null → 所有人可见
  if (!visibleTo) return true

  // 3. 检查用户白名单
  const userIds = visibleTo.user_ids ?? null
  if (userIds !== null) {
    if (userIds.length === 0) {
      // 空数组表示仅管理员可见
      return false
    }
    if (userIds.includes(filter.userId)) {
      return true
    }
  }

  // 4. 检查部门白名单
  const departmentIds = visibleTo.department_ids ?? null
  if (departmentIds !== null) {
    if (departmentIds.length === 0) {
      // 空数组表示仅管理员可见
      return false
    }
    if (!filter.departmentId) {
      return false
    }
    for (const deptId of filter.visibleDepartmentIds ?? new Set()) {
      if (departmentIds.includes(deptId)) return true
    }
  }

  return false
}

/**
 * Whether the viewer may USE an item — pick it for a chat, load it into a
 * session, sync or download it — as opposed to seeing it in the admin UI.
 * Same as isVisibleTo, except for custom items (ownerId set): the scope their
 * creator chose binds admins too, so an admin can see them in the admin UI but
 * only use them when the creator's scope includes them.
 */
export function isUsableBy(
  visibleTo: VisibleTo | null | undefined,
  ownerId: string | null | undefined,
  filter: VisibilityFilter,
): boolean {
  if (!ownerId || !filter.isAdmin) return isVisibleTo(visibleTo, filter)
  return isVisibleTo(visibleTo, {
    isAdmin: false,
    userId: filter.userId,
    departmentId: filter.member?.departmentId ?? null,
    visibleDepartmentIds: filter.member?.visibleDepartmentIds ?? new Set(),
  })
}

/**
 * Owner of a custom skill/agent (created from the SudoWork client). New items
 * record `author_id`; legacy items were always written with
 * `visible_to = { user_ids: [creator] }`, so a lone user id identifies the owner.
 * Returns null for any other source type.
 */
export function customItemOwnerId(
  meta: { source_type?: unknown; author_id?: unknown; visible_to?: VisibleTo } | null | undefined,
): string | null {
  if (meta?.source_type !== 'custom') return null
  if (typeof meta.author_id === 'string' && meta.author_id) return meta.author_id
  const userIds = meta.visible_to?.user_ids
  return userIds?.length === 1 && userIds[0] !== 'admin' ? userIds[0] : null
}

/**
 * Effective visibility of a custom item: the scope its owner chose, plus the
 * owner themselves, so narrowing the scope can never lock the creator out.
 */
export function withOwnerVisibility(
  visibleTo: VisibleTo | undefined,
  ownerId: string | null,
): VisibleTo {
  if (!visibleTo || !ownerId) return visibleTo ?? null
  const userIds = visibleTo.user_ids ?? []
  return {
    department_ids: visibleTo.department_ids ?? null,
    user_ids: userIds.includes(ownerId) ? userIds : [...userIds, ownerId],
  }
}

export function buildVisibilityFilter(
  auth: AuthContext,
  getUserByIdAndOrg: (
    userId: string,
    orgId: string,
  ) => { role: string; departmentId: string | null } | null,
  listDepartmentsByOrg: (
    orgId: string,
  ) => Array<{ id: string; parentId: string | null }>,
): VisibilityFilter {
  const isAdmin =
    auth.role === 'admin' ||
    auth.role === 'super_admin' ||
    hasScope(auth.scopes, '*')
  const user = getUserByIdAndOrg(auth.userId, auth.orgId)
  const departmentId = user?.departmentId ?? null
  const visibleDepartmentIds = getUserAncestorIds(
    auth.userId,
    auth.orgId,
    getUserByIdAndOrg,
    listDepartmentsByOrg,
  )
  if (isAdmin) {
    return {
      isAdmin: true,
      userId: auth.userId,
      departmentId: null,
      visibleDepartmentIds: null,
      member: { departmentId, visibleDepartmentIds },
    }
  }

  return { isAdmin: false, userId: auth.userId, departmentId, visibleDepartmentIds }
}

/**
 * The ordered department chain from a department up to the org root:
 * `[deptId, parentId, grandparentId, ...]`. Self first, so callers that resolve
 * "the nearest department with a value" (e.g. hierarchical credential
 * inheritance) can walk the array in order. Cycles are guarded against.
 */
export function getDepartmentAncestorChain(
  orgId: string,
  deptId: string | null,
  listDepartmentsByOrg: (
    orgId: string,
  ) => Array<{ id: string; parentId: string | null }>,
): string[] {
  if (!deptId) return []
  const byId = new Map(listDepartmentsByOrg(orgId).map(d => [d.id, d]))
  const chain: string[] = []
  const seen = new Set<string>()
  let current = byId.get(deptId) ?? null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current.id)
    current = current.parentId ? byId.get(current.parentId) ?? null : null
  }
  return chain
}

export function getUserAncestorIds(
  userId: string,
  orgId: string,
  getUserByIdAndOrg: (
    userId: string,
    orgId: string,
  ) => { role: string; departmentId: string | null } | null,
  listDepartmentsByOrg: (
    orgId: string,
  ) => Array<{ id: string; parentId: string | null }>,
): Set<string> {
  const user = getUserByIdAndOrg(userId, orgId)
  if (!user?.departmentId) return new Set()

  const departments = listDepartmentsByOrg(orgId)
  const byId = new Map(departments.map(d => [d.id, d]))
  const ancestorIds = new Set<string>()
  let current = byId.get(user.departmentId) ?? null
  while (current) {
    ancestorIds.add(current.id)
    current = current.parentId
      ? byId.get(current.parentId) ?? null
      : null
  }
  return ancestorIds
}
