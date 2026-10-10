import { randomInt, randomUUID } from 'node:crypto'
import type { CommandContext } from '../application/commandContext.js'
import { AuthCenterDb, hashPassword, type AuthCenterUser } from '../authCenter/db.js'
import {
  IdentityRepository,
  type InvitationRecord,
  type OrganizationLoginMethod,
  type OrganizationProfile,
} from './identityRepository.js'
import { UnifiedIdentityService, type CreateUnifiedUserInput } from './unifiedIdentityService.js'
import { detachAllBindingsForOrg } from '../zones/binding/bindingRepository.js'
import type { ClientPolicyRepository } from '../configuration/clientPolicyRepository.js'

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

const INVITATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateInvitationCode(): string {
  return Array.from({ length: 6 }, () => INVITATION_CODE_ALPHABET[randomInt(INVITATION_CODE_ALPHABET.length)]!).join('')
}

export class OrganizationIdentityService {
  constructor(
    private readonly authDb: AuthCenterDb,
    private readonly repository: IdentityRepository,
    private readonly unifiedIdentity: UnifiedIdentityService,
    /**
     * 低-6：跨 org 移动的 membership revoke 钩子（可选——authService 组装处
     * 注入，测试可省）。用户被移动到新 org 后，旧 org 前缀下的 delegation
     * 主动 revoke（best-effort；安全兜底是 nexus verify 的 membership 复查，
     * 此处只加速收敛）。
     */
    private readonly onUserOrgChanged?: (fromOrgId: string, userId: string) => void,
    private readonly modelBilling?: { isShared(orgId: string): Promise<boolean>; beforeMemberChange(orgId: string, userId: string, status: string, targetOrgId?: string): Promise<void> },
    private readonly clientPolicies?: Pick<ClientPolicyRepository, 'getOrganization' | 'putOrganization'>,
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
    modelBilling?: import('../billing/organizationBillingService.js').CreateOrganizationModelInput
    legacyEnterpriseId?: number
  }, context: CommandContext, actor?: IdentityActor) {
    if (actor) this.assertSuperAdmin(actor)
    return this.createOrganizationAsync(input, context, actor)
  }

  async createOrganizationAsync(input: Parameters<OrganizationIdentityService['createOrganization']>[0], context: CommandContext, actor?: IdentityActor) {
    if (actor) this.assertSuperAdmin(actor)
    const created = await this.unifiedIdentity.createOrganization(input, context)
    if (input.loginMethod === undefined && this.clientPolicies) {
      const policy = await this.clientPolicies.getOrganization(created.organizationId)
      if (policy.loginMethod === undefined && policy.loginMethodInherited === undefined) {
        await this.clientPolicies.putOrganization(
          created.organizationId,
          { loginMethodInherited: true },
          actor?.userId ?? 'system',
        )
      }
    }
    const organization = await this.authDb.getOrganization(created.organizationId)
    const profile = await this.repository.getOrganizationProfile(created.organizationId)
    const wallet = await this.repository.getWallet('organization', created.organizationId)
    if (!organization || !profile || !wallet) throw new Error('Created organization is incomplete')
    return { organization, profile, wallet, legacyEnterpriseId: created.legacyEnterpriseId }
  }

  async listOrganizations(actor?: IdentityActor) {
    if (actor && actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new IdentityDomainError('FORBIDDEN', 'Administrator permission required')
    }
    const allOrganizations = await this.authDb.listOrganizations()
    const organizations = actor && !hasGlobalOrganizationAccess(actor)
      ? allOrganizations.filter((organization) => organization.id === actor.orgId)
      : allOrganizations
    return Promise.all(organizations.flatMap(async (organization) => {
      const profile = await this.repository.getOrganizationProfile(organization.id)
      if (!profile) return []
      return [{
        organization,
        profile,
        wallet: await this.repository.getWallet('organization', organization.id),
        legacyEnterpriseId: await this.repository.getNumericAlias('enterprise', organization.id),
        userCount: await this.authDb.countUsersByOrg(organization.id),
      }]
    })).then(items => items.flat())
  }

  async updateOrganization(orgId: string, patch: {
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
    return this.authDb.driver.transaction(async () => {
      const organization = await this.authDb.getOrganization(orgId)
      const profile = await this.repository.getOrganizationProfile(orgId)
      if (!organization || !profile) throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
      if (patch.name !== undefined) {
        const name = patch.name.trim()
        if (!name) throw new IdentityDomainError('INVALID_NAME', 'Organization name is required')
        await this.authDb.updateOrganization(orgId, { name })
      }
      await this.repository.putOrganizationProfile({
        ...profile,
        ...patch,
        orgId,
        code: patch.code?.trim() || profile.code,
      })
      return {
        organization: (await this.authDb.getOrganization(orgId))!,
        profile: (await this.repository.getOrganizationProfile(orgId))!,
      }
    })
  }

  async createInvitations(input: {
    orgId: string
    count: number
    initialCreditUnits?: number
    legacyInitialQuotaUsd?: number | null
  }, codeFactory: (() => string) | undefined = undefined, actor?: IdentityActor): Promise<InvitationRecord[]> {
    if (actor) this.assertOrganizationAdmin(actor, input.orgId)
    if (!(await this.authDb.getOrganization(input.orgId))) {
      throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
    }
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) {
      throw new IdentityDomainError('INVALID_INVITATION_COUNT', 'Invitation count must be between 1 and 100')
    }
    const initialCreditUnits = input.initialCreditUnits ?? 0
    if (!Number.isFinite(initialCreditUnits) || initialCreditUnits < 0) {
      throw new IdentityDomainError('INVALID_INITIAL_CREDIT', 'Initial credit must be non-negative')
    }
    return this.authDb.driver.transaction(async () => {
      const created: InvitationRecord[] = []
      for (let index = 0; index < input.count; index += 1) {
        let invitation: InvitationRecord | null = null
        for (let attempt = 0; attempt < 100 && !invitation; attempt += 1) {
          const code = (codeFactory ?? generateInvitationCode)()
          if (await this.repository.getInvitationByCode(code)) continue
          const id = randomUUID()
          await this.repository.createInvitation({
            id,
            orgId: input.orgId,
            code,
            initialCreditUnits,
            legacyInitialQuotaUsd: input.legacyInitialQuotaUsd,
          })
          await this.repository.allocateNumericAlias('invitation', id, input.orgId)
          invitation = await this.repository.getInvitationById(id)
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

  async deleteInvitation(id: string, actor?: IdentityActor): Promise<boolean> {
    const invitation = await this.repository.getInvitationById(id)
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

  async listUsers(actor: IdentityActor, filters: {
    orgId?: string
    status?: AuthCenterUser['status']
    role?: string
    keyword?: string
  } = {}): Promise<AuthCenterUser[]> {
    if (actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new IdentityDomainError('FORBIDDEN', 'Administrator permission required')
    }
    const orgIds = !hasGlobalOrganizationAccess(actor)
      ? [actor.orgId]
      : filters.orgId ? [filters.orgId] : (await this.authDb.listOrganizations()).map((org) => org.id)
    const keyword = filters.keyword?.trim().toLowerCase()
    const users = (await Promise.all(orgIds.map((orgId) => this.authDb.listUsersByOrg(orgId)))).flat()
    return users
      .filter((user) => !filters.status || user.status === filters.status)
      .filter((user) => !filters.role || user.role === filters.role)
      .filter((user) => !keyword
        || user.name.toLowerCase().includes(keyword)
        || user.displayName?.toLowerCase().includes(keyword))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  }

  async updateUser(userId: string, patch: {
    displayName?: string | null
    status?: AuthCenterUser['status']
    role?: 'admin' | 'dept_admin' | 'user'
    orgId?: string
    password?: string
  }, actor: IdentityActor): Promise<AuthCenterUser> {
    const user = await this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    this.assertOrganizationAdmin(actor, user.orgId)
    if (user.role === 'super_admin') {
      throw new IdentityDomainError('SUPER_ADMIN_IMMUTABLE', 'Super admin cannot be modified')
    }
    if (patch.orgId && patch.orgId !== user.orgId) {
      this.assertSuperAdmin(actor)
      if (!(await this.authDb.getOrganization(patch.orgId))) {
        throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
      }
    }
    await this.modelBilling?.beforeMemberChange(user.orgId, user.id, patch.status ?? user.status, patch.orgId)
    return this.authDb.driver.transaction(async () => {
      await this.authDb.updateUser(userId, {
        displayName: patch.displayName,
        status: patch.status,
        role: patch.role,
        orgId: patch.orgId,
      })
      if (patch.orgId && patch.orgId !== user.orgId) {
        await this.repository.moveUserOrganization(userId, patch.orgId)
        // 低-6：跨 org 移动后旧 org 名下的 delegation 主动 revoke（钩子在
        // 事务提交后调用方不感知——revoke 是 best-effort 网络调用，失败
        // 由 nexus verify 复查兜底）。
        this.onUserOrgChanged?.(user.orgId, userId)
      }
      if (patch.password) {
        await this.authDb.updateUserPassword(userId, hashPassword(patch.password), Date.now())
      }
      return (await this.authDb.getUserById(userId))!
    })
  }

  async deleteUser(userId: string, actor: IdentityActor): Promise<void> {
    this.assertSuperAdmin(actor)
    const user = await this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    if (user.role === 'super_admin') {
      throw new IdentityDomainError('SUPER_ADMIN_IMMUTABLE', 'Super admin cannot be deleted')
    }
    await this.modelBilling?.beforeMemberChange(user.orgId, user.id, 'deleted')
    await this.authDb.driver.transaction(async () => {
      await this.repository.deleteUserRecords(userId)
      await this.authDb.deleteUser(userId)
    })
  }

  async resetUserPassword(userId: string, password: string, actor: IdentityActor): Promise<void> {
    this.assertSuperAdmin(actor)
    const user = await this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    await this.authDb.updateUserPassword(userId, hashPassword(password), Date.now())
  }

  async deleteOrganization(orgId: string, actor: IdentityActor): Promise<void> {
    this.assertSuperAdmin(actor)
    if (!(await this.authDb.getOrganization(orgId))) {
      throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
    }
    if (await this.modelBilling?.isShared(orgId)) throw new IdentityDomainError('MODEL_ACCOUNT_EXISTS', '组织含有模型账户及资金记录，不能删除')
    if ((await this.authDb.countUsersByOrg(orgId)) > 0 || (await this.authDb.countDepartmentsByOrg(orgId)) > 0) {
      throw new IdentityDomainError('ORGANIZATION_NOT_EMPTY', 'Organization is not empty')
    }
    await this.authDb.driver.transaction(async () => {
      // 低-4/N-1：binding detach 与 org 删除同事务（与 authService 删除入口
      // 共用同一辅助）——此前该路径完全不触碰 org_zone_bindings，org 删除后
      // binding 僵尸 bound、Nexus grant 泄漏且无收敛路径。非空预检在上，
      // detach 只在删除必然成功的路径上执行。
      await detachAllBindingsForOrg(this.authDb.driver, { orgId, now: Date.now() })
      await this.repository.deleteOrganizationRecords(orgId)
      await this.authDb.deleteOrganization(orgId)
    })
  }

  async setUserStatus(userId: string, status: AuthCenterUser['status']): Promise<AuthCenterUser> {
    const user = await this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    await this.modelBilling?.beforeMemberChange(user.orgId, user.id, status)
    await this.authDb.updateUser(userId, { status })
    return (await this.authDb.getUserById(userId))!
  }

  async setUserRole(userId: string, role: 'admin' | 'dept_admin' | 'user'): Promise<AuthCenterUser> {
    const user = await this.authDb.getUserById(userId)
    if (!user) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    if (user.role === 'super_admin') {
      throw new IdentityDomainError('SUPER_ADMIN_IMMUTABLE', 'Super admin role cannot be changed')
    }
    await this.authDb.updateUser(userId, { role })
    return (await this.authDb.getUserById(userId))!
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
