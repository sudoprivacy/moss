import { describe, it, expect } from 'bun:test'

// AuthService.isCreatorInScope / defaultTenantVisibility can't be exercised
// directly here: they hang off DirectConnectStore, which can't load under
// bun:test (node:sqlite). Like the audit-log and cron store tests, we lock the
// decision logic in a standalone mirror so a regression in the intended
// semantics is caught. The mirror MUST match the service implementation.

type Role = 'admin' | 'super_admin' | 'dept_admin' | 'user'
type VisibleTo = { department_ids?: string[] | null; user_ids?: string[] | null } | null

// Mirror of AuthService.isCreatorInScope. `subtree` is the actor's visible
// department set (null for a full admin, computed by getVisibleDepartmentIds).
function isCreatorInScope(args: {
  actorRole: Role
  actorUserId: string
  subtree: Set<string> | null
  creatorUserId: string
  creatorCurrentDept: string | null
}): boolean {
  if (args.subtree === null) return true // admin / super_admin
  if (args.creatorUserId === args.actorUserId) return true // own resource
  if (args.actorRole !== 'dept_admin') return false // plain user: self only
  return !!args.creatorCurrentDept && args.subtree.has(args.creatorCurrentDept)
}

// Mirror of AuthService.defaultTenantVisibility.
function defaultTenantVisibility(args: {
  role: Role
  userId: string
  departmentId: string | null
}): VisibleTo {
  if (args.role === 'admin' || args.role === 'super_admin') return null
  if (args.role === 'dept_admin' && args.departmentId) {
    return { department_ids: [args.departmentId], user_ids: null }
  }
  return { department_ids: null, user_ids: [args.userId] }
}

describe('isCreatorInScope', () => {
  it('admin (null subtree) manages anything', () => {
    expect(isCreatorInScope({
      actorRole: 'admin', actorUserId: 'a', subtree: null,
      creatorUserId: 'someone', creatorCurrentDept: 'dX',
    })).toBe(true)
  })

  it('dept_admin manages a creator whose CURRENT dept is in the subtree', () => {
    const subtree = new Set(['d1', 'd1a'])
    expect(isCreatorInScope({
      actorRole: 'dept_admin', actorUserId: 'da', subtree,
      creatorUserId: 'member', creatorCurrentDept: 'd1a',
    })).toBe(true)
  })

  it('dept_admin loses access when the creator moved out of the subtree', () => {
    const subtree = new Set(['d1', 'd1a'])
    expect(isCreatorInScope({
      actorRole: 'dept_admin', actorUserId: 'da', subtree,
      creatorUserId: 'mover', creatorCurrentDept: 'd2',
    })).toBe(false)
  })

  it('dept_admin can always manage their own resource', () => {
    const subtree = new Set(['d1'])
    expect(isCreatorInScope({
      actorRole: 'dept_admin', actorUserId: 'da', subtree,
      creatorUserId: 'da', creatorCurrentDept: null,
    })).toBe(true)
  })

  it('plain user manages only their own', () => {
    const subtree = new Set<string>() // user has empty subtree
    expect(isCreatorInScope({
      actorRole: 'user', actorUserId: 'u1', subtree,
      creatorUserId: 'u1', creatorCurrentDept: 'd1',
    })).toBe(true)
    expect(isCreatorInScope({
      actorRole: 'user', actorUserId: 'u1', subtree,
      creatorUserId: 'u2', creatorCurrentDept: 'd1',
    })).toBe(false)
  })
})

describe('defaultTenantVisibility', () => {
  it('dept_admin → own department', () => {
    expect(defaultTenantVisibility({ role: 'dept_admin', userId: 'da', departmentId: 'd1' }))
      .toEqual({ department_ids: ['d1'], user_ids: null })
  })
  it('user → self', () => {
    expect(defaultTenantVisibility({ role: 'user', userId: 'u1', departmentId: 'd1' }))
      .toEqual({ department_ids: null, user_ids: ['u1'] })
  })
  it('admin → global (null)', () => {
    expect(defaultTenantVisibility({ role: 'admin', userId: 'a', departmentId: null })).toBeNull()
  })
  it('dept_admin without a department falls back to self', () => {
    expect(defaultTenantVisibility({ role: 'dept_admin', userId: 'da', departmentId: null }))
      .toEqual({ department_ids: null, user_ids: ['da'] })
  })
})
