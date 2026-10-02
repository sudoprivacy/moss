import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsAuthorizationError, QmsAuthorizationService } from './qmsAuthorization.js'

const organizations = {
  async getCode(orgId: string) {
    return orgId === 'org-a' ? 'tenant-a' : orgId === 'org-b' ? 'tenant-b' : null
  },
  async hasCode(code: string) {
    return code === 'tenant-a' || code === 'tenant-b'
  },
}

void describe('QMS authorization', () => {
  void it('preserves distinct API key failures and accepts the configured header value', () => {
    const auth = new QmsAuthorizationService({ apiKey: 'secret-key', organizations })

    assert.throws(() => auth.requireApiKey(undefined), (error: unknown) =>
      error instanceof QmsAuthorizationError && error.status === 401 && error.code === 'MISSING_API_KEY')
    assert.throws(() => auth.requireApiKey('wrong'), (error: unknown) =>
      error instanceof QmsAuthorizationError && error.status === 401 && error.code === 'INVALID_API_KEY')
    assert.doesNotThrow(() => auth.requireApiKey('secret-key'))
  })

  void it('fails explicitly when ingestion authentication is not configured', () => {
    const auth = new QmsAuthorizationService({ organizations })
    assert.throws(() => auth.requireApiKey('anything'), (error: unknown) =>
      error instanceof QmsAuthorizationError && error.status === 500 && error.code === 'API_KEY_NOT_CONFIGURED')
  })

  void it('maps organization administrators to their permanent tenant code', async () => {
    const auth = new QmsAuthorizationService({ apiKey: 'secret-key', organizations })

    assert.deepEqual(await auth.adminScope({ userId: 'u1', orgId: 'org-a', role: 'admin' }, 'tenant-b'), {
      userId: 'u1',
      orgId: 'org-a',
      tenantId: 'tenant-a',
      canViewAllTenants: false,
      qmsRole: 'viewer',
    })
  })

  void it('allows super administrators to select a known tenant or query globally', async () => {
    const auth = new QmsAuthorizationService({ apiKey: 'secret-key', organizations })
    const actor = { userId: 'root', orgId: 'root-org', role: 'super_admin' }

    assert.equal((await auth.adminScope(actor)).tenantId, null)
    assert.equal((await auth.adminScope(actor, 'tenant-b')).tenantId, 'tenant-b')
    await assert.rejects(auth.adminScope(actor, 'missing'), (error: unknown) =>
      error instanceof QmsAuthorizationError && error.code === 'TENANT_NOT_FOUND')
  })

  void it('scopes a Moss operations super administrator to the selected organization tenant', async () => {
    const auth = new QmsAuthorizationService({ apiKey: 'secret-key', organizations })
    const actor = {
      userId: 'root', orgId: 'org-b', role: 'super_admin', organizationScoped: true,
    }

    assert.deepEqual(await auth.adminScope(actor, 'tenant-a'), {
      userId: 'root',
      orgId: 'org-b',
      tenantId: 'tenant-b',
      canViewAllTenants: false,
      qmsRole: 'admin',
    })
  })

  void it('rejects ordinary users and administrators without an organization mapping', async () => {
    const auth = new QmsAuthorizationService({ apiKey: 'secret-key', organizations })
    await assert.rejects(auth.adminScope({ userId: 'u2', orgId: 'org-a', role: 'user' }), /Insufficient permissions/)
    await assert.rejects(auth.adminScope({ userId: 'u3', orgId: 'missing', role: 'admin' }), (error: unknown) =>
      error instanceof QmsAuthorizationError && error.code === 'TENANT_NOT_FOUND')
  })
})
