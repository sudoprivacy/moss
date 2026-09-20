import type { ClientPolicyRepository } from './clientPolicyRepository.js'
import type { OrganizationLoginMethod } from '../identity/identityRepository.js'

export interface LoginPolicySources {
  policies: Pick<ClientPolicyRepository, 'getOrganization' | 'getPlatform'>
  identities: {
    getOrganizationProfile(orgId: string): { loginMethod: OrganizationLoginMethod } | null
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
export function resolveEffectiveLoginMethod(
  { policies, identities, defaults }: LoginPolicySources,
  orgId?: string,
  options: { ignoreOrganizationPolicy?: boolean } = {},
): OrganizationLoginMethod {
  return (orgId && !options.ignoreOrganizationPolicy
    ? loginMethod(policies.getOrganization(orgId).loginMethod)
    : undefined)
    ?? loginMethod(policies.getPlatform().loginMethod)
    ?? (orgId ? loginMethod(identities.getOrganizationProfile(orgId)?.loginMethod) : undefined)
    ?? defaults?.loginMethod
    ?? 'password'
}
