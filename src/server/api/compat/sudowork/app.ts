import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  SudoworkIdentityError,
  type SudoworkLegacySession,
  type SudoworkLegacyUser,
} from './identityService.js'
import { IdentityDomainError, type IdentityActor } from '../../../identity/organizationIdentityService.js'
import { SudoworkAdministrationError, type LegacyEnterpriseDto, type LegacyInvitationDto, type LegacyManagedUserDto } from './adminService.js'
import { SudoworkCasError } from './casService.js'
import { SudoworkCatalogError, type SudoworkCatalogService } from './catalogService.js'
import { CatalogArtifactError } from '../../../catalog/catalogArtifactStore.js'
import { SudoworkConfigError, type SudoworkConfigService } from './configService.js'
import { ManagedImageError, type ManagedImageStore } from '../../../configuration/managedImageStore.js'
import { SudoworkSystemConfigError, type SudoworkSystemConfigService } from './systemConfigService.js'
import { SudoworkBillingError, type SudoworkBillingPort } from './billingService.js'
import { registerSudoworkBillingRoutes } from './billingRoutes.js'
import { BillingDomainError } from '../../../billing/types.js'
import type { DifyRuntimeService } from '../../../dify/difyRuntimeService.js'
import type { DifyEnhancementService } from '../../../dify/difyEnhancementService.js'
import type { DifyDatasetService } from '../../../dify/difyDatasetService.js'
import type { DifyAdministrationService } from '../../../dify/difyAdministrationService.js'
import type { VisibilityFilter } from '../../../visibilityFilter.js'
import { registerSudoworkDifyRuntimeRoutes } from './difyRoutes.js'
import { registerSudoworkDifyDatasetRoutes } from './difyDatasetRoutes.js'
import { registerSudoworkDifyAdministrationRoutes } from './difyAdministrationRoutes.js'
import { createSudoworkQmsRoutes } from './qmsRoutes.js'
import { registerSudoworkLegacyUsageRoutes, type SudoworkLegacyUsagePort } from './legacyUsageRoutes.js'
import { SudoworkLegacyUsageError } from './legacyUsageService.js'
import { SudoworkUserProjectionError } from './userProjectionService.js'
import { registerSudoworkLegacyAdminRoutes, type SudoworkLegacyAdminPort } from './legacyAdminRoutes.js'
import { createLegacyLoginRateLimit, type LegacyRateLimitStore } from './legacyRateLimit.js'

export interface SudoworkIdentityPort {
  loginByPassword(input: {
    phone: string
    password: string
    deviceId?: string
  }): Promise<SudoworkLegacySession>
  loginAdminByPassword(input: {
    phone: string
    password: string
    deviceId?: string
  }): Promise<SudoworkLegacySession>
  changePassword(input: {
    accessToken: string
    oldPassword: string
    newPassword: string
    oldPasswordError?: string
  }): Promise<void>
  getActor(accessToken: string): IdentityActor | null
  updateProfile(accessToken: string, nickname: string): SudoworkLegacyUser
  loginByVerifiedPhone(input: {
    phone: string
    deviceId?: string
  }): Promise<
    | { needRegistration: true; registerToken: string; phone: string }
    | { needRegistration: false; session: SudoworkLegacySession }
  >
  registerByVerifiedPhone(input: {
    registerToken: string
    nickname: string
    invitationCode: string
    deviceId?: string
    idempotencyKey?: string
  }): Promise<{ needRegistration: false; session: SudoworkLegacySession }>
  registerByPassword(input: {
    phone: string
    password: string
    nickname: string
    invitationCode: string
    deviceId?: string
    idempotencyKey?: string
  }): Promise<SudoworkLegacySession>
  refresh(input: {
    refreshToken: string
    deviceId?: string
  }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>
  getProfile(accessToken: string): SudoworkLegacyUser | null
  logout(input: {
    refreshToken?: string
    deviceId?: string
    accessToken?: string
    all?: boolean
  }): Promise<void>
}

export interface SudoworkAdministrationPort {
  listEnterprises(actor: IdentityActor): LegacyEnterpriseDto[]
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
  }): Pick<LegacyEnterpriseDto, 'id'>
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
  }): void
  deleteEnterprise(actor: IdentityActor, enterpriseId: number): void
  listInvitationCodes(input: {
    actor: IdentityActor
    enterpriseId?: number
    status?: 0 | 1 | 2
    page?: number
    pageSize?: number
  }): { items: LegacyInvitationDto[] | Array<Record<string, unknown>>; total: number; page: number; page_size: number }
  createInvitationCodes(input: {
    actor: IdentityActor
    enterpriseId?: number
    count: number
    initialQuotaUsd?: number | null
  }): { codes: string[]; count: number }
  deleteInvitationCode(actor: IdentityActor, legacyId: number): boolean
  listUsers(input: {
    actor: IdentityActor
    enterpriseId?: number
    status?: 0 | 1 | 2
    role?: 'SUPER_ADMIN' | 'ENTERPRISE_ADMIN' | 'USER'
    keyword?: string
  }): LegacyManagedUserDto[]
  createPasswordUser(input: {
    actor: IdentityActor
    phone: string
    nickname?: string | null
    password?: string
    enterpriseId: number
    invitationCodeId: number
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> | { id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }
  createPhoneUser(input: {
    actor: IdentityActor
    phone: string
    nickname?: string | null
    enterpriseId: number
    invitationCodeId: number
    idempotencyKey?: string
  }): Promise<{ id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }> | { id: number; phone: string; sudorouter_user_id: number | null; initial_points: number }
  updateUser(input: {
    actor: IdentityActor
    userId: number
    nickname?: string | null
    status?: 0 | 1 | 2
    enterpriseId?: number
  }): void
  setUserRole(input: {
    actor: IdentityActor
    userId: number
    role: 'ENTERPRISE_ADMIN' | 'USER'
  }): void
  manageUser(input: { actor: IdentityActor; userId: number; action: 'enable' | 'disable' }): 1 | 2
  deleteUser(actor: IdentityActor, legacyId: number): void
  updatePasswordUser(input: {
    actor: IdentityActor
    userId: number
    nickname?: string | null
    status?: 0 | 1 | 2
    enterpriseId?: number
    password?: string
  }): void
}

export interface SudoworkCasPort {
  login(input: { providerId: string; ticket: string; service: string; deviceId?: string }): Promise<SudoworkLegacySession>
  createHandoff(input: { providerId: string; ticket: string }): Promise<{ redirectUrl: string }>
  exchange(input: { providerId: string; code: string; deviceId?: string }): Promise<SudoworkLegacySession>
  logoutCallbackUrl(providerId: string): string
  listPublicProviders(): Array<Record<string, unknown>>
}

export interface SudoworkUserProjection {
  sudorouterKey: string | null
  modelServiceUrl: string
  models: string[]
  scodeAutoModel: string
  totalPoints: number
  usedPoints: number
  remainingPoints: number
  bonusPoints: number
  quota: number
  usedQuota: number
}

export interface SudoworkSmsPort {
  sendCode(phone: string): Promise<{
    success: boolean
    message?: string
    expire?: number
    nextSendIn?: number
    dailyRemaining?: number
  }>
  verifyCode(phone: string, code: string): Promise<{ success: boolean; message?: string }>
}

export interface SudoworkCatalogPort {
  listAgents(input: Parameters<SudoworkCatalogService['listAgents']>[0]): ReturnType<SudoworkCatalogService['listAgents']>
  listSkills(input: Parameters<SudoworkCatalogService['listSkills']>[0]): ReturnType<SudoworkCatalogService['listSkills']>
  listVisibleAgents(actor: IdentityActor): ReturnType<SudoworkCatalogService['listVisibleAgents']>
  listVisibleBindings(actor: IdentityActor): ReturnType<SudoworkCatalogService['listVisibleBindings']>
  getAgentDetail(actor: IdentityActor, agentId: string): ReturnType<SudoworkCatalogService['getAgentDetail']>
  getSkillDetail(actor: IdentityActor, skillId: string): ReturnType<SudoworkCatalogService['getSkillDetail']>
  listCategories(actor: IdentityActor, type: 'agent' | 'skill'): ReturnType<SudoworkCatalogService['listCategories']>
  uploadAgent(input: Parameters<SudoworkCatalogService['uploadAgent']>[0]): ReturnType<SudoworkCatalogService['uploadAgent']>
  uploadSkill(input: Parameters<SudoworkCatalogService['uploadSkill']>[0]): ReturnType<SudoworkCatalogService['uploadSkill']>
  getArtifact(kind: 'agent' | 'skill', resourceId: string): ReturnType<SudoworkCatalogService['getArtifact']>
  reviewAgent(actor: IdentityActor, agentId: string): void
  reviewSkill(actor: IdentityActor, skillId: string): void
  deleteAgent(actor: IdentityActor, agentId: string): void
  deleteSkill(actor: IdentityActor, skillId: string): void
}

export interface SudoworkConfigPort {
  list(input: Parameters<SudoworkConfigService['list']>[0]): ReturnType<SudoworkConfigService['list']>
  create(actor: IdentityActor, body: Record<string, unknown>): ReturnType<SudoworkConfigService['create']>
  get(actor: IdentityActor, id: number): ReturnType<SudoworkConfigService['get']>
  update(actor: IdentityActor, id: number, body: Record<string, unknown>): void
  updateStatus(actor: IdentityActor, id: number, status: number): void
  entriesFor(actor: IdentityActor, id: number): ReturnType<SudoworkConfigService['entriesFor']>
  replaceEntries(actor: IdentityActor, id: number, entries: unknown): void
  listEnterprises(actor: IdentityActor, id: number, page?: number, pageSize?: number): ReturnType<SudoworkConfigService['listEnterprises']>
  associate(actor: IdentityActor, id: number, legacyEnterpriseId: number): void
  dissociate(actor: IdentityActor, id: number, legacyEnterpriseId: number): void
  listForUser(actor: IdentityActor): ReturnType<SudoworkConfigService['listForUser']>
  getTenantConfig(actor: IdentityActor, code: string): ReturnType<SudoworkConfigService['getTenantConfig']>
}

export interface SudoworkManagedImagePort {
  put(input: Parameters<ManagedImageStore['put']>[0]): ReturnType<ManagedImageStore['put']>
  read(kind: Parameters<ManagedImageStore['read']>[0], filename: string): ReturnType<ManagedImageStore['read']>
}

export interface SudoworkSystemConfigPort {
  getLoginMethod(): ReturnType<SudoworkSystemConfigService['getLoginMethod']>
  getPublicConfig(): ReturnType<SudoworkSystemConfigService['getPublicConfig']>
  getAdminConfig(actor: IdentityActor): ReturnType<SudoworkSystemConfigService['getAdminConfig']>
  update(actor: IdentityActor, body: Record<string, unknown>): ReturnType<SudoworkSystemConfigService['update']>
  getCredentialData(): ReturnType<SudoworkSystemConfigService['getCredentialData']>
}

const EMPTY_PROJECTION: SudoworkUserProjection = {
  sudorouterKey: null,
  modelServiceUrl: '',
  models: [],
  scodeAutoModel: '',
  totalPoints: 0,
  usedPoints: 0,
  remainingPoints: 0,
  bonusPoints: 0,
  quota: 0,
  usedQuota: 0,
}

const CREDENTIAL_AES_KEY = Buffer.from(
  'L7CbnQlwVrzWlaehCWSIiKuwBxFDh9i1AFaifYv7UXE=',
  'base64',
)

function encryptLegacyCredentials(value: Record<string, unknown>): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', CREDENTIAL_AES_KEY, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

function requireFormText(form: FormData, name: string): string {
  const value = form.get(name)
  if (typeof value !== 'string' || !value.trim()) {
    throw new SudoworkCatalogError(400, `${name} 不能为空`)
  }
  return value.trim()
}

function optionalFormText(form: FormData, name: string): string | null {
  const value = form.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requireFormFile(form: FormData, name: string): File {
  const value = form.get(name)
  if (!(value instanceof File) || value.size === 0) {
    throw new SudoworkCatalogError(400, `${name} 文件不能为空`)
  }
  if (value.size > 50 * 1024 * 1024) {
    throw new SudoworkCatalogError(413, `${name} 文件不能超过 50 MiB`)
  }
  return value
}

function optionalFormStringArray(form: FormData, name: string): string[] {
  const value = optionalFormText(form, name)
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error()
    return [...new Set(parsed.map(item => item.trim()).filter(Boolean))]
  } catch {
    throw new SudoworkCatalogError(400, `${name} 必须是字符串数组`)
  }
}

export function createSudoworkCompatibilityApp(options: {
  identity: SudoworkIdentityPort
  organizationScopedAdmin?: boolean
  administration?: SudoworkAdministrationPort
  catalog?: SudoworkCatalogPort
  configuration?: SudoworkConfigPort
  managedImages?: SudoworkManagedImagePort
  systemConfiguration?: SudoworkSystemConfigPort
  billing?: SudoworkBillingPort
  legacyUsage?: SudoworkLegacyUsagePort
  legacyAdministration?: SudoworkLegacyAdminPort
  rateLimit?: LegacyRateLimitStore
  difyRuntime?: DifyRuntimeService
  difyEnhancement?: DifyEnhancementService
  difyDataset?: DifyDatasetService
  difyAdministration?: DifyAdministrationService
  resolveEnterpriseAlias?: (legacyId: number) => { resourceId: string; orgId: string } | null
  buildVisibility?: (actor: IdentityActor) => VisibilityFilter
  difyUpstreamBaseUrl?: string
  cas?: SudoworkCasPort
  loginMethod?: 'sms' | 'password' | 'cas'
  sms?: SudoworkSmsPort
  systemConfig?: {
    skillhubBaseUrl?: string
  }
  getUserProjection?: (user: SudoworkLegacyUser) => Promise<SudoworkUserProjection>
  qms?: Omit<Parameters<typeof createSudoworkQmsRoutes>[0], 'getActor'>
}): Hono {
  const app = new Hono()
  const loginMethod = () => options.systemConfiguration?.getLoginMethod() ?? options.loginMethod ?? 'password'
  const getProjection = options.getUserProjection ?? (async () => EMPTY_PROJECTION)
  const publicCasProviders = () => loginMethod() === 'cas' ? options.cas?.listPublicProviders() ?? [] : []
  const skillhubBaseUrl = options.systemConfig?.skillhubBaseUrl?.replace(/\/+$/, '') ?? ''

  app.use('*', cors())
  if (options.rateLimit) {
    const loginRateLimit = createLegacyLoginRateLimit(options.rateLimit)
    app.use('/api/v1/auth/login', loginRateLimit)
    app.use('/api/v1/auth/register', loginRateLimit)
    app.use('/api/v1/auth/login-by-config', loginRateLimit)
    app.use('/api/v1/auth/register-password', loginRateLimit)
    app.use('/api/v1/auth/third-party/cas/login', loginRateLimit)
    app.use('/api/v1/auth/third-party/cas/callback/:provider', loginRateLimit)
    app.use('/api/v1/auth/third-party/cas/exchange', loginRateLimit)
    app.use('/api/v1/admin/login', loginRateLimit)
  }
  app.onError((error, context) => {
    if (error instanceof SudoworkIdentityError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof IdentityDomainError) {
      const status = error.code === 'FORBIDDEN' ? 403
        : error.code.endsWith('_NOT_FOUND') ? 404
          : 400
      const message = error.code === 'ORGANIZATION_NOT_FOUND' ? '企业不存在'
        : error.code === 'INVITATION_NOT_FOUND' ? '邀请码不存在'
          : error.code === 'USER_NOT_FOUND' ? '用户不存在'
            : error.code === 'INVITATION_NOT_AVAILABLE' ? '邀请码不存在或已被使用'
              : error.code === 'INVITATION_ORGANIZATION_MISMATCH' ? '邀请码不属于所选企业'
                : error.code === 'USERNAME_EXISTS' ? '用户名已存在'
                  : error.code === 'PHONE_EXISTS' ? '手机号已存在'
                    : error.code === 'LOGIN_TYPE_MISMATCH' ? '跨方式操作被拒绝:该用户不属于当前登录方式'
          : error.code === 'FORBIDDEN' ? '权限不足'
            : error.message
      return context.json({ success: false, msg: message }, status as 400)
    }
    if (error instanceof SudoworkAdministrationError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof SudoworkCasError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof SudoworkCatalogError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof CatalogArtifactError) {
      const status = error.code === 'ARCHIVE_TOO_LARGE' ? 413
        : error.code === 'ARTIFACT_EXISTS' ? 409
          : error.code === 'CHECKSUM_MISMATCH' ? 409
            : error.code === 'UNSAFE_PATH' ? 400
              : 400
      return context.json({ success: false, msg: error.message }, status as 400)
    }
    if (error instanceof SudoworkConfigError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof ManagedImageError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof SudoworkSystemConfigError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 400)
    }
    if (error instanceof SudoworkBillingError) {
      return context.json({ success: false, msg: error.message }, error.statusCode)
    }
    if (error instanceof BillingDomainError) {
      const status = error.code.includes('NOT_FOUND') || error.code === 'WALLET_NOT_FOUND' ? 404
        : error.code.includes('FORBIDDEN') ? 403
          : error.code.includes('PROVIDER_FAILED') || error.code.includes('SYNC_UNKNOWN') ? 500
            : 400
      return context.json({ success: false, msg: error.message }, status as 400)
    }
    if (error instanceof SudoworkLegacyUsageError) {
      return context.json({ success: false, msg: error.message, ...(error.data ? { data: error.data } : {}) }, error.statusCode as 400)
    }
    if (error instanceof SudoworkUserProjectionError) {
      return context.json({ success: false, msg: error.message }, error.statusCode as 500)
    }
    return context.json({ success: false, msg: '服务器内部错误' }, 500)
  })

  const writeSession = async (session: SudoworkLegacySession) => {
    const projection = await getProjection(session.user)
    return {
      success: true as const,
      data: {
        token: session.legacyToken,
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_in: session.expiresIn,
        user: {
          id: session.user.id,
          phone: session.user.phone,
          nickname: session.user.nickname,
          role: session.user.role,
          status: session.user.status,
          enterprise_code: session.user.enterpriseCode,
          sudorouter_key: projection.sudorouterKey,
          model_service_url: projection.modelServiceUrl,
          models: projection.models,
          scode_auto_model: projection.scodeAutoModel,
          points: {
            total: projection.totalPoints,
            used: projection.usedPoints,
            remaining: projection.remainingPoints,
            bonus: projection.bonusPoints,
          },
        },
      },
    }
  }

  app.post('/api/v1/auth/send-code', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    const phone = typeof body.phone === 'string' ? body.phone : ''
    if (!phone) return context.json({ success: false, msg: '手机号不能为空' }, 400)
    if (!isValidPhone(phone)) return context.json({ success: false, msg: '手机号格式不正确' }, 400)
    if (!options.sms) return context.json({ success: false, msg: '短信服务未配置' }, 500)
    const result = await options.sms.sendCode(phone)
    if (!result.success) {
      return context.json({
        success: false,
        msg: result.message,
        next_send_in: result.nextSendIn,
      }, result.message?.includes('频繁') ? 429 : 500)
    }
    return context.json({
      success: true,
      msg: '验证码已发送',
      expire: result.expire,
      next_send_in: result.nextSendIn,
      daily_remaining: result.dailyRemaining,
    })
  })

  const loginBySms = async (
    context: Parameters<Parameters<Hono['post']>[1]>[0],
    body: Record<string, unknown>,
  ) => {
    const phone = typeof body.phone === 'string' ? body.phone : ''
    const code = typeof body.code === 'string' ? body.code : ''
    if (!phone || !code) return context.json({ success: false, msg: '参数不完整' }, 400)
    if (!isValidPhone(phone)) return context.json({ success: false, msg: '手机号格式不正确' }, 400)
    if (!/^\d{6}$/.test(code)) return context.json({ success: false, msg: '验证码格式不正确' }, 400)
    if (!options.sms) return context.json({ success: false, msg: '短信服务未配置' }, 500)
    const verified = await options.sms.verifyCode(phone, code)
    if (!verified.success) {
      return context.json({ success: false, msg: verified.message }, 400)
    }
    const result = await options.identity.loginByVerifiedPhone({
      phone,
      deviceId: context.req.header('X-Device-Id') || 'default',
    })
    if (result.needRegistration) {
      return context.json({
        success: false,
        need_register: true,
        register_token: result.registerToken,
        phone: result.phone,
        msg: '用户不存在，请先注册',
      })
    }
    return context.json(await writeSession(result.session))
  }

  app.post('/api/v1/auth/login', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    return loginBySms(context, body)
  })

  app.post('/api/v1/auth/register', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    const registerToken = typeof body.register_token === 'string' ? body.register_token : ''
    const nickname = typeof body.nickname === 'string' ? body.nickname : ''
    const invitationCode = typeof body.invitation_code === 'string' ? body.invitation_code : ''
    if (!registerToken || !nickname || !invitationCode) {
      return context.json({ success: false, msg: '参数不完整' }, 400)
    }
    const result = await options.identity.registerByVerifiedPhone({
      registerToken,
      nickname,
      invitationCode,
      deviceId: context.req.header('X-Device-Id') || 'default',
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    })
    return context.json(await writeSession(result.session))
  })

  app.post('/api/v1/auth/login-by-config', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    if (loginMethod() === 'cas') {
      return context.json({
        success: false,
        msg: '当前系统已开启三方认证登录，请使用 CAS 登录',
      }, 403)
    }
    if (loginMethod() === 'sms') return loginBySms(context, body)

    const phone = typeof body.phone === 'string' ? body.phone : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!phone || !password) {
      return context.json({ success: false, msg: '账号或密码不能为空' }, 400)
    }
    const session = await options.identity.loginByPassword({
      phone,
      password,
      deviceId: context.req.header('X-Device-Id') || 'default',
    })
    return context.json(await writeSession(session))
  })

  app.post('/api/v1/admin/login', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    const phone = typeof body.phone === 'string' ? body.phone : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!phone || !password) {
      return context.json({ success: false, msg: '账号或密码不能为空' }, 400)
    }
    const session = await options.identity.loginAdminByPassword({
      phone,
      password,
      deviceId: context.req.header('X-Device-Id') || 'default',
    })
    return context.json({
      success: true,
      data: {
        token: session.legacyToken,
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_in: session.expiresIn,
        user: {
          id: session.user.id,
          phone: session.user.phone,
          nickname: session.user.nickname,
          role: session.user.role,
          avatar: null,
          enterprise_id: session.user.enterpriseId,
          tenant_id: session.user.enterpriseCode,
        },
      },
    })
  })

  const changePassword = async (
    context: Parameters<Parameters<Hono['post']>[1]>[0],
    oldPasswordLabel: '旧密码' | '原始密码',
  ) => {
    const token = bearerToken(context.req.header('Authorization'))
    if (!token) return context.json({ success: false, msg: '未授权' }, 401)
    const body = await context.req.json<Record<string, unknown>>()
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    if (!oldPassword || !newPassword) {
      return context.json({ success: false, msg: `${oldPasswordLabel}和新密码不能为空` }, 400)
    }
    await options.identity.changePassword({
      accessToken: token,
      oldPassword,
      newPassword,
      oldPasswordError: `${oldPasswordLabel}错误`,
    })
    return context.json({ success: true, msg: '密码修改成功' })
  }

  app.post('/api/v1/admin/change-password', (context) => changePassword(context, '旧密码'))
  app.post('/api/v1/auth/change-password', (context) => {
    if (loginMethod() !== 'password') {
      return context.json({
        success: false,
        msg: '当前系统未开启用户名密码登录，修改密码功能暂不可用',
      }, 403)
    }
    return changePassword(context, '原始密码')
  })

  const getAuthenticatedActor = (authorization: string | undefined): IdentityActor | null => {
    const token = bearerToken(authorization)
    if (!token) return null
    const actor = options.identity.getActor(token)
    return actor && options.organizationScopedAdmin
      ? { ...actor, organizationScoped: true }
      : actor
  }

  const getAdminActor = (authorization: string | undefined): IdentityActor | null => {
    const actor = getAuthenticatedActor(authorization)
    return actor && (actor.role === 'super_admin' || actor.role === 'admin') ? actor : null
  }

  const cursorLimit = (value: string | undefined): number | undefined => {
    if (!value) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : undefined
  }

  app.get('/api/assistants/cursor', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.listAgents({
      actor,
      tenantCode: context.req.query('tenant_id'),
      cursor: context.req.query('cursor'),
      limit: cursorLimit(context.req.query('limit')),
      query: context.req.query('query'),
      category: context.req.query('category'),
    }))
  })

  app.get('/api/assistants/:assistantId', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.getAgentDetail(actor, context.req.param('assistantId')))
  })

  app.post('/api/assistants', async (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const form = await context.req.formData()
    const source = requireFormFile(form, 'source_url')
    const tenantCode = requireFormText(form, 'tenant_id')
    return context.json(await options.catalog.uploadAgent({
      actor,
      tenantCode,
      name: requireFormText(form, 'name'),
      profession: requireFormText(form, 'profession'),
      description: optionalFormText(form, 'description'),
      defaultInitPrompt: optionalFormText(form, 'default_init_prompt'),
      categories: optionalFormStringArray(form, 'categories'),
      skills: optionalFormStringArray(form, 'skills'),
      version: optionalFormText(form, 'version') ?? undefined,
      bytes: Buffer.from(await source.arrayBuffer()),
      idempotencyKey: context.req.header('Idempotency-Key') || `upload-agent:${actor.userId}:${randomUUID()}`,
    }))
  })

  app.post('/api/assistants/:assistantId/approve', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.catalog.reviewAgent(actor, context.req.param('assistantId'))
    return context.json({ success: true, message: 'success' })
  })

  app.delete('/api/assistants/:assistantId', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.catalog.deleteAgent(actor, context.req.param('assistantId'))
    return context.json({ success: true, message: 'success' })
  })

  app.get('/api/skills', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.listSkills({
      actor,
      limit: cursorLimit(context.req.query('size')),
      query: context.req.query('query'),
      category: context.req.query('category') ?? context.req.query('categories'),
    }))
  })

  app.get('/api/skills/cursor', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.listSkills({
      actor,
      tenantCode: context.req.query('tenant_id'),
      cursor: context.req.query('cursor'),
      limit: cursorLimit(context.req.query('limit')),
      query: context.req.query('query'),
      category: context.req.query('category') ?? context.req.query('categories'),
    }))
  })

  app.get('/api/skills/:skillId', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.getSkillDetail(actor, context.req.param('skillId')))
  })

  app.post('/api/skills', async (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const form = await context.req.formData()
    const source = requireFormFile(form, 'skill_file')
    return context.json(await options.catalog.uploadSkill({
      actor,
      tenantCode: requireFormText(form, 'tenant_id'),
      name: requireFormText(form, 'name'),
      displayName: requireFormText(form, 'display_name'),
      description: optionalFormText(form, 'description'),
      category: optionalFormText(form, 'category'),
      categories: optionalFormStringArray(form, 'categories'),
      emoji: optionalFormText(form, 'emoji'),
      icon: optionalFormText(form, 'icon'),
      homepage: optionalFormText(form, 'homepage'),
      applicableScenarios: optionalFormText(form, 'applicable_scenarios'),
      coreFeatures: optionalFormText(form, 'core_features'),
      version: optionalFormText(form, 'version') ?? undefined,
      bytes: Buffer.from(await source.arrayBuffer()),
      idempotencyKey: context.req.header('Idempotency-Key') || `upload-skill:${actor.userId}:${randomUUID()}`,
    }))
  })

  app.post('/api/skills/:skillId/approve', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.catalog.reviewSkill(actor, context.req.param('skillId'))
    return context.json({ success: true, message: 'success' })
  })

  app.delete('/api/skills/:skillId', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.catalog.deleteSkill(actor, context.req.param('skillId'))
    return context.json({ success: true, message: 'success' })
  })

  app.get('/api/v1/agents/visible/bindings', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.listVisibleBindings(actor))
  })

  app.get('/api/v1/agents/visible', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.listVisibleAgents(actor))
  })

  app.get('/api/categories', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json(options.catalog.listCategories(actor, context.req.query('type') === '1' ? 'agent' : 'skill'))
  })

  app.get('/api/catalog/artifacts/:kind/:resourceId', async (context) => {
    if (!options.catalog) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const kind = context.req.param('kind')
    if (kind !== 'agent' && kind !== 'skill') return context.json({ success: false, msg: '制品不存在' }, 404)
    const artifact = await options.catalog.getArtifact(kind, context.req.param('resourceId'))
    return context.body(new Uint8Array(artifact.bytes), 200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(artifact.bytes.length),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    })
  })

  const uploadManagedImage = async (
    context: Parameters<Parameters<typeof app.post>[1]>[0],
    kind: 'config-item' | 'enterprise',
  ) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.managedImages) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const form = await context.req.formData()
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) {
      return context.json({ success: false, msg: '请选择要上传的文件' }, 400)
    }
    const saved = await options.managedImages.put({
      kind,
      originalName: file.name,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    })
    return context.json({
      success: true,
      data: { filename: saved.filename },
      msg: kind === 'config-item' ? '图标上传成功' : 'Logo上传成功',
    })
  }

  app.post('/api/v1/admin/upload/config-item-icon', context => uploadManagedImage(context, 'config-item'))
  app.post('/api/v1/admin/upload/enterprise-logo', context => uploadManagedImage(context, 'enterprise'))

  const serveManagedImage = async (
    context: Parameters<Parameters<typeof app.get>[1]>[0],
    kind: 'config-item' | 'enterprise',
  ) => {
    if (!options.managedImages) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const image = await options.managedImages.read(kind, context.req.param('filename'))
    return context.body(new Uint8Array(image.bytes), 200, {
      'Content-Type': image.mimeType,
      'Content-Length': String(image.bytes.length),
      'Cache-Control': 'public, max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
      ...(image.mimeType === 'image/svg+xml' ? { 'Content-Security-Policy': 'sandbox' } : {}),
    })
  }

  app.get('/uploads/config-items/:filename', context => serveManagedImage(context, 'config-item'))
  app.get('/uploads/enterprises/:filename', context => serveManagedImage(context, 'enterprise'))

  app.get('/api/v1/admin/enterprises', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json({ success: true, data: options.administration.listEnterprises(actor) })
  })

  app.post('/api/v1/admin/enterprises', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const name = typeof body.name === 'string' ? body.name : ''
    const code = typeof body.code === 'string' ? body.code : ''
    if (!name || !code) return context.json({ success: false, msg: '企业名称和企业码不能为空' }, 400)
    options.administration.createEnterprise({
      actor, name, code,
      creditPool: typeof body.credit_pool === 'number' ? body.credit_pool : undefined,
      logo: typeof body.logo === 'string' ? body.logo : null,
      appName: typeof body.app_name === 'string' ? body.app_name : null,
      topName: typeof body.top_name === 'string' ? body.top_name : null,
      aboutName: typeof body.about_name === 'string' ? body.about_name : null,
      appCompanyName: typeof body.app_company_name === 'string' ? body.app_company_name : null,
      loginDescription: typeof body.login_desp === 'string' ? body.login_desp : null,
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    })
    return context.json({ success: true, msg: '企业创建成功' })
  })

  app.put('/api/v1/admin/enterprises/:id', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const name = typeof body.name === 'string' ? body.name : ''
    if (!name) return context.json({ success: false, msg: '企业名称不能为空' }, 400)
    options.administration.updateEnterprise({
      actor, enterpriseId: Number(context.req.param('id')), name,
      logo: typeof body.logo === 'string' ? body.logo : null,
      appName: typeof body.app_name === 'string' ? body.app_name : null,
      topName: typeof body.top_name === 'string' ? body.top_name : null,
      aboutName: typeof body.about_name === 'string' ? body.about_name : null,
      appCompanyName: typeof body.app_company_name === 'string' ? body.app_company_name : null,
      loginDescription: typeof body.login_desp === 'string' ? body.login_desp : null,
    })
    return context.json({ success: true, msg: '企业更新成功' })
  })

  app.delete('/api/v1/admin/enterprises/:id', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.administration.deleteEnterprise(actor, Number(context.req.param('id')))
    return context.json({ success: true, msg: '企业删除成功' })
  })

  app.get('/api/v1/admin/invitation-codes/available', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const enterpriseId = Number(context.req.query('enterprise_id'))
    if (!Number.isInteger(enterpriseId) || enterpriseId <= 0) {
      return context.json({ success: false, msg: '请指定企业ID' }, 400)
    }
    const result = options.administration.listInvitationCodes({
      actor, enterpriseId, status: 0, page: 1, pageSize: 100,
    })
    return context.json({
      success: true,
      data: result.items.map((item) => ({ id: item.id, code: item.code })),
    })
  })

  app.get('/api/v1/admin/invitation-codes', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const enterpriseIdValue = context.req.query('enterprise_id')
    const statusValue = context.req.query('status')
    const result = options.administration.listInvitationCodes({
      actor,
      enterpriseId: enterpriseIdValue ? Number.parseInt(enterpriseIdValue, 10) : undefined,
      status: statusValue ? Number.parseInt(statusValue, 10) as 0 | 1 | 2 : undefined,
      page: Number.parseInt(context.req.query('page') || '1', 10),
      pageSize: Number.parseInt(context.req.query('page_size') || '20', 10),
    })
    return context.json({ success: true, data: result })
  })

  app.post('/api/v1/admin/invitation-codes', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const enterpriseId = body.enterprise_id == null || body.enterprise_id === ''
      ? undefined
      : Number(body.enterprise_id)
    const initialQuotaUsd = body.initial_quota_usd == null || body.initial_quota_usd === ''
      ? null
      : Number(body.initial_quota_usd)
    if (initialQuotaUsd !== null && (!Number.isFinite(initialQuotaUsd) || initialQuotaUsd < 0)) {
      return context.json({ success: false, msg: '注册赠送额度必须是大于等于 0 的数字' }, 400)
    }
    const result = options.administration.createInvitationCodes({
      actor,
      enterpriseId,
      count: Number(body.count) || 1,
      initialQuotaUsd,
    })
    return context.json({
      success: true,
      data: result,
      msg: `成功创建 ${result.count} 个邀请码`,
    })
  })

  app.delete('/api/v1/admin/invitation-codes/:id', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const deleted = options.administration.deleteInvitationCode(actor, Number(context.req.param('id')))
    if (!deleted) return context.json({ success: false, msg: '邀请码已被使用，无法删除' }, 400)
    return context.json({ success: true, msg: '邀请码删除成功' })
  })

  app.get('/api/v1/admin/users', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const enterpriseId = context.req.query('enterprise_id')
    const status = context.req.query('status')
    const role = context.req.query('role') as 'SUPER_ADMIN' | 'ENTERPRISE_ADMIN' | 'USER' | undefined
    const users = options.administration.listUsers({
      actor,
      enterpriseId: enterpriseId ? Number.parseInt(enterpriseId, 10) : undefined,
      status: status ? Number.parseInt(status, 10) as 0 | 1 | 2 : undefined,
      role,
      keyword: context.req.query('keyword')?.trim().slice(0, 50),
    })
    return context.json({ success: true, data: users })
  })

  app.post('/api/v1/admin/users-password', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (actor.role !== 'super_admin') {
      return context.json({ success: false, msg: '只有超级管理员可以创建用户' }, 403)
    }
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const phone = typeof body.phone === 'string' ? body.phone : ''
    const nickname = typeof body.nickname === 'string' ? body.nickname : null
    const password = typeof body.password === 'string' && body.password ? body.password : undefined
    const enterpriseId = Number(body.enterprise_id)
    const invitationCodeId = Number(body.invitation_code_id)
    if (!phone || !Number.isInteger(enterpriseId)) {
      return context.json({ success: false, msg: '用户名称和所属企业不能为空' }, 400)
    }
    if (!Number.isInteger(invitationCodeId)) {
      return context.json({ success: false, msg: '请选择邀请码' }, 400)
    }
    if (password) {
      const error = validatePassword(password)
      if (error) return context.json({ success: false, msg: error }, 400)
    }
    const result = await options.administration.createPasswordUser({
      actor, phone, nickname, password, enterpriseId, invitationCodeId,
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    })
    return context.json({ success: true, msg: '用户创建成功', data: result })
  })

  app.post('/api/v1/admin/users', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (actor.role !== 'super_admin') {
      return context.json({ success: false, msg: '只有超级管理员可以创建用户' }, 403)
    }
    if (loginMethod() !== 'sms') {
      return context.json({ success: false, msg: '当前登录方式不支持创建手机验证码用户' }, 403)
    }
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const phone = typeof body.phone === 'string' ? body.phone : ''
    const enterpriseId = Number(body.enterprise_id)
    const invitationCodeId = Number(body.invitation_code_id)
    if (!phone || !Number.isInteger(enterpriseId)) {
      return context.json({ success: false, msg: '手机号和所属企业不能为空' }, 400)
    }
    if (!Number.isInteger(invitationCodeId)) {
      return context.json({ success: false, msg: '请选择邀请码' }, 400)
    }
    const result = await options.administration.createPhoneUser({
      actor,
      phone,
      nickname: typeof body.nickname === 'string' ? body.nickname : null,
      enterpriseId,
      invitationCodeId,
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    })
    return context.json({ success: true, msg: '用户创建成功', data: result })
  })

  app.put('/api/v1/admin/users-password/:id', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (actor.role !== 'super_admin') {
      return context.json({ success: false, msg: '只有超级管理员可以编辑用户' }, 403)
    }
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const password = typeof body.password === 'string' && body.password ? body.password : undefined
    if (password) {
      const error = validatePassword(password)
      if (error) return context.json({ success: false, msg: error }, 400)
    }
    options.administration.updatePasswordUser({
      actor,
      userId: Number(context.req.param('id')),
      nickname: typeof body.nickname === 'string' ? body.nickname : undefined,
      status: typeof body.status === 'number' ? body.status as 0 | 1 | 2 : undefined,
      enterpriseId: typeof body.enterprise_id === 'number' ? body.enterprise_id : undefined,
      password,
    })
    return context.json({ success: true, msg: '用户信息更新成功' })
  })

  app.put('/api/v1/admin/users/:id', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (actor.role !== 'super_admin') {
      return context.json({ success: false, msg: '只有超级管理员可以编辑用户' }, 403)
    }
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    options.administration.updateUser({
      actor,
      userId: Number(context.req.param('id')),
      nickname: typeof body.nickname === 'string' ? body.nickname : undefined,
      status: typeof body.status === 'number' ? body.status as 0 | 1 | 2 : undefined,
      enterpriseId: typeof body.enterprise_id === 'number' ? body.enterprise_id : undefined,
    })
    return context.json({ success: true, msg: '用户信息更新成功' })
  })

  app.post('/api/v1/admin/users/:id/role', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const role = body.role
    if (role === 'SUPER_ADMIN') {
      return context.json({ success: false, msg: '无法将用户设置为超级管理员' }, 400)
    }
    if (role !== 'USER' && role !== 'ENTERPRISE_ADMIN') {
      return context.json({ success: false, msg: '无效的角色' }, 400)
    }
    options.administration.setUserRole({ actor, userId: Number(context.req.param('id')), role })
    return context.json({ success: true, msg: '角色更新成功' })
  })

  app.post('/api/v1/admin/users/:id/manage', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const action = body.action
    if (action !== 'enable' && action !== 'disable') {
      return context.json({ success: false, msg: '无效的操作，请使用 enable 或 disable' }, 400)
    }
    const status = options.administration.manageUser({
      actor, userId: Number(context.req.param('id')), action,
    })
    return context.json({
      success: true,
      msg: action === 'enable' ? '用户已启用' : '用户已禁用',
      data: { status },
    })
  })

  app.delete('/api/v1/admin/users/:id', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (actor.role !== 'super_admin') {
      return context.json({ success: false, msg: '只有超级管理员可以删除用户' }, 403)
    }
    if (!options.administration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.administration.deleteUser(actor, Number(context.req.param('id')))
    return context.json({ success: true, msg: '用户删除成功，所有关联数据已清除' })
  })

  app.get('/api/v1/admin/config-items', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json({ success: true, data: options.configuration.list({
      actor,
      name: context.req.query('name'),
      status: context.req.query('status'),
      page: Number.parseInt(context.req.query('page') || '1', 10),
      pageSize: Number.parseInt(context.req.query('page_size') || '20', 10),
    }) })
  })

  app.post('/api/v1/admin/config-items', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const result = options.configuration.create(actor, await context.req.json<Record<string, unknown>>())
    return context.json({ success: true, msg: '配置项创建成功', data: result })
  })

  app.get('/api/v1/admin/config-items/:id', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json({ success: true, data: options.configuration.get(actor, Number(context.req.param('id'))) })
  })

  app.put('/api/v1/admin/config-items/:id', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.configuration.update(actor, Number(context.req.param('id')), await context.req.json<Record<string, unknown>>())
    return context.json({ success: true, msg: '配置项更新成功' })
  })

  app.put('/api/v1/admin/config-items/:id/status', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    const status = Number(body.status)
    options.configuration.updateStatus(actor, Number(context.req.param('id')), status)
    return context.json({ success: true, msg: status === 0 ? '配置项已禁用' : '配置项已恢复' })
  })

  app.get('/api/v1/admin/config-items/:id/entries', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json({ success: true, data: options.configuration.entriesFor(actor, Number(context.req.param('id'))) })
  })

  app.put('/api/v1/admin/config-items/:id/entries', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const body = await context.req.json<Record<string, unknown>>()
    options.configuration.replaceEntries(actor, Number(context.req.param('id')), body.entries)
    return context.json({ success: true, msg: '配置列表保存成功' })
  })

  app.get('/api/v1/admin/config-items/:id/enterprises', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const result = options.configuration.listEnterprises(
      actor,
      Number(context.req.param('id')),
      Number.parseInt(context.req.query('page') || '1', 10),
      Number.parseInt(context.req.query('page_size') || '20', 10),
    )
    return context.json({ success: true, data: result })
  })

  app.post('/api/v1/admin/config-items/:id/enterprises/:enterpriseId', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.configuration.associate(actor, Number(context.req.param('id')), Number(context.req.param('enterpriseId')))
    return context.json({ success: true, msg: '企业关联成功' })
  })

  app.delete('/api/v1/admin/config-items/:id/enterprises/:enterpriseId', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    options.configuration.dissociate(actor, Number(context.req.param('id')), Number(context.req.param('enterpriseId')))
    return context.json({ success: true, msg: '企业取消关联成功' })
  })

  app.get('/api/v1/config/items', (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json({ success: true, data: options.configuration.listForUser(actor) })
  })

  app.get('/api/v1/tenant/config', async (context) => {
    const actor = getAuthenticatedActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.configuration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    const code = context.req.query('code')?.trim()
    if (!code) return context.json({ success: false, msg: '租户码不能为空' }, 400)
    return context.json({ success: true, data: await options.configuration.getTenantConfig(actor, code) })
  })

  app.get('/api/v1/admin/system-config', (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.systemConfiguration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    return context.json({ success: true, data: options.systemConfiguration.getAdminConfig(actor) })
  })

  app.put('/api/v1/admin/system-config', async (context) => {
    const actor = getAdminActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权' }, 401)
    if (!options.systemConfiguration) return context.json({ success: false, msg: '服务器内部错误' }, 500)
    await options.systemConfiguration.update(actor, await context.req.json<Record<string, unknown>>())
    return context.json({ success: true, msg: '系统配置更新成功' })
  })

  app.get('/api/v1/system-config', (context) => context.json({
    success: true,
    data: options.systemConfiguration?.getPublicConfig() ?? {
      login_method: loginMethod() === 'sms' ? 0 : loginMethod() === 'password' ? 1 : 2,
      log_report: { enabled: 0 }, version_update: { enabled: 0 }, product_improvement: { enabled: 0 },
      sudorouter_baseurl: '', skillhub_baseurl: skillhubBaseUrl, scode_auto_model: '',
      third_party_auth: {
        enabled: loginMethod() === 'cas' && options.cas ? 1 : 0,
        default_provider: publicCasProviders()[0]?.id ?? '', providers: publicCasProviders(),
      },
      recharge_mode: 'disabled', credit_application: { enabled: 0 },
    },
  }))

  app.get('/api/v1/system-config/credentials', (context) => {
    const token = bearerToken(context.req.header('Authorization'))
    const actor = token ? options.identity.getActor(token) : null
    if (!token || !actor) {
      return context.json({ success: false, msg: '未授权' }, 401)
    }
    return context.json({
      success: true,
      ...encryptLegacyCredentials({
        skillhub: { token: `Bearer ${token}` },
        ...(options.systemConfiguration?.getCredentialData() ?? {}),
      }),
    })
  })

  app.post('/api/v1/auth/third-party/cas/login', async (context) => {
    if (!options.cas) return context.json({ success: false, msg: '三方认证配置未启用' }, 403)
    const body = await context.req.json<Record<string, unknown>>()
    const providerId = typeof body.provider === 'string' ? body.provider.trim() : ''
    const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : ''
    const service = typeof body.service === 'string' ? body.service.trim() : ''
    if (!providerId || !ticket || !service) {
      return context.json({ success: false, msg: '参数不完整' }, 400)
    }
    const session = await options.cas.login({
      providerId, ticket, service,
      deviceId: context.req.header('X-Device-Id') || 'default',
    })
    return context.json(await writeSession(session))
  })

  app.get('/api/v1/auth/third-party/cas/callback/:provider', async (context) => {
    const providerId = context.req.param('provider')
    const ticket = context.req.query('ticket')
    if (!options.cas || !providerId || !ticket) {
      return renderCasCallback('认证回调失败', 'CAS 回调参数不完整，请重新登录。')
    }
    try {
      const result = await options.cas.createHandoff({ providerId, ticket })
      return renderCasCallback('认证成功', '正在打开 Sudowork，请在浏览器提示中确认。', result.redirectUrl)
    } catch (error) {
      return renderCasCallback(
        '认证回调失败',
        error instanceof Error ? error.message : '三方认证回调失败，请重新登录。',
      )
    }
  })

  app.post('/api/v1/auth/third-party/cas/exchange', async (context) => {
    if (!options.cas) return context.json({ success: false, msg: '三方认证配置未启用' }, 403)
    const body = await context.req.json<Record<string, unknown>>()
    const providerId = typeof body.provider === 'string' ? body.provider.trim() : ''
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!providerId || !code) return context.json({ success: false, msg: '参数不完整' }, 400)
    const session = await options.cas.exchange({
      providerId, code, deviceId: context.req.header('X-Device-Id') || 'default',
    })
    return context.json(await writeSession(session))
  })

  app.get('/api/v1/auth/third-party/cas/logout/callback/:provider', (context) => {
    const providerId = context.req.param('provider')
    const redirectUrl = options.cas && providerId ? options.cas.logoutCallbackUrl(providerId) : undefined
    return renderCasCallback(
      '已退出登录',
      redirectUrl ? '正在打开 Sudowork，请在浏览器提示中确认。' : 'CAS 已完成退出登录，请返回 Sudowork。',
      redirectUrl,
    )
  })

  app.post('/api/v1/auth/register-password', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    const phone = typeof body.phone === 'string' ? body.phone : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const nickname = typeof body.nickname === 'string' ? body.nickname : ''
    const invitationCode = typeof body.invitation_code === 'string' ? body.invitation_code : ''
    if (!phone || !password || !nickname || !invitationCode) {
      return context.json({ success: false, msg: '参数不完整' }, 400)
    }
    const session = await options.identity.registerByPassword({
      phone,
      password,
      nickname,
      invitationCode,
      deviceId: context.req.header('X-Device-Id') || 'default',
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    })
    return context.json(await writeSession(session))
  })

  app.post('/api/v1/auth/refresh', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
    if (!refreshToken) {
      return context.json({ success: false, msg: 'refresh_token 不能为空' }, 400)
    }
    const refreshed = await options.identity.refresh({
      refreshToken,
      deviceId: typeof body.device_id === 'string' ? body.device_id : 'default',
    })
    return context.json({
      success: true,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      expires_in: refreshed.expiresIn,
    })
  })

  app.post('/api/v1/auth/logout', async (context) => {
    const body = await context.req.json<Record<string, unknown>>()
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined
    const all = body.all === true
    if (!refreshToken && !all) {
      return context.json({ success: false, msg: '参数不完整' }, 400)
    }
    await options.identity.logout({
      refreshToken,
      deviceId: typeof body.device_id === 'string' ? body.device_id : 'default',
      accessToken: bearerToken(context.req.header('Authorization')) ?? undefined,
      all,
    })
    return context.json({ success: true, msg: '注销成功' })
  })

  app.get('/api/v1/user/profile', async (context) => {
    const token = bearerToken(context.req.header('Authorization'))
    const user = token ? options.identity.getProfile(token) : null
    if (!user) return context.json({ success: false, msg: '未授权' }, 401)
    const projection = await getProjection(user)
    return context.json({
      success: true,
      data: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        role: user.role,
        status: user.status,
        enterprise_id: user.enterpriseId,
        enterprise_code: user.enterpriseCode,
        bonus_points: projection.bonusPoints,
        remaining_points: projection.remainingPoints,
        used_points: projection.usedPoints,
        quota: projection.quota,
        used_quota: projection.usedQuota,
      },
    })
  })

  app.post('/api/v1/user/update-profile', async (context) => {
    const token = bearerToken(context.req.header('Authorization'))
    if (!token) return context.json({ success: false, msg: '未授权' }, 401)
    const body = await context.req.json<Record<string, unknown>>()
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
    if (!nickname) return context.json({ success: false, msg: '昵称不能为空' }, 400)
    options.identity.updateProfile(token, nickname)
    return context.json({ success: true, msg: '昵称已更新' })
  })

  registerSudoworkBillingRoutes(app, {
    billing: options.billing,
    getActor: getAuthenticatedActor,
    getAdminActor,
  })

  registerSudoworkLegacyUsageRoutes(app, {
    usage: options.legacyUsage,
    getActor: getAuthenticatedActor,
    getAdminActor,
  })
  registerSudoworkLegacyAdminRoutes(app, {
    administration: options.legacyAdministration,
    billing: options.billing,
    getAdminActor,
  })

  if (options.difyRuntime && options.difyEnhancement && options.buildVisibility) {
    registerSudoworkDifyRuntimeRoutes(app, {
      runtime: options.difyRuntime,
      enhancement: options.difyEnhancement,
      getActor: getAuthenticatedActor,
      buildVisibility: options.buildVisibility,
      upstreamBaseUrl: options.difyUpstreamBaseUrl ?? '',
    })
  }

  if (options.difyDataset && options.resolveEnterpriseAlias) {
    registerSudoworkDifyDatasetRoutes(app, {
      dataset: options.difyDataset,
      getActor: getAuthenticatedActor,
      resolveEnterpriseAlias: options.resolveEnterpriseAlias,
    })
  }

  if (options.difyAdministration && options.resolveEnterpriseAlias) {
    registerSudoworkDifyAdministrationRoutes(app, {
      administration: options.difyAdministration,
      getActor: getAuthenticatedActor,
      resolveEnterpriseAlias: options.resolveEnterpriseAlias,
    })
  }

  if (options.qms) {
    app.route('/', createSudoworkQmsRoutes({
      ...options.qms,
      getActor: authorization => {
        const actor = options.identity.getActor(authorization ?? '')
        return actor && options.organizationScopedAdmin
          ? { ...actor, organizationScoped: true }
          : actor
      },
    }))
  } else {
    app.all('/api/v1/qms/*', context => (
      context.json({ success: false, msg: 'QMS 未配置' }, 503)
    ))
  }

  return app
}

function isValidPhone(phone: string): boolean {
  if (phone.length === 11) return phone.startsWith('1') && /^\d{11}$/.test(phone)
  if (phone.length >= 13 && phone.startsWith('+86')) {
    const national = phone.slice(3)
    return national.length === 11 && national.startsWith('1') && /^\d{11}$/.test(national)
  }
  return false
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return '密码长度不能少于 8 位'
  if (password.length > 20) return '密码长度不能超过 20 位'
  if (!/[A-Z]/.test(password)) return '密码必须包含大写字母'
  if (!/[a-z]/.test(password)) return '密码必须包含小写字母'
  if (!/\d/.test(password)) return '密码必须包含数字'
  return null
}

function renderCasCallback(title: string, message: string, redirectUrl?: string): Response {
  const escapedTitle = escapeHtml(title)
  const escapedMessage = escapeHtml(message)
  const redirect = redirectUrl
    ? `<script>setTimeout(function(){ window.location.href = ${JSON.stringify(redirectUrl)}; }, 300);</script>`
    : ''
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapedTitle}</title></head>`
      + `<body><h1>${escapedTitle}</h1><p>${escapedMessage}</p>${redirect}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=UTF-8' } },
  )
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
