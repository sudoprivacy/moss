import { randomInt, randomUUID } from 'node:crypto'
import type { CommandContext } from '../../../application/commandContext.js'
import { onlineCommandContext } from '../../../application/commandContext.js'
import { IdentityRepository, type InvitationRecord, type OperationAuditRecord } from '../../../identity/identityRepository.js'
import type { AuthCenterDb, AuthCenterUser } from '../../../authCenter/db.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { WalletService } from '../../../billing/walletService.js'
import { sudoworkQuotaToCreditUnits, sudoworkUsdToCreditUnits } from '../../../identity/sudoworkCreditConversion.js'
import type { SudorouterAccountService } from '../../../billing/sudorouterAccountService.js'
import { pointsToQuota } from '../../../billing/sudorouterAdapter.js'
import {
  hasGlobalOrganizationAccess,
  IdentityDomainError,
  OrganizationIdentityService,
  type IdentityActor,
} from '../../../identity/organizationIdentityService.js'

export interface LegacyEnterpriseDto {
  id: number
  name: string
  code: string
  credit_pool: number
  logo: string | null
  app_name: string | null
  top_name: string | null
  about_name: string | null
  app_company_name: string | null
  login_desp: string | null
  userCount: number
}

export interface LegacyInvitationDto {
  id: number
  code: string
  enterprise_id: number
  enterprise_name: string
  initial_quota_usd: number | null
  status: 0 | 1 | 2
  used_by_user_id: number | null
  used_by_phone: string | null
  used_by_nickname: string | null
  created_at: number
  used_at: number | null
}

export interface LegacyManagedUserDto {
  id: number
  phone: string
  nickname: string | null
  enterprise_id: number
  enterprise_name: string
  role: 'SUPER_ADMIN' | 'ENTERPRISE_ADMIN' | 'USER'
  status: 0 | 1 | 2
  invitation_code: string | null
  quota: number
  used_quota: number
  balance: number
  login_type: 0 | 1 | 2
  created_at: number
}

export class SudoworkAdministrationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SudoworkAdministrationError'
  }
}

const LEGACY_INVITATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateLegacyInvitationCode(): string {
  return Array.from(
    { length: 6 },
    () => LEGACY_INVITATION_CODE_ALPHABET[randomInt(LEGACY_INVITATION_CODE_ALPHABET.length)]!,
  ).join('')
}

export class SudoworkAdministrationService {
  private readonly billing: BillingRepository
  private readonly wallet: WalletService

  constructor(
    private readonly organizations: OrganizationIdentityService,
    private readonly identities: IdentityRepository,
    private readonly authDb: AuthCenterDb,
    private readonly options: {
      getDifyFeatureFlags?: () => { enabled: boolean; missingEnv: string[] }
      defaultInitialQuota?: number
      accountProvisioner?: Pick<SudorouterAccountService, 'ensureAccount'>
    } = {},
  ) {
    this.billing = new BillingRepository(authDb.driver)
    this.wallet = new WalletService(authDb.driver, this.billing)
  }

  async listEnterprises(actor: IdentityActor): Promise<LegacyEnterpriseDto[]> {
    return Promise.all((await this.organizations.listOrganizations(actor)).map(async (item) => ({
      id: await this.requireLegacyId('enterprise', item.organization.id),
      name: item.organization.name,
      code: item.profile.code,
      credit_pool: item.wallet?.balanceUnits ?? 0,
      logo: item.profile.logo,
      app_name: item.profile.appName,
      top_name: item.profile.topName,
      about_name: item.profile.aboutName,
      app_company_name: item.profile.appCompanyName,
      login_desp: item.profile.loginDescription,
      userCount: item.userCount,
    })))
  }

  async createEnterprise(input: {
    actor: IdentityActor
    name: string
    code: string
    creditPool?: number
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
    idempotencyKey?: string
  }): Promise<LegacyEnterpriseDto> {
    const created = await this.organizations.createOrganization({
      name: input.name,
      code: input.code,
      logo: input.logo,
      appName: input.appName,
      topName: input.topName,
      aboutName: input.aboutName,
      appCompanyName: input.appCompanyName,
      loginDescription: input.loginDescription,
      initialCreditUnits: input.creditPool ?? 10_000,
    }, this.context(input.idempotencyKey), input.actor)
    return {
      id: created.legacyEnterpriseId,
      name: created.organization.name,
      code: created.profile.code,
      credit_pool: created.wallet.balanceUnits,
      logo: created.profile.logo,
      app_name: created.profile.appName,
      top_name: created.profile.topName,
      about_name: created.profile.aboutName,
      app_company_name: created.profile.appCompanyName,
      login_desp: created.profile.loginDescription,
      userCount: 0,
    }
  }

  async updateEnterprise(input: {
    actor: IdentityActor
    enterpriseId: number
    name: string
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
  }): Promise<void> {
    const orgId = await this.requireOrganizationId(input.enterpriseId)
    await this.organizations.updateOrganization(orgId, {
      name: input.name,
      logo: input.logo,
      appName: input.appName,
      topName: input.topName,
      aboutName: input.aboutName,
      appCompanyName: input.appCompanyName,
      loginDescription: input.loginDescription,
    }, input.actor)
  }

  async deleteEnterprise(actor: IdentityActor, enterpriseId: number): Promise<void> {
    await this.organizations.deleteOrganization(await this.requireOrganizationId(enterpriseId), actor)
  }

  async createInvitationCodes(input: {
    actor: IdentityActor
    enterpriseId?: number
    count: number
    initialQuotaUsd?: number | null
  }, codeFactory?: () => string): Promise<{ codes: string[]; count: number }> {
    const orgId = input.enterpriseId === undefined
      ? input.actor.orgId
      : await this.requireOrganizationId(input.enterpriseId)
    const invitations = await this.organizations.createInvitations({
      orgId,
      count: Math.min(Math.max(input.count || 1, 1), 100),
      initialCreditUnits: input.initialQuotaUsd == null
        ? sudoworkQuotaToCreditUnits(this.options.defaultInitialQuota ?? 100_000)
        : sudoworkUsdToCreditUnits(input.initialQuotaUsd),
      legacyInitialQuotaUsd: input.initialQuotaUsd ?? null,
    }, codeFactory ?? generateLegacyInvitationCode, input.actor)
    return { codes: invitations.map((item) => item.code), count: invitations.length }
  }

  async listInvitationCodes(input: {
    actor: IdentityActor
    enterpriseId?: number
    status?: 0 | 1 | 2
    page?: number
    pageSize?: number
  }): Promise<{ items: LegacyInvitationDto[]; total: number; page: number; page_size: number }> {
    const page = Math.max(1, input.page ?? 1)
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 20, 100))
    const orgId = input.enterpriseId === undefined
      ? undefined
      : await this.requireOrganizationId(input.enterpriseId)
    const result = await this.organizations.listInvitations({
      orgId,
      status: input.status === undefined ? undefined : this.fromLegacyInvitationStatus(input.status),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }, input.actor)
    return {
      items: await Promise.all(result.items.map((invitation) => this.toLegacyInvitation(invitation))),
      total: result.total,
      page,
      page_size: pageSize,
    }
  }

  async deleteInvitationCode(actor: IdentityActor, legacyId: number): Promise<boolean> {
    const resolved = await this.identities.resolveNumericAliasGlobal('invitation', legacyId)
    if (!resolved) throw new IdentityDomainError('INVITATION_NOT_FOUND', 'Invitation not found')
    return this.organizations.deleteInvitation(resolved.resourceId, actor)
  }

  async listUsers(input: {
    actor: IdentityActor
    enterpriseId?: number
    status?: 0 | 1 | 2
    role?: 'SUPER_ADMIN' | 'ENTERPRISE_ADMIN' | 'USER'
    keyword?: string
  }): Promise<LegacyManagedUserDto[]> {
    const orgId = input.enterpriseId === undefined
      ? undefined
      : await this.requireOrganizationId(input.enterpriseId)
    const users = (await this.organizations.listUsers(input.actor, {
      orgId,
      status: input.status === undefined ? undefined : this.fromLegacyUserStatus(input.status),
      role: input.role === undefined ? undefined : this.organizations.mapLegacyRole(input.role),
      keyword: input.keyword,
    })).map((user) => this.toLegacyUser(user))
    return Promise.all(users)
  }

  async createPasswordUser(input: {
    actor: IdentityActor
    phone: string
    nickname?: string | null
    password?: string
    enterpriseId: number
    invitationCodeId: number
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> {
    const orgId = await this.requireOrganizationId(input.enterpriseId)
    const invitationAlias = await this.identities.resolveNumericAliasGlobal('invitation', input.invitationCodeId)
    const invitation = invitationAlias
      ? await this.identities.getInvitationById(invitationAlias.resourceId)
      : null
    const createKey = input.idempotencyKey?.trim()
      || `admin-user:${orgId}:${input.phone.trim()}:${input.invitationCodeId}`
    const retryUser = await this.retryableProvisioningUser(createKey, orgId, input.phone, invitation)
    if (await this.identities.findAuthIdentity('phone', 'sudowork', input.phone) && !retryUser) {
      throw new IdentityDomainError('USERNAME_EXISTS', 'Username already exists')
    }
    if (!invitation || (invitation.status !== 'pending' && !retryUser)) {
      throw new IdentityDomainError('INVITATION_NOT_AVAILABLE', 'Invitation is not available')
    }
    if (invitation.orgId !== orgId) {
      throw new IdentityDomainError('INVITATION_ORGANIZATION_MISMATCH', 'Invitation organization mismatch')
    }
    return this.createProvisionedUser({
      actor: input.actor,
      orgId,
      username: input.phone,
      displayName: input.nickname,
      password: input.password ?? 'Temp@Sudo123',
      phone: input.phone,
      invitationCode: invitation.code,
      idempotencyKey: createKey,
    })
  }

  async createPhoneUser(input: {
    actor: IdentityActor
    phone: string
    nickname?: string | null
    enterpriseId: number
    invitationCodeId: number
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> {
    const orgId = await this.requireOrganizationId(input.enterpriseId)
    const invitationAlias = await this.identities.resolveNumericAliasGlobal('invitation', input.invitationCodeId)
    const invitation = invitationAlias
      ? await this.identities.getInvitationById(invitationAlias.resourceId)
      : null
    const createKey = input.idempotencyKey?.trim()
      || `admin-user:${orgId}:${input.phone.trim()}:${input.invitationCodeId}`
    const retryUser = await this.retryableProvisioningUser(createKey, orgId, input.phone, invitation)
    if (await this.identities.findAuthIdentity('phone', 'sudowork', input.phone) && !retryUser) {
      throw new IdentityDomainError('PHONE_EXISTS', 'Phone already exists')
    }
    if (!invitation || (invitation.status !== 'pending' && !retryUser)) {
      throw new IdentityDomainError('INVITATION_NOT_AVAILABLE', 'Invitation is not available')
    }
    if (invitation.orgId !== orgId) {
      throw new IdentityDomainError('INVITATION_ORGANIZATION_MISMATCH', 'Invitation organization mismatch')
    }
    return this.createProvisionedUser({
      actor: input.actor,
      orgId,
      username: input.phone,
      displayName: input.nickname,
      invitationCode: invitation.code,
      authIdentity: { provider: 'phone', issuer: 'sudowork', subject: input.phone },
      idempotencyKey: createKey,
    })
  }

  private async retryableProvisioningUser(
    idempotencyKey: string,
    orgId: string,
    username: string,
    invitation: InvitationRecord | null,
  ): Promise<AuthCenterUser | null> {
    const previous = await this.identities.getCommandResult<{ userId: string }>('identity.create_user', idempotencyKey)
    if (!previous) return null
    const user = await this.authDb.getUserById(previous.userId)
    if (!user || user.status !== 'pending' || user.orgId !== orgId || user.name !== username.trim()) return null
    if (!invitation || invitation.usedByUserId !== user.id) return null
    return user
  }

  private async createProvisionedUser(input: {
    actor: IdentityActor
    orgId: string
    username: string
    displayName?: string | null
    password?: string
    phone?: string
    invitationCode: string
    authIdentity?: { provider: string; issuer: string; subject: string }
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> {
    const createKey = input.idempotencyKey?.trim() || `admin-user:${randomUUID()}`
    const created = await this.organizations.createUser({
      orgId: input.orgId, username: input.username, displayName: input.displayName,
      password: input.password, phone: input.phone, invitationCode: input.invitationCode,
      authIdentity: input.authIdentity,
      status: this.options.accountProvisioner ? 'pending' : 'active',
    }, this.context(createKey), input.actor)
    const wallet = await this.identities.getWallet('user', created.userId)
    let externalUserId: number | null = null
    if (this.options.accountProvisioner) {
      try {
        const account = await this.options.accountProvisioner.ensureAccount({
          ownerId: created.userId, orgId: input.orgId, username: input.username,
          displayName: input.displayName?.trim() || input.username,
          initialQuotaUnits: pointsToQuota(wallet?.balanceUnits ?? 0),
        }, onlineCommandContext(`sudorouter:${createKey}`))
        externalUserId = Number(account.externalUserId)
        await this.organizations.updateUser(created.userId, { status: 'active' }, input.actor)
      } catch {
        throw new SudoworkAdministrationError(500, 'Sudorouter 用户初始化失败，请稍后重试')
      }
    }
    return {
      id: created.legacyUserId, phone: input.username,
      sudorouter_user_id: externalUserId,
      initial_points: wallet?.balanceUnits ?? 0,
    }
  }

  async updateUser(input: {
    actor: IdentityActor
    userId: number
    nickname?: string | null
    status?: 0 | 1 | 2
    enterpriseId?: number
  }): Promise<void> {
    const resolved = await this.requireUser(input.userId)
    await this.organizations.updateUser(resolved.resourceId, {
      displayName: input.nickname,
      status: input.status === undefined ? undefined : this.fromLegacyUserStatus(input.status),
      orgId: input.enterpriseId === undefined ? undefined : await this.requireOrganizationId(input.enterpriseId),
    }, input.actor)
  }

  async setUserRole(input: {
    actor: IdentityActor
    userId: number
    role: 'ENTERPRISE_ADMIN' | 'USER'
  }): Promise<void> {
    const resolved = await this.requireUser(input.userId)
    await this.organizations.updateUser(resolved.resourceId, {
      role: this.organizations.mapLegacyRole(input.role) as 'admin' | 'user',
    }, input.actor)
  }

  async manageUser(input: { actor: IdentityActor; userId: number; action: 'enable' | 'disable' }): Promise<1 | 2> {
    const resolved = await this.requireUser(input.userId)
    const status = input.action === 'enable' ? 'active' : 'disabled'
    await this.organizations.updateUser(resolved.resourceId, { status }, input.actor)
    return input.action === 'enable' ? 1 : 2
  }

  async deleteUser(actor: IdentityActor, legacyId: number): Promise<void> {
    const resolved = await this.requireUser(legacyId)
    await this.organizations.deleteUser(resolved.resourceId, actor)
  }

  async listMembers(actor: IdentityActor): Promise<LegacyManagedUserDto[]> {
    return (await this.listUsers({ actor })).sort((left, right) => (
      left.status - right.status || left.created_at - right.created_at || left.id - right.id
    ))
  }

  async approveUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<void> {
    const key = `sudowork-admin:approve:${input.idempotencyKey?.trim() || randomUUID()}`
    if (await this.identities.hasOperationAudit(key)) return
    const target = await this.requireManagedUser(input.actor, input.legacyUserId)
    if (target.status !== 'pending') throw new SudoworkAdministrationError(400, '用户不是待审批状态')
    await this.authDb.driver.transaction(async () => {
      const current = (await this.identities.getWallet('user', target.id))?.balanceUnits
      if (current === undefined) throw new SudoworkAdministrationError(404, '用户不存在')
      const adjustment = 100 - current
      if (adjustment !== 0) {
        await this.wallet.post({
          ownerType: 'user', ownerId: target.id, deltaUnits: adjustment,
          entryType: adjustment > 0 ? 'BONUS' : 'APPROVAL_ADJUSTMENT',
          memo: '审批通过赠送', sourceType: 'user_approval', sourceId: String(input.legacyUserId),
          actorUserId: input.actor.userId, orgId: target.orgId,
        }, onlineCommandContext(key))
      }
      await this.organizations.updateUser(target.id, { status: 'active' }, input.actor)
      await this.writeUserAudit({
        key, actor: input.actor, target, legacyUserId: input.legacyUserId,
        action: 'USER_APPROVE', path: '/api/v1/admin/approve', response: { status: 1, balance: 100 },
      })
    })
  }

  async rejectUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<void> {
    const key = `sudowork-admin:reject:${input.idempotencyKey?.trim() || randomUUID()}`
    if (await this.identities.hasOperationAudit(key)) return
    const target = await this.requireManagedUser(input.actor, input.legacyUserId)
    if (target.status !== 'pending') throw new SudoworkAdministrationError(400, '用户不是待审批状态')
    await this.authDb.driver.transaction(async () => {
      await this.organizations.updateUser(target.id, { status: 'disabled' }, input.actor)
      await this.writeUserAudit({
        key, actor: input.actor, target, legacyUserId: input.legacyUserId,
        action: 'USER_REJECT', path: '/api/v1/admin/reject', response: { status: 2 },
      })
    })
  }

  async deletePendingUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<void> {
    const key = `sudowork-admin:delete:${input.idempotencyKey?.trim() || randomUUID()}`
    if (await this.identities.hasOperationAudit(key)) return
    const target = await this.requireManagedUser(input.actor, input.legacyUserId)
    if (target.status !== 'pending') throw new SudoworkAdministrationError(400, '只能删除待审批用户')
    if (await this.billing.countOwnerLedgerEntries('user', target.id) > 0) {
      throw new SudoworkAdministrationError(409, '用户已有账本记录，不能删除')
    }
    await this.authDb.driver.transaction(async () => {
      await this.writeUserAudit({
        key, actor: input.actor, target, legacyUserId: input.legacyUserId,
        action: 'USER_DELETE', path: '/api/v1/admin/delete', response: { deleted: true },
      })
      await this.identities.deleteUserRecords(target.id)
      await this.authDb.deleteUser(target.id)
    })
  }

  getFeatureFlags(actor: IdentityActor): { dify: { enabled: boolean; missingEnv: string[] } } {
    this.assertAdmin(actor)
    return { dify: this.options.getDifyFeatureFlags?.() ?? { enabled: false, missingEnv: [] } }
  }

  async listOperationLogs(input: {
    actor: IdentityActor
    query: Record<string, string | undefined>
  }): Promise<{ items: Array<Record<string, unknown>>; total: number; page: number; page_size: number }> {
    this.assertAdmin(input.actor)
    const page = positiveInteger(input.query.page, 1)
    const pageSize = Math.min(positiveInteger(input.query.page_size, 20), 100)
    let actorUserId: string | undefined
    if (input.query.user_id) {
      const legacyId = Number.parseInt(input.query.user_id, 10)
      const alias = Number.isFinite(legacyId)
        ? await this.identities.resolveNumericAliasGlobal('user', legacyId)
        : null
      if (!alias || (!hasGlobalOrganizationAccess(input.actor) && alias.orgId !== input.actor.orgId)) {
        return { items: [], total: 0, page, page_size: pageSize }
      }
      actorUserId = alias.resourceId
    }
    const result = await this.identities.listOperationAudits({
      orgId: hasGlobalOrganizationAccess(input.actor) ? undefined : input.actor.orgId,
      actorUserId,
      action: input.query.action,
      from: unixSeconds(input.query.date_from),
      to: unixSeconds(input.query.date_to),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return {
      items: result.items.map(toLegacyOperationLog),
      total: result.total,
      page,
      page_size: pageSize,
    }
  }

  async getAdminStats(actor: IdentityActor): Promise<Record<string, unknown>> {
    this.assertAdmin(actor)
    const organizations = await this.organizations.listOrganizations(actor)
    const users = (await Promise.all(organizations.map(item => this.authDb.listUsersByOrg(item.organization.id)))).flat()
    const wallets = await Promise.all(users.map(user => this.identities.getWallet('user', user.id)))
    const points = wallets.reduce((total, wallet) => total + (wallet?.balanceUnits ?? 0), 0)
    let bonus = 0
    let consumed = 0
    for (const organization of organizations) {
      bonus += (await this.billing.listLedgerEntries({
        orgId: organization.organization.id, entryType: 'BONUS', limit: 100_000, offset: 0,
      })).list.reduce((total, entry) => total + entry.deltaUnits, 0)
      consumed += (await this.billing.listLedgerEntries({
        orgId: organization.organization.id, entryType: 'CONSUME', limit: 100_000, offset: 0,
      })).list.reduce((total, entry) => total + Math.abs(entry.deltaUnits), 0)
    }
    return {
      enterprises: organizations.length,
      users: users.length,
      approved: users.filter(user => user.status === 'active').length,
      pending: users.filter(user => user.status === 'pending').length,
      points: { total: roundPoints(points), bonus: roundPoints(bonus), consumed: roundPoints(consumed) },
    }
  }

  async resetUserPassword(input: { actor: IdentityActor; userId: number; password: string }): Promise<void> {
    await this.organizations.resetUserPassword((await this.requireUser(input.userId)).resourceId, input.password, input.actor)
  }

  async updatePasswordUser(input: {
    actor: IdentityActor
    userId: number
    nickname?: string | null
    status?: 0 | 1 | 2
    enterpriseId?: number
    password?: string
  }): Promise<void> {
    const resolved = await this.requireUser(input.userId)
    if (!(await this.identities.findAuthIdentityByUser(resolved.resourceId, 'password', 'moss'))) {
      throw new IdentityDomainError('LOGIN_TYPE_MISMATCH', 'User is not a password account')
    }
    await this.organizations.updateUser(resolved.resourceId, {
      displayName: input.nickname,
      status: input.status === undefined ? undefined : this.fromLegacyUserStatus(input.status),
      orgId: input.enterpriseId === undefined ? undefined : await this.requireOrganizationId(input.enterpriseId),
      password: input.password,
    }, input.actor)
  }

  private async toLegacyInvitation(invitation: InvitationRecord): Promise<LegacyInvitationDto> {
    const organization = (await this.organizations.listOrganizations())
      .find((item) => item.organization.id === invitation.orgId)
    if (!organization) throw new Error('Invitation organization is missing')
    return {
      id: await this.requireLegacyId('invitation', invitation.id),
      code: invitation.code,
      enterprise_id: await this.requireLegacyId('enterprise', invitation.orgId),
      enterprise_name: organization.organization.name,
      initial_quota_usd: invitation.legacyInitialQuotaUsd,
      status: invitation.status === 'pending' ? 0 : invitation.status === 'used' ? 1 : 2,
      used_by_user_id: invitation.usedByUserId
        ? await this.identities.getNumericAlias('user', invitation.usedByUserId)
        : null,
      used_by_phone: null,
      used_by_nickname: null,
      created_at: invitation.createdAt,
      used_at: invitation.usedAt,
    }
  }

  private async requireOrganizationId(legacyId: number): Promise<string> {
    const resolved = await this.identities.resolveNumericAliasGlobal('enterprise', legacyId)
    if (!resolved) throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
    return resolved.resourceId
  }

  private async requireUser(legacyId: number): Promise<{ resourceId: string; orgId: string }> {
    const resolved = await this.identities.resolveNumericAliasGlobal('user', legacyId)
    if (!resolved) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    return resolved
  }

  private async requireManagedUser(actor: IdentityActor, legacyId: number): Promise<AuthCenterUser> {
    this.assertAdmin(actor)
    const resolved = await this.requireUser(legacyId)
    if (!hasGlobalOrganizationAccess(actor) && resolved.orgId !== actor.orgId) {
      throw new SudoworkAdministrationError(403, '无权操作该用户')
    }
    const user = await this.authDb.getUserById(resolved.resourceId)
    if (!user) throw new SudoworkAdministrationError(404, '用户不存在')
    if (user.role === 'super_admin') throw new SudoworkAdministrationError(403, '不能删除超级管理员')
    return user
  }

  private assertAdmin(actor: IdentityActor): void {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') {
      throw new SudoworkAdministrationError(403, '权限不足')
    }
  }

  private async writeUserAudit(input: {
    key: string
    actor: IdentityActor
    target: AuthCenterUser
    legacyUserId: number
    action: string
    path: string
    response: Record<string, unknown>
  }): Promise<void> {
    const actorUser = await this.authDb.driver.get<{ name?: string }>(
      'SELECT name FROM users WHERE id = ? LIMIT 1',
      [input.actor.userId],
    )
    await this.identities.insertOperationAudit({
      id: randomUUID(),
      orgId: input.target.orgId,
      actorUserId: input.actor.userId,
      actorLegacyId: await this.identities.getNumericAlias('user', input.actor.userId),
      actorName: actorUser?.name ?? input.actor.userId,
      action: input.action,
      resource: 'user',
      resourceId: String(input.legacyUserId),
      method: 'POST',
      path: input.path,
      requestData: { userId: input.legacyUserId },
      responseData: input.response,
      responseStatus: 200,
      idempotencyKey: input.key,
    })
  }

  private async requireAvailableInvitation(legacyId: number, orgId: string): Promise<InvitationRecord> {
    const resolved = await this.identities.resolveNumericAliasGlobal('invitation', legacyId)
    const invitation = resolved ? await this.identities.getInvitationById(resolved.resourceId) : null
    if (!invitation || invitation.status !== 'pending') {
      throw new IdentityDomainError('INVITATION_NOT_AVAILABLE', 'Invitation is not available')
    }
    if (invitation.orgId !== orgId) {
      throw new IdentityDomainError('INVITATION_ORGANIZATION_MISMATCH', 'Invitation organization mismatch')
    }
    return invitation
  }

  private async requireLegacyId(namespace: string, resourceId: string): Promise<number> {
    const id = await this.identities.getNumericAlias(namespace, resourceId)
    if (id === null) throw new Error(`Missing ${namespace} numeric alias`)
    return id
  }

  private fromLegacyInvitationStatus(status: 0 | 1 | 2): InvitationRecord['status'] {
    if (status === 0) return 'pending'
    if (status === 1) return 'used'
    return 'revoked'
  }

  private fromLegacyUserStatus(status: 0 | 1 | 2): AuthCenterUser['status'] {
    if (status === 0) return 'pending'
    if (status === 1) return 'active'
    return 'disabled'
  }

  private async toLegacyUser(user: AuthCenterUser): Promise<LegacyManagedUserDto> {
    const profile = await this.identities.getOrganizationProfile(user.orgId)
    const organization = await this.authDb.driver.get<{ name?: string }>(
      'SELECT name FROM organizations WHERE id = ? LIMIT 1',
      [user.orgId],
    )
    const phoneIdentity = await this.identities.findAuthIdentityByUser(user.id, 'phone', 'sudowork')
    const invitation = await this.identities.getInvitationByUser(user.id)
    const wallet = await this.identities.getWallet('user', user.id)
    if (!profile || !organization) throw new Error('User organization profile is missing')
    return {
      id: await this.requireLegacyId('user', user.id),
      phone: phoneIdentity?.normalizedSubject ?? user.name,
      nickname: user.displayName,
      enterprise_id: await this.requireLegacyId('enterprise', user.orgId),
      enterprise_name: organization.name ?? profile.appName ?? user.orgId,
      role: user.role === 'super_admin' ? 'SUPER_ADMIN' : user.role === 'admin' ? 'ENTERPRISE_ADMIN' : 'USER',
      status: user.status === 'pending' ? 0 : user.status === 'active' ? 1 : 2,
      invitation_code: invitation?.code ?? null,
      quota: wallet?.balanceUnits ?? 0,
      used_quota: 0,
      balance: wallet?.balanceUnits ?? 0,
      login_type: await this.identities.findAuthIdentityByUser(user.id, 'password', 'moss') ? 1 : 0,
      created_at: user.createdAt,
    }
  }

  private context(idempotencyKey?: string): CommandContext {
    return onlineCommandContext(idempotencyKey ?? `sudowork-admin:${randomUUID()}`)
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function unixSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed * 1000 : undefined
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100
}

function toLegacyOperationLog(record: OperationAuditRecord): Record<string, unknown> {
  return {
    id: record.legacyId,
    user_id: record.actorLegacyId,
    user_phone: record.actorName,
    action: record.action,
    resource: record.resource,
    resource_id: record.resourceId == null ? null : numericWhenPossible(record.resourceId),
    method: record.method,
    path: record.path,
    params: record.legacyParamsRaw,
    request_data: record.legacyRequestDataRaw
      ?? (record.requestData == null ? null : JSON.stringify(record.requestData)),
    response_data: record.legacyResponseDataRaw
      ?? (record.responseData == null ? null : JSON.stringify(record.responseData)),
    response_status: record.responseStatus,
    ip_address: record.ipAddress,
    user_agent: record.userAgent,
    duration_ms: record.durationMs,
    error_message: record.errorMessage,
    created_at: new Date(record.createdAt).toISOString(),
  }
}

function numericWhenPossible(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value
}
