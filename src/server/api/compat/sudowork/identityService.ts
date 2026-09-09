import { randomUUID } from 'node:crypto'
import {
  AuthCenterDb,
  hashPassword,
  isLegacyPasswordHash,
  verifyPassword,
  type AuthCenterUser,
} from '../../../authCenter/db.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import {
  LegacyRefreshTokenService,
  issueLegacyJwt,
  resolveLegacyPrincipal,
  verifyLegacyJwt,
  type LegacyKeyValueStore,
} from '../../../identity/legacyToken.js'
import { runInTransaction } from '../../../storage/sqliteUnitOfWork.js'
import { onlineCommandContext } from '../../../application/commandContext.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import type { SudorouterAccountService } from '../../../billing/sudorouterAccountService.js'
import { pointsToQuota } from '../../../billing/sudorouterAdapter.js'

const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60
const LEGACY_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

export class SudoworkIdentityError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'SudoworkIdentityError'
  }
}

export interface SudoworkLegacyUser {
  id: number
  phone: string
  nickname: string | null
  role: 'SUPER_ADMIN' | 'ENTERPRISE_ADMIN' | 'USER'
  status: 0 | 1 | 2
  enterpriseId: number
  enterpriseCode: string
}

export interface SudoworkLegacySession {
  accessToken: string
  legacyToken: string
  refreshToken: string
  expiresIn: number
  user: SudoworkLegacyUser
}

interface ServiceOptions {
  authDb: AuthCenterDb
  identities: IdentityRepository
  tokenStore: LegacyKeyValueStore
  legacyJwtSecret: string
  nativeActorResolver?: (token: string) => IdentityActor | null
  refreshTokenFactory?: () => string
  registrationTokenFactory?: () => string
  accountProvisioner?: Pick<SudorouterAccountService, 'ensureAccount'>
}

function toLegacyRole(role: string): SudoworkLegacyUser['role'] {
  if (role === 'super_admin') return 'SUPER_ADMIN'
  if (role === 'admin') return 'ENTERPRISE_ADMIN'
  return 'USER'
}

function toLegacyStatus(status: AuthCenterUser['status']): SudoworkLegacyUser['status'] {
  if (status === 'pending') return 0
  if (status === 'active') return 1
  return 2
}

export class SudoworkIdentityService {
  private readonly refreshTokens: LegacyRefreshTokenService
  private readonly tokenFactory: () => string
  private readonly registrationTokenFactory: () => string
  private readonly unifiedIdentity: UnifiedIdentityService

  constructor(private readonly options: ServiceOptions) {
    if (!options.legacyJwtSecret.trim()) {
      throw new Error('Legacy JWT secret must be configured explicitly')
    }
    this.tokenFactory = options.refreshTokenFactory ?? randomUUID
    this.registrationTokenFactory = options.registrationTokenFactory
      ?? (() => randomUUID().replaceAll('-', ''))
    this.refreshTokens = new LegacyRefreshTokenService(
      options.tokenStore,
      this.tokenFactory,
      REFRESH_TOKEN_TTL_SECONDS,
    )
    this.unifiedIdentity = new UnifiedIdentityService(
      options.authDb.db,
      options.authDb,
      options.identities,
    )
  }

  async loginByVerifiedPhone(input: {
    phone: string
    deviceId?: string
  }): Promise<
    | { needRegistration: true; registerToken: string; phone: string }
    | { needRegistration: false; session: SudoworkLegacySession }
  > {
    const phone = input.phone.trim()
    const identity = this.options.identities.findAuthIdentity('phone', 'sudowork', phone)
    if (!identity) {
      const registerToken = this.registrationTokenFactory()
      await this.options.tokenStore.setex(
        `register_token:${registerToken}`,
        600,
        JSON.stringify({ phone, verified: true, created_at: Date.now() }),
      )
      return { needRegistration: true, registerToken, phone }
    }
    const user = this.options.authDb.getUserByIdAndOrg(identity.userId, identity.orgId)
    if (!user) throw new SudoworkIdentityError(500, '用户企业信息异常')
    if (user.status !== 'active') {
      throw new SudoworkIdentityError(403, '该账户已被禁用，请联系管理员')
    }
    return {
      needRegistration: false,
      session: await this.startSession(user, phone, input.deviceId),
    }
  }

  async registerByVerifiedPhone(input: {
    registerToken: string
    nickname: string
    invitationCode: string
    deviceId?: string
    idempotencyKey?: string
  }): Promise<{ needRegistration: false; session: SudoworkLegacySession }> {
    const registerKey = `register_token:${input.registerToken}`
    const tokenData = await this.options.tokenStore.get(registerKey)
    if (!tokenData) {
      throw new SudoworkIdentityError(400, '注册凭证无效或已过期，请重新获取验证码')
    }
    let phone = ''
    try {
      const parsed = JSON.parse(tokenData) as Record<string, unknown>
      if (parsed.verified === true && typeof parsed.phone === 'string') phone = parsed.phone
    } catch {
      // Invalid handoff data is treated exactly like an expired token.
    }
    if (!phone) {
      throw new SudoworkIdentityError(400, '注册凭证无效或已过期，请重新获取验证码')
    }
    const existingIdentity = this.options.identities.findAuthIdentity('phone', 'sudowork', phone)
    const existingUser = existingIdentity
      ? this.options.authDb.getUserByIdAndOrg(existingIdentity.userId, existingIdentity.orgId)
      : null
    if (existingUser && (existingUser.status !== 'pending' || !this.options.accountProvisioner)) {
      await this.options.tokenStore.del(registerKey)
      throw new SudoworkIdentityError(400, '该手机号已注册，请直接登录')
    }
    const invitation = this.options.identities.getInvitationByCode(input.invitationCode)
    if (!existingUser && !invitation) throw new SudoworkIdentityError(400, '邀请码不存在')
    if (!existingUser && invitation?.status !== 'pending') {
      throw new SudoworkIdentityError(400, '邀请码已被使用')
    }
    const createKey = input.idempotencyKey ?? `sudowork-register:${phone}:${input.invitationCode}`
    const created = existingUser ? { userId: existingUser.id } : this.unifiedIdentity.createUser({
      orgId: invitation!.orgId,
      username: phone,
      displayName: input.nickname,
      role: 'user',
      status: this.options.accountProvisioner ? 'pending' : 'active',
      invitationCode: input.invitationCode,
      authIdentity: {
        provider: 'phone', issuer: 'sudowork', subject: phone, metadata: {},
      },
    }, onlineCommandContext(createKey))
    await this.provisionAccount(created.userId, phone, input.nickname, createKey)
    await this.options.tokenStore.del(registerKey)
    const user = this.options.authDb.getUserById(created.userId)
    if (!user) throw new SudoworkIdentityError(500, '用户企业信息异常')
    return {
      needRegistration: false,
      session: await this.startSession(user, phone, input.deviceId),
    }
  }

  async registerByPassword(input: {
    phone: string
    password: string
    nickname: string
    invitationCode: string
    deviceId?: string
    idempotencyKey?: string
  }): Promise<SudoworkLegacySession> {
    const passwordError = validateLegacyPassword(input.password)
    if (passwordError) throw new SudoworkIdentityError(400, passwordError)
    const phone = input.phone.trim()
    const existingIdentity = this.options.identities.findAuthIdentity('phone', 'sudowork', phone)
    const existingUser = existingIdentity
      ? this.options.authDb.getUserByIdAndOrg(existingIdentity.userId, existingIdentity.orgId)
      : null
    if (existingUser && (existingUser.status !== 'pending' || !this.options.accountProvisioner)) {
      throw new SudoworkIdentityError(400, '用户名已存在')
    }
    const invitation = this.options.identities.getInvitationByCode(input.invitationCode)
    if (!existingUser && !invitation) throw new SudoworkIdentityError(400, '邀请码不存在')
    if (!existingUser && invitation?.status !== 'pending') {
      throw new SudoworkIdentityError(400, '邀请码已被使用')
    }
    const createKey = input.idempotencyKey ?? `sudowork-register:${phone}:${input.invitationCode}`
    try {
      const created = existingUser ? { userId: existingUser.id } : this.unifiedIdentity.createUser({
        orgId: invitation!.orgId,
        username: phone,
        displayName: input.nickname,
        password: input.password,
        phone,
        role: 'user',
        status: this.options.accountProvisioner ? 'pending' : 'active',
        invitationCode: input.invitationCode,
      }, onlineCommandContext(createKey))
      await this.provisionAccount(created.userId, phone, input.nickname, createKey)
    } catch (error) {
      if (error instanceof Error && /Username already exists|UNIQUE constraint failed/.test(error.message)) {
        throw new SudoworkIdentityError(400, '用户名已存在')
      }
      throw error
    }
    return this.loginByPassword({
      phone,
      password: input.password,
      deviceId: input.deviceId,
    })
  }

  private async provisionAccount(
    userId: string,
    username: string,
    displayName: string,
    createKey: string,
  ): Promise<void> {
    if (!this.options.accountProvisioner) return
    const user = this.options.authDb.getUserById(userId)
    const wallet = this.options.identities.getWallet('user', userId)
    if (!user || !wallet) throw new SudoworkIdentityError(500, '用户初始化失败')
    try {
      await this.options.accountProvisioner.ensureAccount({
        ownerId: user.id,
        orgId: user.orgId,
        username,
        displayName: displayName.trim() || username,
        initialQuotaUnits: pointsToQuota(wallet.balanceUnits),
      }, onlineCommandContext(`sudorouter:${createKey}`))
      this.options.authDb.updateUser(user.id, { status: 'active' })
    } catch {
      throw new SudoworkIdentityError(500, 'Sudorouter 用户初始化失败，请稍后重试')
    }
  }

  async loginByPassword(input: {
    phone: string
    password: string
    deviceId?: string
    nowSeconds?: number
  }): Promise<SudoworkLegacySession> {
    const phone = input.phone.trim()
    const identity = this.options.identities.findAuthIdentity('phone', 'sudowork', phone)
    const user = identity ? this.options.authDb.getUserByIdAndOrg(identity.userId, identity.orgId) : null
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new SudoworkIdentityError(401, '账号或密码错误')
    }
    if (user.status !== 'active') {
      throw new SudoworkIdentityError(403, '该账户已被禁用，请联系管理员')
    }

    runInTransaction(this.options.authDb.db, () => {
      if (isLegacyPasswordHash(user.passwordHash)) {
        this.options.authDb.updateUserPassword(user.id, hashPassword(input.password), Date.now())
      }
      this.options.authDb.updateUserLastLogin(user.id)
    })

    return this.startSession(user, phone, input.deviceId, input.nowSeconds)
  }

  async loginAdminByPassword(input: {
    phone: string
    password: string
    deviceId?: string
    nowSeconds?: number
  }): Promise<SudoworkLegacySession> {
    const phone = input.phone.trim()
    const identity = this.options.identities.findAuthIdentity('phone', 'sudowork', phone)
    const user = identity ? this.options.authDb.getUserByIdAndOrg(identity.userId, identity.orgId) : null
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      throw new SudoworkIdentityError(404, '账号不存在')
    }
    if (!verifyPassword(input.password, user.passwordHash)) {
      throw new SudoworkIdentityError(401, '密码错误')
    }
    if (user.status !== 'active') {
      throw new SudoworkIdentityError(403, '该账户已被禁用，请联系管理员')
    }
    runInTransaction(this.options.authDb.db, () => {
      if (isLegacyPasswordHash(user.passwordHash)) {
        this.options.authDb.updateUserPassword(user.id, hashPassword(input.password), Date.now())
      }
      this.options.authDb.updateUserLastLogin(user.id)
    })
    return this.startSession(user, phone, input.deviceId, input.nowSeconds)
  }

  async startSessionForCanonicalUser(input: {
    userId: string
    account: string
    deviceId?: string
    nowSeconds?: number
  }): Promise<SudoworkLegacySession> {
    const user = this.options.authDb.getUserById(input.userId)
    if (!user) throw new SudoworkIdentityError(401, '登录凭证已失效，请重新登录')
    if (user.status !== 'active') throw new SudoworkIdentityError(403, 'CAS 用户已被禁用')
    return this.startSession(user, input.account, input.deviceId, input.nowSeconds)
  }

  async changePassword(input: {
    accessToken: string
    oldPassword: string
    newPassword: string
    oldPasswordError?: string
    nowSeconds?: number
  }): Promise<void> {
    const passwordError = validateLegacyPassword(input.newPassword)
    if (passwordError) throw new SudoworkIdentityError(400, passwordError)
    const principal = resolveLegacyPrincipal(
      input.accessToken,
      this.options.legacyJwtSecret,
      this.options.identities,
      this.options.authDb,
      input.nowSeconds,
    )
    if (!principal) throw new SudoworkIdentityError(401, '未授权')
    const user = this.options.authDb.getUserByIdAndOrg(principal.userId, principal.orgId)
    if (!user) throw new SudoworkIdentityError(404, '用户不存在')
    if (!user.localAuth || !verifyPassword(input.oldPassword, user.passwordHash)) {
      throw new SudoworkIdentityError(401, input.oldPasswordError ?? '原始密码错误')
    }
    this.options.authDb.updateUserPassword(user.id, hashPassword(input.newPassword), Date.now())
  }

  updateProfile(accessToken: string, nickname: string, nowSeconds?: number): SudoworkLegacyUser {
    const principal = resolveLegacyPrincipal(
      accessToken,
      this.options.legacyJwtSecret,
      this.options.identities,
      this.options.authDb,
      nowSeconds,
    )
    if (!principal) throw new SudoworkIdentityError(401, '未授权')
    const user = this.options.authDb.getUserByIdAndOrg(principal.userId, principal.orgId)
    if (!user) throw new SudoworkIdentityError(404, '用户不存在')
    const displayName = nickname.trim()
    if (!displayName) throw new SudoworkIdentityError(400, '昵称不能为空')
    this.options.authDb.updateUser(user.id, { displayName })
    const phone = this.options.identities
      .findAuthIdentityByUser(user.id, 'phone', 'sudowork')?.normalizedSubject
    if (!phone) throw new SudoworkIdentityError(500, '用户企业信息异常')
    return this.resolveLegacyUser({ ...user, displayName }, phone)
  }

  private async startSession(
    user: AuthCenterUser,
    phone: string,
    deviceId?: string,
    nowSeconds?: number,
  ): Promise<SudoworkLegacySession> {
    const legacyUser = this.resolveLegacyUser(user, phone)
    const refreshToken = this.tokenFactory()
    await this.options.tokenStore.setex(
      `refresh_token:${legacyUser.id}:${deviceId || 'default'}:${refreshToken}`,
      REFRESH_TOKEN_TTL_SECONDS,
      JSON.stringify({
        phone: legacyUser.phone,
        role: legacyUser.role,
        enterprise_id: legacyUser.enterpriseId,
      }),
    )
    return this.issueSessionTokens(legacyUser, refreshToken, nowSeconds)
  }

  async refresh(input: {
    refreshToken: string
    deviceId?: string
    nowSeconds?: number
  }): Promise<Pick<SudoworkLegacySession, 'accessToken' | 'refreshToken' | 'expiresIn'>> {
    const rotated = await this.refreshTokens.rotate(input.refreshToken, input.deviceId || 'default')
    if (!rotated) {
      throw new SudoworkIdentityError(401, 'refresh_token 无效或已过期')
    }
    return {
      accessToken: issueLegacyJwt({
        secret: this.options.legacyJwtSecret,
        userId: rotated.userId,
        phone: rotated.claims.phone,
        role: rotated.claims.role,
        enterpriseId: rotated.claims.enterprise_id,
        expiresInSec: ACCESS_TOKEN_TTL_SECONDS,
        nowSeconds: input.nowSeconds,
      }),
      refreshToken: rotated.token,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    }
  }

  getProfile(accessToken: string, nowSeconds?: number): SudoworkLegacyUser | null {
    const claims = verifyLegacyJwt(
      accessToken,
      this.options.legacyJwtSecret,
      nowSeconds ?? Math.floor(Date.now() / 1000),
    )
    if (!claims) return null
    const principal = resolveLegacyPrincipal(
      accessToken,
      this.options.legacyJwtSecret,
      this.options.identities,
      this.options.authDb,
      nowSeconds,
    )
    if (!principal) return null
    const user = this.options.authDb.getUserByIdAndOrg(principal.userId, principal.orgId)
    return user ? this.resolveLegacyUser(user, claims.phone) : null
  }

  getActor(accessToken: string, nowSeconds?: number): IdentityActor | null {
    const principal = resolveLegacyPrincipal(
      accessToken,
      this.options.legacyJwtSecret,
      this.options.identities,
      this.options.authDb,
      nowSeconds,
    )
    if (!principal) return this.options.nativeActorResolver?.(accessToken) ?? null
    const user = this.options.authDb.getUserByIdAndOrg(principal.userId, principal.orgId)
    if (!user || user.status !== 'active') return null
    return { userId: user.id, orgId: user.orgId, role: user.role }
  }

  async logout(input: {
    refreshToken?: string
    deviceId?: string
    accessToken?: string
    all?: boolean
    nowSeconds?: number
  }): Promise<void> {
    if (input.all && input.accessToken) {
      const profile = this.getProfile(input.accessToken, input.nowSeconds)
      if (profile) {
        const keys = await this.options.tokenStore.keys(`refresh_token:${profile.id}:*`)
        if (keys.length > 0) await this.options.tokenStore.del(...keys)
      }
      return
    }
    if (input.refreshToken) {
      const keys = await this.options.tokenStore.keys(
        `refresh_token:*:${input.deviceId || 'default'}:${input.refreshToken}`,
      )
      if (keys.length > 0) await this.options.tokenStore.del(...keys)
    }
  }

  private resolveLegacyUser(user: AuthCenterUser, phone: string): SudoworkLegacyUser {
    const profile = this.options.identities.getOrganizationProfile(user.orgId)
    const userId = this.options.identities.getNumericAlias('user', user.id)
    const enterpriseId = this.options.identities.getNumericAlias('enterprise', user.orgId)
    if (!profile || userId === null || enterpriseId === null) {
      throw new SudoworkIdentityError(500, '用户企业信息异常')
    }
    return {
      id: userId,
      phone,
      nickname: user.displayName,
      role: toLegacyRole(user.role),
      status: toLegacyStatus(user.status),
      enterpriseId,
      enterpriseCode: profile.code,
    }
  }

  private issueSessionTokens(
    user: SudoworkLegacyUser,
    refreshToken: string,
    nowSeconds?: number,
  ): SudoworkLegacySession {
    const common = {
      secret: this.options.legacyJwtSecret,
      userId: user.id,
      phone: user.phone,
      role: user.role,
      enterpriseId: user.enterpriseId,
      nowSeconds,
    }
    return {
      accessToken: issueLegacyJwt({ ...common, expiresInSec: ACCESS_TOKEN_TTL_SECONDS }),
      legacyToken: issueLegacyJwt({ ...common, expiresInSec: LEGACY_TOKEN_TTL_SECONDS }),
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user,
    }
  }
}

function validateLegacyPassword(password: string): string | null {
  if (password.length < 8) return '密码长度不能少于 8 位'
  if (password.length > 20) return '密码长度不能超过 20 位'
  if (!/[A-Z]/.test(password)) return '密码必须包含大写字母'
  if (!/[a-z]/.test(password)) return '密码必须包含小写字母'
  if (!/\d/.test(password)) return '密码必须包含数字'
  return null
}
