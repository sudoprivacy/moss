/**
 * Per-user long-lived Docker container registry. Only runs in the moss-server
 * main process — runner subprocesses must not import this module (they have
 * no shared memory with the main process and would build a divergent view).
 *
 * Container lifecycle:
 *   - ensureUserContainer: create (or reuse) `moss-user-<hash>` for an
 *     (orgId, userId) tuple, under PerKeyMutex.
 *   - acquireSession / releaseSession: refcount sessions inside the
 *     container. The idle timer arms when count drops to 0 and is cancelled
 *     when it climbs back to 1.
 *   - onIdleFire: triggered by the idle timer; double-checks count under the
 *     mutex and runs `docker stop` + `docker rm`.
 *   - reconcile: rebuild registry on moss-server startup from
 *     `docker ps --filter label=moss.kind=user-container`.
 *
 * The mutex serializes ensure / acquire / release / onIdleFire so race
 * scenarios like "ensure sees 'dead' twice and creates two containers" are
 * impossible.
 */

import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { MOSS_HOME } from '../../utils/skills/localSkillDirectories.js'
import type { ServerConfig } from '../types.js'
import { PerKeyMutex } from './perKeyMutex.js'
import { toHostPath } from './dockerPathMap.js'
import { logRuntimeEvent, logRuntimeMetric } from './runtimeMetrics.js'

export type UserContainerState = 'starting' | 'running' | 'draining' | 'dead'

export type UserContainerRecord = {
  key: string
  containerName: string
  containerId: string
  imageDigest: string
  configHash: string
  createdAt: number
  lastActiveAt: number
  activeSessionIds: Set<string>
  idleTimer: NodeJS.Timeout | null
  state: UserContainerState
  pendingRebuild: boolean
}

export type EnsureContext = {
  orgId: string
  userId: string
  role: string
  scopes: string[]
  image: string | undefined
}

export type DockerExecResult = {
  code: number
  stdout: string
  stderr: string
}

// Module-level singleton so the registry is shared across imports in the
// main process. The dynamic import from runtimeService picks this up.
const mutex = new PerKeyMutex()
const registry = new Map<string, UserContainerRecord>()

function key(orgId: string, userId: string): string {
  return `${orgId}:${userId}`
}

/** moss-user-<hash12> avoids leaking orgId/userId into the docker container
 * name and stays within Docker's 63-char limit. */
export function buildUserContainerName(orgId: string, userId: string): string {
  const hash = createHash('sha1')
    .update(`${orgId}:${userId}`)
    .digest('hex')
    .slice(0, 12)
  return `moss-user-${hash}`
}

function configHash(input: {
  mossHome: string
  runtimeDir: string
  containerEnvKeys: string[]
  resources: { pidsLimit: number; memory: string; cpus: string; nofile: number }
}): string {
  const payload = JSON.stringify({
    mossHome: input.mossHome,
    runtimeDir: input.runtimeDir,
    containerEnvKeys: [...input.containerEnvKeys].sort(),
    resources: input.resources,
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function runDocker(args: string[]): Promise<DockerExecResult> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString('utf8') })
    child.stderr?.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', err => {
      resolve({ code: -1, stdout, stderr: stderr || String(err) })
    })
    child.on('close', code => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function dockerInspectAlive(name: string): Promise<boolean> {
  const result = await runDocker(['inspect', '--format', '{{.State.Running}}', name])
  if (result.code !== 0) return false
  return result.stdout.trim() === 'true'
}

const CONTAINER_ENV_KEYS = [
  'MOSS_SESSION_USER_ID',
  'MOSS_SESSION_ORG_ID',
  'MOSS_SESSION_ROLE',
  'MOSS_SESSION_SCOPES',
  'MOSS_SERVER_URL',
  'MOSS_HOME',
  'SUDOWORK_AUTH_PROXY_URL',
  'SUDOWORK_AUTH_PROXY_BASE_URL',
  'ANTHROPIC_BASE_URL',
]

async function doCreate(
  config: ServerConfig,
  ctx: EnsureContext,
  rec: UserContainerRecord,
): Promise<void> {
  const image = ctx.image || config.dockerImage
  if (!image) {
    throw new Error('docker.image not configured; cannot create user container')
  }

  const userResources = config.docker?.user ?? {
    pidsLimit: 512, memory: '4g', cpus: '2', nofile: 4096,
  }
  rec.configHash = configHash({
    mossHome: MOSS_HOME,
    runtimeDir: config.runtimeDir,
    containerEnvKeys: CONTAINER_ENV_KEYS,
    resources: userResources,
  })
  rec.imageDigest = image

  // moss-server may itself be running inside a container; in that case
  // config.runtimeDir is the container-internal path that the Docker daemon
  // does NOT know how to mount. Translate via MOSS_HOST_PATH_MAP. If
  // moss-server is on the host, toHostPath is a no-op.
  const runtimeDirHost = toHostPath(config.runtimeDir)
  const mossHomeHost = toHostPath(MOSS_HOME)

  const args = [
    'run', '-d',
    '--name', rec.containerName,
    '--restart=no',
    '--pids-limit', String(userResources.pidsLimit),
    '--memory', userResources.memory,
    '--cpus', userResources.cpus,
    '--ulimit', `nofile=${userResources.nofile}`,
    '--security-opt', 'seccomp=unconfined',
    '--cap-add', 'SYS_ADMIN',
    '--label', 'moss.kind=user-container',
    '--label', `moss.org=${ctx.orgId}`,
    '--label', `moss.user=${ctx.userId}`,
    '--label', `moss.image=${image}`,
    '--label', `moss.runtime.config.hash=${rec.configHash}`,
    '-v', `${runtimeDirHost}:${config.runtimeDir}`,
    '-v', `${mossHomeHost}:${MOSS_HOME}`,
    '-e', `MOSS_HOME=${MOSS_HOME}`,
    '-e', `MOSS_RUNTIME_DIR=${config.runtimeDir}`,
    '-e', `MOSS_SESSION_USER_ID=${ctx.userId}`,
    '-e', `MOSS_SESSION_ORG_ID=${ctx.orgId}`,
    '-e', `MOSS_SESSION_ROLE=${ctx.role}`,
    '-e', `MOSS_SESSION_SCOPES=${ctx.scopes.join(',')}`,
  ]

  // Pass through container-level env (shared across all execs).
  for (const k of CONTAINER_ENV_KEYS) {
    const v = process.env[k]
    if (v) {
      args.push('-e', `${k}=${v}`)
    }
  }

  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`)
  }

  args.push(image, 'sleep', 'infinity')

  const result = await runDocker(args)
  if (result.code !== 0) {
    throw new Error(`docker run failed (code=${result.code}): ${result.stderr.trim()}`)
  }
  rec.containerId = result.stdout.trim()
  rec.createdAt = Date.now()
  rec.lastActiveAt = rec.createdAt
  logRuntimeEvent('user_container_ensure_ok', {
    org: ctx.orgId,
    userId: ctx.userId,
    containerName: rec.containerName,
    containerId: rec.containerId,
    runtimeDirHost,
    mossHomeHost,
  })
}

/**
 * Create or reuse the user container. Always called under per-key mutex.
 */
export async function ensureUserContainer(
  config: ServerConfig,
  ctx: EnsureContext,
): Promise<UserContainerRecord> {
  const k = key(ctx.orgId, ctx.userId)
  return mutex.run(k, async () => {
    let rec = registry.get(k)

    if (rec) {
      if (rec.state === 'running') {
        if (await dockerInspectAlive(rec.containerName)) {
          logRuntimeMetric('user_container_reused', { org: ctx.orgId })
          return rec
        }
        // Container vanished externally.
        logRuntimeMetric('user_container_external_vanished', { org: ctx.orgId })
        rec.state = 'dead'
        registry.delete(k)
        rec = undefined
      } else if (rec.state === 'draining' || rec.state === 'dead') {
        // Under the mutex we shouldn't see 'starting' or 'draining' since
        // those transitions are short-lived; treat as anomaly and rebuild.
        registry.delete(k)
        rec = undefined
      }
    }

    if (!rec) {
      const containerName = buildUserContainerName(ctx.orgId, ctx.userId)
      rec = {
        key: k,
        containerName,
        containerId: '',
        imageDigest: '',
        configHash: '',
        createdAt: 0,
        lastActiveAt: 0,
        activeSessionIds: new Set(),
        idleTimer: null,
        state: 'starting',
        pendingRebuild: false,
      }
      registry.set(k, rec)
      logRuntimeMetric('user_container_ensure_started', { org: ctx.orgId })
      try {
        await doCreate(config, ctx, rec)
        rec.state = 'running'
      } catch (err) {
        rec.state = 'dead'
        registry.delete(k)
        logRuntimeMetric('user_container_ensure_failed', {
          org: ctx.orgId,
          reason: 'docker_run_error',
        })
        logRuntimeEvent('user_container_ensure_failed', {
          org: ctx.orgId,
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }
    return rec
  })
}

function resetIdleTimer(
  rec: UserContainerRecord,
  config: ServerConfig,
): void {
  if (rec.idleTimer) clearTimeout(rec.idleTimer)
  const timeoutMs = config.docker?.userContainerIdleTimeoutMs ?? 20 * 60 * 1000
  if (timeoutMs <= 0) return
  rec.idleTimer = setTimeout(() => {
    void onIdleFire(rec.key, config).catch(err => {
      process.stderr.write(
        `[UserContainerRegistry] idle reclaim failed for ${rec.key}: ${err}\n`,
      )
    })
  }, timeoutMs)
  rec.idleTimer.unref?.()
}

function cancelIdleTimer(rec: UserContainerRecord): void {
  if (rec.idleTimer) {
    clearTimeout(rec.idleTimer)
    rec.idleTimer = null
  }
}

export async function acquireSession(
  orgId: string,
  userId: string,
  sessionId: string,
  config: ServerConfig,
): Promise<void> {
  const k = key(orgId, userId)
  return mutex.run(k, async () => {
    const rec = registry.get(k)
    if (!rec) {
      throw new Error(`acquireSession called before ensureUserContainer: ${k}`)
    }
    const maxSessionsPerUser = config.docker?.maxSessionsPerUser ?? 5
    if (
      !rec.activeSessionIds.has(sessionId) &&
      rec.activeSessionIds.size >= maxSessionsPerUser
    ) {
      logRuntimeMetric('session_acquire_rejected', {
        org: orgId,
        reason: 'max_sessions_per_user',
      })
      logRuntimeEvent('session_acquire_rejected', {
        org: orgId,
        userId,
        sessionId,
        containerName: rec.containerName,
        activeCount: rec.activeSessionIds.size,
        maxSessionsPerUser,
      })
      throw new Error(
        `maxSessionsPerUser exceeded for ${k}: ${rec.activeSessionIds.size}/${maxSessionsPerUser}`,
      )
    }
    rec.activeSessionIds.add(sessionId)
    if (rec.activeSessionIds.size === 1) {
      cancelIdleTimer(rec)
    }
    rec.lastActiveAt = Date.now()
    logRuntimeMetric('session_acquire', { org: orgId })
    logRuntimeEvent('session_acquire', {
      org: orgId,
      userId,
      sessionId,
      containerName: rec.containerName,
      activeCount: rec.activeSessionIds.size,
    })
  })
}

export async function releaseSession(
  orgId: string,
  userId: string,
  sessionId: string,
  config: ServerConfig,
): Promise<void> {
  const k = key(orgId, userId)
  return mutex.run(k, async () => {
    const rec = registry.get(k)
    if (!rec) return
    rec.activeSessionIds.delete(sessionId)
    if (rec.activeSessionIds.size === 0) {
      resetIdleTimer(rec, config)
    }
    logRuntimeMetric('session_release', { org: orgId })
    logRuntimeEvent('session_release', {
      org: orgId,
      userId,
      sessionId,
      containerName: rec.containerName,
      activeCount: rec.activeSessionIds.size,
    })
  })
}

async function onIdleFire(k: string, config: ServerConfig): Promise<void> {
  await mutex.run(k, async () => {
    const rec = registry.get(k)
    if (!rec) return
    if (rec.state !== 'running') return
    if (rec.activeSessionIds.size > 0) return // resurrected just before fire
    rec.state = 'draining'
    logRuntimeMetric('user_container_reclaim_started', { reason: 'idle' })
    logRuntimeEvent('user_container_reclaim_started', {
      containerName: rec.containerName,
      reason: 'idle',
    })
    const stopTimeout = config.dockerStopTimeoutSec ?? 10
    let failed = false
    try {
      const stop = await runDocker(['stop', '--time', String(stopTimeout), rec.containerName])
      if (stop.code !== 0) failed = true
      const rm = await runDocker(['rm', rec.containerName])
      if (rm.code !== 0 && !rm.stderr.includes('No such container')) failed = true
    } catch {
      failed = true
    } finally {
      rec.state = 'dead'
      registry.delete(k)
      if (failed) {
        logRuntimeMetric('user_container_reclaim_failed', { reason: 'docker_error' })
      } else {
        logRuntimeMetric('user_container_reclaim_ok', { reason: 'idle' })
      }
    }
  })
}

/**
 * Force-drain everything. Used by MOSS_FORCE_DRAIN_USER_CONTAINERS on startup
 * for emergency rollback, and by shutdown paths.
 */
export async function shutdownAll(config: ServerConfig): Promise<void> {
  const keys = [...registry.keys()]
  for (const k of keys) {
    await mutex.run(k, async () => {
      const rec = registry.get(k)
      if (!rec) return
      cancelIdleTimer(rec)
      rec.state = 'draining'
      logRuntimeMetric('user_container_force_drain', { reason: 'shutdown' })
      try {
        await runDocker(['stop', '--time', String(config.dockerStopTimeoutSec ?? 10), rec.containerName])
        await runDocker(['rm', rec.containerName])
      } catch {
        // best effort
      }
      rec.state = 'dead'
      registry.delete(k)
    })
  }
}

/**
 * Test/debug only: reset module state. Production code should never call this.
 */
export function _resetForTests(): void {
  for (const rec of registry.values()) {
    cancelIdleTimer(rec)
  }
  registry.clear()
}

export function _getRecordForTests(orgId: string, userId: string): UserContainerRecord | undefined {
  return registry.get(key(orgId, userId))
}

export function _getMutexForTests(): PerKeyMutex {
  return mutex
}

/**
 * Reconcile registry against `docker ps`. Called once on moss-server startup.
 * Does not acquire any sessions — refcounts get rebuilt as runners reconnect.
 */
export async function reconcile(): Promise<void> {
  const result = await runDocker([
    'ps',
    '--filter', 'label=moss.kind=user-container',
    '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}',
  ])
  if (result.code !== 0) return

  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const [id, name, labelStr] = line.split('\t')
    const labels: Record<string, string> = {}
    for (const kv of (labelStr || '').split(',')) {
      const eq = kv.indexOf('=')
      if (eq > 0) labels[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim()
    }
    const orgId = labels['moss.org']
    const userId = labels['moss.user']
    if (!orgId || !userId) continue
    const k = key(orgId, userId)
    if (registry.has(k)) continue
    registry.set(k, {
      key: k,
      containerName: name,
      containerId: id,
      imageDigest: labels['moss.image'] || '',
      configHash: labels['moss.runtime.config.hash'] || '',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      activeSessionIds: new Set(),
      idleTimer: null,
      state: 'running',
      pendingRebuild: false,
    })
    logRuntimeMetric('reconcile_user_container_seen', {})
    logRuntimeEvent('reconcile_user_container_seen', {
      org: orgId,
      userId,
      containerName: name,
      containerId: id,
    })
  }
}

/** Used by docker exec callers (DockerBackend) to discover the right name
 * without re-hashing. The lookup never blocks on the mutex because it's a
 * read-only Map.get and the caller already received the name via manifest. */
export function getRecordSnapshot(orgId: string, userId: string): UserContainerRecord | undefined {
  const r = registry.get(key(orgId, userId))
  if (!r) return undefined
  return { ...r, activeSessionIds: new Set(r.activeSessionIds) }
}
