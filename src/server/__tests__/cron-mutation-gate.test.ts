import { describe, it, expect } from 'bun:test'
import { isCronMutationBlocked } from '../api/cron.js'

// Internal gate for client-issued cron mutations (#83): enforced inside the api
// methods, not only on the HTTP route, so any future caller (an in-session agent
// tool, internal code) is gated regardless of how it is wired. Admins bypass.
describe('isCronMutationBlocked (#83)', () => {
  const user = { orgId: 'org-a', userId: 'u', scopes: ['sessions:create'] }
  const admin = { orgId: 'org-a', userId: 'a', scopes: ['admin:cron'] }
  const roleAdmin = { orgId: 'org-a', userId: 'a', role: 'admin', scopes: [] as string[] }

  it('does not block anyone when client cron is enabled', () => {
    expect(isCronMutationBlocked(true, user)).toBe(false)
    expect(isCronMutationBlocked(true, admin)).toBe(false)
  })

  it('blocks non-admin users when client cron is disabled', () => {
    expect(isCronMutationBlocked(false, user)).toBe(true)
  })

  it('never blocks admin-capable actors, even when disabled', () => {
    expect(isCronMutationBlocked(false, admin)).toBe(false)
    expect(isCronMutationBlocked(false, roleAdmin)).toBe(false)
    expect(isCronMutationBlocked(false, { orgId: 'o', userId: 'u', role: 'super_admin' })).toBe(false)
  })
})
