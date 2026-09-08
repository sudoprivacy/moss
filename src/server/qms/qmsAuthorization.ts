import { createHash, timingSafeEqual } from 'node:crypto'

import type { IdentityActor } from '../identity/organizationIdentityService.js'

export class QmsAuthorizationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'QmsAuthorizationError'
  }
}

export interface QmsOrganizationDirectory {
  getCode(orgId: string): string | null
  hasCode(code: string): boolean
}

export interface QmsAdminScope {
  userId: string
  orgId: string
  tenantId: string | null
  canViewAllTenants: boolean
  qmsRole: 'admin' | 'viewer'
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export class QmsAuthorizationService {
  constructor(private readonly options: {
    apiKey?: string
    organizations: QmsOrganizationDirectory
  }) {}

  requireApiKey(received: string | undefined): void {
    if (!received) {
      throw new QmsAuthorizationError(401, 'MISSING_API_KEY', 'Missing API key header')
    }
    const expected = this.options.apiKey
    if (!expected) {
      throw new QmsAuthorizationError(500, 'API_KEY_NOT_CONFIGURED', 'QMS API key not configured on server')
    }
    if (!timingSafeEqual(digest(received), digest(expected))) {
      throw new QmsAuthorizationError(401, 'INVALID_API_KEY', 'Invalid API key')
    }
  }

  adminScope(actor: IdentityActor | null, requestedTenantCode?: string | null): QmsAdminScope {
    if (!actor) throw new QmsAuthorizationError(401, 'UNAUTHORIZED', 'Unauthorized')
    if (actor.role === 'super_admin') {
      const tenantId = requestedTenantCode?.trim() || null
      if (tenantId && !this.options.organizations.hasCode(tenantId)) {
        throw new QmsAuthorizationError(404, 'TENANT_NOT_FOUND', 'Tenant not found')
      }
      return {
        userId: actor.userId,
        orgId: actor.orgId,
        tenantId,
        canViewAllTenants: true,
        qmsRole: 'admin',
      }
    }
    if (actor.role !== 'admin') {
      throw new QmsAuthorizationError(403, 'FORBIDDEN', 'Insufficient permissions')
    }
    const tenantId = this.options.organizations.getCode(actor.orgId)
    if (!tenantId) {
      throw new QmsAuthorizationError(403, 'TENANT_NOT_FOUND', 'Current administrator is not associated with a tenant')
    }
    return {
      userId: actor.userId,
      orgId: actor.orgId,
      tenantId,
      canViewAllTenants: false,
      qmsRole: 'viewer',
    }
  }
}
