import { describe, it, expect } from 'bun:test'
import { isVisibleTo, buildVisibilityFilter, type VisibilityFilter } from '../visibilityFilter.js'
import type { AuthContext } from '../auth/token.js'

describe('isVisibleTo', () => {
  const adminFilter: VisibilityFilter = {
    isAdmin: true,
    departmentId: null,
    visibleDepartmentIds: null,
  }

  const userFilter: VisibilityFilter = {
    isAdmin: false,
    departmentId: 'd01',
    visibleDepartmentIds: new Set(['d01', 'd-parent']),
  }

  const userNoDeptFilter: VisibilityFilter = {
    isAdmin: false,
    departmentId: null,
    visibleDepartmentIds: new Set(),
  }

  it('admin sees all items', () => {
    expect(isVisibleTo(null, adminFilter)).toBe(true)
    expect(isVisibleTo({ department_ids: null }, adminFilter)).toBe(true)
    expect(isVisibleTo({ department_ids: ['d01'] }, adminFilter)).toBe(true)
    expect(isVisibleTo({ department_ids: [] }, adminFilter)).toBe(true)
  })

  it('null visible_to means visible to all', () => {
    expect(isVisibleTo(null, userFilter)).toBe(true)
    expect(isVisibleTo(undefined, userFilter)).toBe(true)
  })

  it('empty department_ids means admin-only', () => {
    expect(isVisibleTo({ department_ids: [] }, userFilter)).toBe(false)
    expect(isVisibleTo({ department_ids: [] }, adminFilter)).toBe(true)
  })

  it('user sees item if their ancestor chain intersects', () => {
    expect(isVisibleTo({ department_ids: ['d01'] }, userFilter)).toBe(true)
    expect(isVisibleTo({ department_ids: ['d-parent'] }, userFilter)).toBe(true)
    expect(isVisibleTo({ department_ids: ['d01', 'd02'] }, userFilter)).toBe(true)
  })

  it('user cannot see item restricted to other departments', () => {
    expect(isVisibleTo({ department_ids: ['d99'] }, userFilter)).toBe(false)
  })

  it('user without departmentId only sees null visible_to items', () => {
    expect(isVisibleTo(null, userNoDeptFilter)).toBe(true)
    expect(isVisibleTo({ department_ids: [] }, userNoDeptFilter)).toBe(false)
    expect(isVisibleTo({ department_ids: ['d01'] }, userNoDeptFilter)).toBe(false)
  })
})

describe('buildVisibilityFilter', () => {
  const makeAuth = (role: string, scopes: string[] = []): AuthContext => ({
    rawToken: '',
    userId: 'u1',
    orgId: 'org1',
    role,
    scopes,
    keyId: 'k1',
    jti: 'j1',
    exp: Date.now() / 1000 + 3600,
  })

  const users = new Map<string, { role: string; departmentId: string | null }>([
    ['u1:org1', { role: 'user', departmentId: 'd01' }],
    ['u2:org1', { role: 'admin', departmentId: null }],
    ['u3:org1', { role: 'user', departmentId: null }],
  ])

  const departments = [
    { id: 'd01', parentId: 'd-parent' },
    { id: 'd-parent', parentId: 'd-root' },
    { id: 'd-root', parentId: null },
    { id: 'd-other', parentId: null },
  ]

  const getUser = (userId: string, orgId: string) =>
    users.get(`${userId}:${orgId}`) ?? null
  const listDepts = () => departments

  it('returns admin filter for admin role', () => {
    const filter = buildVisibilityFilter(makeAuth('admin'), getUser, listDepts)
    expect(filter.isAdmin).toBe(true)
  })

  it('returns admin filter for wildcard scope', () => {
    const filter = buildVisibilityFilter(makeAuth('user', ['*']), getUser, listDepts)
    expect(filter.isAdmin).toBe(true)
  })

  it('builds ancestor chain for user with department', () => {
    const filter = buildVisibilityFilter(makeAuth('user'), getUser, listDepts)
    expect(filter.isAdmin).toBe(false)
    expect(filter.departmentId).toBe('d01')
    expect(filter.visibleDepartmentIds?.has('d01')).toBe(true)
    expect(filter.visibleDepartmentIds?.has('d-parent')).toBe(true)
    expect(filter.visibleDepartmentIds?.has('d-root')).toBe(true)
    expect(filter.visibleDepartmentIds?.has('d-other')).toBe(false)
  })

  it('returns empty set for user without department', () => {
    const auth = { ...makeAuth('user'), userId: 'u3' }
    const filter = buildVisibilityFilter(auth, getUser, listDepts)
    expect(filter.isAdmin).toBe(false)
    expect(filter.departmentId).toBeNull()
    expect(filter.visibleDepartmentIds?.size).toBe(0)
  })
})
