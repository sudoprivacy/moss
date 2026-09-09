import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CommandContext } from '../application/commandContext.js'
import { assertTrustedCommandContext } from '../application/commandContext.js'
import {
  AuthCenterDb,
  createSyntheticUserEmail,
  hashPassword,
  type AuthCenterUser,
} from '../authCenter/db.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import { IdentityRepository } from './identityRepository.js'

export interface CreateUnifiedUserInput {
  id?: string
  orgId: string
  username: string
  displayName?: string | null
  email?: string
  password?: string
  passwordHash?: string
  phone?: string
  role: 'super_admin' | 'admin' | 'dept_admin' | 'user'
  status?: AuthCenterUser['status']
  departmentId?: string | null
  extUserId?: string | null
  invitationCode?: string
  initialCreditUnits?: number
  legacyUserId?: number
  authIdentity?: {
    provider: string
    issuer: string
    subject: string
    metadata?: Record<string, unknown>
  }
}

export interface CreateUnifiedUserResult {
  userId: string
  legacyUserId: number
}

export interface CreateUnifiedOrganizationResult {
  organizationId: string
  legacyEnterpriseId: number
  code: string
}

export class UnifiedIdentityService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly authDb: AuthCenterDb,
    private readonly repository: IdentityRepository,
  ) {}

  createOrganization(input: {
    id?: string
    name: string
    code?: string
    extOrgId?: string | null
    legacyEnterpriseId?: number
    loginMethod?: 'sms' | 'password' | 'cas'
    localEnabled?: boolean
    cloudEnabled?: boolean
    logo?: string | null
    appName?: string | null
    topName?: string | null
    aboutName?: string | null
    appCompanyName?: string | null
    loginDescription?: string | null
    initialCreditUnits?: number
  }, context: CommandContext): CreateUnifiedOrganizationResult {
    assertTrustedCommandContext(context)
    const previous = this.repository.getCommandResult<CreateUnifiedOrganizationResult>(
      'identity.create_organization', context.idempotencyKey,
    )
    if (previous) return previous

    return runInTransaction(this.db, () => {
      const repeated = this.repository.getCommandResult<CreateUnifiedOrganizationResult>(
        'identity.create_organization', context.idempotencyKey,
      )
      if (repeated) return repeated
      const name = input.name.trim()
      if (!name) throw new Error('Organization name is required')
      if (this.authDb.getOrganizationByName(name)) throw new Error('Organization name already exists')

      const organizationId = input.id?.trim() || randomUUID()
      if (this.authDb.getOrganization(organizationId)) throw new Error('Organization id already exists')
      const code = input.code?.trim() || `moss-${organizationId.slice(0, 8)}`
      this.authDb.createOrganization(organizationId, name, Date.now(), input.extOrgId?.trim() || null)
      this.repository.putOrganizationProfile({
        orgId: organizationId,
        code,
        loginMethod: input.loginMethod ?? 'password',
        localEnabled: input.localEnabled ?? true,
        cloudEnabled: input.cloudEnabled ?? true,
        logo: input.logo,
        appName: input.appName,
        topName: input.topName,
        aboutName: input.aboutName,
        appCompanyName: input.appCompanyName,
        loginDescription: input.loginDescription,
      })
      let legacyEnterpriseId: number
      if (input.legacyEnterpriseId !== undefined) {
        this.repository.assignNumericAlias({
          namespace: 'enterprise', legacyId: input.legacyEnterpriseId,
          resourceId: organizationId, orgId: organizationId,
          migrationRunId: context.migrationRunId,
        })
        legacyEnterpriseId = input.legacyEnterpriseId
      } else {
        legacyEnterpriseId = this.repository.allocateNumericAlias('enterprise', organizationId, organizationId)
      }
      this.repository.createWallet('organization', organizationId, input.initialCreditUnits ?? 0)
      const result = { organizationId, legacyEnterpriseId, code }
      this.repository.recordCommandResult(
        'identity.create_organization', context.idempotencyKey, context.source, result,
      )
      return result
    })
  }

  createUser(input: CreateUnifiedUserInput, context: CommandContext): CreateUnifiedUserResult {
    assertTrustedCommandContext(context)
    const previous = this.repository.getCommandResult<CreateUnifiedUserResult>('identity.create_user', context.idempotencyKey)
    if (previous) return previous

    return runInTransaction(this.db, () => {
      const repeated = this.repository.getCommandResult<CreateUnifiedUserResult>('identity.create_user', context.idempotencyKey)
      if (repeated) return repeated
      const organization = this.authDb.getOrganization(input.orgId)
      if (!organization) throw new Error('Unknown organization')
      const username = input.username.trim()
      if (!username) throw new Error('Username is required')
      if (this.authDb.listUsersByName(username).length > 0) throw new Error('Username already exists')
      const hasLocalPassword = Boolean(input.password || input.passwordHash)
      if (!hasLocalPassword && !input.authIdentity) {
        throw new Error('Password, password hash, or provider identity is required')
      }

      const invitation = input.invitationCode
        ? this.repository.getInvitationByCode(input.invitationCode)
        : null
      if (input.invitationCode && (!invitation || invitation.status !== 'pending')) {
        throw new Error('Invitation is not available')
      }
      if (invitation && invitation.orgId !== input.orgId) throw new Error('Invitation organization mismatch')

      const userId = input.id?.trim() || randomUUID()
      if (this.authDb.getUserById(userId)) throw new Error('User id already exists')
      const timestamp = Date.now()
      const user: AuthCenterUser = {
        id: userId,
        orgId: input.orgId,
        email: input.email?.trim() || createSyntheticUserEmail(userId),
        name: username,
        displayName: input.displayName?.trim() || null,
        departmentId: input.departmentId ?? null,
        role: input.role,
        status: input.status ?? 'active',
        localAuth: hasLocalPassword,
        tokenLimit: null,
        createdAt: timestamp,
        passwordHash: input.passwordHash ?? (input.password ? hashPassword(input.password) : null),
        passwordUpdatedAt: input.password ? timestamp : null,
        lastLoginAt: null,
        extUserId: input.extUserId?.trim() || null,
      }
      this.authDb.createUser(user)

      if (hasLocalPassword) {
        this.repository.createAuthIdentity({
          id: randomUUID(),
          orgId: input.orgId,
          userId,
          provider: 'password',
          issuer: 'moss',
          normalizedSubject: username,
          metadata: {},
        })
      }

      if (input.authIdentity) {
        this.repository.createAuthIdentity({
          id: randomUUID(),
          orgId: input.orgId,
          userId,
          provider: input.authIdentity.provider,
          issuer: input.authIdentity.issuer,
          normalizedSubject: input.authIdentity.subject,
          metadata: input.authIdentity.metadata ?? {},
        })
      }

      if (input.phone?.trim()) {
        this.repository.createAuthIdentity({
          id: randomUUID(),
          orgId: input.orgId,
          userId,
          provider: 'phone',
          issuer: 'sudowork',
          normalizedSubject: input.phone.trim(),
          metadata: {},
        })
      }

      let legacyUserId: number
      if (input.legacyUserId !== undefined) {
        this.repository.assignNumericAlias({
          namespace: 'user',
          legacyId: input.legacyUserId,
          resourceId: userId,
          orgId: input.orgId,
          migrationRunId: context.migrationRunId,
        })
        legacyUserId = input.legacyUserId
      } else {
        legacyUserId = this.repository.allocateNumericAlias('user', userId, input.orgId)
      }

      this.repository.createWallet('user', userId, invitation?.initialCreditUnits ?? input.initialCreditUnits ?? 0)
      if (invitation) this.repository.consumeInvitation(invitation.id, userId)

      const suppressed = context.externalEffects === 'suppress_external'
      this.repository.createOutboxEvent({
        id: randomUUID(),
        eventType: 'user.welcome',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId, orgId: input.orgId },
        status: suppressed ? 'suppressed' : 'pending',
        contextSource: context.source,
        idempotencyKey: `welcome:${context.idempotencyKey}`,
        suppressReason: suppressed ? `${context.source} context suppresses external effects` : null,
      })

      const result = { userId, legacyUserId }
      this.repository.recordCommandResult('identity.create_user', context.idempotencyKey, context.source, result)
      return result
    })
  }
}
