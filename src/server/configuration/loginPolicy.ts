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
  const organizationPolicy = orgId && !options.ignoreOrganizationPolicy
    ? await policies.getOrganization(orgId)
    : undefined
  const organizationMethod = loginMethod(organizationPolicy?.loginMethod)
  if (organizationMethod) return organizationMethod

  const platformMethod = loginMethod((await policies.getPlatform()).loginMethod)
  if (platformMethod) return platformMethod

  // `ignoreOrganizationPolicy` resolves the platform's effective default. It
  // must not fall back to an organization's legacy profile, otherwise the UI
  // can display "follow platform" while authentication still uses that old
  // profile value. Explicit inheritance has the same platform-only fallback.
  if (options.ignoreOrganizationPolicy || organizationPolicy?.loginMethodInherited === true) {
    return defaults?.loginMethod ?? 'password'
  }

  return (orgId ? loginMethod((await identities.getOrganizationProfile(orgId))?.loginMethod) : undefined)
    ?? defaults?.loginMethod
    ?? 'password'
}
