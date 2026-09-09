import type { DatabaseSync } from 'node:sqlite'
import type { ClientPolicyRepository } from '../../../configuration/clientPolicyRepository.js'
import { PlatformIntegrationSettingsRepository } from '../../../configuration/platformIntegrationSettingsRepository.js'
import type { ConfigKey } from '../../../configStore/configStore.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import type { IdentityRepository, IntegrationConnection } from '../../../identity/identityRepository.js'
import { runInTransaction } from '../../../storage/sqliteUnitOfWork.js'

const LOG_REPORT_SECRET_KEY = 'client.log-report-key' as const

type LoginMethod = 'sms' | 'password' | 'cas'
type RechargeMode = 'pay' | 'approve' | 'disabled'
type Json = Record<string, unknown>

export interface SudoworkInfrastructureConfig {
  sms: {
    provider: 'disabled' | 'tencent'
    sdkAppId: string
    signName: string
    templateId: string
    signId: string
    region: string
    codeLength: number
    expireMinutes: number
    sendIntervalSeconds: number
    maxPerDay: number
  }
  billing: {
    enabled: boolean
    fuiou: {
      testMode: boolean
      merchantCode: string
      timeoutMs: number
      testApiUrl?: string
      testRefundUrl?: string
      prodApiUrl?: string
      prodRefundUrl?: string
    }
    sudorouter: {
      baseUrl: string
      adminUserId: string
      timeoutMs: number
      initialQuota: number
      modelServiceUrl: string
      modelsApiUrl: string
    }
  }
}

export class SudoworkSystemConfigError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SudoworkSystemConfigError'
  }
}

export class SudoworkSystemConfigService {
  private readonly infrastructureSettings: PlatformIntegrationSettingsRepository

  constructor(private readonly options: {
    db: DatabaseSync
    policies: ClientPolicyRepository
    infrastructureSettings?: PlatformIntegrationSettingsRepository
    identities: IdentityRepository
    defaults: {
      loginMethod: LoginMethod
      skillhubBaseUrl: string
      sudorouterBaseUrl?: string
      productImprovementEncryptionRequired?: boolean
      productImprovementApiKey?: string
      productImprovementPublicKey?: string
      sms?: SudoworkInfrastructureConfig['sms']
      billing?: SudoworkInfrastructureConfig['billing']
    }
    smsRuntimeAvailable?: boolean
    smsCredentialsAvailable?: boolean
    smsConfigured?: boolean
    secrets: {
      get(key: ConfigKey): string | undefined
      put(key: ConfigKey, value: string): Promise<void>
      remove(key: ConfigKey): Promise<void>
    }
  }) {
    this.infrastructureSettings = options.infrastructureSettings
      ?? new PlatformIntegrationSettingsRepository(options.db)
  }

  getLoginMethod(): LoginMethod {
    return loginMethodFromNumber(this.policy().loginMethod, this.options.defaults.loginMethod)
  }

  getPublicConfig(): Json {
    const policy = this.policy()
    const infrastructure = this.getInfrastructureConfig()
    const logReport = object(policy.logReport)
    const versionUpdate = object(policy.versionUpdate)
    const productImprovement = object(policy.productImprovement)
    const enabledLogReport = flag(logReport.enabled)
    const enabledVersionUpdate = flag(versionUpdate.enabled)
    const enabledProductImprovement = flag(productImprovement.enabled)
    return {
      login_method: loginMethodToNumber(this.getLoginMethod()),
      log_report: enabledLogReport === 1
        ? { enabled: 1, baseurl: `${string(logReport.protocol, 'https')}://${string(logReport.domain)}` }
        : { enabled: 0 },
      version_update: enabledVersionUpdate === 1
        ? { enabled: 1, cos_domain: string(versionUpdate.cosDomain) }
        : { enabled: 0 },
      product_improvement: enabledProductImprovement === 1
        ? { enabled: 1, encryption_required: this.options.defaults.productImprovementEncryptionRequired === true }
        : { enabled: 0 },
      sudorouter_baseurl: withoutTrailingSlash(string(
        policy.sudorouterBaseUrl,
        infrastructure.billing.sudorouter.baseUrl || this.options.defaults.sudorouterBaseUrl || '',
      )),
      skillhub_baseurl: withoutTrailingSlash(string(policy.skillhubBaseUrl, this.options.defaults.skillhubBaseUrl)),
      scode_auto_model: string(policy.scodeAutoModel),
      third_party_auth: this.thirdPartyAuth(false),
      recharge_mode: rechargeMode(policy.rechargeMode),
      credit_application: normalizeCreditApplication(policy.creditApplication),
    }
  }

  getCreditApplicationPolicy(): {
    rechargeMode: 'payment' | 'approve' | 'disabled'
    minPoints: number
    maxPoints: number
    allowDuplicatePending: boolean
  } {
    const policy = this.policy()
    const credit = normalizeCreditApplication(policy.creditApplication)
    return {
      rechargeMode: rechargeMode(policy.rechargeMode) === 'pay' ? 'payment' : rechargeMode(policy.rechargeMode),
      minPoints: Number(credit.min_points),
      maxPoints: Number(credit.max_points),
      allowDuplicatePending: credit.allow_duplicate_pending === true,
    }
  }

  getInfrastructureConfig(): SudoworkInfrastructureConfig {
    return {
      sms: normalizeSmsInfrastructure(
        this.infrastructureSettings.get('sudowork.sms'),
        this.options.defaults.sms ?? DEFAULT_SMS_INFRASTRUCTURE,
      ),
      billing: normalizeBillingInfrastructure(
        this.infrastructureSettings.get('sudowork.billing'),
        this.options.defaults.billing ?? DEFAULT_BILLING_INFRASTRUCTURE,
      ),
    }
  }

  getAdminConfig(actor: IdentityActor): Json {
    this.assertAdmin(actor)
    const policy = this.policy()
    const logReport = object(policy.logReport)
    const versionUpdate = object(policy.versionUpdate)
    const productImprovement = object(policy.productImprovement)
    const config: Json = {
      login_method: loginMethodToNumber(this.getLoginMethod()),
      sms_configured: this.isSmsConfigured(),
      third_party_auth: this.thirdPartyAuth(true),
      log_report: {
        enabled: flag(logReport.enabled),
        protocol: string(logReport.protocol),
        domain: string(logReport.domain),
        key: '',
        key_set: Boolean(this.options.secrets.get(LOG_REPORT_SECRET_KEY)),
      },
      version_update: {
        enabled: flag(versionUpdate.enabled),
        cos_domain: string(versionUpdate.cosDomain),
      },
      product_improvement: { enabled: flag(productImprovement.enabled) },
      scode_auto_model: string(policy.scodeAutoModel),
      recharge_mode: rechargeMode(policy.rechargeMode),
      credit_application: normalizeCreditApplication(policy.creditApplication),
    }
    if (!actor.organizationScoped) return config
    const infrastructure = this.getInfrastructureConfig()
    return {
      ...config,
      restart_required: true,
      sms: adminSmsConfig(infrastructure.sms),
      billing: adminBillingConfig(infrastructure.billing),
    }
  }

  getCredentialData(): Json {
    const result: Json = {}
    const logReport = object(this.policy().logReport)
    const logKey = this.options.secrets.get(LOG_REPORT_SECRET_KEY)
    if (flag(logReport.enabled) === 1 && logKey) result.log_report = { key: logKey }
    const productImprovement = object(this.policy().productImprovement)
    if (flag(productImprovement.enabled) === 1) {
      const value: Json = { api_key: this.options.defaults.productImprovementApiKey ?? '' }
      if (this.options.defaults.productImprovementEncryptionRequired) {
        value.public_key = this.options.defaults.productImprovementPublicKey ?? ''
      }
      result.product_improvement = value
    }
    return result
  }

  async update(actor: IdentityActor, body: Json): Promise<void> {
    const {
      patch, providers, nextLogKey, smsInfrastructure, billingInfrastructure,
    } = this.prepareUpdate(actor, body)
    const previousLogKey = this.options.secrets.get(LOG_REPORT_SECRET_KEY)
    if (nextLogKey !== undefined) await this.options.secrets.put(LOG_REPORT_SECRET_KEY, nextLogKey)
    try {
      runInTransaction(this.options.db, () => {
        this.options.policies.putPlatform(patch, actor.userId)
        if (smsInfrastructure) {
          this.infrastructureSettings.put('sudowork.sms', smsInfrastructure, actor.userId)
        }
        if (billingInfrastructure) {
          this.infrastructureSettings.put('sudowork.billing', billingInfrastructure, actor.userId)
        }
        if (providers) this.replaceCasConnections(providers)
      })
    } catch (error) {
      if (nextLogKey !== undefined) {
        if (previousLogKey !== undefined) await this.options.secrets.put(LOG_REPORT_SECRET_KEY, previousLogKey)
        else await this.options.secrets.remove(LOG_REPORT_SECRET_KEY)
      }
      throw error
    }
  }

  validateUpdate(actor: IdentityActor, body: Json): void {
    this.prepareUpdate(actor, body)
  }

  private prepareUpdate(actor: IdentityActor, body: Json): {
    patch: Json
    providers?: NormalizedProvider[]
    nextLogKey?: string
    smsInfrastructure?: SudoworkInfrastructureConfig['sms']
    billingInfrastructure?: SudoworkInfrastructureConfig['billing']
  } {
    if (actor.role !== 'super_admin') throw new SudoworkSystemConfigError(403, '权限不足')
    const patch: Json = {}
    let providers: NormalizedProvider[] | undefined
    let smsInfrastructure: SudoworkInfrastructureConfig['sms'] | undefined
    let billingInfrastructure: SudoworkInfrastructureConfig['billing'] | undefined

    if (body.third_party_auth !== undefined) {
      const normalized = normalizeThirdPartyAuth(body.third_party_auth)
      providers = normalized.providers.map(provider => this.validateProvider(provider))
      if (normalized.enabled === 1 && !providers.some(provider => provider.id === normalized.defaultProvider && provider.enabled)) {
        throw new SudoworkSystemConfigError(400, '默认三方认证 Provider 不存在或未启用')
      }
      patch.thirdPartyAuth = { enabled: normalized.enabled, defaultProvider: normalized.defaultProvider }
    }

    if (body.login_method !== undefined) {
      if (body.login_method !== 0 && body.login_method !== 1 && body.login_method !== 2) {
        throw new SudoworkSystemConfigError(400, '无效的登录方式')
      }
      if (body.login_method === 0 && !this.isSmsConfigured()) {
        throw new SudoworkSystemConfigError(400, '短信通道未配置,无法切换到手机验证码')
      }
      const thirdParty = object(patch.thirdPartyAuth ?? this.policy().thirdPartyAuth)
      if (body.login_method === 2 && flag(thirdParty.enabled) !== 1) {
        throw new SudoworkSystemConfigError(400, '三方认证配置未启用')
      }
      patch.loginMethod = body.login_method
    }

    let nextLogKey: string | undefined
    if (body.log_report !== undefined) {
      const value = object(body.log_report)
      const enabled = flag(value.enabled)
      const protocol = string(value.protocol)
      const domain = string(value.domain)
      nextLogKey = typeof value.key === 'string' && value.key.length > 0 ? value.key : undefined
      if (enabled === 1 && protocol !== 'http' && protocol !== 'https') {
        throw new SudoworkSystemConfigError(400, '日志上报开启时,协议类型必须为 http 或 https')
      }
      if (enabled === 1 && !domain) throw new SudoworkSystemConfigError(400, '日志上报开启时,域名必填且非空')
      if (enabled === 1 && !nextLogKey && !this.options.secrets.get(LOG_REPORT_SECRET_KEY)) {
        throw new SudoworkSystemConfigError(400, '日志上报开启时,Key 必填')
      }
      patch.logReport = { enabled, protocol, domain, keySet: Boolean(nextLogKey || this.options.secrets.get(LOG_REPORT_SECRET_KEY)) }
    }

    if (body.version_update !== undefined) {
      const value = object(body.version_update)
      const enabled = flag(value.enabled)
      const cosDomain = string(value.cos_domain)
      if (enabled === 1 && !cosDomain) {
        throw new SudoworkSystemConfigError(400, '版本自动更新开启时,COS 访问域名必填且非空')
      }
      patch.versionUpdate = { enabled, cosDomain }
    }
    if (body.product_improvement !== undefined) {
      const enabled = flag(object(body.product_improvement).enabled)
      if (enabled === 1 && !this.options.defaults.productImprovementApiKey) {
        throw new SudoworkSystemConfigError(400, '未配置 QMS_DEFAULT_API_KEY,无法开启产品改进计划')
      }
      if (enabled === 1 && this.options.defaults.productImprovementEncryptionRequired
        && (!this.options.defaults.productImprovementPublicKey)) {
        throw new SudoworkSystemConfigError(400, '已开启遥测加密,但未配置 QMS_TELEMETRY_PUBLIC_KEY')
      }
      patch.productImprovement = { enabled }
    }
    if (body.scode_auto_model !== undefined) {
      if (typeof body.scode_auto_model !== 'string') {
        throw new SudoworkSystemConfigError(400, 'Sudowork Auto 默认模型必须为字符串')
      }
      patch.scodeAutoModel = body.scode_auto_model.trim()
    }
    if (body.recharge_mode !== undefined) patch.rechargeMode = rechargeMode(body.recharge_mode)
    if (body.credit_application !== undefined) patch.creditApplication = normalizeCreditApplication(body.credit_application)
    if (body.sms !== undefined) {
      smsInfrastructure = parseSmsInfrastructure(
        body.sms,
        this.getInfrastructureConfig().sms,
      )
    }
    if (body.billing !== undefined) {
      billingInfrastructure = parseBillingInfrastructure(
        body.billing,
        this.getInfrastructureConfig().billing,
      )
    }
    return { patch, providers, nextLogKey, smsInfrastructure, billingInfrastructure }
  }

  isSmsConfigured(): boolean {
    if (this.options.smsConfigured !== undefined) return this.options.smsConfigured
    const sms = this.getInfrastructureConfig().sms
    return this.options.smsRuntimeAvailable === true
      && sms.provider === 'tencent'
      && [sms.sdkAppId, sms.signName, sms.templateId, sms.signId, sms.region].every(Boolean)
      && (this.options.smsCredentialsAvailable === true || (
        Boolean(this.options.secrets.get('server.sudowork-tencent-secret-id'))
        && Boolean(this.options.secrets.get('server.sudowork-tencent-secret-key'))
      ))
  }

  private policy(): Json {
    return this.options.policies.getEffective()
  }

  private thirdPartyAuth(admin: boolean): Json {
    const policy = object(this.policy().thirdPartyAuth)
    const providers = this.options.identities.listOrganizationProfiles().flatMap(profile =>
      this.options.identities.listIntegrationConnections(profile.orgId, 'cas').map(connection =>
        legacyProvider(connection, profile.code, admin)),
    )
    const defaultProvider = string(policy.defaultProvider, providers[0]?.id as string | undefined)
    return { enabled: flag(policy.enabled), default_provider: defaultProvider, providers: providers.filter(item => admin || item.enabled === 1) }
  }

  private validateProvider(provider: NormalizedProvider): NormalizedProvider {
    if (provider.type !== 'cas') throw new SudoworkSystemConfigError(400, '当前仅支持 CAS 类型 Provider')
    if (!provider.id || !provider.name) throw new SudoworkSystemConfigError(400, 'Provider ID 和名称不能为空')
    if (!validHttpUrl(provider.casUrl)) throw new SudoworkSystemConfigError(400, 'CAS URL 格式不正确')
    if (!provider.loginPath || !provider.validatePath || !provider.logoutPath || !provider.serviceParam) {
      throw new SudoworkSystemConfigError(400, 'CAS 登录地址、校验地址、登出地址和 service 参数名不能为空')
    }
    if (provider.callbackMode === 'server_callback' && !validHttpUrl(provider.serverCallbackUrl)) {
      throw new SudoworkSystemConfigError(400, '服务端回调 URL 格式不正确')
    }
    if (provider.logoutServiceUrl && !validHttpUrl(provider.logoutServiceUrl)) {
      throw new SudoworkSystemConfigError(400, '登出回跳 URL 必须使用 http 或 https')
    }
    if (!provider.appCallbackUrl) throw new SudoworkSystemConfigError(400, 'App 回调 URL 不能为空')
    const profile = this.options.identities.getOrganizationProfileByCode(provider.enterpriseCode)
    if (!profile) throw new SudoworkSystemConfigError(400, `Provider 绑定企业码 ${provider.enterpriseCode} 不存在`)
    return { ...provider, orgId: profile.orgId }
  }

  private replaceCasConnections(providers: NormalizedProvider[]): void {
    const ids = new Set(providers.map(provider => provider.id))
    for (const profile of this.options.identities.listOrganizationProfiles()) {
      for (const existing of this.options.identities.listIntegrationConnections(profile.orgId, 'cas')) {
        if (!ids.has(existing.id)) this.options.identities.putIntegrationConnection({ ...existing, enabled: false })
      }
    }
    for (const provider of providers) {
      this.options.identities.putIntegrationConnection({
        id: provider.id,
        orgId: provider.orgId!,
        providerType: 'cas',
        name: provider.name,
        enabled: provider.enabled,
        secretRef: null,
        config: {
          casUrl: provider.casUrl,
          loginPath: provider.loginPath,
          validatePath: provider.validatePath,
          logoutPath: provider.logoutPath,
          logoutServiceUrl: provider.logoutServiceUrl,
          serviceParam: provider.serviceParam,
          serviceEncodeMode: provider.serviceEncodeMode,
          callbackMode: provider.callbackMode,
          serverCallbackUrl: provider.serverCallbackUrl,
          appCallbackUrl: provider.appCallbackUrl,
          autoProvision: provider.autoProvision,
        },
      })
    }
  }

  private assertAdmin(actor: IdentityActor): void {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') {
      throw new SudoworkSystemConfigError(403, '权限不足')
    }
  }
}

const DEFAULT_SMS_INFRASTRUCTURE: SudoworkInfrastructureConfig['sms'] = {
  provider: 'disabled', sdkAppId: '', signName: '', templateId: '', signId: '',
  region: 'ap-beijing', codeLength: 6, expireMinutes: 5,
  sendIntervalSeconds: 60, maxPerDay: 10,
}

const DEFAULT_BILLING_INFRASTRUCTURE: SudoworkInfrastructureConfig['billing'] = {
  enabled: false,
  fuiou: { testMode: false, merchantCode: '', timeoutMs: 10_000 },
  sudorouter: {
    baseUrl: '', adminUserId: '13', timeoutMs: 10_000, initialQuota: 100_000,
    modelServiceUrl: '', modelsApiUrl: 'https://hk.sudorouter.ai/api/specific_pricing',
  },
}

interface NormalizedProvider {
  id: string
  orgId?: string
  name: string
  type: string
  enabled: boolean
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
  enterpriseCode: string
  autoProvision: boolean
}

function normalizeThirdPartyAuth(value: unknown): { enabled: number; defaultProvider: string; providers: NormalizedProvider[] } {
  const raw = object(value)
  const providers = Array.isArray(raw.providers) ? raw.providers.map(item => {
    const provider = object(item)
    return {
      id: string(provider.id), name: string(provider.name), type: string(provider.type, 'cas'),
      enabled: flag(provider.enabled) === 1, casUrl: string(provider.cas_url),
      loginPath: string(provider.login_path, '/cas/login'), validatePath: string(provider.validate_path, '/cas/p3/serviceValidate'),
      logoutPath: string(provider.logout_path, '/cas/logout'), logoutServiceUrl: string(provider.logout_service_url),
      serviceParam: string(provider.service_param, 'service'),
      serviceEncodeMode: provider.service_encode_mode === 'raw' ? 'raw' as const : 'component' as const,
      callbackMode: provider.callback_mode === 'direct_app' ? 'direct_app' as const : 'server_callback' as const,
      serverCallbackUrl: string(provider.server_callback_url), appCallbackUrl: string(provider.app_callback_url),
      enterpriseCode: string(provider.enterprise_code), autoProvision: flag(provider.auto_provision) === 1,
    }
  }) : []
  const ids = new Set<string>()
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new SudoworkSystemConfigError(400, `Provider ID 重复: ${provider.id}`)
    ids.add(provider.id)
  }
  return { enabled: flag(raw.enabled), defaultProvider: string(raw.default_provider), providers }
}

function legacyProvider(connection: IntegrationConnection, enterpriseCode: string, admin: boolean): Json {
  const config = connection.config
  return {
    id: connection.id, name: connection.name, type: 'cas', enabled: connection.enabled ? 1 : 0,
    cas_url: string(config.casUrl), login_path: string(config.loginPath, '/cas/login'),
    validate_path: string(config.validatePath, '/cas/p3/serviceValidate'),
    logout_path: string(config.logoutPath, '/cas/logout'), logout_service_url: string(config.logoutServiceUrl),
    service_param: string(config.serviceParam, 'service'),
    service_encode_mode: config.serviceEncodeMode === 'raw' ? 'raw' : 'component',
    callback_mode: config.callbackMode === 'direct_app' ? 'direct_app' : 'server_callback',
    server_callback_url: string(config.serverCallbackUrl), app_callback_url: string(config.appCallbackUrl),
    enterprise_code: admin ? enterpriseCode : '', auto_provision: admin && config.autoProvision !== false ? 1 : 0,
  }
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function flag(value: unknown): 0 | 1 {
  return value === true || value === 1 || value === '1' ? 1 : 0
}

function rechargeMode(value: unknown): RechargeMode {
  return value === 'approve' || value === 'disabled' || value === 'pay' ? value : 'pay'
}

function normalizeCreditApplication(value: unknown): Json {
  const raw = object(value)
  const min = Number(raw.min_points)
  const minPoints = Number.isInteger(min) && min > 0 ? min : 100
  const max = Number(raw.max_points)
  return {
    min_points: minPoints,
    max_points: Number.isInteger(max) && max >= minPoints ? max : 1_000_000,
    allow_duplicate_pending: raw.allow_duplicate_pending === true,
  }
}

function normalizeSmsInfrastructure(
  value: unknown,
  fallback: SudoworkInfrastructureConfig['sms'],
): SudoworkInfrastructureConfig['sms'] {
  const raw = object(value)
  return {
    provider: raw.provider === 'tencent' ? 'tencent' : raw.provider === 'disabled' ? 'disabled' : fallback.provider,
    sdkAppId: string(raw.sdkAppId, fallback.sdkAppId),
    signName: string(raw.signName, fallback.signName),
    templateId: string(raw.templateId, fallback.templateId),
    signId: string(raw.signId, fallback.signId),
    region: string(raw.region, fallback.region),
    codeLength: integer(raw.codeLength, fallback.codeLength),
    expireMinutes: integer(raw.expireMinutes, fallback.expireMinutes),
    sendIntervalSeconds: integer(raw.sendIntervalSeconds, fallback.sendIntervalSeconds),
    maxPerDay: integer(raw.maxPerDay, fallback.maxPerDay),
  }
}

function parseSmsInfrastructure(
  value: unknown,
  current: SudoworkInfrastructureConfig['sms'],
): SudoworkInfrastructureConfig['sms'] {
  const raw = object(value)
  const provider = raw.provider === undefined ? current.provider : raw.provider
  if (provider !== 'disabled' && provider !== 'tencent') {
    throw new SudoworkSystemConfigError(400, '短信服务商无效')
  }
  const codeLength = adminInteger(raw.code_length, current.codeLength)
  const expireMinutes = adminInteger(raw.expire_minutes, current.expireMinutes)
  const sendIntervalSeconds = adminInteger(raw.send_interval_seconds, current.sendIntervalSeconds)
  const maxPerDay = adminInteger(raw.max_per_day, current.maxPerDay)
  if (codeLength < 4 || codeLength > 8) throw new SudoworkSystemConfigError(400, '短信验证码长度必须为 4 至 8 位')
  if (expireMinutes < 1) throw new SudoworkSystemConfigError(400, '短信验证码有效期必须大于 0')
  if (sendIntervalSeconds < 1) throw new SudoworkSystemConfigError(400, '短信发送间隔必须大于 0')
  if (maxPerDay < 1) throw new SudoworkSystemConfigError(400, '短信每日发送上限必须大于 0')
  return {
    provider,
    sdkAppId: adminString(raw.sdk_app_id, current.sdkAppId),
    signName: adminString(raw.sign_name, current.signName),
    templateId: adminString(raw.template_id, current.templateId),
    signId: adminString(raw.sign_id, current.signId),
    region: adminString(raw.region, current.region),
    codeLength,
    expireMinutes,
    sendIntervalSeconds,
    maxPerDay,
  }
}

function normalizeBillingInfrastructure(
  value: unknown,
  fallback: SudoworkInfrastructureConfig['billing'],
): SudoworkInfrastructureConfig['billing'] {
  const raw = object(value)
  const fuiou = object(raw.fuiou)
  const sudorouter = object(raw.sudorouter)
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    fuiou: {
      testMode: typeof fuiou.testMode === 'boolean' ? fuiou.testMode : fallback.fuiou.testMode,
      merchantCode: string(fuiou.merchantCode, fallback.fuiou.merchantCode),
      timeoutMs: integer(fuiou.timeoutMs, fallback.fuiou.timeoutMs),
      ...optionalString('testApiUrl', fuiou.testApiUrl, fallback.fuiou.testApiUrl),
      ...optionalString('testRefundUrl', fuiou.testRefundUrl, fallback.fuiou.testRefundUrl),
      ...optionalString('prodApiUrl', fuiou.prodApiUrl, fallback.fuiou.prodApiUrl),
      ...optionalString('prodRefundUrl', fuiou.prodRefundUrl, fallback.fuiou.prodRefundUrl),
    },
    sudorouter: {
      baseUrl: string(sudorouter.baseUrl, fallback.sudorouter.baseUrl),
      adminUserId: string(sudorouter.adminUserId, fallback.sudorouter.adminUserId),
      timeoutMs: integer(sudorouter.timeoutMs, fallback.sudorouter.timeoutMs),
      initialQuota: integer(sudorouter.initialQuota, fallback.sudorouter.initialQuota),
      modelServiceUrl: string(sudorouter.modelServiceUrl, fallback.sudorouter.modelServiceUrl),
      modelsApiUrl: string(sudorouter.modelsApiUrl, fallback.sudorouter.modelsApiUrl),
    },
  }
}

function parseBillingInfrastructure(
  value: unknown,
  current: SudoworkInfrastructureConfig['billing'],
): SudoworkInfrastructureConfig['billing'] {
  const raw = object(value)
  const fuiou = object(raw.fuiou)
  const sudorouter = object(raw.sudorouter)
  const timeoutMs = adminInteger(fuiou.timeout_ms, current.fuiou.timeoutMs)
  const sudorouterTimeoutMs = adminInteger(sudorouter.timeout_ms, current.sudorouter.timeoutMs)
  const initialQuota = adminInteger(sudorouter.initial_quota, current.sudorouter.initialQuota)
  if (timeoutMs < 1) throw new SudoworkSystemConfigError(400, '富友超时时间必须大于 0')
  if (sudorouterTimeoutMs < 1) throw new SudoworkSystemConfigError(400, 'Sudorouter 超时时间必须大于 0')
  if (initialQuota < 0) throw new SudoworkSystemConfigError(400, 'Sudorouter 初始额度不能小于 0')
  const urls = {
    testApiUrl: adminOptionalUrl(fuiou.test_api_url, current.fuiou.testApiUrl, '富友测试支付地址'),
    testRefundUrl: adminOptionalUrl(fuiou.test_refund_url, current.fuiou.testRefundUrl, '富友测试退款地址'),
    prodApiUrl: adminOptionalUrl(fuiou.prod_api_url, current.fuiou.prodApiUrl, '富友生产支付地址'),
    prodRefundUrl: adminOptionalUrl(fuiou.prod_refund_url, current.fuiou.prodRefundUrl, '富友生产退款地址'),
  }
  const baseUrl = adminString(sudorouter.base_url, current.sudorouter.baseUrl)
  if (baseUrl && !validHttpUrl(baseUrl)) throw new SudoworkSystemConfigError(400, 'Sudorouter 地址格式不正确')
  const modelServiceUrl = adminString(sudorouter.model_service_url, current.sudorouter.modelServiceUrl)
  if (modelServiceUrl && !validHttpUrl(modelServiceUrl)) throw new SudoworkSystemConfigError(400, '模型服务地址格式不正确')
  const modelsApiUrl = adminString(sudorouter.models_api_url, current.sudorouter.modelsApiUrl)
  if (modelsApiUrl && !validHttpUrl(modelsApiUrl)) throw new SudoworkSystemConfigError(400, '模型列表地址格式不正确')
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : current.enabled,
    fuiou: {
      testMode: typeof fuiou.test_mode === 'boolean' ? fuiou.test_mode : current.fuiou.testMode,
      merchantCode: adminString(fuiou.merchant_code, current.fuiou.merchantCode),
      timeoutMs,
      ...(urls.testApiUrl ? { testApiUrl: urls.testApiUrl } : {}),
      ...(urls.testRefundUrl ? { testRefundUrl: urls.testRefundUrl } : {}),
      ...(urls.prodApiUrl ? { prodApiUrl: urls.prodApiUrl } : {}),
      ...(urls.prodRefundUrl ? { prodRefundUrl: urls.prodRefundUrl } : {}),
    },
    sudorouter: {
      baseUrl,
      adminUserId: adminString(sudorouter.admin_user_id, current.sudorouter.adminUserId),
      timeoutMs: sudorouterTimeoutMs,
      initialQuota,
      modelServiceUrl: withoutTrailingSlash(modelServiceUrl),
      modelsApiUrl: withoutTrailingSlash(modelsApiUrl),
    },
  }
}

function adminSmsConfig(value: SudoworkInfrastructureConfig['sms']): Json {
  return {
    provider: value.provider,
    sdk_app_id: value.sdkAppId,
    sign_name: value.signName,
    template_id: value.templateId,
    sign_id: value.signId,
    region: value.region,
    code_length: value.codeLength,
    expire_minutes: value.expireMinutes,
    send_interval_seconds: value.sendIntervalSeconds,
    max_per_day: value.maxPerDay,
  }
}

function adminBillingConfig(value: SudoworkInfrastructureConfig['billing']): Json {
  return {
    enabled: value.enabled,
    fuiou: {
      test_mode: value.fuiou.testMode,
      merchant_code: value.fuiou.merchantCode,
      timeout_ms: value.fuiou.timeoutMs,
      test_api_url: value.fuiou.testApiUrl ?? '',
      test_refund_url: value.fuiou.testRefundUrl ?? '',
      prod_api_url: value.fuiou.prodApiUrl ?? '',
      prod_refund_url: value.fuiou.prodRefundUrl ?? '',
    },
    sudorouter: {
      base_url: value.sudorouter.baseUrl,
      admin_user_id: value.sudorouter.adminUserId,
      timeout_ms: value.sudorouter.timeoutMs,
      initial_quota: value.sudorouter.initialQuota,
      model_service_url: value.sudorouter.modelServiceUrl,
      models_api_url: value.sudorouter.modelsApiUrl,
    },
  }
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback
}

function adminInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new SudoworkSystemConfigError(400, '配置值必须为整数')
  return parsed
}

function adminString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : string(value)
}

function optionalString<K extends string>(key: K, value: unknown, fallback: string | undefined): Partial<Record<K, string>> {
  const normalized = value === undefined ? fallback : string(value)
  return normalized ? { [key]: normalized } as Record<K, string> : {}
}

function adminOptionalUrl(value: unknown, fallback: string | undefined, label: string): string | undefined {
  const normalized = value === undefined ? fallback : string(value)
  if (normalized && !validHttpUrl(normalized)) throw new SudoworkSystemConfigError(400, `${label}格式不正确`)
  return normalized || undefined
}

function loginMethodFromNumber(value: unknown, fallback: LoginMethod): LoginMethod {
  return value === 0 ? 'sms' : value === 1 ? 'password' : value === 2 ? 'cas'
    : value === 'sms' || value === 'password' || value === 'cas' ? value : fallback
}

function loginMethodToNumber(value: LoginMethod): 0 | 1 | 2 {
  return value === 'sms' ? 0 : value === 'password' ? 1 : 2
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
