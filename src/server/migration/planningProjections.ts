import type { CatalogRepository } from '../catalog/catalogRepository.js'
import type { AuthIdentity, IdentityRepository, OrganizationProfile } from '../identity/identityRepository.js'
import type { IdentityMigrationPlan } from './identityMigrationService.js'
import type { LegacyIdentitySnapshot } from './identityMergePlanner.js'

type AliasKind = 'enterprise' | 'user'
type Alias = { resourceId: string; orgId: string }

export class PlanningIdentityProjection {
  readonly repository: IdentityRepository
  private readonly aliases = new Map<string, Alias>()
  private readonly profiles = new Map<string, OrganizationProfile>()
  private readonly identities: AuthIdentity[] = []
  private active = false

  constructor(private readonly base: IdentityRepository) {
    this.repository = new Proxy(base, {
      get: (target, property) => {
        if (property === 'resolveNumericAliasGlobal') return this.resolveNumericAliasGlobal.bind(this)
        if (property === 'resolveNumericAlias') return this.resolveNumericAlias.bind(this)
        if (property === 'getNumericAlias') return this.getNumericAlias.bind(this)
        if (property === 'getOrganizationProfile') return this.getOrganizationProfile.bind(this)
        if (property === 'getOrganizationProfileByCode') return this.getOrganizationProfileByCode.bind(this)
        if (property === 'findAuthIdentity') return this.findAuthIdentity.bind(this)
        if (property === 'findAuthIdentityByUser') return this.findAuthIdentityByUser.bind(this)
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  install(plan: IdentityMigrationPlan, source: LegacyIdentitySnapshot): void {
    this.active = true
    this.aliases.clear()
    this.profiles.clear()
    this.identities.length = 0
    const sourceOrganizations = new Map(source.organizations.map(item => [item.legacyId, item]))
    for (const decision of plan.organizations) {
      if (!decision.targetId) continue
      const organization = sourceOrganizations.get(decision.legacyId)
      if (!organization) continue
      this.aliases.set(aliasKey('enterprise', decision.legacyId), {
        resourceId: decision.targetId,
        orgId: decision.targetId,
      })
      if (!this.base.getOrganizationProfile(decision.targetId)) {
        this.profiles.set(decision.targetId, {
          orgId: decision.targetId,
          code: organization.code?.trim() || `moss-${decision.targetId.slice(0, 8)}`,
          loginMethod: 'password', localEnabled: true, cloudEnabled: true, clientCronEnabled: true,
          logo: null, appName: null, topName: null, aboutName: null,
          appCompanyName: null, loginDescription: null, createdAt: 0, updatedAt: 0,
        })
      }
    }
    const sourceUsers = new Map(source.users.map(item => [item.legacyId, item]))
    for (const decision of plan.users) {
      if (!decision.targetId || !decision.targetOrgId) continue
      const user = sourceUsers.get(decision.legacyId)
      if (!user) continue
      this.aliases.set(aliasKey('user', decision.legacyId), {
        resourceId: decision.targetId,
        orgId: decision.targetOrgId,
      })
      const providers = [...(user.providerIdentities ?? (user.providerIdentity ? [user.providerIdentity] : []))]
      if (user.phoneVerified && user.phone) {
        providers.push({ provider: 'phone', issuer: 'sudowork', subject: user.phone })
      }
      for (const [index, provider] of providers.entries()) {
        if (this.base.findAuthIdentity(provider.provider, provider.issuer, provider.subject)) continue
        this.identities.push({
          id: `projection:${decision.legacyId}:${index}`,
          orgId: decision.targetOrgId,
          userId: decision.targetId,
          provider: provider.provider,
          issuer: provider.issuer,
          normalizedSubject: provider.subject,
          metadata: { projected: true },
          createdAt: 0,
          updatedAt: 0,
        })
      }
    }
  }

  isProjected(kind: AliasKind, resourceId: string): boolean {
    return this.active && [...this.aliases.entries()].some(([key, alias]) => key.startsWith(`${kind}:`) && alias.resourceId === resourceId)
  }

  deactivate(): void {
    this.active = false
  }

  private resolveNumericAliasGlobal(kind: string, legacyId: number): Alias | null {
    return this.base.resolveNumericAliasGlobal(kind, legacyId)
      ?? (this.active ? this.aliases.get(aliasKey(kind as AliasKind, legacyId)) : undefined)
      ?? null
  }

  private resolveNumericAlias(kind: string, legacyId: number, orgId: string): string | null {
    const actual = this.base.resolveNumericAlias(kind, legacyId, orgId)
    if (actual) return actual
    const projected = this.active ? this.aliases.get(aliasKey(kind as AliasKind, legacyId)) : undefined
    return projected?.orgId === orgId ? projected.resourceId : null
  }

  private getNumericAlias(kind: string, resourceId: string): number | null {
    const actual = this.base.getNumericAlias(kind, resourceId)
    if (actual !== null) return actual
    if (!this.active) return null
    for (const [key, alias] of this.aliases) {
      if (key.startsWith(`${kind}:`) && alias.resourceId === resourceId) return Number(key.slice(kind.length + 1))
    }
    return null
  }

  private getOrganizationProfile(orgId: string): OrganizationProfile | null {
    return this.base.getOrganizationProfile(orgId) ?? (this.active ? this.profiles.get(orgId) : undefined) ?? null
  }

  private getOrganizationProfileByCode(code: string): OrganizationProfile | null {
    return this.base.getOrganizationProfileByCode(code)
      ?? (this.active ? [...this.profiles.values()].find(profile => profile.code.toLowerCase() === code.trim().toLowerCase()) : undefined)
      ?? null
  }

  private findAuthIdentity(provider: string, issuer: string, subject: string): AuthIdentity | null {
    return this.base.findAuthIdentity(provider, issuer, subject)
      ?? (this.active ? this.identities.find(item => item.provider === provider && item.issuer === issuer && item.normalizedSubject === subject) : undefined)
      ?? null
  }

  private findAuthIdentityByUser(userId: string, provider: string, issuer: string): AuthIdentity | null {
    return this.base.findAuthIdentityByUser(userId, provider, issuer)
      ?? (this.active ? this.identities.find(item => item.userId === userId && item.provider === provider && item.issuer === issuer) : undefined)
      ?? null
  }
}

interface ProjectedCatalogResource {
  kind: 'agent' | 'skill'
  id: string
  orgIds: Set<string>
}

export class PlanningCatalogProjection {
  readonly repository: CatalogRepository
  private readonly resources = new Map<string, ProjectedCatalogResource>()

  constructor(private readonly base: CatalogRepository) {
    this.repository = new Proxy(base, {
      get: (target, property) => {
        if (property === 'findAgent') return (id: string) => this.find('agent', id)
        if (property === 'findSkill') return (id: string) => this.find('skill', id)
        if (property === 'isAvailableToOrganization') return this.isAvailableToOrganization.bind(this)
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  install(plan: { resources?: unknown }): void {
    this.resources.clear()
    if (!Array.isArray(plan.resources)) return
    for (const raw of plan.resources) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const source = item.source as Record<string, unknown> | undefined
      if ((item.kind !== 'agent' && item.kind !== 'skill') || typeof source?.id !== 'string' || typeof item.orgId !== 'string') continue
      const orgIds = new Set([item.orgId, ...(Array.isArray(item.assignedOrgIds) ? item.assignedOrgIds.filter(value => typeof value === 'string') : [])] as string[])
      this.resources.set(`${item.kind}:${source.id}`, { kind: item.kind, id: source.id, orgIds })
    }
  }

  private find(kind: 'agent' | 'skill', id: string): unknown {
    const actual = kind === 'agent' ? this.base.findAgent(id) : this.base.findSkill(id)
    if (actual) return actual
    const projected = this.resources.get(`${kind}:${id}`)
    return projected ? { id: projected.id, orgId: [...projected.orgIds][0], providerBinding: null } : null
  }

  private isAvailableToOrganization(kind: 'agent' | 'skill', id: string, orgId: string): boolean {
    if (this.base.isAvailableToOrganization(kind, id, orgId)) return true
    return this.resources.get(`${kind}:${id}`)?.orgIds.has(orgId) ?? false
  }
}

function aliasKey(kind: AliasKind, legacyId: number): string {
  return `${kind}:${legacyId}`
}
