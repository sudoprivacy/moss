// Extracted from server.ts for testability: importing the whole server.js
// pulls in node:sqlite (bun cannot load it) AND bun:bundle (node cannot load
// it), so its unit tests ran under neither runner. Keep this module free of
// node:sqlite and bun: imports — both runners must be able to load it (same
// convention as workspaceText.ts).
import { execFile } from 'child_process'
import { promisify } from 'util'
import type http from 'http'
import type { ServerConfig } from './types.js'
import type { RuntimeService } from './runtimeService.js'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { resolveNexusConfigFromEnv, type ResolvedNexusConfig } from './nexus/nexusManager.js'

/**
 * One client per endpoint, reused across polls.
 *
 * /readyz is polled by the load balancer on a short interval; a client per poll
 * would open a gRPC channel per poll and never close it.
 */
const probeClients = new Map<string, NexusVfsClient>()

function probeClientFor(nexusConfig: ResolvedNexusConfig): { client: NexusVfsClient; token: string } {
  const endpoint = nexusConfig.mode === 'external'
    ? nexusConfig.endpoint
    : `127.0.0.1:${nexusConfig.grpcPort}`
  const token = nexusConfig.mode === 'external' ? nexusConfig.authToken : ''
  let client = probeClients.get(endpoint)
  if (!client) {
    const tls = nexusConfig.mode === 'external' ? nexusConfig.tls : null
    client = tls ? NexusVfsClient.withMtls(endpoint, tls) : new NexusVfsClient(endpoint)
    probeClients.set(endpoint, client)
  }
  return { client, token }
}

export function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Sticky-routing cookie for multi-instance LB deployments (Nginx
 * `map $cookie_moss_route`). Only set when `config.instanceId` is configured
 * (`MOSS_INSTANCE_ID`) — single-instance deployments keep their current
 * behavior (no Set-Cookie at all). HttpOnly + SameSite=Lax per the HA design;
 * `Secure` is appended when MOSS_ROUTE_COOKIE_SECURE=true (HTTPS entry).
 * Called once at the top of the HTTP handler so every response (API, static,
 * SSE, unauthenticated) carries it; WS upgrades don't pass through the HTTP
 * handler, but browser WebSocket handshakes send cookies automatically.
 */
export function setRouteCookieHeader(res: http.ServerResponse, config: ServerConfig): void {
  if (!config.instanceId) return
  const parts = [
    `${config.routeCookieName}=${config.instanceId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (config.routeCookieSecure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

const execFileAsync = promisify(execFile)

/** Readiness probe surface for /readyz — injectable for unit tests (M5). */
export type ReadinessProbes = {
  isDraining(): boolean
  probeDb(): Promise<boolean>
  probeNexus(): Promise<boolean>
  probeDocker(): Promise<boolean>
  probeK8s(): Promise<boolean>
}

export type ReadinessResult = {
  ok: boolean
  ready: boolean
  instance_id: string | null
  checks: {
    db: boolean
    nexus: boolean
    /** null = not applicable (defaultRuntime has nothing to probe, e.g. host). */
    runtime: boolean | null
    /** null unless defaultRuntime='k8s' (same probe as checks.runtime then). */
    k8s: boolean | null
    draining: boolean
  }
  httpStatus: 200 | 503
}

async function probeWithTimeout(probe: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([probe, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Readiness for /readyz (LB removal signal). Checks run in parallel
 * (Promise.allSettled; per-probe timeout: db/nexus/docker 2s, k8s 5s — kubectl
 * cold start + TLS can exceed 2s). `ready = !draining && db && nexus &&
 * (runtime !== false)`. Probes are injectable so unit tests get deterministic
 * behavior without a live nexus listener or docker/kubectl binaries.
 */
export async function computeReadiness(
  config: ServerConfig,
  runtime: RuntimeService,
  probes?: Partial<ReadinessProbes>,
): Promise<ReadinessResult> {
  const isDraining = probes?.isDraining ?? (() => false)
  const probeDb =
    probes?.probeDb ??
    (async () => {
      try {
        // Driver seam, not the raw sqlite handle: on the postgres construction
        // form `store.db` is undefined (the schema lives in pg_schema.ts).
        await runtime.store.driver.get('SELECT 1 AS ok')
        return true
      } catch {
        return false
      }
    })
  const probeNexus =
    probes?.probeNexus ??
    (async () => {
      // A real RPC, not a TCP connect. nexusd binds its port early — that port
      // is the raft data plane, and peers need it to form the cluster — while
      // the VFS service co-hosted on it only starts answering once the kernel
      // is wired and the declared topology has converged. So an accepted
      // connection says the process is alive, not that it can serve, and from
      // nexus-vfs v0.7.7 the daemon is explicit about the difference: requests
      // in that window are held, not answered.
      //
      // Reporting ready there is the failure this whole check exists to
      // prevent — the load balancer sends traffic to an instance whose nexus
      // cannot yet answer, and every one of those requests waits or fails.
      // serverInfo is the cheapest call that only a serving VFS can satisfy.
      const nexusConfig = resolveNexusConfigFromEnv()
      try {
        const { client, token } = probeClientFor(nexusConfig)
        await client.serverInfo(token)
        return true
      } catch {
        return false
      }
    })
  const probeDocker =
    probes?.probeDocker ??
    (async () => {
      try {
        await execFileAsync('docker', ['info'], { timeout: 2_000 })
        return true
      } catch {
        return false
      }
    })
  const probeK8s =
    probes?.probeK8s ??
    (async () => {
      // kubeconfig is optional (kubectl then falls back to its own defaults);
      // only pass --kubeconfig when set, mirroring k8sBackend's optional wiring.
      const args: string[] = []
      if (config.k8s?.kubeconfig) args.push('--kubeconfig', config.k8s.kubeconfig)
      args.push('get', '--raw', '/readyz')
      try {
        await execFileAsync('kubectl', args, { timeout: 5_000 })
        return true
      } catch {
        return false
      }
    })

  const draining = isDraining()
  const settled = await Promise.allSettled([
    probeWithTimeout(probeDb(), 2_500),
    probeWithTimeout(probeNexus(), 2_500),
    // 5.5s outer bound > the 5s kubectl timeout inside the default probe.
    probeWithTimeout(
      config.defaultRuntime === 'docker'
        ? probeDocker()
        : config.defaultRuntime === 'k8s'
          ? probeK8s()
          : Promise.resolve<boolean | null>(null),
      5_500,
    ),
  ])
  // A probe rejecting (e.g. resolveNexusConfigFromEnv throwing on a misconfigured
  // https endpoint) must degrade to "not ready" (503), not crash /readyz into a
  // 500 — hence allSettled with rejected → false.
  const db = settled[0].status === 'fulfilled' ? settled[0].value : false
  const nexus = settled[1].status === 'fulfilled' ? settled[1].value : false
  const runtimeProbe = settled[2].status === 'fulfilled' ? settled[2].value : false

  const runtimeCheck = config.defaultRuntime === 'host' ? null : runtimeProbe
  const ready = !draining && db && nexus && runtimeCheck !== false
  return {
    ok: ready,
    ready,
    instance_id: config.instanceId ?? null,
    checks: {
      db,
      nexus,
      runtime: runtimeCheck,
      k8s: config.defaultRuntime === 'k8s' ? runtimeCheck : null,
      draining,
    },
    httpStatus: ready ? 200 : 503,
  }
}
