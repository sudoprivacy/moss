import { randomInt, randomUUID } from 'node:crypto'
import type { CommandContext } from '../../../application/commandContext.js'
import { onlineCommandContext } from '../../../application/commandContext.js'
import { IdentityRepository, type InvitationRecord, type OperationAuditRecord } from '../../../identity/identityRepository.js'
import type { AuthCenterDb, AuthCenterUser } from '../../../authCenter/db.js'
import { BillingRepository } from '../../../billing/billingRepository.js'
import { WalletService } from '../../../billing/walletService.js'
import { runInTransaction } from '../../../storage/sqliteUnitOfWork.js'
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
    this.billing = new BillingRepository(authDb.db)
    this.wallet = new WalletService(authDb.db, this.billing)
  }

  listEnterprises(actor: IdentityActor): LegacyEnterpriseDto[] {
    return this.organizations.listOrganizations(actor).map((item) => ({
      id: this.requireLegacyId('enterprise', item.organization.id),
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
    }))
  }

  createEnterprise(input: {
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
  }): LegacyEnterpriseDto {
    const created = this.organizations.createOrganization({
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

  updateEnterprise(input: {
    actor: IdentityActor
    enterpriseId: number
    name: string
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
  }): void {
    const orgId = this.requireOrganizationId(input.enterpriseId)
    this.organizations.updateOrganization(orgId, {
      name: input.name,
      logo: input.logo,
      appName: input.appName,
      topName: input.topName,
      aboutName: input.aboutName,
      appCompanyName: input.appCompanyName,
      loginDescription: input.loginDescription,
    }, input.actor)
  }

  deleteEnterprise(actor: IdentityActor, enterpriseId: number): void {
    this.organizations.deleteOrganization(this.requireOrganizationId(enterpriseId), actor)
  }

  createInvitationCodes(input: {
    actor: IdentityActor
    enterpriseId?: number
    count: number
    initialQuotaUsd?: number | null
  }, codeFactory?: () => string): { codes: string[]; count: number } {
    const orgId = input.enterpriseId === undefined
      ? input.actor.orgId
      : this.requireOrganizationId(input.enterpriseId)
    const invitations = this.organizations.createInvitations({
      orgId,
      count: Math.min(Math.max(input.count || 1, 1), 100),
      initialCreditUnits: input.initialQuotaUsd == null
        ? sudoworkQuotaToCreditUnits(this.options.defaultInitialQuota ?? 100_000)
        : sudoworkUsdToCreditUnits(input.initialQuotaUsd),
      legacyInitialQuotaUsd: input.initialQuotaUsd ?? null,
    }, codeFactory ?? generateLegacyInvitationCode, input.actor)
    return { codes: invitations.map((item) => item.code), count: invitations.length }
  }

  listInvitationCodes(input: {
    actor: IdentityActor
    enterpriseId?: number
    status?: 0 | 1 | 2
    page?: number
    pageSize?: number
  }): { items: LegacyInvitationDto[]; total: number; page: number; page_size: number } {
    const page = Math.max(1, input.page ?? 1)
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 20, 100))
    const orgId = input.enterpriseId === undefined
      ? undefined
      : this.requireOrganizationId(input.enterpriseId)
    const result = this.organizations.listInvitations({
      orgId,
      status: input.status === undefined ? undefined : this.fromLegacyInvitationStatus(input.status),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }, input.actor)
    return {
      items: result.items.map((invitation) => this.toLegacyInvitation(invitation)),
      total: result.total,
      page,
      page_size: pageSize,
    }
  }

  deleteInvitationCode(actor: IdentityActor, legacyId: number): boolean {
    const resolved = this.identities.resolveNumericAliasGlobal('invitation', legacyId)
    if (!resolved) throw new IdentityDomainError('INVITATION_NOT_FOUND', 'Invitation not found')
    return this.organizations.deleteInvitation(resolved.resourceId, actor)
  }

  listUsers(input: {
    actor: IdentityActor
    enterpriseId?: number
    status?: 0 | 1 | 2
    role?: 'SUPER_ADMIN' | 'ENTERPRISE_ADMIN' | 'USER'
    keyword?: string
  }): LegacyManagedUserDto[] {
    const orgId = input.enterpriseId === undefined
      ? undefined
      : this.requireOrganizationId(input.enterpriseId)
    return this.organizations.listUsers(input.actor, {
      orgId,
      status: input.status === undefined ? undefined : this.fromLegacyUserStatus(input.status),
      role: input.role === undefined ? undefined : this.organizations.mapLegacyRole(input.role),
      keyword: input.keyword,
    }).map((user) => this.toLegacyUser(user))
  }

  createPasswordUser(input: {
    actor: IdentityActor
    phone: string
    nickname?: string | null
    password?: string
    enterpriseId: number
    invitationCodeId: number
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> {
    const orgId = this.requireOrganizationId(input.enterpriseId)
    const invitationAlias = this.identities.resolveNumericAliasGlobal('invitation', input.invitationCodeId)
    const invitation = invitationAlias
      ? this.identities.getInvitationById(invitationAlias.resourceId)
      : null
    const createKey = input.idempotencyKey?.trim()
      || `admin-user:${orgId}:${input.phone.trim()}:${input.invitationCodeId}`
    const retryUser = this.retryableProvisioningUser(createKey, orgId, input.phone, invitation)
    if (this.identities.findAuthIdentity('phone', 'sudowork', input.phone) && !retryUser) {
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

  createPhoneUser(input: {
    actor: IdentityActor
    phone: string
    nickname?: string | null
    enterpriseId: number
    invitationCodeId: number
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> {
    const orgId = this.requireOrganizationId(input.enterpriseId)
    const invitationAlias = this.identities.resolveNumericAliasGlobal('invitation', input.invitationCodeId)
    const invitation = invitationAlias
      ? this.identities.getInvitationById(invitationAlias.resourceId)
      : null
    const createKey = input.idempotencyKey?.trim()
      || `admin-user:${orgId}:${input.phone.trim()}:${input.invitationCodeId}`
    const retryUser = this.retryableProvisioningUser(createKey, orgId, input.phone, invitation)
    if (this.identities.findAuthIdentity('phone', 'sudowork', input.phone) && !retryUser) {
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

  private retryableProvisioningUser(
    idempotencyKey: string,
    orgId: string,
    username: string,
    invitation: InvitationRecord | null,
  ): AuthCenterUser | null {
    const previous = this.identities.getCommandResult<{ userId: string }>('identity.create_user', idempotencyKey)
    if (!previous) return null
    const user = this.authDb.getUserById(previous.userId)
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
    const created = this.organizations.createUser({
      orgId: input.orgId, username: input.username, displayName: input.displayName,
      password: input.password, phone: input.phone, invitationCode: input.invitationCode,
      authIdentity: input.authIdentity,
      status: this.options.accountProvisioner ? 'pending' : 'active',
    }, this.context(createKey), input.actor)
    const wallet = this.identities.getWallet('user', created.userId)
    let externalUserId: number | null = null
    if (this.options.accountProvisioner) {
      try {
        const account = await this.options.accountProvisioner.ensureAccount({
          ownerId: created.userId, orgId: input.orgId, username: input.username,
          displayName: input.displayName?.trim() || input.username,
          initialQuotaUnits: pointsToQuota(wallet?.balanceUnits ?? 0),
        }, onlineCommandContext(`sudorouter:${createKey}`))
        externalUserId = Number(account.externalUserId)
        this.organizations.updateUser(created.userId, { status: 'active' }, input.actor)
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

  updateUser(input: {
    actor: IdentityActor
    userId: number
    nickname?: string | null
    status?: 0 | 1 | 2
    enterpriseId?: number
  }): void {
    const resolved = this.requireUser(input.userId)
    this.organizations.updateUser(resolved.resourceId, {
      displayName: input.nickname,
      status: input.status === undefined ? undefined : this.fromLegacyUserStatus(input.status),
      orgId: input.enterpriseId === undefined ? undefined : this.requireOrganizationId(input.enterpriseId),
    }, input.actor)
  }

  setUserRole(input: {
    actor: IdentityActor
    userId: number
    role: 'ENTERPRISE_ADMIN' | 'USER'
  }): void {
    const resolved = this.requireUser(input.userId)
    this.organizations.updateUser(resolved.resourceId, {
      role: this.organizations.mapLegacyRole(input.role) as 'admin' | 'user',
    }, input.actor)
  }

  manageUser(input: { actor: IdentityActor; userId: number; action: 'enable' | 'disable' }): 1 | 2 {
    const resolved = this.requireUser(input.userId)
    const status = input.action === 'enable' ? 'active' : 'disabled'
    this.organizations.updateUser(resolved.resourceId, { status }, input.actor)
    return input.action === 'enable' ? 1 : 2
  }

  deleteUser(actor: IdentityActor, legacyId: number): void {
    const resolved = this.requireUser(legacyId)
    this.organizations.deleteUser(resolved.resourceId, actor)
  }

  listMembers(actor: IdentityActor): LegacyManagedUserDto[] {
    return this.listUsers({ actor }).sort((left, right) => (
      left.status - right.status || left.created_at - right.created_at || left.id - right.id
    ))
  }

  approveUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): void {
    const key = `sudowork-admin:approve:${input.idempotencyKey?.trim() || randomUUID()}`
    if (this.identities.hasOperationAudit(key)) return
    const target = this.requireManagedUser(input.actor, input.legacyUserId)
    if (target.status !== 'pending') throw new SudoworkAdministrationError(400, '用户不是待审批状态')
    runInTransaction(this.authDb.db, () => {
      const current = this.identities.getWallet('user', target.id)?.balanceUnits
      if (current === undefined) throw new SudoworkAdministrationError(404, '用户不存在')
      const adjustment = 100 - current
      if (adjustment !== 0) {
        this.wallet.post({
          ownerType: 'user', ownerId: target.id, deltaUnits: adjustment,
          entryType: adjustment > 0 ? 'BONUS' : 'APPROVAL_ADJUSTMENT',
          memo: '审批通过赠送', sourceType: 'user_approval', sourceId: String(input.legacyUserId),
          actorUserId: input.actor.userId, orgId: target.orgId,
        }, onlineCommandContext(key))
      }
      this.organizations.updateUser(target.id, { status: 'active' }, input.actor)
      this.writeUserAudit({
        key, actor: input.actor, target, legacyUserId: input.legacyUserId,
        action: 'USER_APPROVE', path: '/api/v1/admin/approve', response: { status: 1, balance: 100 },
      })
    })
  }

  rejectUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): void {
    const key = `sudowork-admin:reject:${input.idempotencyKey?.trim() || randomUUID()}`
    if (this.identities.hasOperationAudit(key)) return
    const target = this.requireManagedUser(input.actor, input.legacyUserId)
    if (target.status !== 'pending') throw new SudoworkAdministrationError(400, '用户不是待审批状态')
    runInTransaction(this.authDb.db, () => {
      this.organizations.updateUser(target.id, { status: 'disabled' }, input.actor)
      this.writeUserAudit({
        key, actor: input.actor, target, legacyUserId: input.legacyUserId,
        action: 'USER_REJECT', path: '/api/v1/admin/reject', response: { status: 2 },
      })
    })
  }

  deletePendingUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): void {
    const key = `sudowork-admin:delete:${input.idempotencyKey?.trim() || randomUUID()}`
    if (this.identities.hasOperationAudit(key)) return
    const target = this.requireManagedUser(input.actor, input.legacyUserId)
    if (target.status !== 'pending') throw new SudoworkAdministrationError(400, '只能删除待审批用户')
    if (this.billing.countOwnerLedgerEntries('user', target.id) > 0) {
      throw new SudoworkAdministrationError(409, '用户已有账本记录，不能删除')
    }
    runInTransaction(this.authDb.db, () => {
      this.writeUserAudit({
        key, actor: input.actor, target, legacyUserId: input.legacyUserId,
        action: 'USER_DELETE', path: '/api/v1/admin/delete', response: { deleted: true },
      })
      this.identities.deleteUserRecords(target.id)
      this.authDb.deleteUser(target.id)
    })
  }

  getFeatureFlags(actor: IdentityActor): { dify: { enabled: boolean; missingEnv: string[] } } {
    this.assertAdmin(actor)
    return { dify: this.options.getDifyFeatureFlags?.() ?? { enabled: false, missingEnv: [] } }
  }

  listOperationLogs(input: {
    actor: IdentityActor
    query: Record<string, string | undefined>
  }): { items: Array<Record<string, unknown>>; total: number; page: number; page_size: number } {
    this.assertAdmin(input.actor)
    const page = positiveInteger(input.query.page, 1)
    const pageSize = Math.min(positiveInteger(input.query.page_size, 20), 100)
    let actorUserId: string | undefined
    if (input.query.user_id) {
      const legacyId = Number.parseInt(input.query.user_id, 10)
      const alias = Number.isFinite(legacyId)
        ? this.identities.resolveNumericAliasGlobal('user', legacyId)
        : null
      if (!alias || (!hasGlobalOrganizationAccess(input.actor) && alias.orgId !== input.actor.orgId)) {
        return { items: [], total: 0, page, page_size: pageSize }
      }
      actorUserId = alias.resourceId
    }
    const result = this.identities.listOperationAudits({
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

  getAdminStats(actor: IdentityActor): Record<string, unknown> {
    this.assertAdmin(actor)
    const organizations = this.organizations.listOrganizations(actor)
    const users = organizations.flatMap(item => this.authDb.listUsersByOrg(item.organization.id))
    const points = users.reduce((total, user) => total + (this.identities.getWallet('user', user.id)?.balanceUnits ?? 0), 0)
    let bonus = 0
    let consumed = 0
    for (const organization of organizations) {
      bonus += this.billing.listLedgerEntries({
        orgId: organization.organization.id, entryType: 'BONUS', limit: 100_000, offset: 0,
      }).list.reduce((total, entry) => total + entry.deltaUnits, 0)
      consumed += this.billing.listLedgerEntries({
        orgId: organization.organization.id, entryType: 'CONSUME', limit: 100_000, offset: 0,
      }).list.reduce((total, entry) => total + Math.abs(entry.deltaUnits), 0)
    }
    return {
      enterprises: organizations.length,
      users: users.length,
      approved: users.filter(user => user.status === 'active').length,
      pending: users.filter(user => user.status === 'pending').length,
      points: { total: roundPoints(points), bonus: roundPoints(bonus), consumed: roundPoints(consumed) },
    }
  }

  resetUserPassword(input: { actor: IdentityActor; userId: number; password: string }): void {
    this.organizations.resetUserPassword(this.requireUser(input.userId).resourceId, input.password, input.actor)
  }

  updatePasswordUser(input: {
    actor: IdentityActor
    userId: number
    nickname?: string | null
    status?: 0 | 1 | 2
    enterpriseId?: number
    password?: string
  }): void {
    const resolved = this.requireUser(input.userId)
    if (!this.identities.findAuthIdentityByUser(resolved.resourceId, 'password', 'moss')) {
      throw new IdentityDomainError('LOGIN_TYPE_MISMATCH', 'User is not a password account')
    }
    this.organizations.updateUser(resolved.resourceId, {
      displayName: input.nickname,
      status: input.status === undefined ? undefined : this.fromLegacyUserStatus(input.status),
      orgId: input.enterpriseId === undefined ? undefined : this.requireOrganizationId(input.enterpriseId),
      password: input.password,
    }, input.actor)
  }

  private toLegacyInvitation(invitation: InvitationRecord): LegacyInvitationDto {
    const organization = this.organizations.listOrganizations()
      .find((item) => item.organization.id === invitation.orgId)
    if (!organization) throw new Error('Invitation organization is missing')
    return {
      id: this.requireLegacyId('invitation', invitation.id),
      code: invitation.code,
      enterprise_id: this.requireLegacyId('enterprise', invitation.orgId),
      enterprise_name: organization.organization.name,
      initial_quota_usd: invitation.legacyInitialQuotaUsd,
      status: invitation.status === 'pending' ? 0 : invitation.status === 'used' ? 1 : 2,
      used_by_user_id: invitation.usedByUserId
        ? this.identities.getNumericAlias('user', invitation.usedByUserId)
        : null,
      used_by_phone: null,
      used_by_nickname: null,
      created_at: invitation.createdAt,
      used_at: invitation.usedAt,
    }
  }

  private requireOrganizationId(legacyId: number): string {
    const resolved = this.identities.resolveNumericAliasGlobal('enterprise', legacyId)
    if (!resolved) throw new IdentityDomainError('ORGANIZATION_NOT_FOUND', 'Organization not found')
    return resolved.resourceId
  }

  private requireUser(legacyId: number): { resourceId: string; orgId: string } {
    const resolved = this.identities.resolveNumericAliasGlobal('user', legacyId)
    if (!resolved) throw new IdentityDomainError('USER_NOT_FOUND', 'User not found')
    return resolved
  }

  private requireManagedUser(actor: IdentityActor, legacyId: number): AuthCenterUser {
    this.assertAdmin(actor)
    const resolved = this.requireUser(legacyId)
    if (!hasGlobalOrganizationAccess(actor) && resolved.orgId !== actor.orgId) {
      throw new SudoworkAdministrationError(403, '无权操作该用户')
    }
    const user = this.authDb.getUserById(resolved.resourceId)
    if (!user) throw new SudoworkAdministrationError(404, '用户不存在')
    if (user.role === 'super_admin') throw new SudoworkAdministrationError(403, '不能删除超级管理员')
    return user
  }

  private assertAdmin(actor: IdentityActor): void {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') {
      throw new SudoworkAdministrationError(403, '权限不足')
    }
  }

  private writeUserAudit(input: {
    key: string
    actor: IdentityActor
    target: AuthCenterUser
    legacyUserId: number
    action: string
    path: string
    response: Record<string, unknown>
  }): void {
    const actorUser = this.authDb.getUserById(input.actor.userId)
    this.identities.insertOperationAudit({
      id: randomUUID(),
      orgId: input.target.orgId,
      actorUserId: input.actor.userId,
      actorLegacyId: this.identities.getNumericAlias('user', input.actor.userId),
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

  private requireAvailableInvitation(legacyId: number, orgId: string): InvitationRecord {
    const resolved = this.identities.resolveNumericAliasGlobal('invitation', legacyId)
    const invitation = resolved ? this.identities.getInvitationById(resolved.resourceId) : null
    if (!invitation || invitation.status !== 'pending') {
      throw new IdentityDomainError('INVITATION_NOT_AVAILABLE', 'Invitation is not available')
    }
    if (invitation.orgId !== orgId) {
      throw new IdentityDomainError('INVITATION_ORGANIZATION_MISMATCH', 'Invitation organization mismatch')
    }
    return invitation
  }

  private requireLegacyId(namespace: string, resourceId: string): number {
    const id = this.identities.getNumericAlias(namespace, resourceId)
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

  private toLegacyUser(user: AuthCenterUser): LegacyManagedUserDto {
    const profile = this.identities.getOrganizationProfile(user.orgId)
    const organization = this.authDb.getOrganization(user.orgId)
    const phoneIdentity = this.identities.findAuthIdentityByUser(user.id, 'phone', 'sudowork')
    const invitation = this.identities.getInvitationByUser(user.id)
    const wallet = this.identities.getWallet('user', user.id)
    if (!profile || !organization) throw new Error('User organization profile is missing')
    return {
      id: this.requireLegacyId('user', user.id),
      phone: phoneIdentity?.normalizedSubject ?? user.name,
      nickname: user.displayName,
      enterprise_id: this.requireLegacyId('enterprise', user.orgId),
      enterprise_name: organization.name,
      role: user.role === 'super_admin' ? 'SUPER_ADMIN' : user.role === 'admin' ? 'ENTERPRISE_ADMIN' : 'USER',
      status: user.status === 'pending' ? 0 : user.status === 'active' ? 1 : 2,
      invitation_code: invitation?.code ?? null,
      quota: wallet?.balanceUnits ?? 0,
      used_quota: 0,
      balance: wallet?.balanceUnits ?? 0,
      login_type: this.identities.findAuthIdentityByUser(user.id, 'password', 'moss') ? 1 : 0,
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
