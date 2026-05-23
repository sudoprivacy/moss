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
  const isAdmin = auth.role === 'admin' || hasScope(auth.scopes, '*')
  if (isAdmin) {
    return { isAdmin: true, userId: auth.userId, departmentId: null, visibleDepartmentIds: null }
  }

  const user = getUserByIdAndOrg(auth.userId, auth.orgId)
  const departmentId = user?.departmentId ?? null
  const visibleDepartmentIds = getUserAncestorIds(
    auth.userId,
    auth.orgId,
    getUserByIdAndOrg,
    listDepartmentsByOrg,
  )

  return { isAdmin: false, userId: auth.userId, departmentId, visibleDepartmentIds }
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
