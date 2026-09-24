import type { ClientPolicyRepository } from '../../../configuration/clientPolicyRepository.js'
import { PlatformIntegrationSettingsRepository } from '../../../configuration/platformIntegrationSettingsRepository.js'
import { resolveEffectiveLoginMethod } from '../../../configuration/loginPolicy.js'
import type { ConfigKey } from '../../../configStore/configStore.js'
import {
  hasGlobalOrganizationAccess,
  type IdentityActor,
} from '../../../identity/organizationIdentityService.js'
import type { IdentityRepository, IntegrationConnection } from '../../../identity/identityRepository.js'
import type { DbDriver } from '../../../db/driver.js'
import { getSystemSettings, updateSystemSettingsWithCommit } from '../../../systemSettings.js'

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
    db: DbDriver
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
    productImprovementAvailable?: boolean
    platformConfigPage?: boolean
    smsConfigured?: boolean
    getSmsReadiness?: () => Promise<{ ready: boolean; reason?: string }>
    resolveInfrastructure?: (legacy: SudoworkInfrastructureConfig) => SudoworkInfrastructureConfig
    secrets: {
      get(key: ConfigKey): string | undefined
      put(key: ConfigKey, value: string): Promise<void>
      remove(key: ConfigKey): Promise<void>
    }
  }) {
    this.infrastructureSettings = options.infrastructureSettings
      ?? new PlatformIntegrationSettingsRepository(options.db)
  }

  async getLoginMethod(orgId?: string): Promise<LoginMethod> {
    return resolveEffectiveLoginMethod(this.options, orgId)
  }

  async getPublicConfig(orgId?: string): Promise<Json> {
    const policy = await this.policy(orgId)
    const infrastructure = await this.getInfrastructureConfig()
    const logReport = object(policy.logReport)
    const versionUpdate = object(policy.versionUpdate)
    const productImprovement = object(policy.productImprovement)
    const enabledLogReport = flag(logReport.enabled)
    const enabledVersionUpdate = flag(versionUpdate.enabled)
    const enabledProductImprovement = this.options.productImprovementAvailable === false ? 0 : flag(productImprovement.enabled)
    const systemSettings = getSystemSettings()
    return {
      login_method: loginMethodToNumber(await this.getLoginMethod(orgId)),
      auth_methods: [({ sms: 'phone', password: 'password', cas: 'sso' } as const)[await this.getLoginMethod(orgId)]],
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
        infrastructure.billing.sudorouter.baseUrl,
        this.options.defaults.sudorouterBaseUrl || '',
      )),
      skillhub_baseurl: withoutTrailingSlash(string(policy.skillhubBaseUrl, this.options.defaults.skillhubBaseUrl)),
      scode_auto_model: string(policy.scodeAutoModel),
      third_party_auth: await this.thirdPartyAuth(false, orgId),
      recharge_mode: rechargeMode(policy.rechargeMode),
      credit_application: normalizeCreditApplication(policy.creditApplication),
      client_cron_enabled: await this.effectiveClientCronEnabled(orgId, systemSettings.clientCronEnabled),
      client_show_tool_calls: typeof policy.clientShowToolCalls === 'boolean'
        ? policy.clientShowToolCalls
        : systemSettings.clientShowToolCalls,
      workspace_upload_limit_bytes: workspaceUploadLimit(policy.workspaceUploadLimitBytes, systemSettings.workspaceUploadLimitBytes),
    }
  }

  async getCreditApplicationPolicy(orgId?: string): Promise<{
    rechargeMode: 'payment' | 'approve' | 'disabled'
    minPoints: number
    maxPoints: number
    allowDuplicatePending: boolean
  }> {
    const policy = await this.policy(orgId)
    const credit = normalizeCreditApplication(policy.creditApplication)
    const mode = rechargeMode(policy.rechargeMode)
    return {
      rechargeMode: mode === 'pay' ? 'payment' : mode,
      minPoints: Number(credit.min_points),
      maxPoints: Number(credit.max_points),
      allowDuplicatePending: credit.allow_duplicate_pending === true,
    }
  }

  async getInfrastructureConfig(): Promise<SudoworkInfrastructureConfig> {
    const result: SudoworkInfrastructureConfig = {
      sms: normalizeSmsInfrastructure(
        await this.infrastructureSettings.get('sudowork.sms'),
        this.options.defaults.sms ?? DEFAULT_SMS_INFRASTRUCTURE,
      ),
      billing: normalizeBillingInfrastructure(
        await this.infrastructureSettings.get('sudowork.billing'),
        this.options.defaults.billing ?? DEFAULT_BILLING_INFRASTRUCTURE,
      ),
    }
    return this.options.resolveInfrastructure?.(result) ?? result
  }

  async getAdminConfig(actor: IdentityActor): Promise<Json> {
    this.assertAdmin(actor)
    const orgId = this.policyOrgId(actor)
    const policy = await this.policy(orgId)
    const logReport = object(policy.logReport)
    const versionUpdate = object(policy.versionUpdate)
    const productImprovement = object(policy.productImprovement)
    const config: Json = {
      scope_type: orgId ? 'organization' : 'platform',
      organization_id: orgId ?? '',
      login_method: loginMethodToNumber(await this.getLoginMethod(orgId)),
      sms_configured: await this.isSmsConfigured(),
      sms_status: await this.options.getSmsReadiness?.(),
      login_method_inherited: orgId ? (await this.options.policies.getOrganization(orgId)).loginMethod === undefined : false,
      third_party_auth: await this.thirdPartyAuth(true, orgId),
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
      client_cron_enabled: await this.effectiveClientCronEnabled(orgId),
      client_show_tool_calls: typeof policy.clientShowToolCalls === 'boolean'
        ? policy.clientShowToolCalls
        : getSystemSettings().clientShowToolCalls,
      workspace_upload_limit_bytes: workspaceUploadLimit(
        policy.workspaceUploadLimitBytes,
        getSystemSettings().workspaceUploadLimitBytes,
      ),
    }
    if (orgId) return config
    const infrastructure = await this.getInfrastructureConfig()
    return {
      ...config,
      restart_required: true,
      ...(this.options.platformConfigPage ? { platform_config_url: '/settings/platform-config' } : { sms: adminSmsConfig(infrastructure.sms), billing: adminBillingConfig(infrastructure.billing) }),
    }
  }

  async getCredentialData(orgId?: string): Promise<Json> {
    const result: Json = {}
    const policy = await this.policy(orgId)
    const logReport = object(policy.logReport)
    const logKey = this.options.secrets.get(LOG_REPORT_SECRET_KEY)
    if (flag(logReport.enabled) === 1 && logKey) result.log_report = { key: logKey }
    const productImprovement = object(policy.productImprovement)
    if (flag(productImprovement.enabled) === 1 && this.options.productImprovementAvailable !== false) {
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
      patch, inheritedKeys, providers, nextLogKey, smsInfrastructure, billingInfrastructure, orgId, clientCronEnabled,
    } = await this.prepareUpdate(actor, body)
    const previousLogKey = this.options.secrets.get(LOG_REPORT_SECRET_KEY)
    try {
      if (nextLogKey !== undefined) await this.options.secrets.put(LOG_REPORT_SECRET_KEY, nextLogKey)
      const commit = () => this.options.db.transaction(async () => {
        if (Object.keys(patch).length > 0) {
          if (orgId) await this.options.policies.putOrganization(orgId, patch, actor.userId)
          else await this.options.policies.putPlatform(patch, actor.userId)
        }
        if (orgId && inheritedKeys.length > 0) {
          await this.options.policies.removeOrganizationKeys(orgId, inheritedKeys, actor.userId)
        }
        if (clientCronEnabled !== undefined && orgId !== undefined) {
          await this.options.identities.setOrganizationClientCronEnabled(orgId, clientCronEnabled)
        }
        if (smsInfrastructure) {
          await this.infrastructureSettings.put('sudowork.sms', smsInfrastructure, actor.userId)
        }
        if (billingInfrastructure) {
          await this.infrastructureSettings.put('sudowork.billing', billingInfrastructure, actor.userId)
        }
        if (providers) await this.replaceCasConnections(providers, orgId)
      })
      if (clientCronEnabled !== undefined && orgId === undefined) {
        await updateSystemSettingsWithCommit({ clientCronEnabled }, commit)
      } else await commit()
    } catch (error) {
      if (nextLogKey !== undefined) {
        if (previousLogKey !== undefined) await this.options.secrets.put(LOG_REPORT_SECRET_KEY, previousLogKey)
        else await this.options.secrets.remove(LOG_REPORT_SECRET_KEY)
      }
      throw error
    }
  }

  async validateUpdate(actor: IdentityActor, body: Json): Promise<void> {
    await this.prepareUpdate(actor, body)
  }

  private async prepareUpdate(actor: IdentityActor, body: Json): Promise<{
    patch: Json
    inheritedKeys: string[]
    providers?: NormalizedProvider[]
    nextLogKey?: string
    smsInfrastructure?: SudoworkInfrastructureConfig['sms']
    billingInfrastructure?: SudoworkInfrastructureConfig['billing']
    orgId?: string
    clientCronEnabled?: boolean
  }> {
    this.assertAdmin(actor)
    const orgId = this.policyOrgId(actor)
    const platformActor = orgId === undefined
    if (this.options.platformConfigPage && (body.sms !== undefined || body.billing !== undefined)) {
      throw new SudoworkSystemConfigError(platformActor ? 409 : 403, '公共服务连接已移至平台配置，请在平台配置页面修改')
    }
    if (body.inherit_login_method !== undefined && typeof body.inherit_login_method !== 'boolean') {
      throw new SudoworkSystemConfigError(400, 'inherit_login_method 必须为布尔值')
    }
    const patch: Json = {}
    let providers: NormalizedProvider[] | undefined
    let smsInfrastructure: SudoworkInfrastructureConfig['sms'] | undefined
    let billingInfrastructure: SudoworkInfrastructureConfig['billing'] | undefined
    let clientCronEnabled: boolean | undefined

    if (body.third_party_auth !== undefined) {
      const normalized = normalizeThirdPartyAuth(body.third_party_auth)
      providers = await Promise.all(normalized.providers.map(provider => this.validateProvider(provider, orgId)))
      if (normalized.enabled === 1 && !providers.some(provider => provider.id === normalized.defaultProvider && provider.enabled)) {
        throw new SudoworkSystemConfigError(400, '默认三方认证 Provider 不存在或未启用')
      }
      patch.thirdPartyAuth = { enabled: normalized.enabled, defaultProvider: normalized.defaultProvider }
    }

    if (body.login_method !== undefined && body.inherit_login_method !== true) {
      if (body.login_method !== 0 && body.login_method !== 1 && body.login_method !== 2) {
        throw new SudoworkSystemConfigError(400, '无效的登录方式')
      }
      if (body.login_method === 0 && !(await this.isSmsConfigured())) {
        const readiness = await this.options.getSmsReadiness?.()
        throw new SudoworkSystemConfigError(400, readiness?.reason || '短信通道未配置,无法切换到手机验证码')
      }
      if (body.login_method === 2 && !(await this.hasEnabledThirdPartyAuth(orgId, patch.thirdPartyAuth, providers))) {
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
      if (!platformActor && nextLogKey !== undefined) {
        throw new SudoworkSystemConfigError(403, '日志上报密钥属于部署级配置,仅平台超级管理员可修改')
      }
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
      if (enabled === 1 && this.options.productImprovementAvailable === false) throw new SudoworkSystemConfigError(400, '平台 QMS 服务未启用或尚未重启生效')
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
    if (body.client_cron_enabled !== undefined) {
      const requested = parseBoolean(body.client_cron_enabled, 'client_cron_enabled')
      const current = orgId
        ? (await this.options.identities.getOrganizationProfile(orgId))?.clientCronEnabled
        : getSystemSettings().clientCronEnabled
      if (current === undefined || requested !== current) clientCronEnabled = requested
    }
    if (body.client_show_tool_calls !== undefined) {
      patch.clientShowToolCalls = parseBoolean(body.client_show_tool_calls, 'client_show_tool_calls')
    }
    if (body.workspace_upload_limit_bytes !== undefined) {
      patch.workspaceUploadLimitBytes = parseWorkspaceUploadLimit(body.workspace_upload_limit_bytes)
    }
    if (body.sms !== undefined) {
      if (!platformActor) throw new SudoworkSystemConfigError(403, '短信基础设施属于部署级配置,仅平台超级管理员可修改')
      smsInfrastructure = parseSmsInfrastructure(
        body.sms,
        (await this.getInfrastructureConfig()).sms,
      )
    }
    if (body.billing !== undefined) {
      if (!platformActor) throw new SudoworkSystemConfigError(403, '支付基础设施属于部署级配置,仅平台超级管理员可修改')
      billingInfrastructure = parseBillingInfrastructure(
        body.billing,
        (await this.getInfrastructureConfig()).billing,
      )
    }
    const scoped = orgId
      ? splitPlatformInheritedValues(patch, await this.platformInheritedValues(orgId))
      : { patch, inheritedKeys: [] }
    if (body.inherit_login_method === true) {
      if (!orgId) throw new SudoworkSystemConfigError(400, '只有组织策略可跟随平台默认')
      delete scoped.patch.loginMethod
      scoped.inheritedKeys.push('loginMethod')
    }
    return {
      patch: scoped.patch,
      inheritedKeys: scoped.inheritedKeys,
      providers,
      nextLogKey,
      smsInfrastructure,
      billingInfrastructure,
      orgId,
      clientCronEnabled,
    }
  }

  async isSmsConfigured(): Promise<boolean> {
    if (this.options.getSmsReadiness) return (await this.options.getSmsReadiness()).ready
    if (this.options.smsConfigured !== undefined) return this.options.smsConfigured
    const sms = (await this.getInfrastructureConfig()).sms
    return this.options.smsRuntimeAvailable === true
      && sms.provider === 'tencent'
      && [sms.sdkAppId, sms.signName, sms.templateId, sms.region].every(Boolean)
      && (this.options.smsCredentialsAvailable === true || (
        Boolean(this.options.secrets.get('server.sudowork-tencent-secret-id'))
        && Boolean(this.options.secrets.get('server.sudowork-tencent-secret-key'))
      ))
  }

  private policy(orgId?: string): Promise<Json> {
    return this.options.policies.getEffective(orgId)
  }

  private async platformInheritedValues(orgId: string): Promise<Json> {
    const platform = await this.options.policies.getPlatform()
    const systemSettings = getSystemSettings()
    return {
      ...platform,
      loginMethod: loginMethodToNumber(await resolveEffectiveLoginMethod(this.options, orgId, { ignoreOrganizationPolicy: true })),
      logReport: platform.logReport ?? { enabled: 0, protocol: '', domain: '', keySet: Boolean(this.options.secrets.get(LOG_REPORT_SECRET_KEY)) },
      versionUpdate: platform.versionUpdate ?? { enabled: 0, cosDomain: '' },
      productImprovement: platform.productImprovement ?? { enabled: 0 },
      thirdPartyAuth: platform.thirdPartyAuth ?? { enabled: 0, defaultProvider: '' },
      scodeAutoModel: string(platform.scodeAutoModel),
      rechargeMode: rechargeMode(platform.rechargeMode),
      creditApplication: normalizeCreditApplication(platform.creditApplication),
      clientShowToolCalls: typeof platform.clientShowToolCalls === 'boolean'
        ? platform.clientShowToolCalls
        : systemSettings.clientShowToolCalls,
      workspaceUploadLimitBytes: workspaceUploadLimit(
        platform.workspaceUploadLimitBytes,
        systemSettings.workspaceUploadLimitBytes,
      ),
    }
  }

  private async thirdPartyAuth(admin: boolean, orgId?: string): Promise<Json> {
    const policy = object((await this.policy(orgId)).thirdPartyAuth)
    const profiles = orgId
      ? (await this.options.identities.listOrganizationProfiles()).filter(profile => profile.orgId === orgId)
      : await this.options.identities.listOrganizationProfiles()
    const groups = await Promise.all(profiles.map(async profile =>
      (await this.options.identities.listIntegrationConnections(profile.orgId, 'cas')).map(connection =>
        legacyProvider(connection, profile.code, admin)),
    ))
    const providers = groups.flat()
    const visibleProviders = providers.filter(item => admin || item.enabled === 1)
    const enabledProviders = visibleProviders.filter(item => item.enabled === 1)
    const configuredDefault = string(policy.defaultProvider)
    const defaultProvider = enabledProviders.some(provider => provider.id === configuredDefault)
      ? configuredDefault
      : string(enabledProviders[0]?.id as string | undefined)
    return {
      enabled: enabledProviders.length > 0 ? flag(policy.enabled) : 0,
      default_provider: defaultProvider,
      providers: visibleProviders,
    }
  }

  private async hasEnabledThirdPartyAuth(
    orgId?: string,
    policyOverride?: unknown,
    providersOverride?: NormalizedProvider[],
  ): Promise<boolean> {
    const policy = object(policyOverride ?? (await this.policy(orgId)).thirdPartyAuth)
    if (flag(policy.enabled) !== 1) return false
    const enabledProviderIds = providersOverride
      ? providersOverride
        .filter(provider => provider.enabled && (!orgId || provider.orgId === orgId))
        .map(provider => provider.id)
      : await this.enabledCasProviderIds(orgId)
    if (enabledProviderIds.length === 0) return false
    const defaultProvider = string(policy.defaultProvider)
    return !defaultProvider || enabledProviderIds.includes(defaultProvider) || enabledProviderIds.length > 0
  }

  private async enabledCasProviderIds(orgId?: string): Promise<string[]> {
    const profiles = orgId
      ? (await this.options.identities.listOrganizationProfiles()).filter(profile => profile.orgId === orgId)
      : await this.options.identities.listOrganizationProfiles()
    const groups = await Promise.all(profiles.map(async profile =>
      (await this.options.identities.listIntegrationConnections(profile.orgId, 'cas'))
        .filter(connection => connection.enabled)
        .map(connection => connection.id),
    ))
    return groups.flat()
  }

  private async validateProvider(provider: NormalizedProvider, orgScopeId?: string): Promise<NormalizedProvider> {
    if (provider.type !== 'cas') throw new SudoworkSystemConfigError(400, '当前仅支持 CAS 类型 Provider')
    if (!provider.id || !provider.name) throw new SudoworkSystemConfigError(400, 'Provider ID 和名称不能为空')
    const profile = await this.options.identities.getOrganizationProfileByCode(provider.enterpriseCode)
    if (!profile) throw new SudoworkSystemConfigError(400, `Provider 绑定企业码 ${provider.enterpriseCode} 不存在`)
    const existing = await this.options.identities.getIntegrationConnection(provider.id)
    if (orgScopeId && existing && existing.orgId !== orgScopeId) {
      throw new SudoworkSystemConfigError(403, '无权修改其他企业的三方认证 Provider')
    }
    if (orgScopeId && profile.orgId !== orgScopeId) {
      throw new SudoworkSystemConfigError(403, '无权修改其他企业的三方认证 Provider')
    }
    if (!provider.enabled) return { ...provider, orgId: profile.orgId }
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
    return { ...provider, orgId: profile.orgId }
  }

  private async replaceCasConnections(providers: NormalizedProvider[], orgScopeId?: string): Promise<void> {
    const ids = new Set(providers.map(provider => provider.id))
    const profiles = orgScopeId
      ? (await this.options.identities.listOrganizationProfiles()).filter(profile => profile.orgId === orgScopeId)
      : await this.options.identities.listOrganizationProfiles()
    for (const profile of profiles) {
      for (const existing of await this.options.identities.listIntegrationConnections(profile.orgId, 'cas')) {
        if (!ids.has(existing.id)) await this.options.identities.putIntegrationConnection({ ...existing, enabled: false })
      }
    }
    for (const provider of providers) {
      await this.options.identities.putIntegrationConnection({
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

  private policyOrgId(actor: IdentityActor): string | undefined {
    return hasGlobalOrganizationAccess(actor) ? undefined : actor.orgId
  }

  private async effectiveClientCronEnabled(orgId?: string, global = getSystemSettings().clientCronEnabled): Promise<boolean> {
    return orgId
      ? global && ((await this.options.identities.getOrganizationProfile(orgId))?.clientCronEnabled ?? true)
      : global
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

function splitPlatformInheritedValues(patch: Json, platform: Json): { patch: Json; inheritedKeys: string[] } {
  const result: Json = {}
  const inheritedKeys: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'loginMethod' && jsonEqual(value, platform[key])) inheritedKeys.push(key)
    else result[key] = value
  }
  return { patch: result, inheritedKeys }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function flag(value: unknown): 0 | 1 {
  return value === true || value === 1 || value === '1' ? 1 : 0
}

function parseBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  throw new SudoworkSystemConfigError(400, `${fieldName} 必须为布尔值`)
}

function workspaceUploadLimit(value: unknown, fallback: number): number {
  const limit = typeof value === 'number' ? value : Number.NaN
  if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 1024 * 1024 * 1024) return limit
  return fallback
}

function parseWorkspaceUploadLimit(value: unknown): number {
  const limit = typeof value === 'number' ? value : Number.NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024 * 1024) {
    throw new SudoworkSystemConfigError(400, '工作区上传限制必须为 1 至 1073741824 字节之间的整数')
  }
  return limit
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
