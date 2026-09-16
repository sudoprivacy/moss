import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CommandContext } from '../application/commandContext.js'
import { AuthCenterDb, hashPassword, type AuthCenterUser } from '../authCenter/db.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import {
  IdentityRepository,
  type InvitationRecord,
  type OrganizationLoginMethod,
  type OrganizationProfile,
} from './identityRepository.js'
import { UnifiedIdentityService, type CreateUnifiedUserInput } from './unifiedIdentityService.js'

export class IdentityDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'IdentityDomainError'
  }
}

export interface IdentityActor {
  userId: string
  orgId: string
  role: string
  organizationScoped?: boolean
}

export function hasGlobalOrganizationAccess(actor: IdentityActor): boolean {
  return actor.role === 'super_admin' && actor.organizationScoped !== true
}

export class OrganizationIdentityService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly authDb: AuthCenterDb,
    private readonly repository: IdentityRepository,
    private readonly unifiedIdentity: UnifiedIdentityService,
  ) {}

  createOrganization(input: {
    name: string
    code: string
    loginMethod?: OrganizationLoginMethod
    localEnabled?: boolean
    cloudEnabled?: boolean
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
    initialCreditUnits?: number
    legacyEnterpriseId?: number
  }, context: CommandContext, actor?: IdentityActor) {
    if (actor) this.assertSuperAdmin(actor)
    const created = this.unifiedIdentity.createOrganization(input, context)
    const organization = this.authDb.getOrganization(created.organizationId)
    const profile = this.repository.getOrganizationProfile(created.organizationId)
    const wallet = this.repository.getWallet('organization', created.organizationId)
    if (!organization || !profile || !wallet) throw new Error('Created organization is incomplete')
    return { organization, profile, wallet, legacyEnterpriseId: created.legacyEnterpriseId }
  }

  listOrganizations(actor?: IdentityActor) {
    if (actor && actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new IdentityDomainError('FORBIDDEN', 'Administrator permission required')
    }
    const organizations = actor && !hasGlobalOrganizationAccess(actor)
      ? this.authDb.listOrganizations().filter((organization) => organization.id === actor.orgId)
      : this.authDb.listOrganizations()
    return organizations.flatMap((organization) => {
      const profile = this.repository.getOrganizationProfile(organization.id)
      if (!profile) return []
      return [{
        organization,
        profile,
        wallet: this.repository.getWallet('organization', organization.id),
        legacyEnterpriseId: this.repository.getNumericAlias('enterprise', organization.id),
        userCount: this.authDb.countUsersByOrg(organization.id),
      }]
    })
  }

  updateOrganization(orgId: string, patch: {
    name?: string
    code?: string
    loginMethod?: OrganizationLoginMethod
    localEnabled?: boolean
    cloudEnabled?: boolean
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
  }, actor?: IdentityActor) {
    if (actor) this.assertOrganizationAdmin(actor, orgId)
    return runInTransaction(this.db, () => {
      const organization = this.authDb.getOrganization(orgId)
      const profile = this.repository.getOrganizationProfile(orgId)
      if (!organization || !profile) throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
      if (patch.name !== undefined) {
        const name = patch.name.trim()
        if (!name) throw new IdentityDomainError('INVALID_NAME', 'Organization name is required')
        this.authDb.updateOrganization(orgId, { name })
      }
      this.repository.putOrganizationProfile({
        ...profile,
        ...patch,
        orgId,
        code: patch.code?.trim() || profile.code,
      })
      return {
        organization: this.authDb.getOrganization(orgId)!,
        profile: this.repository.getOrganizationProfile(orgId)!,
      }
    })
  }

  createInvitations(input: {
    orgId: string
    count: number
    initialCreditUnits?: number
    legacyInitialQuotaUsd?: number | null
  }, codeFactory: (() => string) | undefined = undefined, actor?: IdentityActor): InvitationRecord[] {
    if (actor) this.assertOrganizationAdmin(actor, input.orgId)
    if (!this.authDb.getOrganization(input.orgId)) {
      throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
    }
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) {
      throw new IdentityDomainError('INVALID_INVITATION_COUNT', 'Invitation count must be between 1 and 100')
    }
    const initialCreditUnits = input.initialCreditUnits ?? 0
    if (!Number.isFinite(initialCreditUnits) || initialCreditUnits < 0) {
      throw new IdentityDomainError('INVALID_INITIAL_CREDIT', 'Initial credit must be non-negative')
    }
    return runInTransaction(this.db, () => {
      const created: InvitationRecord[] = []
      for (let index = 0; index < input.count; index += 1) {
        let invitation: InvitationRecord | null = null
        for (let attempt = 0; attempt < 100 && !invitation; attempt += 1) {
          const code = (codeFactory ?? (() => randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()))()
          if (this.repository.getInvitationByCode(code)) continue
          const id = randomUUID()
          this.repository.createInvitation({
            id,
            orgId: input.orgId,
            code,
            initialCreditUnits,
            legacyInitialQuotaUsd: input.legacyInitialQuotaUsd,
          })
          this.repository.allocateNumericAlias('invitation', id, input.orgId)
          invitation = this.repository.getInvitationById(id)
        }
        if (!invitation) throw new IdentityDomainError('INVITATION_CODE_EXHAUSTED', 'Unable to generate invitation code')
        created.push(invitation)
      }
      return created
    })
  }

  listInvitations(input: Parameters<IdentityRepository['listInvitations']>[0] = {}, actor?: IdentityActor) {
    if (actor) {
      if (actor.role !== 'super_admin' && actor.role !== 'admin') {
        throw new IdentityDomainError('FORBIDDEN', 'Administrator permission required')
      }
      if (!hasGlobalOrganizationAccess(actor)) input = { ...input, orgId: actor.orgId }
    }
    return this.repository.listInvitations(input)
  }

  deleteInvitation(id: string, actor?: IdentityActor): boolean {
    const invitation = this.repository.getInvitationById(id)
    if (!invitation) throw new IdentityDomainError('INVITATION_NOT_FOUND', 'Invitation not found')
    if (actor) this.assertOrganizationAdmin(actor, invitation.orgId)
    if (invitation.status !== 'pending') return false
    return this.repository.deletePendingInvitation(id)
  }

  createUser(
    input: Omit<CreateUnifiedUserInput, 'role'> & { role?: 'admin' | 'dept_admin' | 'user' },
    context: CommandContext,
    actor?: IdentityActor,
  ) {
    if (actor) this.assertSuperAdmin(actor)
    return this.unifiedIdentity.createUser({ ...input, role: input.role ?? 'user' }, context)
  }

  listUsers(actor: IdentityActor, filters: {
    orgId?: string
    status?: AuthCenterUser['status']
    role?: string
    keyword?: string
  } = {}): AuthCenterUser[] {
    if (actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new IdentityDomainError('FORBIDDEN', 'Administrator permission required')
    }
    const orgIds = !hasGlobalOrganizationAccess(actor)
      ? [actor.orgId]
      : filters.orgId ? [filters.orgId] : this.authDb.listOrganizations().map((org) => org.id)
    const keyword = filters.keyword?.trim().toLowerCase()
    return orgIds
      .flatMap((orgId) => this.authDb.listUsersByOrg(orgId))
      .filter((user) => !filters.status || user.status === filters.status)
      .filter((user) => !filters.role || user.role === filters.role)
      .filter((user) => !keyword
        || user.name.toLowerCase().includes(keyword)
        || user.displayName?.toLowerCase().includes(keyword))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  }

  updateUser(userId: string, patch: {
    displayName?: string | null
    status?: AuthCenterUser['status']
    role?: 'admin' | 'dept_admin' | 'user'
    orgId?: string
    password?: string
  }, actor: IdentityActor): AuthCenterUser {
    const user = this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    this.assertOrganizationAdmin(actor, user.orgId)
    if (user.role === 'super_admin') {
      throw new IdentityDomainError('SUPER_ADMIN_IMMUTABLE', 'Super admin cannot be modified')
    }
    if (patch.orgId && patch.orgId !== user.orgId) {
      this.assertSuperAdmin(actor)
      if (!this.authDb.getOrganization(patch.orgId)) {
        throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
      }
    }
    return runInTransaction(this.db, () => {
      this.authDb.updateUser(userId, {
        displayName: patch.displayName,
        status: patch.status,
        role: patch.role,
        orgId: patch.orgId,
      })
      if (patch.orgId && patch.orgId !== user.orgId) {
        this.repository.moveUserOrganization(userId, patch.orgId)
      }
      if (patch.password) {
        this.authDb.updateUserPassword(userId, hashPassword(patch.password), Date.now())
      }
      return this.authDb.getUserById(userId)!
    })
  }

  deleteUser(userId: string, actor: IdentityActor): void {
    this.assertSuperAdmin(actor)
    const user = this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    if (user.role === 'super_admin') {
      throw new IdentityDomainError('SUPER_ADMIN_IMMUTABLE', 'Super admin cannot be deleted')
    }
    runInTransaction(this.db, () => {
      this.repository.deleteUserRecords(userId)
      this.authDb.deleteUser(userId)
    })
  }

  resetUserPassword(userId: string, password: string, actor: IdentityActor): void {
    this.assertSuperAdmin(actor)
    const user = this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    this.authDb.updateUserPassword(userId, hashPassword(password), Date.now())
  }

  deleteOrganization(orgId: string, actor: IdentityActor): void {
    this.assertSuperAdmin(actor)
    if (!this.authDb.getOrganization(orgId)) {
      throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
    }
    if (this.authDb.countUsersByOrg(orgId) > 0 || this.authDb.countDepartmentsByOrg(orgId) > 0) {
      throw new IdentityDomainError('ORGANIZATION_NOT_EMPTY', 'Organization is not empty')
    }
    runInTransaction(this.db, () => {
      this.repository.deleteOrganizationRecords(orgId)
      this.authDb.deleteOrganization(orgId)
    })
  }

  setUserStatus(userId: string, status: AuthCenterUser['status']): AuthCenterUser {
    const user = this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    this.authDb.updateUser(userId, { status })
    return this.authDb.getUserById(userId)!
  }

  setUserRole(userId: string, role: 'admin' | 'dept_admin' | 'user'): AuthCenterUser {
    const user = this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    if (user.role === 'super_admin') {
      throw new IdentityDomainError('SUPER_ADMIN_IMMUTABLE', 'Super admin role cannot be changed')
    }
    this.authDb.updateUser(userId, { role })
    return this.authDb.getUserById(userId)!
  }

  mapLegacyRole(role: string): 'super_admin' | 'admin' | 'user' {
    if (role === 'SUPER_ADMIN') return 'super_admin'
    if (role === 'ENTERPRISE_ADMIN') return 'admin'
    if (role === 'USER') return 'user'
    throw new IdentityDomainError('ROLE_CONFLICT', `Unsupported legacy role: ${role}`)
  }

  private assertSuperAdmin(actor: IdentityActor): void {
    if (actor.role !== 'super_admin') {
      throw new IdentityDomainError('FORBIDDEN', 'Super administrator permission required')
    }
  }

  private assertOrganizationAdmin(actor: IdentityActor, orgId: string): void {
    if (hasGlobalOrganizationAccess(actor)) return
    if (actor.role === 'super_admin' && actor.orgId === orgId) return
    if (actor.role === 'admin' && actor.orgId === orgId) return
    throw new IdentityDomainError('FORBIDDEN', 'Administrator permission required for this organization')
  }
}
