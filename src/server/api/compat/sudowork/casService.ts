import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { onlineCommandContext } from '../../../application/commandContext.js'
import type { AuthCenterDb, AuthCenterUser } from '../../../authCenter/db.js'
import type { IdentityRepository, IntegrationConnection } from '../../../identity/identityRepository.js'
import type { LegacyKeyValueStore } from '../../../identity/legacyToken.js'
import type { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import type { SudoworkIdentityService, SudoworkLegacySession } from './identityService.js'

const HANDOFF_TTL_SECONDS = 60

export class SudoworkCasError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SudoworkCasError'
  }
}

export interface CasProfile {
  subject: string
  account: string
  nickname: string
  active: boolean
  attributes: Record<string, string>
}

export interface CasTicketValidator {
  validate(provider: CasProvider, service: string, ticket: string): Promise<CasProfile>
}

export interface CasProvider {
  id: string
  orgId: string
  name: string
  casUrl: string
  loginPath: string
  validatePath: string
  logoutPath: string
  logoutServiceUrl: string
  serviceParam: string
  serviceEncodeMode: 'component' | 'raw'
  callbackMode: 'direct_app' | 'server_callback'
  serverCallbackUrl: string
  appCallbackUrl: string
  autoProvision: boolean
}

export class HttpCasTicketValidator implements CasTicketValidator {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async validate(provider: CasProvider, service: string, ticket: string): Promise<CasProfile> {
    const base = new URL(provider.validatePath, provider.casUrl)
    let url: string
    if (provider.serviceEncodeMode === 'raw') {
      const separator = base.toString().includes('?') ? '&' : '?'
      url = `${base}${separator}${provider.serviceParam}=${service}&ticket=${encodeURIComponent(ticket)}`
    } else {
      base.searchParams.set(provider.serviceParam, service)
      base.searchParams.set('ticket', ticket)
      url = base.toString()
    }
    const response = await this.fetchImpl(url)
    const xml = await response.text()
    if (!response.ok) throw new SudoworkCasError(502, `CAS 服务校验失败: HTTP ${response.status}`)
    let document: Document
    try {
      document = new DOMParser({
        onError(level, message) {
          if (level !== 'warning') throw new Error(message)
        },
      }).parseFromString(xml, 'application/xml')
    } catch {
      throw new SudoworkCasError(502, 'CAS 响应格式无效')
    }
    const failure = elementText(document, 'authenticationFailure')
    if (failure) throw new SudoworkCasError(401, `CAS 认证失败: ${failure}`)
    const subject = elementText(document, 'user')
    if (!subject) throw new SudoworkCasError(401, 'CAS 响应缺少用户标识')
    const attributesElement = firstElement(document, 'attributes')
    const attributes: Record<string, string> = {}
    for (const key of ['username', 'first_name', 'last_name', 'email', 'phone', 'mobile', 'is_active']) {
      const value = attributesElement ? elementText(attributesElement, key) : undefined
      if (value !== undefined) attributes[key] = value
    }
    const account = attributes.email || attributes.phone || attributes.mobile || attributes.username || subject
    const nickname = [attributes.first_name, attributes.last_name].filter(Boolean).join(' ').trim()
      || attributes.username || subject
    const active = !['0', 'false', 'no', 'disabled'].includes((attributes.is_active ?? '').toLowerCase())
    return { subject, account, nickname, active, attributes }
  }
}

export class SudoworkCasService {
  private readonly validator: CasTicketValidator
  private readonly codeFactory: () => string

  constructor(private readonly options: {
    authDb: AuthCenterDb
    identities: IdentityRepository
    unifiedIdentity: UnifiedIdentityService
    identity: SudoworkIdentityService
    tokenStore: LegacyKeyValueStore
    ticketValidator?: CasTicketValidator
    codeFactory?: () => string
  }) {
    this.validator = options.ticketValidator ?? new HttpCasTicketValidator()
    this.codeFactory = options.codeFactory ?? (() => randomBytes(32).toString('base64url'))
  }

  getProvider(providerId: string): CasProvider {
    const connection = this.options.identities.getIntegrationConnection(providerId)
    if (!connection || connection.providerType !== 'cas' || !connection.enabled) {
      throw new SudoworkCasError(400, '无效的三方认证 Provider')
    }
    return parseProvider(connection)
  }

  listPublicProviders(): Array<Record<string, unknown>> {
    return this.options.authDb.listOrganizations().flatMap((org) =>
      this.options.identities.listIntegrationConnections(org.id, 'cas')
        .filter((connection) => connection.enabled)
        .map((connection) => toLegacyProvider(parseProvider(connection))),
    )
  }

  async login(input: {
    providerId: string
    ticket: string
    service: string
    deviceId?: string
  }): Promise<SudoworkLegacySession> {
    const resolved = await this.resolveUser(input.providerId, input.ticket, input.service)
    return this.options.identity.startSessionForCanonicalUser({
      userId: resolved.user.id,
      account: resolved.profile.account,
      deviceId: input.deviceId,
    })
  }

  async createHandoff(input: { providerId: string; ticket: string }): Promise<{ redirectUrl: string }> {
    const provider = this.getProvider(input.providerId)
    if (provider.callbackMode !== 'server_callback') {
      throw new SudoworkCasError(400, '当前 Provider 未启用服务端回调模式')
    }
    if (!provider.serverCallbackUrl) throw new SudoworkCasError(400, '服务端回调 URL 未配置')
    const resolved = await this.resolveUser(provider.id, input.ticket, provider.serverCallbackUrl)
    const code = this.codeFactory()
    await this.options.tokenStore.setex(
      `cas_handoff:${hash(code)}`,
      HANDOFF_TTL_SECONDS,
      JSON.stringify({
        providerId: provider.id,
        userId: resolved.user.id,
        account: resolved.profile.account,
      }),
    )
    return { redirectUrl: callbackUrl(provider, code) }
  }

  async exchange(input: { providerId: string; code: string; deviceId?: string }): Promise<SudoworkLegacySession> {
    const provider = this.getProvider(input.providerId)
    const key = `cas_handoff:${hash(input.code)}`
    const raw = await this.options.tokenStore.get(key)
    if (!raw) throw new SudoworkCasError(401, '登录凭证无效，请重新登录')
    const payload = JSON.parse(raw) as { providerId: string; userId: string; account: string }
    if (payload.providerId !== provider.id) throw new SudoworkCasError(401, '登录凭证无效，请重新登录')
    const consumed = await this.options.tokenStore.rotate(key, `cas_handoff_used:${hash(input.code)}`, 1, 'used')
    if (!consumed) throw new SudoworkCasError(401, '登录凭证已失效，请重新登录')
    return this.options.identity.startSessionForCanonicalUser({
      userId: payload.userId,
      account: payload.account,
      deviceId: input.deviceId,
    })
  }

  logoutCallbackUrl(providerId: string): string {
    const provider = this.getProvider(providerId)
    const fallback = `sudowork://cas-callback/${encodeURIComponent(provider.id)}/logout`
    const rawUrl = provider.appCallbackUrl || fallback
    try {
      const url = new URL(rawUrl)
      url.pathname = url.pathname.replace(/\/callback\/?$/, '/logout')
      url.search = ''
      return url.toString()
    } catch {
      return fallback
    }
  }

  private async resolveUser(providerId: string, ticket: string, service: string): Promise<{
    provider: CasProvider
    profile: CasProfile
    user: AuthCenterUser
  }> {
    const provider = this.getProvider(providerId)
    const profile = await this.validator.validate(provider, service, ticket)
    if (!profile.active) throw new SudoworkCasError(403, 'CAS 用户已被禁用')
    const existingIdentity = this.options.identities.findAuthIdentity('cas', provider.id, profile.subject)
    let user = existingIdentity ? this.options.authDb.getUserById(existingIdentity.userId) : null
    if (!user) {
      const accountIdentity = this.options.identities.findAuthIdentity('phone', 'sudowork', profile.account)
        ?? this.options.identities.findAuthIdentity('password', 'moss', profile.account)
      user = accountIdentity ? this.options.authDb.getUserById(accountIdentity.userId) : null
      if (user && user.orgId !== provider.orgId) {
        throw new SudoworkCasError(409, 'CAS 账号对应的本地用户已存在但登录方式或企业不匹配，请联系管理员处理')
      }
      if (!user) {
        if (!provider.autoProvision) throw new SudoworkCasError(403, '当前 Provider 未开启自动创建用户')
        const created = this.options.unifiedIdentity.createUser({
          orgId: provider.orgId,
          username: profile.account,
          displayName: profile.nickname,
          role: 'user',
          status: 'active',
          authIdentity: {
            provider: 'cas', issuer: provider.id, subject: profile.subject,
            metadata: profile.attributes,
          },
        }, onlineCommandContext(`cas-user:${provider.id}:${profile.subject}`))
        user = this.options.authDb.getUserById(created.userId)
      } else {
        this.options.identities.createAuthIdentity({
          id: randomUUID(), orgId: provider.orgId, userId: user.id,
          provider: 'cas', issuer: provider.id, normalizedSubject: profile.subject,
          metadata: profile.attributes,
        })
      }
    }
    if (!user) throw new SudoworkCasError(500, '三方认证身份绑定失败')
    return { provider, profile, user }
  }
}

function parseProvider(connection: IntegrationConnection): CasProvider {
  const config = connection.config
  const string = (key: string, fallback = '') => typeof config[key] === 'string' ? String(config[key]) : fallback
  return {
    id: connection.id,
    orgId: connection.orgId,
    name: connection.name,
    casUrl: string('casUrl'),
    loginPath: string('loginPath', '/cas/login'),
    validatePath: string('validatePath', '/cas/p3/serviceValidate'),
    logoutPath: string('logoutPath', '/cas/logout'),
    logoutServiceUrl: string('logoutServiceUrl'),
    serviceParam: string('serviceParam', 'service'),
    serviceEncodeMode: config.serviceEncodeMode === 'raw' ? 'raw' : 'component',
    callbackMode: config.callbackMode === 'direct_app' ? 'direct_app' : 'server_callback',
    serverCallbackUrl: string('serverCallbackUrl'),
    appCallbackUrl: string('appCallbackUrl'),
    autoProvision: config.autoProvision !== false,
  }
}

function toLegacyProvider(provider: CasProvider): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    type: 'cas',
    enabled: 1,
    cas_url: provider.casUrl,
    login_path: provider.loginPath,
    validate_path: provider.validatePath,
    logout_path: provider.logoutPath,
    logout_service_url: provider.logoutServiceUrl,
    service_param: provider.serviceParam,
    service_encode_mode: provider.serviceEncodeMode,
    callback_mode: provider.callbackMode,
    server_callback_url: provider.serverCallbackUrl,
    app_callback_url: provider.appCallbackUrl,
  }
}

function callbackUrl(provider: CasProvider, code: string): string {
  const fallback = `sudowork://cas-callback/${encodeURIComponent(provider.id)}/callback`
  const url = new URL(provider.appCallbackUrl || fallback)
  url.searchParams.set('code', code)
  return url.toString()
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function firstElement(parent: Document | Element, localName: string): Element | undefined {
  const elements = parent.getElementsByTagNameNS('*', localName)
  return elements.length > 0 ? elements.item(0) ?? undefined : undefined
}

function elementText(parent: Document | Element, localName: string): string | undefined {
  const value = firstElement(parent, localName)?.textContent?.trim()
  return value || undefined
}
