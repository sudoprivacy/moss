import type { ServerConfig } from './types.js'
import { startServer } from './server.js'
import { printBanner } from './serverBanner.js'
import { createServerLogger } from './serverLog.js'
import { ensureServerDirectories } from './config.js'
import { openDirectConnectStore } from './db.js'
import { RuntimeService } from './runtimeService.js'
import { createAuthService } from './auth/service.js'
import { enableConfigs } from '../utils/config.js'
import { initHubConfig } from './hubConfig.js'
import { NexusManager } from './nexus/nexusManager.js'
import { NexusClient } from './nexus/nexusClient.js'
import { initConfigStore } from './configStore/configStore.js'
import { AuthProxyServer, configItemToRule } from './authProxy/authProxyServer.js'
import { TokenMinter } from './authProxy/tokenMinter.js'
import { setSecretsApiDependencies } from './authProxy/secretsApi.js'
import type { NexusClient as NexusClientType } from './nexus/nexusClient.js'
import { createSudoworkCompatibilityApp } from './api/compat/sudowork/app.js'
import { createRedisLegacyTokenStore } from './api/compat/sudowork/redisLegacyStore.js'
import { SmsVerificationService } from './identity/smsVerification.js'
import { createTencentSmsSender } from './identity/tencentSmsSender.js'
import { ManagedImageStore } from './configuration/managedImageStore.js'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SudorouterAdapter } from './billing/sudorouterAdapter.js'
import { FuiouAdapter } from './billing/fuiouAdapter.js'
import { startQmsRuntime, type StartedQmsRuntime } from './qms/qmsRuntime.js'
import { QmsNexusSecretAdapter } from './qms/qmsSecretAdapter.js'
import { getAvailableModels } from './modelListCache.js'

export type StandaloneServerOptions = ServerConfig

export async function startStandaloneDirectConnectServer(
  config: ServerConfig,
): Promise<{
  config: ServerConfig
  port: number
  httpUrl: string
  bootstrapAdminUsername?: string
  bootstrapAdminApiKey?: string
  bootstrapAdminEmail?: string
  bootstrapAdminPassword?: string
  stop: () => Promise<void>
}> {
  enableConfigs()
  await ensureServerDirectories(config)

  // Nexus is the secrets backend (required, no in-memory fallback). Depending
  // on MOSS_NEXUS_MODE this either spawns an embedded `serve-local` daemon
  // (default) or connects to an external production `nexusd-cluster` over mTLS
  // without spawning anything (start() is connect-only in that mode).
  const nexusManager = new NexusManager()

  await nexusManager.start()
  try {
    return await finishStandaloneServerStartup(config, nexusManager)
  } catch (error) {
    await nexusManager.stop().catch(stopError => {
      process.stderr.write(
        `[Startup] failed to stop Nexus after startup error: ${stopError instanceof Error ? stopError.message : String(stopError)}\n`,
      )
    })
    throw error
  }
}

async function finishStandaloneServerStartup(
  config: ServerConfig,
  nexusManager: NexusManager,
) {
  const nexusClient: NexusClientType = new NexusClient(
    nexusManager.grpcUrl,
    nexusManager.authToken,
    nexusManager.tlsConfig,
  )
  console.log(
    `[Startup] Nexus ready for secrets management (gRPC ${nexusManager.mode} mode, endpoint=${nexusManager.grpcUrl})`,
  )

  // Config store: probe-sandwich load (fail-fast), then hydrate the
  // already-parsed ServerConfig snapshot in place with the Nexus values.
  // The sensitive fields' file values are discarded during hydration — Nexus
  // (+ env) is the sole source; operators enter them via the admin UI.
  // initHubConfig runs after hydration so it consumes the Nexus-backed
  // hubAuthorization (previously it ran before Nexus started, on file values).
  const configStore = initConfigStore(nexusClient)
  await configStore.loadAll()
  configStore.hydrateConfig(config)
  if (config.qms.enabled && !config.sudoworkCompatibility.enabled) {
    throw new Error('QMS requires Sudowork compatibility to be enabled so its frozen routes are reachable')
  }
  initHubConfig({
    hubApiBaseUrl: config.hubApiBaseUrl,
    hubAuthorization: config.hubAuthorization,
    cosBaseUrl: config.cosBaseUrl,
  })

  // Initialize store and ensure default config items exist before Auth Proxy starts
  const store = openDirectConnectStore(config)
  store.ensureDefaultConfigItems()

  // Start Auth Proxy (create instance, will load rules after DB is ready)
  const authProxy = new AuthProxyServer()
  if (nexusClient) {
    authProxy.setNexusClient(nexusClient)
  }
  try {
    await authProxy.start()
  } catch (error) {
    console.error('[Startup] Failed to start Auth Proxy:', error instanceof Error ? error.message : error)
    throw error
  }

  const { service: authService, bootstrap } = await createAuthService({
    db: store.db,
    dbPath: config.dbPath,
    tokenTtlSec: config.tokenTtlSec,
    bootstrapAdmin: config.bootstrapAdmin,
  })
  const instance = store.registerServerInstance(config.host)

  // Multi-org backfill: now that organizations exist (auth bootstrap ran), assign
  // a default org to any pre-existing credential/secret/channel rows so they
  // aren't stranded global. Idempotent (only NULL org_id rows are touched).
  const defaultOrgId = authService.listAllOrganizations().organizations[0]?.id
  if (defaultOrgId) {
    store.backfillOrgScoping(defaultOrgId)
  }

  // Token minter for login-type 凭据 (mints + caches a per-user access_token
  // from the user's stored credential), backed by the encrypted
  // minted_service_tokens cache via AuthService.
  authProxy.setTokenMinter(new TokenMinter(authService.getMintedTokenStore()))

  // Load config item rules into Auth Proxy now that DB is available
  const activeItems = store.getAllActiveConfigItems()
  authProxy.updateRules(
    activeItems.map(item => configItemToRule(item, id => store.getConfigEntries(id))),
  )
  const policyProvider = {
    getAuthorizedConfigItemIds(departmentId: string): number[] {
      return store.getDepartmentPolicies(departmentId).map(r => r.config_item_id as number)
    },
  }
  authProxy.setPolicyProvider(policyProvider)
  // Hierarchical department-credential value inheritance: resolve a department's
  // ordered ancestor chain so an authorized consumer inherits the nearest
  // ancestor's value when their own department has none.
  authProxy.setDeptAncestorProvider((orgId, departmentId) =>
    authService.getDepartmentAncestorChain(orgId, departmentId),
  )
  setSecretsApiDependencies(
    nexusClient,
    policyProvider,
    () => store.getAllActiveConfigItems() as unknown as Array<{ id: number; scope: string; pinyin: string }>,
    (orgId, departmentId) => authService.getDepartmentAncestorChain(orgId, departmentId),
  )
  const runtime = new RuntimeService({
    config,
    store,
    authService,
    serverInstanceId: instance.instanceId,
    nexusClient,
  })
  runtime.authProxy = authProxy
  await runtime.reconcileOnStartup()

  const logger = createServerLogger()
  let closeSudoworkRedis: (() => Promise<void>) | undefined
  let qmsRuntime: StartedQmsRuntime | undefined
  let sudoworkCompatibility: {
    hosts: readonly string[]
    fetch: ReturnType<typeof createSudoworkCompatibilityApp>['fetch']
    routes: ReturnType<typeof createSudoworkCompatibilityApp>['routes']
  } | undefined
  if (config.sudoworkCompatibility.enabled) {
    if (config.sudoworkCompatibility.hosts.length === 0) {
      throw new Error('Sudowork compatibility requires at least one trusted host')
    }
    if (!config.sudoworkCompatibility.legacyJwtSecret) {
      throw new Error('Sudowork compatibility requires SUDOWORK_LEGACY_JWT_SECRET or its Nexus value')
    }
    if (!config.sudoworkCompatibility.redisUrl) {
      throw new Error('Sudowork compatibility requires SUDOWORK_REDIS_URL or its Nexus value')
    }
    if (!config.sudoworkCompatibility.publicBaseUrl) {
      throw new Error('Sudowork compatibility requires sudoworkCompatibility.publicBaseUrl')
    }
    const redis = createRedisLegacyTokenStore(config.sudoworkCompatibility.redisUrl)
    closeSudoworkRedis = redis.close
    try {
    const identity = authService.createSudoworkIdentityService({
      tokenStore: redis.store,
      legacyJwtSecret: config.sudoworkCompatibility.legacyJwtSecret,
    })
    const administration = authService.createSudoworkAdministrationService({
      getDifyFeatureFlags: () => {
        const values: Record<string, string | undefined> = {
          DIFY_BASE_URL: config.sudoworkCompatibility.dify.baseUrl,
          DIFY_SYSTEM_TOKEN: config.sudoworkCompatibility.dify.systemToken,
          DIFY_SYSTEM_SECRET: config.sudoworkCompatibility.dify.provisionSecret,
          DIFY_SSO_SECRET: config.sudoworkCompatibility.dify.ssoSecret,
        }
        const missingEnv = Object.entries(values)
          .filter(([, value]) => !value?.trim())
          .map(([key]) => key)
        return { enabled: missingEnv.length === 0, missingEnv }
      },
    })
    const cas = authService.createSudoworkCasService({ identity, tokenStore: redis.store })
    const catalog = authService.createSudoworkCatalogService({
      artifactsRoot: join(config.runtimeDir, 'catalog-artifacts'),
      publicBaseUrl: config.sudoworkCompatibility.publicBaseUrl,
    })
    const dify = authService.createSudoworkDifyServices({
      baseUrl: config.sudoworkCompatibility.dify.baseUrl,
      systemToken: config.sudoworkCompatibility.dify.systemToken,
      provisionSecret: config.sudoworkCompatibility.dify.provisionSecret,
      ssoSecret: config.sudoworkCompatibility.dify.ssoSecret,
      publicBaseUrl: config.sudoworkCompatibility.publicBaseUrl,
      artifactsRoot: join(config.runtimeDir, 'catalog-artifacts'),
      secrets: nexusClient,
    })
    const managedImages = new ManagedImageStore(join(config.runtimeDir, 'uploads'))
    const configuration = authService.createSudoworkConfigService(store, managedImages)
    const smsConfig = config.sudoworkCompatibility.sms
    const smsConfigured = smsConfig.provider === 'tencent' && [
      smsConfig.secretId, smsConfig.secretKey, smsConfig.sdkAppId,
      smsConfig.signName, smsConfig.templateId, smsConfig.signId,
    ].every(value => typeof value === 'string' && value.trim().length > 0)
    const sms = smsConfig.provider === 'tencent'
      ? new SmsVerificationService({
          store: redis.store,
          sender: createTencentSmsSender({
            secretId: smsConfig.secretId ?? '',
            secretKey: smsConfig.secretKey ?? '',
            sdkAppId: smsConfig.sdkAppId,
            signName: smsConfig.signName,
            templateId: smsConfig.templateId,
            signId: smsConfig.signId,
            region: smsConfig.region,
          }),
          codeLength: smsConfig.codeLength,
          expireMinutes: smsConfig.expireMinutes,
          sendIntervalSeconds: smsConfig.sendIntervalSeconds,
          maxPerDay: smsConfig.maxPerDay,
        })
      : undefined
    const systemConfiguration = authService.createSudoworkSystemConfigService({
      secrets: configStore,
      loginMethod: config.sudoworkCompatibility.loginMethod,
      skillhubBaseUrl: config.sudoworkCompatibility.publicBaseUrl,
      sudorouterBaseUrl: process.env.SUDOROUTER_BASE_URL,
      smsConfigured,
      productImprovementEncryptionRequired: process.env.QMS_TELEMETRY_ENCRYPTION_REQUIRED === 'true',
    })
    const billingEnabled = process.env.SUDOWORK_BILLING_ENABLED === 'true'
    const billing = billingEnabled
      ? createBillingCompatibilityService(authService, systemConfiguration, config.sudoworkCompatibility.publicBaseUrl)
      : undefined
    const legacyUsage = authService.createSudoworkLegacyUsageService({ listModels: getAvailableModels })
    const qmsSecrets = new QmsNexusSecretAdapter(config.qms, {
      get: key => configStore.get(key),
      put: (key, value) => configStore.put(key, value, config),
    })
    qmsRuntime = await startQmsRuntime({
      config: config.qms,
      ownerId: instance.instanceId,
      organizations: authService.createQmsOrganizationDirectory(),
      secrets: qmsSecrets,
      environment: {
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        PORT: config.port,
        HOST: config.host,
        LOG_LEVEL: config.logLevel,
      },
    })
    const app = createSudoworkCompatibilityApp({
      identity,
      administration,
      legacyAdministration: administration,
      catalog,
      configuration,
      managedImages,
      systemConfiguration,
      billing,
      legacyUsage,
      rateLimit: process.env.RATE_LIMIT_ENABLED === 'false' ? undefined : redis.store,
      difyRuntime: dify.runtime,
      difyEnhancement: dify.enhancement,
      difyDataset: dify.dataset,
      difyAdministration: dify.administration,
      resolveEnterpriseAlias: dify.resolveEnterpriseAlias,
      buildVisibility: dify.buildVisibility,
      difyUpstreamBaseUrl: config.sudoworkCompatibility.dify.baseUrl,
      cas,
      loginMethod: config.sudoworkCompatibility.loginMethod,
      sms,
      systemConfig: {
        skillhubBaseUrl: config.sudoworkCompatibility.publicBaseUrl,
      },
      qms: qmsRuntime ? {
        apiKeyHeader: qmsRuntime.apiKeyHeader,
        authorization: qmsRuntime.authorization,
        encryption: qmsRuntime.encryption,
        operations: qmsRuntime.operations,
      } : undefined,
    })
    sudoworkCompatibility = {
      hosts: config.sudoworkCompatibility.hosts,
      fetch: app.fetch,
      routes: app.routes,
    }
    } catch (error) {
      await qmsRuntime?.stop()
      qmsRuntime = undefined
      await closeSudoworkRedis?.()
      closeSudoworkRedis = undefined
      throw error
    }
  }
  let server: ReturnType<typeof startServer>
  let actualPort: number
  try {
    server = startServer(config, runtime, authService, logger, nexusClient, sudoworkCompatibility)
    actualPort = (await server.ready) ?? config.port
  } catch (error) {
    await qmsRuntime?.stop()
    await closeSudoworkRedis?.()
    throw error
  }
  const connectHost =
    config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  const httpUrl = `http://${connectHost}:${actualPort}`

  printBanner(
    {
      host: config.host,
      port: actualPort,
    },
    actualPort,
  )

  const heartbeatTimer = setInterval(() => {
    store.heartbeatServerInstance(instance.instanceId)
  }, Math.max(5_000, Math.floor(config.heartbeatTimeoutMs / 2)))
  heartbeatTimer.unref?.()

  // Concurrent multi-instance HA: periodically adopt sessions orphaned by a dead
  // instance so a survivor takes them over within ~a heartbeat timeout, instead
  // of only on the next restart. The claim CAS makes concurrent survivors safe.
  const adoptionTimer = setInterval(() => {
    void runtime.adoptOrphanedSessions().catch((err: unknown) => {
      process.stderr.write(
        `[server] adoptOrphanedSessions failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })
  }, Math.max(5_000, config.heartbeatTimeoutMs))
  adoptionTimer.unref?.()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearInterval(heartbeatTimer)
    clearInterval(adoptionTimer)
    authService.destroy()
    if (config.docker?.containerMode === 'user') {
      try {
        const reg = await import('./runtime/userContainerRegistry.js')
        await reg.shutdownAll(config)
      } catch (err) {
        process.stderr.write(
          `[Startup] failed to drain user containers during shutdown: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }
    await server.stop()
    await qmsRuntime?.stop()
    await closeSudoworkRedis?.()
    await authProxy.stop()
    await nexusManager.stop()
    store.stopServerInstance(instance.instanceId)
    store.close()
  }

  return {
    config,
    port: actualPort,
    httpUrl,
    bootstrapAdminUsername: bootstrap.bootstrapAdminUsername,
    bootstrapAdminApiKey: bootstrap.bootstrapAdminApiKey,
    bootstrapAdminEmail: bootstrap.bootstrapAdminEmail,
    bootstrapAdminPassword: bootstrap.bootstrapAdminPassword,
    stop,
  }
}

function createBillingCompatibilityService(
  authService: Awaited<ReturnType<typeof createAuthService>>['service'],
  systemConfiguration: ReturnType<typeof authService.createSudoworkSystemConfigService>,
  publicBaseUrl: string,
) {
  const required = (name: string): string => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`Sudowork Billing requires ${name}`)
    return value
  }
  const testMode = process.env.FUIOU_TEST_MODE === 'true'
  const privateKey = readFuiouKey('private')
  const publicKey = readFuiouKey('public')
  const payment = new FuiouAdapter({
    merchantCode: required('FUIOU_MERCHANT_CODE'),
    merchantPrivateKey: privateKey,
    fuiouPublicKey: publicKey,
    callbackUrl: `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/recharge/callback`,
    baseUrl: process.env[testMode ? 'FUIOU_TEST_API_URL' : 'FUIOU_PROD_API_URL'],
    refundUrl: process.env[testMode ? 'FUIOU_TEST_REFUND_URL' : 'FUIOU_PROD_REFUND_URL'],
    timeoutMs: Number.parseInt(process.env.FUIOU_TIMEOUT_MS || '10000', 10),
    testMode,
  })
  const sudorouter = new SudorouterAdapter({
    baseUrl: required('SUDOROUTER_BASE_URL'),
    apiToken: required('SUDOROUTER_API_TOKEN'),
    adminUserId: process.env.SUDOROUTER_ADMIN_USER_ID || '13',
    timeoutMs: Number.parseInt(process.env.SUDOROUTER_TIMEOUT_MS || '10000', 10),
  })
  return authService.createSudoworkBillingService({
    sudorouter, payment,
    getCreditPolicy: () => systemConfiguration.getCreditApplicationPolicy(),
    testPaymentAmountCents: testMode ? 1 : undefined,
  })
}

function readFuiouKey(type: 'private' | 'public'): string {
  const prefix = type === 'private' ? 'FUIOU_MERCHANT_PRIVATE_KEY' : 'FUIOU_PUBLIC_KEY'
  const file = process.env[`${prefix}_FILE`]?.trim()
  if (file) return readFileSync(file, 'utf8')
  const encoded = process.env[`${prefix}_BASE64`]?.trim()
  if (encoded) return Buffer.from(encoded, 'base64').toString('utf8')
  return process.env[prefix]?.trim() || (() => { throw new Error(`Sudowork Billing requires ${prefix}`) })()
}
