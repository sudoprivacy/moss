import type { AuthCenterDb } from '../authCenter/db.js'
import { AccountMemberships } from '../identity/accountMemberships.js'
import { getUserAncestorIds, type VisibilityFilter } from '../visibilityFilter.js'

/** Read current membership and account state; never trust a session's role snapshot. */
export function currentMcpMember(db: AuthCenterDb) {
  const accounts = new AccountMemberships(db.driver)
  return async (orgId: string, userId: string): Promise<VisibilityFilter | null> => {
    const user = await db.getUserByIdAndOrg(userId, orgId)
    if (user?.status !== 'active' || !await accounts.isActiveForUser(userId)) return null
    const departments = await getUserAncestorIds(userId, orgId,
      (id, org) => db.getUserByIdAndOrg(id, org), org => db.listDepartmentsByOrg(org))
    return { isAdmin: false, userId, role: user.role, departmentId: user.departmentId ?? null, visibleDepartmentIds: departments }
  }
}
