import { PlatformConfigService } from './configuration/platformConfigService.js'
import { PlatformIntegrationSettingsRepository } from './configuration/platformIntegrationSettingsRepository.js'
import { legacyPlatformSnapshots, applyPlatformRuntime, platformInfrastructure, platformEnvironment, smsReadiness, resolveNativeSmsCredentials } from './configuration/platformConfigRuntime.js'
import type { ServerConfig } from './types.js'
import { startServer } from './server.js'
import { printBanner } from './serverBanner.js'
import { createServerLogger } from './serverLog.js'
import { ensureServerDirectories } from './config.js'
import { openStoreAsync } from './db.js'
import { RuntimeService } from './runtimeService.js'
import { createAuthService } from './auth/service.js'
import { repairConfigAvailability } from './configuration/configAvailabilitySchema.js'
import { ensureCompatibilityCoreSchema, ensureSqliteCompatibilityDomainSchemas } from './db/compatibilitySchema.js'
import { enableConfigs } from '../utils/config.js'
import { initHubConfig } from './hubConfig.js'
import { NexusManager } from './nexus/nexusManager.js'
import { NexusClient } from './nexus/nexusClient.js'
import { getConfigStore } from './configStore/configStore.js'
import { sendTencentSms } from './auth/smsTencent.js'
import { initConfigStore } from './configStore/configStore.js'
import { AuthProxyServer, loadAuthProxyRules } from './authProxy/authProxyServer.js'
import { TokenMinter } from './authProxy/tokenMinter.js'
import { setSecretsApiDependencies } from './authProxy/secretsApi.js'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createSudoworkCompatibilityApp } from './api/compat/sudowork/app.js'
import { createRedisLegacyTokenStore, type RedisLegacyTokenStore } from './api/compat/sudowork/redisLegacyStore.js'
import { SmsVerificationService } from './identity/smsVerification.js'
import { createTencentSmsSender } from './identity/tencentSmsSender.js'
import { ManagedImageStore } from './configuration/managedImageStore.js'
import { SudorouterAdapter } from './billing/sudorouterAdapter.js'
import { FuiouAdapter } from './billing/fuiouAdapter.js'
import {
  resolveBillingRuntimeConfig,
  resolveSudorouterRuntimeConfig,
  type BillingRuntimeConfig,
} from './billing/billingRuntimeConfig.js'
import { startQmsRuntime, type StartedQmsRuntime } from './qms/qmsRuntime.js'
import { QmsNexusSecretAdapter } from './qms/qmsSecretAdapter.js'
import { getAvailableModels } from './modelListCache.js'
import { getSystemSettings } from './systemSettings.js'
import { migrateLegacyModelSettings } from './configuration/migrateLegacyModelSettings.js'
import { migrateLegacyEnterpriseCronPolicy } from './migration/legacyEnterpriseCronPolicy.js'
import { migrateLegacySudorouterCredentials } from './migration/legacySudorouterCredentials.js'
import type { LegacyKeyValueStore } from './identity/legacyToken.js'
import type { NexusClient as NexusClientType } from './nexus/nexusClient.js'
import { assertSafeInstanceIdentity } from './startupGuards.js'

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

/**
 * Wait until the HTTP connection count reaches zero or the timeout elapses.
 * Reality check: Nginx upstream `keepalive` idle connections linger on the
 * socket, so reaching zero is rare — timing out at the grace period is the
 * expected (designed) outcome; the grace window exists precisely to give the
 * LB time to stop routing new traffic before the process exits.
 */
async function waitForIdleConnections(
  getConnections: () => Promise<number>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await getConnections()) === 0) return
    } catch {
      return // server handle already gone — proceed to cleanup
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
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
  // Cross-instance refresh (R20): another instance editing a Nexus-backed
  // sensitive config is picked up within one poll and hydrated in place, so a
  // peer's new sessions use the new value instead of staying stale until
  // restart. Stopped in server.stop.
  configStore.startRefreshPolling(config)
  // HA misconfig guard (R8): with a multi-instance id but no public base URL,
  // the internal channel loops back to itself and owner routing loses its route
  // params — cron/events/channels to non-local sessions fail 100%. ha.yml's
  // `:?` already refuses to start on a missing value; this is the belt for a
  // hand-set instanceId that bypassed compose. Not fail-fast: a single instance
  // legitimately setting instanceId must not be blocked.
  if (config.instanceId && !config.publicBaseUrl) {
    console.warn(
      '[Startup] MOSS_INSTANCE_ID is set but MOSS_PUBLIC_BASE_URL is not — under HA the ' +
      'internal channel loops back to this instance and owner routing fails for sessions ' +
      'owned by other instances. Set MOSS_PUBLIC_BASE_URL to the LB entry (http://<LB-VIP>).',
    )
  }
  initHubConfig({
    hubApiBaseUrl: config.hubApiBaseUrl,
    hubAuthorization: config.hubAuthorization,
    cosBaseUrl: config.cosBaseUrl,
  })

  // Initialize store and ensure default config items exist before Auth Proxy starts
  const store = await openStoreAsync(config)
  await store.driver.exec(`CREATE TABLE IF NOT EXISTS platform_integration_settings (
    setting_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by TEXT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  )`)
  const platformConfig = new PlatformConfigService({
    driver: store.driver, vault: nexusClient, instanceId: config.instanceId || `standalone-${process.pid}`,
    legacy: providers => legacyPlatformSnapshots(config, configStore, nexusClient, new PlatformIntegrationSettingsRepository(store.driver), process.env, providers),
  })
  await platformConfig.initialize()
  applyPlatformRuntime(platformConfig, config, configStore)

  const sqliteDb = store.db
  if (sqliteDb) {
    ensureSqliteCompatibilityDomainSchemas(sqliteDb, { legacyClientCronEnabled: getSystemSettings().clientCronEnabled })
    ensureCompatibilityCoreSchema(sqliteDb)
  }
  await store.ensureDefaultConfigItems()
  await repairConfigAvailability(store.driver)

  // E-5: a live peer without MOSS_INSTANCE_ID → refuse to start.
  // The container-name suffix, docker label filter and wiki claim column all
  // collapse to the 'default' fallback when instanceId is unset, which makes
  // two such instances claim-kill each other's containers and stage dirs.
  // publicBaseUrl is deliberately not a signal here: legacy single-node
  // installs set it so generated links are externally reachable.
  // We cannot know our own row yet (registration happens below), so the
  // live-peer count uses an empty-string sentinel — before registration
  // there is no self row to exclude, and `instance_id != ''` holds for every
  // real UUID row. (Never pass config.instanceId here: undefined bind values
  // throw in the driver.)
  if (!config.instanceId) {
    const livePeerCount = await store.countLiveOtherInstances('', config.heartbeatTimeoutMs)
    assertSafeInstanceIdentity(config, livePeerCount)
  }
  // B-9: sqlite backend + instanceId set + live peers sharing the file →
  // refuse: the advisory-lock seam is a no-op passthrough on sqlite, so
  // cross-instance mutual exclusion (source sync etc.) silently degrades to
  // double-runs. (The unset-id HA case is already caught by the guard above.)
  if (store.driver.kind === 'sqlite' && config.instanceId) {
    const peers = await store.countLiveOtherInstances(config.instanceId, config.heartbeatTimeoutMs)
    if (peers > 0) {
      throw new Error(
        `[Startup] Refusing to start: ${peers} live instance(s) are registered against the shared SQLite file, ` +
          'but the sqlite backend has no cross-process mutual exclusion (advisory locks are a no-op there) — ' +
          'two processes would double-run source syncs and races. Use the postgres backend for multi-instance HA.',
      )
    }
  }

  // A-10: cross-host clock-skew visibility. Liveness judgements compare
  // heartbeats written by OTHER hosts against this host's Date.now() (30s
  // threshold; the 90s fencing watchdog bounds the damage), so HA hosts are
  // expected to be NTP-synced — see deploy/nginx/README-ha.md. Advisory
  // only: compare our clock against the DB's once at boot and warn on skew.
  try {
    const row = store.driver.kind === 'postgres'
      ? await store.driver.get<{ ts: number | string }>(`SELECT (extract(epoch from now()) * 1000) AS ts`)
      : await store.driver.get<{ ts: number | string }>(`SELECT (CAST(strftime('%s','now') AS INTEGER) * 1000) AS ts`)
    const dbNow = Number(row?.ts ?? 0)
    if (dbNow > 0 && Math.abs(Date.now() - dbNow) > 5_000) {
      console.warn(
        `[Startup] Host clock differs from the database clock by ${Math.round((Date.now() - dbNow) / 1000)}s — ` +
          'liveness thresholds assume NTP-synced hosts; large skew causes spurious fences or delayed takeovers.',
      )
    }
  } catch {
    // Advisory only — never block startup on it.
  }

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

  // SMS credentials are fetched from the vault per send, not cached at boot:
  // rotating a leaked key should take effect on the next code, not on the next
  // restart. The lookup is cheap next to the provider round-trip it precedes.
  const smsSender = buildSmsSender(config, nexusClient)

  const { service: authService, bootstrap } = await createAuthService({
    db: store,
    dbPath: config.dbPath,
    tokenTtlSec: config.tokenTtlSec,
    bootstrapAdmin: config.bootstrapAdmin,
    phoneAuth: config.phoneAuth,
    smsSender,
  })
  if (config.phoneAuth.enabled && config.phoneAuth.delivery === 'log') {
    // Said once, loudly, at boot rather than only per code: a deployment that
    // enabled self-service signup without wiring an SMS provider is handing
    // account access to anyone who can read the server log.
    console.warn(
      '[PhoneAuth] ENABLED with delivery=log — verification codes are written to ' +
      'the server log. Anyone who can read the log can sign in as any number. ' +
      'Development and single-operator use only.',
    )
  }
  const instance = await store.registerServerInstance(config.host, undefined, config.instanceId)

  // Multi-org backfill: now that organizations exist (auth bootstrap ran), assign
  // a default org to any pre-existing credential/secret/channel rows so they
  // aren't stranded global. Idempotent (only NULL org_id rows are touched).
  const defaultOrgId = (await authService.listAllOrganizations()).organizations[0]?.id
  if (defaultOrgId) {
    await store.backfillOrgScoping(defaultOrgId)
    await migrateLegacyModelSettings(store.driver, defaultOrgId)
  }
  await migrateLegacyEnterpriseCronPolicy(store.driver)

  // Token minter for login-type 凭据 (mints + caches a per-user access_token
  // from the user's stored credential), backed by the encrypted
  // minted_service_tokens cache via AuthService.
  authProxy.setTokenMinter(new TokenMinter(authService.getMintedTokenStore()))

  // Load config item rules into Auth Proxy now that DB is available
  await loadAuthProxyRules(store, authProxy)
  // HA: pick up config-items changes made on OTHER instances (this instance's
  // rules are process-local memory; the API callback only fires locally).
  authProxy.startRulesChangePolling(
    () => store.getConfigRulesFingerprint(),
    () => loadAuthProxyRules(store, authProxy),
  )
  const policyProvider = {
    async getAuthorizedConfigItemIds(departmentId: string): Promise<number[]> {
      return (await store.getDepartmentPolicies(departmentId)).map(r => r.config_item_id as number)
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
    async () => (await store.getAllActiveConfigItems()) as unknown as Array<{ id: number; scope: string; pinyin: string }>,
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

  const disabledTokenStore: LegacyKeyValueStore = {
    async setex(): Promise<void> { throw new Error('Sudowork legacy sessions are disabled') },
    async keys(): Promise<string[]> { return [] },
    async get(): Promise<string | null> { return null },
    async del(): Promise<void> {},
    async rotate(): Promise<boolean> { return false },
  }
  let legacyTokenStore: LegacyKeyValueStore = disabledTokenStore
  let redisLegacyTokenStore: RedisLegacyTokenStore | undefined
  if (config.sudoworkCompatibility.enabled) {
    if (config.sudoworkCompatibility.hosts.length === 0) {
      throw new Error('Sudowork compatibility requires at least one trusted host')
    }
    if (!config.sudoworkCompatibility.legacyJwtSecret) {
      throw new Error('Sudowork compatibility requires SUDOWORK_LEGACY_JWT_SECRET')
    }
    if (!config.sudoworkCompatibility.redisUrl) {
      throw new Error('Sudowork compatibility requires SUDOWORK_REDIS_URL')
    }
    const redis = createRedisLegacyTokenStore(config.sudoworkCompatibility.redisUrl)
    legacyTokenStore = redis.store
    redisLegacyTokenStore = redis.store
    closeSudoworkRedis = redis.close
  }

  const publicBaseUrl = config.sudoworkCompatibility.publicBaseUrl || config.publicBaseUrl || ''
  const managedImages = new ManagedImageStore(join(config.runtimeDir, 'uploads'))
  const catalog = authService.createSudoworkCatalogService({
    artifactsRoot: join(config.runtimeDir, 'catalog-artifacts'),
    publicBaseUrl,
  })
  const systemConfiguration = authService.createSudoworkSystemConfigService({
    secrets: configStore,
    loginMethod: config.systemConfig.loginMethod === 0 ? 'sms' : config.systemConfig.loginMethod === 2 ? 'cas' : 'password',
    platformConfigPage: true,
    productImprovementAvailable: platformConfig.isManaged('qms') ? config.qms?.enabled === true : undefined,
    getSmsReadiness: () => smsReadiness(platformConfig, config, configStore, nexusClient),
    resolveInfrastructure: legacy => platformInfrastructure(platformConfig, legacy),
    skillhubBaseUrl: publicBaseUrl,
    sudorouterBaseUrl: process.env.SUDOROUTER_BASE_URL,
    smsRuntimeAvailable: config.sudoworkCompatibility.enabled,
    smsCredentialsAvailable: Boolean(
      config.sudoworkCompatibility.sms.secretId && config.sudoworkCompatibility.sms.secretKey,
    ),
    sms: config.sudoworkCompatibility.sms,
    billing: {
      enabled: config.systemConfig.rechargeMode === 'pay',
      fuiou: {
        testMode: config.systemConfig.recharge.fuiou.testMode,
        merchantCode: config.systemConfig.recharge.fuiou.merchantCode ?? '',
        timeoutMs: config.systemConfig.recharge.fuiou.timeoutMs,
        testApiUrl: config.systemConfig.recharge.fuiou.testApiUrl,
        prodApiUrl: config.systemConfig.recharge.fuiou.prodApiUrl,
        testRefundUrl: config.systemConfig.recharge.fuiou.testRefundUrl,
        prodRefundUrl: config.systemConfig.recharge.fuiou.prodRefundUrl,
      },
      sudorouter: {
        baseUrl: process.env.SUDOROUTER_BASE_URL || config.systemConfig.sudorouterBaseUrl || '',
        adminUserId: process.env.SUDOROUTER_ADMIN_USER_ID || '13',
        timeoutMs: Number.parseInt(process.env.SUDOROUTER_TIMEOUT_MS || '10000', 10),
        initialQuota: config.systemConfig.initialPoints > 0 ? config.systemConfig.initialPoints : 100_000,
        modelServiceUrl: process.env.SUDOROUTER_MODEL_SERVICE_URL || '',
        modelsApiUrl: process.env.SUDOROUTER_MODELS_API_URL || 'https://hk.sudorouter.ai/api/specific_pricing',
      },
    },
    productImprovementEncryptionRequired: platformConfig.isManaged('qms') ? config.qms?.encryptionRequired === true : process.env.QMS_TELEMETRY_ENCRYPTION_REQUIRED === 'true',
  })
  if (platformConfig.isManaged('sudorouter')) {
    const c = platformConfig.getActive('sudorouter').config
    const root = String(c.baseUrl || '').replace(/\/+$/, '')
    const modelServiceUrl = String(c.modelServiceUrl || `${root}/v1`)
    authService.configurePlatformRouterModel({ enabled: c.enabled === true, modelServiceUrl, modelsApiUrl: String(c.modelsApiUrl || `${modelServiceUrl}/models`) })
  }
  const configuration = authService.createSudoworkConfigService(store, managedImages, systemConfiguration)
  const infrastructure = await systemConfiguration.getInfrastructureConfig()
  const sudorouterRuntime = platformConfig.isManaged('sudorouter') && !platformConfig.getActive('sudorouter').config.enabled ? null : resolveSudorouterRuntimeConfig({
    infrastructure: infrastructure.billing.sudorouter,
    environment: platformEnvironment(platformConfig),
    getSecret: key => configStore.get(key),
  })
  const sudorouter = sudorouterRuntime ? new SudorouterAdapter(sudorouterRuntime) : undefined
  if (sudorouter) {
    // Use the resolved platform adapter; a disabled integration skips adoption too.
    const migrated = await migrateLegacySudorouterCredentials(store.driver, sudorouter, nexusClient)
    if (migrated.imported > 0) console.info(`[Startup] Adopted ${migrated.imported} existing Sudorouter credentials`)
  }
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
    tokenStore: legacyTokenStore,
    legacyJwtSecret: config.sudoworkCompatibility.legacyJwtSecret ?? 'moss-operations-only',
    accountProvisioner,
    getLoginMethod: orgId => systemConfiguration.getLoginMethod(orgId),
  })
  const administration = authService.createSudoworkAdministrationService({
    accountProvisioner,
    defaultInitialQuota: sudorouterRuntime?.initialQuota,
  })
  const cas = authService.createSudoworkCasService({
        identity,
        tokenStore: legacyTokenStore,
        accountProvisioner,
        initialQuotaUnits: sudorouterRuntime?.initialQuota,
        getLoginMethod: orgId => systemConfiguration.getLoginMethod(orgId),
      })
  const dify = platformConfig.isManaged('dify') && !platformConfig.getActive('dify').config.enabled ? undefined : authService.createSudoworkDifyServices({
    timeoutMs: config.sudoworkCompatibility.dify.timeoutMs,
    baseUrl: config.sudoworkCompatibility.dify.baseUrl,
    systemToken: config.sudoworkCompatibility.dify.systemToken,
    provisionSecret: config.sudoworkCompatibility.dify.provisionSecret,
    ssoSecret: config.sudoworkCompatibility.dify.ssoSecret,
    publicBaseUrl,
    artifactsRoot: join(config.runtimeDir, 'catalog-artifacts'),
    secrets: nexusClient,
  })
  const smsConfig = infrastructure.sms
  const sms = await systemConfiguration.isSmsConfigured() && redisLegacyTokenStore
    ? new SmsVerificationService({
        store: redisLegacyTokenStore,
        sender: smsSender ? { send: input => smsSender(input.phone, input.code) } : createTencentSmsSender({
          secretId: config.sudoworkCompatibility.sms.secretId ?? '',
          secretKey: config.sudoworkCompatibility.sms.secretKey ?? '',
          sdkAppId: smsConfig.sdkAppId,
          signName: smsConfig.signName,
          templateId: smsConfig.templateId,
          signId: smsConfig.signId,
          region: smsConfig.region,
        }),
        codeLength: smsConfig.codeLength,
        expireMinutes: smsSender ? Math.max(1, Math.round(config.phoneAuth.codeTtlSec / 60)) : smsConfig.expireMinutes,
        sendIntervalSeconds: smsSender ? config.phoneAuth.resendCooldownSec : smsConfig.sendIntervalSeconds,
        maxPerDay: smsConfig.maxPerDay,
      })
    : undefined
  const billingRuntime = !sudorouter ? null : resolveBillingRuntimeConfig({
    infrastructure: platformConfig.isManaged('fuiou') && platformConfig.getActive('fuiou').secrets.merchantPrivateKey ? { ...infrastructure.billing, enabled: true } : infrastructure.billing,
    environment: platformEnvironment(platformConfig),
    getSecret: key => configStore.get(key),
    readFile: path => readFileSync(path, 'utf8'),
  })
  const billing = sudorouter
    ? createBillingCompatibilityService(authService, systemConfiguration, config.systemConfig.recharge.fuiou.callbackBaseUrl || publicBaseUrl, billingRuntime, sudorouter, infrastructure.billing.enabled)
    : undefined
  const listOrganizationModels = async (orgId?: string) => {
    const settings = orgId
      ? await authService.getOrganizationSystemSettings(orgId)
      : getSystemSettings()
    return getAvailableModels({ settings, orgId })
  }
  const legacyUsage = authService.createSudoworkLegacyUsageService({
    listModels: listOrganizationModels,
    sudorouter,
  })
  const userProjection = authService.createSudoworkUserProjectionService({
    secrets: nexusClient,
    listModels: listOrganizationModels,
    quotaReader: sudorouter,
    getRuntimeConfig: async orgId => ({
      modelServiceUrl: (await systemConfiguration.getInfrastructureConfig()).billing.sudorouter.modelServiceUrl,
      scodeAutoModel: String((await systemConfiguration.getPublicConfig(orgId)).scode_auto_model ?? ''),
    }),
  })
  qmsRuntime = await startQmsRuntime({
    config: config.qms,
    ownerId: instance.instanceId,
    organizations: authService.createQmsOrganizationDirectory(),
    secrets: new QmsNexusSecretAdapter(config.qms, {
      get: key => configStore.get(key),
      put: (key, value) => configStore.put(key, value, config),
    }),
    environment: {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      PORT: config.port,
      HOST: config.host,
      LOG_LEVEL: config.logLevel,
    },
  })
  const compatibilityAppOptions: Parameters<typeof createSudoworkCompatibilityApp>[0] = {
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
    rateLimit: config.sudoworkCompatibility.enabled ? redisLegacyTokenStore : undefined,
    difyRuntime: dify?.runtime,
    difyEnhancement: dify?.enhancement,
    difyDataset: dify?.dataset,
    difyAdministration: dify?.administration,
    resolveEnterpriseAlias: dify?.resolveEnterpriseAlias,
    buildVisibility: dify?.buildVisibility,
    difyUpstreamBaseUrl: config.sudoworkCompatibility.dify.baseUrl,
    cas,
    loginMethod: config.sudoworkCompatibility.loginMethod,
    sms,
    systemConfig: { skillhubBaseUrl: publicBaseUrl },
    qms: qmsRuntime ? {
      apiKeyHeader: qmsRuntime.apiKeyHeader,
      authorization: qmsRuntime.authorization,
      encryption: qmsRuntime.encryption,
      operations: qmsRuntime.operations,
    } : undefined,
  }
  const mossOperationsApp = createSudoworkCompatibilityApp({
    ...compatibilityAppOptions,
    organizationScopedAdmin: true,
  })
  const sudoworkCompatibility = config.sudoworkCompatibility.enabled
    ? (() => {
        const app = createSudoworkCompatibilityApp(compatibilityAppOptions)
        return {
          hosts: config.sudoworkCompatibility.hosts,
          fetch: app.fetch,
          routes: app.routes,
        }
      })()
    : undefined

  const server = startServer(
    config,
    runtime,
    authService,
    logger,
    nexusClient,
    sudoworkCompatibility,
    { fetch: mossOperationsApp.fetch },
    platformConfig,
    cas,
  )
  const platformVersionTimer = setInterval(() => { void platformConfig.reportVersions().catch(() => {}) }, 30_000)
  platformVersionTimer.unref()
  const actualPort = (await server.ready) ?? config.port
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
    void store.heartbeatServerInstance(instance.instanceId)
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

  // k8s runtime: periodically reap pods/Secrets orphaned by crashes (no-op
  // unless k8s is the active runtime). Startup already sweeps once; this catches
  // leaks that accrue while the server runs.
  const k8sGcTimer = setInterval(() => {
    void runtime.gcOrphanedK8sPods()
  }, Math.max(60_000, config.heartbeatTimeoutMs * 2))
  k8sGcTimer.unref?.()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    // Graceful drain (multi-instance LB): flip /readyz to 503 so the LB stops
    // routing new traffic, then keep serving existing WS/SSE — and keep
    // heartbeating (we still own our attempts) — until connections drain or
    // the grace timeout elapses. shutdownGraceMs=0 (default) skips this
    // entirely: stop() proceeds straight to the existing cleanup chain,
    // preserving single-instance behavior. Heartbeat clearing stays BELOW the
    // drain on purpose: while draining we must remain a live owner so other
    // instances don't adopt sessions we are still serving.
    if (config.shutdownGraceMs > 0) {
      server.beginDrain()
      await waitForIdleConnections(server.getConnections, config.shutdownGraceMs)
    }
    clearInterval(heartbeatTimer)
    clearInterval(adoptionTimer)
    clearInterval(k8sGcTimer)
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
    clearInterval(platformVersionTimer)
    await qmsRuntime?.stop()
    await closeSudoworkRedis?.()
    await authProxy.stop()
    await nexusManager.stop()
    // M-13: a transient DB error here used to reject the whole stop() chain,
    // skipping store.close(); the peer heartbeat timeout reaps the stale row
    // either way, so just log it and keep closing.
    try {
      await store.stopServerInstance(instance.instanceId)
    } catch (err) {
      console.error(
        '[Shutdown] failed to mark server instance stopped (peer heartbeat timeout will reap it):',
        err,
      )
    }
    await store.close()
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
  runtime: BillingRuntimeConfig | null,
  sudorouter: SudorouterAdapter,
  paymentsEnabled = true,
) {
  const payment = runtime ? new FuiouAdapter({
    merchantCode: runtime.merchantCode,
    merchantPrivateKey: runtime.merchantPrivateKey,
    fuiouPublicKey: runtime.fuiouPublicKey,
    callbackUrl: `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/recharge/callback`,
    baseUrl: runtime.baseUrl,
    refundUrl: runtime.refundUrl,
    timeoutMs: runtime.timeoutMs,
    testMode: runtime.testMode,
  }) : undefined
  return authService.createSudoworkBillingService({
    sudorouter,
    payment,
    paymentsEnabled,
    getCreditPolicy: orgId => systemConfiguration.getCreditApplicationPolicy(orgId),
    testPaymentAmountCents: runtime?.testMode ? 1 : undefined,
  })
}


/**
 * Build the SMS sender for the configured provider, or undefined when codes go
 * to the log. Credentials are read from the Nexus vault at send time — they are
 * never in `server.json`, so a config file that leaks cannot send messages.
 */
function buildSmsSender(
  config: ServerConfig,
  nexus: NexusClientType,
): ((phone: string, code: string) => Promise<void>) | undefined {
  if (!config.phoneAuth.enabled || config.phoneAuth.delivery === 'log') return undefined

  const tencent = config.phoneAuth.tencent
  if (!tencent) {
    throw new Error("phoneAuth.delivery is 'tencent' but phoneAuth.tencent is not configured")
  }

  return async (phone: string, code: string) => {
    const { secretId, secretKey } = await resolveNativeSmsCredentials(config, getConfigStore(), nexus)
    if (!secretId || !secretKey) {
      throw new Error(
        'SMS credentials are not configured. Set them on the server credentials '
        + `page (server.sms-secret-id / server.sms-secret-key), or in the vault `
        + `(${tencent.vaultNamespace}: ${tencent.secretIdKey} / ${tencent.secretKeyKey}).`,
      )
    }
    await sendTencentSms({
      phone,
      code,
      settings: {
        sdkAppId: tencent.sdkAppId,
        signName: tencent.signName,
        templateId: tencent.templateId,
        region: tencent.region,
        templateParams: tencent.templateParams,
      },
      // Templates commonly state the validity window; keep it in step with the
      // TTL actually enforced rather than hardcoding a number in the message.
      ttlMinutes: Math.max(1, Math.round(config.phoneAuth.codeTtlSec / 60)),
      credentials: { secretId, secretKey },
    })
  }
}
