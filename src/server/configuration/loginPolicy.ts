import type { ClientPolicyRepository } from './clientPolicyRepository.js'
import type { OrganizationLoginMethod } from '../identity/identityRepository.js'

export interface LoginPolicySources {
  policies: Pick<ClientPolicyRepository, 'getOrganization' | 'getPlatform'>
  identities: {
    getOrganizationProfile(orgId: string): Promise<{ loginMethod: OrganizationLoginMethod } | null>
  }
  defaults?: { loginMethod?: OrganizationLoginMethod }
}

function loginMethod(value: unknown): OrganizationLoginMethod | undefined {
  if (value === 0 || value === 'sms') return 'sms'
  if (value === 1 || value === 'password') return 'password'
  if (value === 2 || value === 'cas') return 'cas'
  return undefined
}

/** Stored delivery policies take precedence over legacy organization profiles. */
export async function resolveEffectiveLoginMethod(
  { policies, identities, defaults }: LoginPolicySources,
  orgId?: string,
  options: { ignoreOrganizationPolicy?: boolean } = {},
): Promise<OrganizationLoginMethod> {
  return (orgId && !options.ignoreOrganizationPolicy
    ? loginMethod((await policies.getOrganization(orgId)).loginMethod)
    : undefined)
    ?? loginMethod((await policies.getPlatform()).loginMethod)
    ?? (orgId ? loginMethod((await identities.getOrganizationProfile(orgId))?.loginMethod) : undefined)
    ?? defaults?.loginMethod
    ?? 'password'
}
