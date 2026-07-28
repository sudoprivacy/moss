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
import { AuthProxyServer, configItemToRule } from './authProxy/authProxyServer.js'
import { TokenMinter } from './authProxy/tokenMinter.js'
import { setSecretsApiDependencies } from './authProxy/secretsApi.js'
import type { NexusClient as NexusClientType } from './nexus/nexusClient.js'

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
  initHubConfig({
    hubApiBaseUrl: config.hubApiBaseUrl,
    hubAuthorization: config.hubAuthorization,
    cosBaseUrl: config.cosBaseUrl,
  })
  await ensureServerDirectories(config)

  const nexusDisabled = process.env.MOSS_NEXUS_DISABLED === '1' || process.env.MOSS_NEXUS_DISABLED === 'true'
  const nexusManager = nexusDisabled ? null : new NexusManager()
  let nexusClient: NexusClientType | undefined

  if (nexusManager) {
    await nexusManager.start()
    nexusClient = new NexusClient(nexusManager.grpcUrl)
    console.log('[Startup] Nexus started successfully for secrets management (gRPC mode)')
  } else {
    console.warn('[Startup] Nexus disabled by MOSS_NEXUS_DISABLED; secrets-backed features are unavailable')
  }

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
    await nexusManager?.stop().catch(() => {})
    process.exit(1)
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
  if (nexusClient) {
    setSecretsApiDependencies(
      nexusClient,
      policyProvider,
      () => store.getAllActiveConfigItems() as unknown as Array<{ id: number; scope: string; pinyin: string }>,
      (orgId, departmentId) => authService.getDepartmentAncestorChain(orgId, departmentId),
    )
  }
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
  const server = startServer(config, runtime, authService, logger, nexusClient)
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
    store.heartbeatServerInstance(instance.instanceId)
  }, Math.max(5_000, Math.floor(config.heartbeatTimeoutMs / 2)))
  heartbeatTimer.unref?.()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearInterval(heartbeatTimer)
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
    await authProxy.stop()
    // Only stop nexusManager if it was started (not in fallback mode)
    if (nexusManager && nexusManager['child'] !== null) {
      await nexusManager.stop()
    }
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
