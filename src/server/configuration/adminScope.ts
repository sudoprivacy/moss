import type { IdentityActor } from '../identity/organizationIdentityService.js'

export class ConfigurationScopeError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'ConfigurationScopeError'
  }
}

export function resolveConfigurationActor(
  actor: IdentityActor,
  requestedScope: string | null | undefined,
  defaultScope: 'organization' | 'platform' = 'organization',
): IdentityActor {
  if (actor.role !== 'admin' && actor.role !== 'super_admin') {
    throw new ConfigurationScopeError(403, 'Administrator access required')
  }
  const scope = requestedScope ?? defaultScope
  if (scope !== 'organization' && scope !== 'platform') {
    throw new ConfigurationScopeError(400, 'Invalid configuration scope')
  }
  if (scope === 'platform' && actor.role !== 'super_admin') {
    throw new ConfigurationScopeError(403, 'Platform configuration requires a super administrator')
  }
  return { ...actor, organizationScoped: scope === 'organization' }
}
