import { describe, it, expect } from 'bun:test'
import {
  canReadDepartmentSecrets,
  canWriteUserSecrets,
  canReadSecretAudit,
  isStoreAdmin,
  isCronAdminCapable,
} from '../auth/token.js'

// The Phase A scope split gives dept_admin/user narrow, split scopes instead of
// the coarse admin:secrets / admin:settings / admin:cron gates. These predicates
// are the shared source of truth used by both routes and the frontend, so they
// must classify each role from its default scope set correctly.

const DEPT_ADMIN_SCOPES = [
  'sessions:create',
  'sessions:attach',
  'sessions:list',
  'admin:users',
  'admin:api_keys',
  'secrets:department:read',
  'secrets:user:write',
  'store:read',
  'store:tenant:write',
  'store:custom:write',
  'cron:self',
  'cron:list:subtree',
  'cron:manage:subtree',
  'admin:mcp',
  'admin:mcp:write',
  'admin:mcp:audit',
]

const USER_SCOPES = [
  'sessions:create',
  'sessions:attach',
  'sessions:list',
  'secrets:user:write',
  'store:read',
  'store:tenant:write',
  'store:custom:write',
  'cron:self',
]

describe('canReadDepartmentSecrets', () => {
  it('grants full admins (role or wildcard) and admin:secrets holders', () => {
    expect(canReadDepartmentSecrets({ role: 'admin', scopes: [] })).toBe(true)
    expect(canReadDepartmentSecrets({ role: 'super_admin', scopes: [] })).toBe(true)
    expect(canReadDepartmentSecrets({ role: 'user', scopes: ['*'] })).toBe(true)
    expect(canReadDepartmentSecrets({ role: 'user', scopes: ['admin:secrets'] })).toBe(true)
  })
  it('grants dept_admin via secrets:department:read', () => {
    expect(canReadDepartmentSecrets({ role: 'dept_admin', scopes: DEPT_ADMIN_SCOPES })).toBe(true)
  })
  it('denies a normal user', () => {
    expect(canReadDepartmentSecrets({ role: 'user', scopes: USER_SCOPES })).toBe(false)
  })
})

describe('canWriteUserSecrets', () => {
  it('grants dept_admin and user via secrets:user:write, and full admins', () => {
    expect(canWriteUserSecrets({ role: 'dept_admin', scopes: DEPT_ADMIN_SCOPES })).toBe(true)
    expect(canWriteUserSecrets({ role: 'user', scopes: USER_SCOPES })).toBe(true)
    expect(canWriteUserSecrets({ role: 'admin', scopes: [] })).toBe(true)
  })
  it('denies a role with only session scopes', () => {
    expect(canWriteUserSecrets({ role: 'user', scopes: ['sessions:list'] })).toBe(false)
  })
})

describe('canReadSecretAudit', () => {
  it('grants dept_admin, user, and full admins (route narrows the rows)', () => {
    expect(canReadSecretAudit({ role: 'dept_admin', scopes: DEPT_ADMIN_SCOPES })).toBe(true)
    expect(canReadSecretAudit({ role: 'user', scopes: USER_SCOPES })).toBe(true)
    expect(canReadSecretAudit({ role: 'admin', scopes: [] })).toBe(true)
  })
  it('denies a bare session-only actor', () => {
    expect(canReadSecretAudit({ role: 'user', scopes: ['sessions:list'] })).toBe(false)
  })
})

describe('isStoreAdmin', () => {
  it('grants only full admins / admin:settings, never the split store scopes', () => {
    expect(isStoreAdmin({ role: 'admin', scopes: [] })).toBe(true)
    expect(isStoreAdmin({ role: 'user', scopes: ['admin:settings'] })).toBe(true)
    expect(isStoreAdmin({ role: 'dept_admin', scopes: DEPT_ADMIN_SCOPES })).toBe(false)
    expect(isStoreAdmin({ role: 'user', scopes: USER_SCOPES })).toBe(false)
  })
})

describe('isCronAdminCapable stays admin-only after the split', () => {
  // cron:self must NOT make an actor admin-capable, otherwise dept_admin/user
  // would bypass the client_cron_enabled gate.
  it('is false for dept_admin and user despite cron:self', () => {
    expect(isCronAdminCapable({ role: 'dept_admin', scopes: DEPT_ADMIN_SCOPES })).toBe(false)
    expect(isCronAdminCapable({ role: 'user', scopes: USER_SCOPES })).toBe(false)
  })
})
