import { describe, it, expect } from 'bun:test'

// authService.clampVisibleToScope keeps only the department/user ids a non-admin
// is allowed to set, instead of overwriting their request wholesale with their
// default (the old bug that silently dropped a legitimate in-scope choice and
// revoked admin-set out-of-scope grants). AuthService can't load under bun:test
// (node:sqlite), so — like the audit-filter tests — we replicate the exact
// intersection the method performs and assert its semantics.
//
// Inputs the real method derives from the DB:
//  - visibleDepartmentIds: null for admin (unrestricted); the subtree set for a
//    dept_admin; empty set for a normal user.
//  - subtreeUserIds: null for admin; {self + subtree members} for dept_admin;
//    {self} for a normal user.

type VisibleTo = { department_ids?: string[] | null; user_ids?: string[] | null } | null

function clamp(
  requested: VisibleTo,
  visibleDepartmentIds: Set<string> | null,
  subtreeUserIds: Set<string> | null,
  defaultVisibility: VisibleTo,
): VisibleTo {
  if (visibleDepartmentIds === null) return requested // admin
  if (!requested || (!requested.department_ids && !requested.user_ids)) return requested // all
  if (requested.user_ids?.length === 1 && requested.user_ids[0] === 'admin') {
    return { department_ids: null, user_ids: ['admin'] } // admin-only sentinel
  }
  if (requested.department_ids?.length) {
    const inScope = requested.department_ids.filter(id => visibleDepartmentIds.has(id))
    return inScope.length === 0 ? defaultVisibility : { department_ids: inScope, user_ids: null }
  }
  if (requested.user_ids?.length) {
    const set = subtreeUserIds ?? new Set<string>()
    const inScope = requested.user_ids.filter(id => set.has(id))
    return inScope.length === 0 ? defaultVisibility : { department_ids: null, user_ids: inScope }
  }
  return defaultVisibility
}

describe('clampVisibleToScope', () => {
  const DEPT = 'dept-self'
  const SUBDEPT = 'dept-child'
  const OUTDEPT = 'dept-outside'
  const SELF = 'u-self'
  const MEMBER = 'u-member'
  const OUTSIDER = 'u-outside'

  // dept_admin scope
  const daDepts = new Set([DEPT, SUBDEPT])
  const daUsers = new Set([SELF, MEMBER])
  const daDefault: VisibleTo = { department_ids: [DEPT], user_ids: null }

  // normal user scope
  const userDepts = new Set<string>() // empty
  const userUsers = new Set([SELF])
  const userDefault: VisibleTo = { department_ids: null, user_ids: [SELF] }

  it('admin (null dept set): passes request through untouched', () => {
    const req: VisibleTo = { department_ids: null, user_ids: [OUTSIDER, MEMBER] }
    expect(clamp(req, null, null, null)).toEqual(req)
  })

  it('all (null) is always allowed', () => {
    expect(clamp(null, daDepts, daUsers, daDefault)).toBeNull()
  })

  it('admin-only sentinel passes through', () => {
    expect(clamp({ department_ids: null, user_ids: ['admin'] }, daDepts, daUsers, daDefault))
      .toEqual({ department_ids: null, user_ids: ['admin'] })
  })

  it('dept_admin: in-scope user choice sticks (the clobber bugfix)', () => {
    // The exact failing case: dept_admin submits {users:[member]}, must persist
    // that, not get overwritten with their whole-department default.
    expect(clamp({ department_ids: null, user_ids: [MEMBER] }, daDepts, daUsers, daDefault))
      .toEqual({ department_ids: null, user_ids: [MEMBER] })
  })

  it('dept_admin: out-of-scope users are stripped, in-scope kept', () => {
    expect(clamp({ department_ids: null, user_ids: [MEMBER, OUTSIDER] }, daDepts, daUsers, daDefault))
      .toEqual({ department_ids: null, user_ids: [MEMBER] })
  })

  it('dept_admin: all-out-of-scope falls back to default (never empty=nobody)', () => {
    expect(clamp({ department_ids: null, user_ids: [OUTSIDER] }, daDepts, daUsers, daDefault))
      .toEqual(daDefault)
  })

  it('dept_admin: in-scope dept choice sticks; out-of-scope stripped', () => {
    expect(clamp({ department_ids: [SUBDEPT, OUTDEPT], user_ids: null }, daDepts, daUsers, daDefault))
      .toEqual({ department_ids: [SUBDEPT], user_ids: null })
  })

  it('normal user: can only pick themselves', () => {
    expect(clamp({ department_ids: null, user_ids: [SELF] }, userDepts, userUsers, userDefault))
      .toEqual({ department_ids: null, user_ids: [SELF] })
  })

  it('normal user: other users stripped -> falls back to self default', () => {
    expect(clamp({ department_ids: null, user_ids: [OUTSIDER] }, userDepts, userUsers, userDefault))
      .toEqual(userDefault)
  })

  it('normal user: any department pick is out of scope -> default (depts disabled)', () => {
    expect(clamp({ department_ids: [DEPT], user_ids: null }, userDepts, userUsers, userDefault))
      .toEqual(userDefault)
  })
})
