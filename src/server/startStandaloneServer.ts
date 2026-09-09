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
import {
  resolveBillingRuntimeConfig,
  resolveSudorouterRuntimeConfig,
  type BillingRuntimeConfig,
} from './billing/billingRuntimeConfig.js'
import { startQmsRuntime, type StartedQmsRuntime } from './qms/qmsRuntime.js'
import { QmsNexusSecretAdapter } from './qms/qmsSecretAdapter.js'
import { configureModelListSource, getAvailableModels } from './modelListCache.js'

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
  let legacyRedis: ReturnType<typeof createRedisLegacyTokenStore>['store'] | undefined
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
    legacyRedis = redis.store
    closeSudoworkRedis = redis.close
  }

  try {
    const mossOnlyTokenStore = {
      async setex(): Promise<void> { throw new Error('Sudowork legacy sessions are disabled') },
      async keys(): Promise<string[]> { return [] },
      async get(): Promise<string | null> { return null },
      async del(): Promise<void> {},
      async rotate(): Promise<boolean> { return false },
    }
    const externalBaseUrl = config.sudoworkCompatibility.publicBaseUrl
      || config.publicBaseUrl
      || ''
    const catalog = authService.createSudoworkCatalogService({
      artifactsRoot: join(config.runtimeDir, 'catalog-artifacts'),
      publicBaseUrl: externalBaseUrl,
    })
    const dify = authService.createSudoworkDifyServices({
      baseUrl: config.sudoworkCompatibility.dify.baseUrl,
      systemToken: config.sudoworkCompatibility.dify.systemToken,
      provisionSecret: config.sudoworkCompatibility.dify.provisionSecret,
      ssoSecret: config.sudoworkCompatibility.dify.ssoSecret,
      publicBaseUrl: externalBaseUrl,
      artifactsRoot: join(config.runtimeDir, 'catalog-artifacts'),
      secrets: nexusClient,
    })
    const managedImages = new ManagedImageStore(join(config.runtimeDir, 'uploads'))
    const configuration = authService.createSudoworkConfigService(store, managedImages)
    const systemConfiguration = authService.createSudoworkSystemConfigService({
      secrets: configStore,
      loginMethod: config.sudoworkCompatibility.loginMethod,
      skillhubBaseUrl: externalBaseUrl,
      sudorouterBaseUrl: process.env.SUDOROUTER_BASE_URL,
      smsRuntimeAvailable: Boolean(legacyRedis),
      smsCredentialsAvailable: Boolean(
        config.sudoworkCompatibility.sms.secretId
        && config.sudoworkCompatibility.sms.secretKey,
      ),
      sms: config.sudoworkCompatibility.sms,
      billing: {
        enabled: false,
        fuiou: { testMode: false, merchantCode: '', timeoutMs: 10_000 },
        sudorouter: {
          baseUrl: '', adminUserId: '13', timeoutMs: 10_000, initialQuota: 100_000,
          modelServiceUrl: '', modelsApiUrl: 'https://hk.sudorouter.ai/api/specific_pricing',
        },
      },
      productImprovementEncryptionRequired: process.env.QMS_TELEMETRY_ENCRYPTION_REQUIRED === 'true',
    })
    const infrastructure = systemConfiguration.getInfrastructureConfig()
    const sudorouterRuntime = resolveSudorouterRuntimeConfig({
      infrastructure: infrastructure.billing.sudorouter,
      environment: process.env,
      getSecret: key => configStore.get(key),
    })
    configureModelListSource(sudorouterRuntime?.modelsApiUrl ?? null)
    if (config.sudoworkCompatibility.enabled && !sudorouterRuntime) {
      throw new Error('Sudowork compatibility requires Sudorouter configuration')
    }
    const sudorouter = sudorouterRuntime ? new SudorouterAdapter(sudorouterRuntime) : undefined
    const accountProvisioner = sudorouter
      ? authService.createSudorouterAccountService({ provider: sudorouter, secrets: nexusClient })
      : undefined
    if (accountProvisioner && sudorouterRuntime) {
      authService.configureSudorouterAccounts({
        accountProvisioner,
        initialQuotaUnits: sudorouterRuntime.initialQuota,
      })
    }
    const identity = authService.createSudoworkIdentityService({
      tokenStore: legacyRedis ?? mossOnlyTokenStore,
      legacyJwtSecret: config.sudoworkCompatibility.legacyJwtSecret
        ?? 'moss-native-operations-no-legacy-jwt',
      accountProvisioner,
    })
    const administration = authService.createSudoworkAdministrationService({
      accountProvisioner,
      defaultInitialQuota: sudorouterRuntime?.initialQuota,
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
    const cas = legacyRedis
      ? authService.createSudoworkCasService({
          identity, tokenStore: legacyRedis, accountProvisioner,
          initialQuotaUnits: sudorouterRuntime?.initialQuota,
        })
      : undefined
    const smsConfig = infrastructure.sms
    const sms = systemConfiguration.isSmsConfigured() && legacyRedis
      ? new SmsVerificationService({
          store: legacyRedis,
          sender: createTencentSmsSender({
            secretId: config.sudoworkCompatibility.sms.secretId ?? '',
            secretKey: config.sudoworkCompatibility.sms.secretKey ?? '',
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
    const billingRuntime = resolveBillingRuntimeConfig({
      infrastructure: infrastructure.billing,
      environment: process.env,
      getSecret: key => configStore.get(key),
      readFile: path => readFileSync(path, 'utf8'),
    })
    const billing = billingRuntime
      ? createBillingCompatibilityService(
          authService,
          systemConfiguration,
          externalBaseUrl,
          billingRuntime,
          sudorouter!,
        )
      : undefined
    const legacyUsage = authService.createSudoworkLegacyUsageService({
      listModels: getAvailableModels,
      sudorouter,
    })
    const userProjection = authService.createSudoworkUserProjectionService({
      secrets: nexusClient,
      listModels: getAvailableModels,
      quotaReader: sudorouter,
      getRuntimeConfig: () => {
        const publicConfig = systemConfiguration.getPublicConfig()
        return {
          modelServiceUrl: systemConfiguration.getInfrastructureConfig().billing.sudorouter.modelServiceUrl,
          scodeAutoModel: typeof publicConfig.scode_auto_model === 'string'
            ? publicConfig.scode_auto_model
            : '',
        }
      },
    })
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
    const appOptions: Parameters<typeof createSudoworkCompatibilityApp>[0] = {
      identity,
      administration,
      legacyAdministration: administration,
      catalog,
      configuration,
      managedImages,
      systemConfiguration,
      billing,
      legacyUsage,
      getUserProjection: user => userProjection.project(user),
      rateLimit: process.env.RATE_LIMIT_ENABLED === 'false' ? undefined : legacyRedis,
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
        skillhubBaseUrl: externalBaseUrl,
      },
      qms: qmsRuntime ? {
        apiKeyHeader: qmsRuntime.apiKeyHeader,
        authorization: qmsRuntime.authorization,
        encryption: qmsRuntime.encryption,
        operations: qmsRuntime.operations,
      } : undefined,
    }
    const operationsApp = createSudoworkCompatibilityApp({
      ...appOptions,
      organizationScopedAdmin: true,
    })
    if (config.sudoworkCompatibility.enabled) {
      const compatibilityApp = createSudoworkCompatibilityApp(appOptions)
      sudoworkCompatibility = {
        hosts: config.sudoworkCompatibility.hosts,
        fetch: compatibilityApp.fetch,
        routes: compatibilityApp.routes,
      }
    }
    const mossOperations = { fetch: operationsApp.fetch }

    const server = startServer(
      config, runtime, authService, logger, nexusClient,
      sudoworkCompatibility, mossOperations,
    )
    const actualPort = (await server.ready) ?? config.port

    return finishStartedServer({
      config, runtime, authService, authProxy, nexusManager, store, instance,
      server, actualPort, qmsRuntime, closeSudoworkRedis, bootstrap,
    })
  } catch (error) {
    await qmsRuntime?.stop()
    qmsRuntime = undefined
    await closeSudoworkRedis?.()
    closeSudoworkRedis = undefined
    throw error
  }
}

function finishStartedServer(input: {
  config: ServerConfig
  runtime: RuntimeService
  authService: Awaited<ReturnType<typeof createAuthService>>['service']
  authProxy: AuthProxyServer
  nexusManager: NexusManager
  store: ReturnType<typeof openDirectConnectStore>
  instance: ReturnType<ReturnType<typeof openDirectConnectStore>['registerServerInstance']>
  server: ReturnType<typeof startServer>
  actualPort: number
  qmsRuntime?: StartedQmsRuntime
  closeSudoworkRedis?: () => Promise<void>
  bootstrap: Awaited<ReturnType<typeof createAuthService>>['bootstrap']
}) {
  const {
    config, runtime, authService, authProxy, nexusManager, store, instance,
    server, actualPort, qmsRuntime, closeSudoworkRedis, bootstrap,
  } = input
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
  runtime: BillingRuntimeConfig,
  sudorouter: SudorouterAdapter,
) {
  const payment = new FuiouAdapter({
    merchantCode: runtime.merchantCode,
    merchantPrivateKey: runtime.merchantPrivateKey,
    fuiouPublicKey: runtime.fuiouPublicKey,
    callbackUrl: `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/recharge/callback`,
    baseUrl: runtime.baseUrl,
    refundUrl: runtime.refundUrl,
    timeoutMs: runtime.timeoutMs,
    testMode: runtime.testMode,
  })
  return authService.createSudoworkBillingService({
    sudorouter, payment,
    getCreditPolicy: () => systemConfiguration.getCreditApplicationPolicy(),
    testPaymentAmountCents: runtime.testMode ? 1 : undefined,
  })
}
