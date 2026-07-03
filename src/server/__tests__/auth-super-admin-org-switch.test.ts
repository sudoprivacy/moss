import { describe, it, expect } from 'bun:test'
import { resolveUserPinnedOrSuperAdmin } from '../auth/token.js'

// A super_admin has a users row in exactly one (home) org but authority in
// every org: after switchOrg their effective auth.orgId points at a foreign
// org, so strict getUserByIdAndOrg lookups miss their record. That broke cron
// execution ("User auth not found for <id>") and author_name stamping for
// resources created while switched. resolveUserPinnedOrSuperAdmin falls back
// to an id-only lookup for super_admins ONLY; every other role stays pinned
// to its home org to preserve isolation.

type User = { id: string; orgId: string; role: string; name: string }

const HOME_ORG = 'org-default'
const FOREIGN_ORG = 'org-ruigu'

const superAdmin: User = { id: 'u-super', orgId: HOME_ORG, role: 'super_admin', name: 'admin' }
const regularAdmin: User = { id: 'u-admin', orgId: HOME_ORG, role: 'admin', name: 'org-admin' }
const regularUser: User = { id: 'u-user', orgId: HOME_ORG, role: 'user', name: 'alice' }

function makeDb(users: User[]) {
  return {
    getUserByIdAndOrg: (id: string, orgId: string) =>
      users.find(u => u.id === id && u.orgId === orgId) ?? null,
    getUserById: (id: string) => users.find(u => u.id === id) ?? null,
  }
}

describe('resolveUserPinnedOrSuperAdmin', () => {
  const db = makeDb([superAdmin, regularAdmin, regularUser])

  it('resolves any user in their home org via the strict lookup', () => {
    expect(resolveUserPinnedOrSuperAdmin(regularUser.id, HOME_ORG, db)).toEqual(regularUser)
    expect(resolveUserPinnedOrSuperAdmin(superAdmin.id, HOME_ORG, db)).toEqual(superAdmin)
  })

  it('resolves a super_admin from a foreign org (switched effective org)', () => {
    expect(resolveUserPinnedOrSuperAdmin(superAdmin.id, FOREIGN_ORG, db)).toEqual(superAdmin)
  })

  it('does NOT resolve a plain admin from a foreign org (stays org-pinned)', () => {
    expect(resolveUserPinnedOrSuperAdmin(regularAdmin.id, FOREIGN_ORG, db)).toBeNull()
  })

  it('does NOT resolve a regular user from a foreign org (isolation preserved)', () => {
    expect(resolveUserPinnedOrSuperAdmin(regularUser.id, FOREIGN_ORG, db)).toBeNull()
  })

  it('returns null for an unknown user id', () => {
    expect(resolveUserPinnedOrSuperAdmin('u-ghost', HOME_ORG, db)).toBeNull()
    expect(resolveUserPinnedOrSuperAdmin('u-ghost', FOREIGN_ORG, db)).toBeNull()
  })
})
