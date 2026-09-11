import type { ServerConfig } from './types.js'
import { startServer } from './server.js'
import { printBanner } from './serverBanner.js'
import { createServerLogger } from './serverLog.js'
import { ensureServerDirectories } from './config.js'
import { openStoreAsync } from './db.js'
import { RuntimeService } from './runtimeService.js'
import { createAuthService } from './auth/service.js'
import { enableConfigs } from '../utils/config.js'
import { initHubConfig } from './hubConfig.js'
import { NexusManager } from './nexus/nexusManager.js'
import { NexusClient } from './nexus/nexusClient.js'
import { sendTencentSms } from './auth/smsTencent.js'
import { initConfigStore } from './configStore/configStore.js'
import { AuthProxyServer, loadAuthProxyRules } from './authProxy/authProxyServer.js'
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
  await store.ensureDefaultConfigItems()

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
  }

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
    await authProxy.stop()
    await nexusManager.stop()
    await store.stopServerInstance(instance.instanceId)
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
    const [id, key] = await Promise.all([
      nexus.getSecret(tencent.vaultNamespace, tencent.secretIdKey),
      nexus.getSecret(tencent.vaultNamespace, tencent.secretKeyKey),
    ])
    if (!id?.value || !key?.value) {
      throw new Error(
        `SMS credentials missing from the vault (${tencent.vaultNamespace}: ` +
        `${tencent.secretIdKey} / ${tencent.secretKeyKey})`,
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
      credentials: { secretId: id.value, secretKey: key.value },
    })
  }
}
