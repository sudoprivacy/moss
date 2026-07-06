import { describe, it, expect } from 'bun:test'
import { isDepartmentCredentialAllowed } from '../authProxyServer.js'

// The auth-proxy department gate (handleRequest step 4) decides whether a
// session may use a matched credential rule. Admins/super_admins bypass it;
// non-admins are filtered by their department's policy. Extracted as a pure
// predicate so the decision is testable without the HTTP proxy + nexus + minter.

// item 1 is whitelisted for the test department; item 2 is not.
const policy = (_deptId: string) => [1]

describe('isDepartmentCredentialAllowed', () => {
  it('allows any non-department credential regardless of actor', () => {
    for (const scope of ['system', 'user', 'unknown']) {
      expect(
        isDepartmentCredentialAllowed(
          { scope, configItemId: 999 },
          { isAdmin: false, departmentId: null },
          policy,
        ),
      ).toBe(true)
    }
  })

  it('lets an admin use any department credential, even with no department', () => {
    expect(
      isDepartmentCredentialAllowed(
        { scope: 'department', configItemId: 2 }, // not policy-authorized
        { isAdmin: true, departmentId: null },
        policy,
      ),
    ).toBe(true)
  })

  it('lets an admin who belongs to a department use an unauthorized item', () => {
    expect(
      isDepartmentCredentialAllowed(
        { scope: 'department', configItemId: 2 },
        { isAdmin: true, departmentId: 'dept-x' },
        policy,
      ),
    ).toBe(true)
  })

  it('allows a non-admin only the items their department policy authorizes', () => {
    expect(
      isDepartmentCredentialAllowed(
        { scope: 'department', configItemId: 1 },
        { isAdmin: false, departmentId: 'dept-x' },
        policy,
      ),
    ).toBe(true)
  })

  it('denies a non-admin an item their department policy does not authorize', () => {
    expect(
      isDepartmentCredentialAllowed(
        { scope: 'department', configItemId: 2 },
        { isAdmin: false, departmentId: 'dept-x' },
        policy,
      ),
    ).toBe(false)
  })

  it('leaves a department-less non-admin unchanged (allowed) — gate applies only within a department', () => {
    expect(
      isDepartmentCredentialAllowed(
        { scope: 'department', configItemId: 2 },
        { isAdmin: false, departmentId: null },
        policy,
      ),
    ).toBe(true)
  })
})
