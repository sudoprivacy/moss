import { readFileSync } from 'node:fs'
import type { ServerConfig } from '../types.js'
import type { ConfigKey, ConfigStore } from '../configStore/configStore.js'
import { resolveQmsConfig } from '../qms/config.js'
import type { SudoworkInfrastructureConfig } from '../api/compat/sudowork/systemConfigService.js'
import { PLATFORM_PROVIDERS, type PlatformProvider, type PlatformValues } from './platformConfigDefinition.js'
import { PlatformConfigService, type PlatformSnapshot, type PlatformVault, validatePlatformConfig } from './platformConfigService.js'
import type { PlatformIntegrationSettingsRepository } from './platformIntegrationSettingsRepository.js'

export const PLATFORM_CREDENTIAL_GROUPS: Partial<Record<ConfigKey, PlatformProvider>> = {
  'server.sms-secret-id': 'sms', 'server.sms-secret-key': 'sms',
  'server.sudowork-tencent-secret-id': 'sms', 'server.sudowork-tencent-secret-key': 'sms',
  'server.sudorouter-api-token': 'sudorouter', 'server.sudorouter-admin-token': 'sudorouter',
  'server.fuiou-merchant-private-key': 'fuiou', 'server.fuiou-public-key': 'fuiou',
  'dify.system-token': 'dify', 'dify.system-secret': 'dify', 'dify.sso-secret': 'dify',
  'server.qms-postgres-url': 'qms', 'server.qms-redis-url': 'qms', 'server.qms-api-key': 'qms',
  'qms.default-api-key': 'qms', 'qms.telemetry-private-key': 'qms', 'server.qms-telemetry-private-key': 'qms',
  'server.qms-telemetry-public-key': 'qms', 'server.qms-lark-webhook-url': 'qms', 'server.qms-smtp-url': 'qms',
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const snapshot = (config: PlatformValues, secrets: Record<string, string>, source: string): PlatformSnapshot => ({
  config, secrets, sources: Object.fromEntries([...Object.keys(config), ...Object.keys(secrets)].map(key => [key, source])),
})

export async function legacyPlatformSnapshots(config: ServerConfig, store: ConfigStore, vault: PlatformVault,
  repository: PlatformIntegrationSettingsRepository, env: Record<string, string | undefined> = process.env,
  providers: readonly PlatformProvider[] = PLATFORM_PROVIDERS,
): Promise<Partial<Record<PlatformProvider, PlatformSnapshot>>> {
  const result: Partial<Record<PlatformProvider, PlatformSnapshot>> = {}
  const smsDb = providers.includes('sms') ? await repository.get('sudowork.sms') : undefined
  const billingDb = providers.some(id => id === 'sudorouter' || id === 'fuiou') ? await repository.get('sudowork.billing') : undefined
  const router = record(billingDb?.sudorouter)
  const fuiou = record(billingDb?.fuiou)
  const rawPay = config.systemConfig.recharge.fuiou
  const secret = (key: ConfigKey, envKey: string) => env[envKey] || store.get(key) || ''
  const fileSecret = (key: ConfigKey, envKey: string) => env[`${envKey}_FILE`]
    ? readFileSync(env[`${envKey}_FILE`]!, 'utf8')
    : env[`${envKey}_BASE64`] ? Buffer.from(env[`${envKey}_BASE64`]!, 'base64').toString('utf8') : secret(key, envKey)
  if (providers.includes('sms')) {
  const nativeSms = config.phoneAuth.enabled && config.phoneAuth.delivery === 'tencent' && config.phoneAuth.tencent
  const tencent = nativeSms || config.phoneAuth.tencent
  const nativeSecrets = await resolveNativeSmsCredentials(config, store, vault, env).catch(() => ({ secretId: '', secretKey: '' }))
  const compatibilitySecrets = env.SUDOWORK_TENCENT_SECRET_ID || env.SUDOWORK_TENCENT_SECRET_KEY
    ? { secretId: env.SUDOWORK_TENCENT_SECRET_ID || '', secretKey: env.SUDOWORK_TENCENT_SECRET_KEY || '' }
    : { secretId: store.get('server.sudowork-tencent-secret-id') || '', secretKey: store.get('server.sudowork-tencent-secret-key') || '' }
  const compatSms = { ...config.sudoworkCompatibility.sms, ...smsDb }
  const sms = snapshot({
    enabled: Boolean(nativeSms || (config.sudoworkCompatibility.enabled && compatSms.provider === 'tencent')),
    sdkAppId: str(nativeSms ? tencent?.sdkAppId : compatSms.sdkAppId), signName: str(nativeSms ? tencent?.signName : compatSms.signName),
    templateId: str(nativeSms ? tencent?.templateId : compatSms.templateId), region: str(nativeSms ? tencent?.region : compatSms.region) || 'ap-beijing',
    templateParams: nativeSms ? tencent?.templateParams ?? ['{code}', '{ttlMinutes}'] : ['{code}', '{ttlMinutes}'],
    codeTtlSec: nativeSms ? config.phoneAuth.codeTtlSec : Number(compatSms.expireMinutes) * 60,
    resendCooldownSec: nativeSms ? config.phoneAuth.resendCooldownSec : Number(compatSms.sendIntervalSeconds),
    maxSendsPerHour: config.phoneAuth.maxSendsPerHour, maxVerifyAttempts: config.phoneAuth.maxVerifyAttempts,
  }, nativeSms ? nativeSecrets : compatibilitySecrets, nativeSms ? 'phoneAuth / Nexus / environment' : 'sudoworkCompatibility / Nexus / environment')
  sms.conflicts = (['secretId', 'secretKey'] as const).filter(key => nativeSecrets[key] && compatibilitySecrets[key] && nativeSecrets[key] !== compatibilitySecrets[key])
  if (nativeSms) {
    const credentialSource = store.get('server.sms-secret-id') || store.get('server.sms-secret-key') ? 'Nexus: moss:config'
      : env.TENCENT_SECRET_ID || env.TENCENT_SECRET_KEY ? '环境变量 TENCENT_SECRET_*' : 'phoneAuth.tencent 的旧 Nexus 引用'
    sms.sources = Object.fromEntries(Object.keys(sms.config).map(key => [key, 'server.json: phoneAuth']))
    sms.sources.secretId = credentialSource; sms.sources.secretKey = credentialSource
  }
  result.sms = sms
  }
  if (providers.includes('sudorouter')) {
  const routerToken = secret('server.sudorouter-api-token', 'SUDOROUTER_API_TOKEN')
  const oldToken = secret('server.sudorouter-admin-token', 'SUDOROUTER_ADMIN_TOKEN')
  const routerSnapshot = snapshot({
    enabled: Boolean(routerToken || oldToken), baseUrl: env.SUDOROUTER_BASE_URL || str(router.baseUrl) || config.systemConfig.sudorouterBaseUrl || '',
    adminUserId: env.SUDOROUTER_ADMIN_USER_ID || str(router.adminUserId) || '13',
    timeoutMs: Number(env.SUDOROUTER_TIMEOUT_MS || router.timeoutMs || 10000),
    modelServiceUrl: env.SUDOROUTER_MODEL_SERVICE_URL || str(router.modelServiceUrl),
    modelsApiUrl: env.SUDOROUTER_MODELS_API_URL || str(router.modelsApiUrl) || 'https://hk.sudorouter.ai/api/specific_pricing',
  }, { apiToken: routerToken || oldToken }, 'environment / legacy platform / server.json / Nexus')
  routerSnapshot.conflicts = routerToken && oldToken && routerToken !== oldToken ? ['apiToken'] : []
  result.sudorouter = routerSnapshot
  }
  if (providers.includes('fuiou')) result.fuiou = snapshot({
      enabled: env.SUDOWORK_BILLING_ENABLED === undefined ? Boolean(billingDb?.enabled ?? config.systemConfig.rechargeMode === 'pay') : env.SUDOWORK_BILLING_ENABLED === 'true',
      testMode: env.FUIOU_TEST_MODE === undefined ? Boolean(fuiou.testMode ?? rawPay.testMode) : env.FUIOU_TEST_MODE === 'true',
      merchantCode: env.FUIOU_MERCHANT_CODE || str(fuiou.merchantCode) || rawPay.merchantCode || '',
      timeoutMs: Number(env.FUIOU_TIMEOUT_MS || fuiou.timeoutMs || rawPay.timeoutMs),
      ...Object.fromEntries(['testApiUrl', 'prodApiUrl', 'testRefundUrl', 'prodRefundUrl'].map(key => {
        const envKey = 'FUIOU_' + key.replace(/[A-Z]/g, c => '_' + c).toUpperCase()
        return [key, env[envKey] || str(fuiou[key]) || str(record(rawPay)[key])]
      })), callbackBaseUrl: config.systemConfig.recharge.fuiou.callbackBaseUrl || '',
    }, { merchantPrivateKey: fileSecret('server.fuiou-merchant-private-key', 'FUIOU_MERCHANT_PRIVATE_KEY'),
      publicKey: fileSecret('server.fuiou-public-key', 'FUIOU_PUBLIC_KEY') }, 'environment / legacy platform / server.json / Nexus')
  if (providers.includes('dify')) result.dify = snapshot({ enabled: Boolean(config.sudoworkCompatibility.dify.baseUrl), baseUrl: config.sudoworkCompatibility.dify.baseUrl, timeoutMs: config.sudoworkCompatibility.dify.timeoutMs ?? 330000 }, {
      systemToken: config.sudoworkCompatibility.dify.systemToken || '', provisionSecret: config.sudoworkCompatibility.dify.provisionSecret || '',
      ssoSecret: config.sudoworkCompatibility.dify.ssoSecret || '',
    }, 'environment / server.json / Nexus')
  if (providers.includes('qms')) {
    const qms = config.qms ?? resolveQmsConfig({}, {})
    result.qms = snapshot({ enabled: qms.enabled, apiKeyHeader: qms.apiKeyHeader, encryptionRequired: qms.encryptionRequired,
      queueFlushIntervalMs: qms.queue.flushIntervalMs, queueBatchSize: qms.queue.batchSize,
      perfRetentionDays: qms.retention.perfDays, conversationRetentionDays: qms.retention.conversationDays,
    }, Object.fromEntries(Object.entries(qms.secrets).map(([key, value]) => [key, value || ''])), 'environment / server.json / Nexus')
  }
  return result
}

export function applyPlatformRuntime(service: PlatformConfigService, config: ServerConfig, store: ConfigStore): void {
  const manage = (id: PlatformProvider, mappings: Record<string, ConfigKey[]>) => {
    if (!service.isManaged(id)) return
    const active = service.getActive(id)
    for (const [key, aliases] of Object.entries(mappings)) for (const alias of aliases) {
      store.setManaged(alias, active.secrets[key] || undefined)
    }
  }
  manage('sms', { secretId: ['server.sms-secret-id', 'server.sudowork-tencent-secret-id'], secretKey: ['server.sms-secret-key', 'server.sudowork-tencent-secret-key'] })
  manage('sudorouter', { apiToken: ['server.sudorouter-api-token', 'server.sudorouter-admin-token'] })
  manage('fuiou', { merchantPrivateKey: ['server.fuiou-merchant-private-key'], publicKey: ['server.fuiou-public-key'] })
  manage('dify', { systemToken: ['dify.system-token'], provisionSecret: ['dify.system-secret'], ssoSecret: ['dify.sso-secret'] })
  manage('qms', { postgresUrl: ['server.qms-postgres-url'], redisUrl: ['server.qms-redis-url'], apiKey: ['server.qms-api-key', 'qms.default-api-key', 'client.product-improvement-api-key'],
    privateKeyPem: ['server.qms-telemetry-private-key', 'qms.telemetry-private-key'], publicKeyPem: ['server.qms-telemetry-public-key', 'client.product-improvement-public-key'],
    larkWebhookUrl: ['server.qms-lark-webhook-url'], smtpUrl: ['server.qms-smtp-url'] })
  store.hydrateConfig(config)
  if (service.isManaged('sms') || (!config.phoneAuth.enabled && config.sudoworkCompatibility.enabled && service.getActive('sms').config.enabled)) {
    const c = service.getActive('sms').config
    Object.assign(config.phoneAuth, { enabled: c.enabled, delivery: 'tencent', codeTtlSec: c.codeTtlSec,
      resendCooldownSec: c.resendCooldownSec, maxSendsPerHour: c.maxSendsPerHour, maxVerifyAttempts: c.maxVerifyAttempts,
      tencent: { sdkAppId: c.sdkAppId, signName: c.signName, templateId: c.templateId, region: c.region,
        templateParams: c.templateParams, vaultNamespace: service.isManaged('sms') ? '' : 'moss:config',
        secretIdKey: service.isManaged('sms') ? '' : 'server.sudowork-tencent-secret-id',
        secretKeyKey: service.isManaged('sms') ? '' : 'server.sudowork-tencent-secret-key' } })
    Object.assign(config.sudoworkCompatibility.sms, { provider: c.enabled ? 'tencent' : 'disabled', sdkAppId: c.sdkAppId,
      signName: c.signName, templateId: c.templateId, region: c.region, expireMinutes: Number(c.codeTtlSec) / 60,
      sendIntervalSeconds: c.resendCooldownSec })
  }
  if (service.isManaged('sudorouter')) {
    const c = service.getActive('sudorouter').config
    config.systemConfig.sudorouterBaseUrl = c.enabled ? str(c.baseUrl) : ''
    config.systemConfig.sudorouterEnabled = c.enabled === true
    config.systemConfig.sudorouterAdminUserId = str(c.adminUserId)
    config.systemConfig.sudorouterTimeoutMs = Number(c.timeoutMs)
  }
  if (service.isManaged('fuiou')) {
    const c = service.getActive('fuiou').config
    Object.assign(config.systemConfig.recharge.fuiou, c)
    config.systemConfig.recharge.fuiou.enabled = c.enabled === true
    config.systemConfig.recharge.fuiou.callbackBaseUrl = str(c.callbackBaseUrl)
  }
  if (service.isManaged('dify')) {
    const c = service.getActive('dify').config
    config.sudoworkCompatibility.dify.baseUrl = c.enabled ? str(c.baseUrl) : ''
    config.sudoworkCompatibility.dify.timeoutMs = Number(c.timeoutMs)
  }
  if (service.isManaged('qms')) {
    const { config: c, secrets } = service.getActive('qms')
    config.qms = resolveQmsConfig(c, {
      QMS_POSTGRES_URL: secrets.postgresUrl, QMS_REDIS_URL: secrets.redisUrl, QMS_API_KEY: secrets.apiKey,
      QMS_TELEMETRY_PRIVATE_KEY: secrets.privateKeyPem, QMS_TELEMETRY_PUBLIC_KEY: secrets.publicKeyPem,
      QMS_LARK_WEBHOOK_URL: secrets.larkWebhookUrl, QMS_SMTP_URL: secrets.smtpUrl,
    })
  }
}

export function platformInfrastructure(service: PlatformConfigService, legacy: SudoworkInfrastructureConfig): SudoworkInfrastructureConfig {
  const result = structuredClone(legacy)
  if (service.isManaged('sms')) {
    const c = service.getActive('sms').config
    Object.assign(result.sms, { ...c, provider: c.enabled ? 'tencent' : 'disabled', expireMinutes: Number(c.codeTtlSec) / 60, sendIntervalSeconds: c.resendCooldownSec })
  }
  if (service.isManaged('sudorouter')) {
    const c = service.getActive('sudorouter').config
    Object.assign(result.billing.sudorouter, c, { baseUrl: c.enabled ? c.baseUrl : '', modelServiceUrl: c.enabled ? c.modelServiceUrl : '', modelsApiUrl: c.enabled ? c.modelsApiUrl : '' })
  }
  if (service.isManaged('fuiou')) {
    const c = service.getActive('fuiou').config
    result.billing.enabled = c.enabled === true
    Object.assign(result.billing.fuiou, c)
  }
  return result
}
export function platformEnvironment(service: PlatformConfigService, env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    if (service.isManaged('sudorouter') && key.startsWith('SUDOROUTER_')) return false
    if (service.isManaged('fuiou') && (key.startsWith('FUIOU_') || key === 'SUDOWORK_BILLING_ENABLED')) return false
    return true
  }))
}
export async function smsReadiness(service: PlatformConfigService, config: ServerConfig, store: ConfigStore, vault: PlatformVault) {
  if (service.isManaged('sms')) {
    const active = service.getActive('sms')
    const issues = validatePlatformConfig('sms', active)
    return { ready: active.config.enabled === true && issues.length === 0, reason: active.config.enabled ? issues.join('；') : '平台短信服务未启用或尚未重启生效' }
  }
  if (!config.phoneAuth.enabled || config.phoneAuth.delivery !== 'tencent' || !config.phoneAuth.tencent) {
    const legacy = service.getActive('sms')
    const issues = validatePlatformConfig('sms', legacy)
    if (config.sudoworkCompatibility.enabled && legacy.config.enabled) return { ready: issues.length === 0, reason: issues.join('；') }
    return { ready: false, reason: '短信通道未启用，请在平台配置中配置腾讯短信并重启生效' }
  }
  const c = config.phoneAuth.tencent
  if (!c.templateParams?.some(value => value.includes('{code}'))) return { ready: false, reason: '短信模板参数必须包含 {code}' }
  const missing = ['sdkAppId', 'signName', 'templateId', 'region'].filter(key => !str(record(c)[key]).trim())
  if (missing.length) return { ready: false, reason: `短信配置缺少：${missing.join('、')}` }
  try {
    const { secretId, secretKey } = await resolveNativeSmsCredentials(config, store, vault)
    return { ready: Boolean(secretId && secretKey), reason: secretId && secretKey ? undefined : '腾讯短信 Secret ID / Secret Key 未配置或不完整' }
  } catch { return { ready: false, reason: '短信凭据暂不可读取，请检查 Nexus 服务' } }
}

/** Resolve an entire credential pair from one source; never mix accounts. */
export async function resolveNativeSmsCredentials(config: ServerConfig, store: ConfigStore, vault: PlatformVault,
  env: Record<string, string | undefined> = process.env) {
  const tencent = config.phoneAuth.tencent
  if (tencent?.secretIdKey === 'server.sudowork-tencent-secret-id') {
    if (env.SUDOWORK_TENCENT_SECRET_ID || env.SUDOWORK_TENCENT_SECRET_KEY) return { secretId: env.SUDOWORK_TENCENT_SECRET_ID || '', secretKey: env.SUDOWORK_TENCENT_SECRET_KEY || '' }
    return { secretId: store.get('server.sudowork-tencent-secret-id') || '', secretKey: store.get('server.sudowork-tencent-secret-key') || '' }
  }
  const storedId = store.get('server.sms-secret-id') || ''
  const storedKey = store.get('server.sms-secret-key') || ''
  if (storedId || storedKey || store.isManaged('server.sms-secret-id')) return { secretId: storedId, secretKey: storedKey }
  if (env.TENCENT_SECRET_ID || env.TENCENT_SECRET_KEY) return { secretId: env.TENCENT_SECRET_ID || '', secretKey: env.TENCENT_SECRET_KEY || '' }
  if (!tencent?.vaultNamespace || !tencent.secretIdKey || !tencent.secretKeyKey) return { secretId: '', secretKey: '' }
  const [id, key] = await Promise.all([vault.getSecret(tencent.vaultNamespace, tencent.secretIdKey), vault.getSecret(tencent.vaultNamespace, tencent.secretKeyKey)])
  return { secretId: id?.value || '', secretKey: key?.value || '' }
}
