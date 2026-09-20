import type { AuthCenterDb } from '../authCenter/db.js'
import type { IdentityRepository } from '../identity/identityRepository.js'
import type { LegacyProviderIdentity, TargetIdentitySnapshot } from './identityMergePlanner.js'

type SqlIdentity = {
  user_id: string
  provider: string
  issuer: string
  normalized_subject: string
}

type SqlOrganization = {
  id: string
  name: string
}

type SqlUser = {
  id: string
  org_id: string
  email: string
  name: string
  display_name: string | null
}

export async function readTargetIdentitySnapshot(
  auth: AuthCenterDb,
  identities: IdentityRepository,
): Promise<TargetIdentitySnapshot> {
  const providers = await auth.driver.all<SqlIdentity & Record<string, unknown>>(`
    SELECT user_id, provider, issuer, normalized_subject
    FROM user_auth_identities
    ORDER BY user_id, provider, issuer, normalized_subject
  `)
  const providersByUser = new Map<string, LegacyProviderIdentity[]>()
  for (const item of providers) {
    const current = providersByUser.get(item.user_id) ?? []
    current.push({ provider: item.provider, issuer: item.issuer, subject: item.normalized_subject })
    providersByUser.set(item.user_id, current)
  }

  const organizationRows = await auth.driver.all<SqlOrganization & Record<string, unknown>>(`
    SELECT id, name
    FROM organizations
    ORDER BY created_at ASC
  `)
  const organizations = await Promise.all(organizationRows.map(async (organization) => {
    const profile = await identities.getOrganizationProfile(organization.id)
    return {
      id: organization.id,
      name: organization.name,
      code: profile?.code ?? '',
      codeVerified: Boolean(profile?.code),
      legacyAlias: await identities.getNumericAlias('enterprise', organization.id),
    }
  }))
  const userRows = await auth.driver.all<SqlUser & Record<string, unknown>>(`
    SELECT id, org_id, email, name, display_name
    FROM users
    ORDER BY created_at ASC
  `)
  const users = await Promise.all(userRows.map(async (user) => {
    const userProviders = providersByUser.get(user.id) ?? []
    const phone = userProviders.find(item => item.provider === 'phone' && item.issuer === 'sudowork')?.subject ?? null
    return {
      id: user.id,
      orgId: user.org_id,
      email: user.email,
      emailVerified: false,
      phone,
      phoneVerified: phone !== null,
      username: user.name,
      displayName: user.display_name,
      legacyAlias: await identities.getNumericAlias('user', user.id),
      providerIdentities: userProviders,
    }
  }))
  return { organizations, users }
}
