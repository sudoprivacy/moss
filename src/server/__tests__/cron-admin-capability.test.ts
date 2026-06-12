import { describe, it, expect } from 'bun:test'
import { isCronAdminCapable } from '../auth/token.js'

// clientCronEnabled gates client-issued cron actions only (#83): admin actors
// bypass both the /api/v1/cron/* route gate and the scheduler's owner check.
describe('isCronAdminCapable', () => {
  it('grants admin and super_admin roles', () => {
    expect(isCronAdminCapable({ role: 'admin', scopes: [] })).toBe(true)
    expect(isCronAdminCapable({ role: 'super_admin', scopes: [] })).toBe(true)
  })

  it('denies plain users and dept_admin without scope', () => {
    expect(isCronAdminCapable({ role: 'user', scopes: ['sessions:create'] })).toBe(false)
    expect(isCronAdminCapable({ role: 'dept_admin', scopes: [] })).toBe(false)
  })

  it('grants the admin:cron scope regardless of role', () => {
    expect(isCronAdminCapable({ role: 'user', scopes: ['admin:cron'] })).toBe(true)
  })

  it('grants wildcard scopes per hasScope semantics', () => {
    expect(isCronAdminCapable({ role: 'user', scopes: ['*'] })).toBe(true)
    expect(isCronAdminCapable({ role: 'user', scopes: ['admin:*'] })).toBe(true)
  })

  it('handles missing scopes', () => {
    expect(isCronAdminCapable({ role: 'user' })).toBe(false)
    expect(isCronAdminCapable({ role: 'admin' })).toBe(true)
  })
})
