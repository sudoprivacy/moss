import type { AuthCenterDb } from '../authCenter/db.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { LegacyProviderIdentity, TargetIdentitySnapshot } from './identityMergePlanner.js'

type SqlIdentity = {
  user_id: string
  provider: string
  issuer: string
  normalized_subject: string
}

export function readTargetIdentitySnapshot(
  auth: AuthCenterDb,
  identities: IdentityRepository,
): TargetIdentitySnapshot {
  const providers = auth.db.prepare(`
    SELECT user_id, provider, issuer, normalized_subject
    FROM user_auth_identities
    ORDER BY user_id, provider, issuer, normalized_subject
  `).all() as unknown as SqlIdentity[]
  const providersByUser = new Map<string, LegacyProviderIdentity[]>()
  for (const item of providers) {
    const current = providersByUser.get(item.user_id) ?? []
    current.push({ provider: item.provider, issuer: item.issuer, subject: item.normalized_subject })
    providersByUser.set(item.user_id, current)
  }

  const organizations = auth.listOrganizations().map(organization => {
    const profile = identities.getOrganizationProfile(organization.id)
    return {
      id: organization.id,
      name: organization.name,
      code: profile?.code ?? '',
      codeVerified: Boolean(profile?.code),
      legacyAlias: identities.getNumericAlias('enterprise', organization.id),
    }
  })
  const users = organizations.flatMap(organization => auth.listUsersByOrg(organization.id).map(user => {
    const userProviders = providersByUser.get(user.id) ?? []
    const phone = userProviders.find(item => item.provider === 'phone' && item.issuer === 'sudowork')?.subject ?? null
    return {
      id: user.id,
      orgId: user.orgId,
      email: user.email,
      emailVerified: false,
      phone,
      phoneVerified: phone !== null,
      username: user.name,
      displayName: user.displayName,
      legacyAlias: identities.getNumericAlias('user', user.id),
      providerIdentities: userProviders,
    }
  }))
  return { organizations, users }
}
