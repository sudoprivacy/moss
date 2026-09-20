import { randomUUID } from 'crypto'
import { validateZoneId, describeRefusal } from '@sudo/contracts/zone-id'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { createServer } from 'net'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { getErrnoCode } from '../../utils/errors.js'
import { lock } from '../../utils/lockfile.js'
import runtimeVersions from './runtime-versions.json' with { type: 'json' }
import {
  NEXUS_DEFAULT_GRPC_PORT,
  resolveNexusConfigFromEnv,
  type NexusMode,
  type NexusTlsConfig,
  type ResolvedNexusConfig,
} from './nexusEnvConfig.js'

// The env-resolved config moved to `nexusEnvConfig.ts` so consumers that only
// need the config (the session runner's k8s backend) do not inline this
// module's daemon-lifecycle imports. Re-exported here because every existing
// caller — `readiness.ts`, the tests — reaches for it through this module.
export {
  resolveNexusConfigFromEnv,
  type NexusMode,
  type NexusTlsConfig,
  type ResolvedNexusConfig,
}

const NEXUS_VERSION = runtimeVersions['nexusd-cluster']
const NEXUS_POLL_INTERVAL_MS = 200
const NEXUS_HEALTH_TIMEOUT_MS = 30_000
const NEXUS_CONNECT_TIMEOUT_MS = 1_000
const NEXUS_STOP_TIMEOUT_MS = 3_000
const NEXUS_STARTUP_LOCK_STALE_MS = 60_000
const NEXUS_STARTUP_LOCK_UPDATE_MS = 5_000
const MAX_STDERR_CAPTURE_CHARS = 8 * 1024
const MAX_LOG_LINE_CHARS = 4 * 1024

export type NexusExitInfo = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type NexusManagerOptions = {
  nexusDir?: string
  grpcPort?: number
  healthTimeoutMs?: number
  pollIntervalMs?: number
  connectTimeoutMs?: number
  /** Override the env-resolved runtime config (tests / embedding hosts). */
  config?: ResolvedNexusConfig
  /** Override process boundaries without changing production defaults. */
  pluginDir?: string
  spawnProcess?: typeof spawn
  readinessProbe?: () => Promise<void>
  runtimeResolver?: () => { path: string; version: string | null }
  startupLock?: typeof lock
}


function assertValidNexusZoneId(zoneId: string): void {
  const refusal = validateZoneId(zoneId)
  if (refusal) {
    throw new Error(
      `refusing to start nexusd with zone id ${JSON.stringify(zoneId)}: ${describeRefusal(refusal)}. ` +
        'A zone id is the first path segment of everything in the zone and cannot be changed afterwards — ' +
        'pointing at a different id later creates a new empty zone and abandons the old one.',
    )
  }
}

/**
 * Builds the daemon's argv, refusing a zone id we would not be allowed to keep.
 *
 * `clusterInit` names the zone this node founds. Omitted, the daemon founds its
 * default root zone, which is what every deployment does today — so passing
 * nothing behaves exactly as before.
 *
 * The id is checked here, before spawning, rather than left to the daemon. Two
 * reasons, and the second is the one that matters:
 *
 *   * a spawn that fails on argv is a worse error than a refusal that names the
 *     offending id and the rule it broke;
 *   * the daemon only refuses on FIRST boot. On a restart it warns and carries
 *     on, deliberately, so that a new rule cannot take down a node that has been
 *     serving for months. That leniency is right for the daemon and wrong for
 *     us: moss generating an id is always creating one, never inheriting one, so
 *     there is no running deployment for us to protect and no reason to let a
 *     malformed id through.
 *
 * `validateZoneId` is not written here. It is derived from
 * `contracts/zone-id/spec.json` in nexus-vfs — the repository that owns the
 * concept — via sudostack, which pins a revision rather than copying the rules.
 * The same spec generates the daemon's own Rust validator, so the two cannot
 * disagree about what is valid.
 */
export function buildNexusArgs(
  grpcPort: number,
  dataDir: string,
  pluginDir: string,
  clusterInit?: string,
): string[] {
  const args = [
    'serve-local',
    '--port', String(grpcPort),
    '--data-dir', dataDir,
    '--no-tls',
    '--plugin-dir', pluginDir,
  ]

  if (clusterInit !== undefined) {
    assertValidNexusZoneId(clusterInit)
    args.push('--cluster-init', clusterInit)
  }

  return args
}

const NEXUS_ZONE_ID_LOCK_VERSION = 1
const NEXUS_ZONE_ID_LOCK_MAX_BYTES = 512

export function resolveNexusZoneIdLockPath(dataDir: string): string {
  return join(dirname(dataDir), `${basename(dataDir)}.zone-id.lock.json`)
}

function serializeNexusZoneIdLock(zoneId: string): string {
  return `${JSON.stringify({ version: NEXUS_ZONE_ID_LOCK_VERSION, zoneId }, null, 2)}\n`
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  }
}

function readNexusZoneIdLock(lockPath: string): string | undefined {
  const stat = lstatIfExists(lockPath)
  if (!stat) return undefined
  if (!stat.isFile()) {
    throw new Error(`Invalid Nexus ZoneId lock at ${lockPath}: expected a regular file`)
  }
  if (stat.size > NEXUS_ZONE_ID_LOCK_MAX_BYTES) {
    throw new Error(
      `Invalid Nexus ZoneId lock at ${lockPath}: record exceeds ${NEXUS_ZONE_ID_LOCK_MAX_BYTES} bytes`,
    )
  }

  const raw = readFileSync(lockPath, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid Nexus ZoneId lock at ${lockPath}: malformed JSON`)
  }

  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'zoneId') ||
    (value as { version?: unknown }).version !== NEXUS_ZONE_ID_LOCK_VERSION ||
    typeof (value as { zoneId?: unknown }).zoneId !== 'string'
  ) {
    throw new Error(
      `Invalid Nexus ZoneId lock at ${lockPath}: expected version ${NEXUS_ZONE_ID_LOCK_VERSION} and one string zoneId`,
    )
  }

  const zoneId = (value as { zoneId: string }).zoneId
  try {
    assertValidNexusZoneId(zoneId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Nexus ZoneId lock at ${lockPath}: ${reason}`)
  }
  if (raw !== serializeNexusZoneIdLock(zoneId)) {
    throw new Error(`Invalid Nexus ZoneId lock at ${lockPath}: record is not in canonical versioned form`)
  }
  return zoneId
}

function assertNexusDataUninitialized(dataDir: string): void {
  const stat = lstatIfExists(dataDir)
  if (!stat) return
  if (!stat.isDirectory()) {
    throw new Error(
      `Cannot declare MOSS_NEXUS_ZONE_ID: Nexus data path ${dataDir} already exists and is not a directory`,
    )
  }
  const directory = opendirSync(dataDir)
  try {
    if (directory.readSync() !== null) {
      throw new Error(
        `Cannot declare MOSS_NEXUS_ZONE_ID: Nexus data directory ${dataDir} is already initialized or non-empty; ` +
          'a separately authorized migration is required',
      )
    }
  } finally {
    directory.closeSync()
  }
}

type EmbeddedNexusZoneIdResolution =
  | { zoneId: string | undefined; needsBinding: false }
  | { zoneId: string; needsBinding: true }

function inspectEmbeddedNexusZoneId(
  dataDir: string,
  requestedZoneId?: string,
): EmbeddedNexusZoneIdResolution {
  if (requestedZoneId !== undefined) assertValidNexusZoneId(requestedZoneId)

  const lockPath = resolveNexusZoneIdLockPath(dataDir)
  const lockedZoneId = readNexusZoneIdLock(lockPath)
  if (lockedZoneId !== undefined) {
    if (requestedZoneId !== undefined && requestedZoneId !== lockedZoneId) {
      throw new Error(
        `MOSS_NEXUS_ZONE_ID ${JSON.stringify(requestedZoneId)} does not byte-match the immutable local ` +
          `binding ${JSON.stringify(lockedZoneId)} at ${lockPath}`,
      )
    }
    return { zoneId: lockedZoneId, needsBinding: false }
  }
  if (requestedZoneId === undefined) return { zoneId: undefined, needsBinding: false }

  assertNexusDataUninitialized(dataDir)
  return { zoneId: requestedZoneId, needsBinding: true }
}

function syncParentDirectory(path: string): void {
  if (process.platform === 'win32') return
  const directory = openSync(path, 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function publishNexusZoneIdLock(dataDir: string, requestedZoneId: string): string {
  const lockPath = resolveNexusZoneIdLockPath(dataDir)
  const serialized = serializeNexusZoneIdLock(requestedZoneId)
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`
  let published = false

  try {
    writeFileSync(tempPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true })
    try {
      linkSync(tempPath, lockPath)
      published = true
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }
  } finally {
    try {
      unlinkSync(tempPath)
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') throw error
    }
  }

  if (published) {
    syncParentDirectory(dirname(lockPath))
    return requestedZoneId
  }

  const racedZoneId = readNexusZoneIdLock(lockPath)
  if (racedZoneId !== requestedZoneId) {
    throw new Error(
      `MOSS_NEXUS_ZONE_ID ${JSON.stringify(requestedZoneId)} lost an atomic lock race to ` +
        `${JSON.stringify(racedZoneId)} at ${lockPath}; the existing binding was not overwritten`,
    )
  }
  return racedZoneId
}

function resolveEmbeddedNexusZoneId(dataDir: string, requestedZoneId?: string): string | undefined {
  const resolution = inspectEmbeddedNexusZoneId(dataDir, requestedZoneId)
  if (!resolution.needsBinding) return resolution.zoneId
  return publishNexusZoneIdLock(dataDir, resolution.zoneId)
}

function assertExternalNexusZoneIdSafe(dataDir: string, requestedZoneId?: string): void {
  if (requestedZoneId !== undefined) {
    throw new Error(
      'MOSS_NEXUS_ZONE_ID is only valid for Moss-managed embedded Nexus; external Nexus topology is owned outside Moss',
    )
  }
  const lockPath = resolveNexusZoneIdLockPath(dataDir)
  if (lstatIfExists(lockPath)) {
    throw new Error(
      `Cannot switch to external Nexus while the embedded ZoneId lock exists at ${lockPath}; ` +
        'a separately authorized topology migration is required',
    )
  }
}

/**
 * vault 插件目录：<cwd>/bin/nexus/plugins（容器内即镜像路径
 * /app/bin/nexus/plugins；本地开发即仓库 bin/nexus/plugins）。
 * 有意不使用挂载卷（binDir）路径——宿主残留旧插件与镜像内新 nexusd
 * 会错配，插件与 nexusd 必须同批进镜像保证版本配套。
 */
export function resolveNexusPluginDir(): string {
  return join(process.cwd(), 'bin', 'nexus', 'plugins')
}

/**
 * 按平台返回 vault 插件动态库文件名：macOS `.dylib` / Windows `.dll` / 其它（Linux）`.so`。
 * 抽成纯函数以便脱离 process.platform 做平台无关单测（防 darwin 分支回归）。
 */
export function resolveVaultDylibName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'nexus_vault.dll'
  if (platform === 'darwin') return 'libnexus_vault.dylib'
  return 'libnexus_vault.so'
}

/** 校验插件目录下存在当前平台的 vault 插件（.so/.dll/.dylib 与 .sig 成对，缺失即 fail-fast）。 */
export function assertVaultPluginAvailable(pluginDir: string): void {
  const dylibName = resolveVaultDylibName(process.platform)
  const dylibPath = join(pluginDir, dylibName)
  const sigPath = `${dylibPath}.sig`
  if (!existsSync(dylibPath) || !existsSync(sigPath)) {
    const hint =
      process.platform === 'win32' || process.platform === 'darwin'
        ? `Run \`bun run build:node\` at the repo root to fetch it automatically (Windows/macOS dev).`
        : `On Linux it is baked into the server image; for native/WSL dev see deploy/README.md ` +
          `to download nexus-vault-linux-x86_64 manually (see runtime-versions.json "nexus-vault").`
    throw new Error(
      `vault plugin not found at ${dylibPath} (+ .sig). ` +
        `Secrets cannot be stored encrypted without it. ` +
        hint,
    )
  }
}

export function parseNexusVersion(output: string): string | null {
  return output.match(/\bnexusd-cluster\s+v?(\d+\.\d+\.\d+)\b/)?.[1] ?? null
}

export function formatNexusStartupFailure(input: {
  message: string
  pid?: number
  exit?: NexusExitInfo | null
  stderr?: string
}): string {
  const details = [input.message]
  if (input.pid !== undefined) details.push(`pid=${input.pid}`)
  if (input.exit) {
    details.push(`code=${input.exit.code ?? 'null'}`)
    details.push(`signal=${input.exit.signal ?? 'null'}`)
  }
  const stderr = input.stderr?.trim()
  if (stderr) details.push(`stderr=${stderr}`)
  return details.join('; ')
}

/** Fail before spawn if another process already owns the configured port. */
export async function assertTcpPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close(error => error ? reject(error) : resolve())
    })
  }).catch(error => {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Cannot start nexusd-cluster: 127.0.0.1:${port} is already in use or unavailable (${reason})`,
    )
  })
}

function appendBounded(current: string, next: string): string {
  const combined = `${current}${next}`
  return combined.length <= MAX_STDERR_CAPTURE_CHARS
    ? combined
    : combined.slice(-MAX_STDERR_CAPTURE_CHARS)
}

function logChunk(prefix: string, chunk: Buffer, error: boolean): void {
  const lines = chunk.toString().split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    const rendered = line.length > MAX_LOG_LINE_CHARS
      ? `${line.slice(0, MAX_LOG_LINE_CHARS)}... [truncated]`
      : line
    if (error) console.error(`${prefix} ${rendered}`)
    else console.log(`${prefix} ${rendered}`)
  }
}

export class NexusManager {
  private child: ChildProcess | null = null
  private readonly nexusDir: string
  private readonly binDir: string
  private readonly grpcPort: number
  private readonly healthTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly connectTimeoutMs: number
  private readonly pluginDir: string
  private readonly spawnProcess: typeof spawn
  private readonly readinessProbe?: () => Promise<void>
  private readonly runtimeResolver?: () => { path: string; version: string | null }
  private readonly startupLock: typeof lock
  private probeClient: NexusVfsClient | null = null
  private readonly config: ResolvedNexusConfig
  private isRustBinary = false

  constructor(options: NexusManagerOptions = {}) {
    this.config = options.config ?? resolveNexusConfigFromEnv()
    this.nexusDir = options.nexusDir ?? join(homedir(), '.moss', 'nexus')
    this.binDir = join(this.nexusDir, 'bin')
    this.grpcPort =
      options.grpcPort ?? (this.config.mode === 'embedded' ? this.config.grpcPort : NEXUS_DEFAULT_GRPC_PORT)
    this.healthTimeoutMs = options.healthTimeoutMs ?? NEXUS_HEALTH_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? NEXUS_POLL_INTERVAL_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? NEXUS_CONNECT_TIMEOUT_MS
    this.pluginDir = options.pluginDir ?? resolveNexusPluginDir()
    this.spawnProcess = options.spawnProcess ?? spawn
    this.readinessProbe = options.readinessProbe
    this.runtimeResolver = options.runtimeResolver
    this.startupLock = options.startupLock ?? lock
  }

  get mode(): NexusMode {
    return this.config.mode
  }

  get baseUrl(): string {
    // Keep for backwards compatibility, but Rust version doesn't have HTTP.
    return 'http://127.0.0.1:12012'
  }

  get grpcUrl(): string {
    // External mode: host + scheme + port come from MOSS_NEXUS_ENDPOINT (may be
    // https). Embedded mode: fixed trusted loopback.
    return this.config.mode === 'external'
      ? this.config.endpoint
      : `http://127.0.0.1:${this.grpcPort}`
  }

  /** mTLS material for the external cluster, or null (embedded / plaintext). */
  get tlsConfig(): NexusTlsConfig | null {
    return this.config.mode === 'external' ? this.config.tls : null
  }

  /** Per-RPC auth token to present to the VFS (empty in embedded mode). */
  get authToken(): string {
    return this.config.mode === 'external' ? this.config.authToken : ''
  }

  get isRust(): boolean {
    return this.isRustBinary
  }

  async start(): Promise<void> {
    const dataDir = join(this.nexusDir, 'data')
    if (this.config.mode === 'external') {
      assertExternalNexusZoneIdSafe(dataDir, this.config.zoneId)
      // Connect-only: the production nexusd-cluster owns the daemon lifecycle.
      // moss neither spawns nor claims the port; it just points its client at
      // the configured endpoint.
      console.log(
        `[NexusManager] External nexus mode: connecting to ${this.config.endpoint}` +
          `${this.config.tls ? ' over mTLS' : ' (plaintext)'} — not spawning serve-local`,
      )
      return
    }

    inspectEmbeddedNexusZoneId(dataDir, this.config.zoneId)
    mkdirSync(this.nexusDir, { recursive: true })

    let releaseStartupLock: () => Promise<void>
    try {
      releaseStartupLock = await this.startupLock(this.nexusDir, {
        realpath: false,
        stale: NEXUS_STARTUP_LOCK_STALE_MS,
        update: NEXUS_STARTUP_LOCK_UPDATE_MS,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot start embedded Nexus while another startup owns ${this.nexusDir}: ${reason}`)
    }

    let startupFailed = false
    let startupError: unknown
    try {
      await this.startEmbedded(dataDir)
    } catch (error) {
      startupFailed = true
      startupError = error
    }

    let releaseError: unknown
    try {
      await releaseStartupLock()
    } catch (error) {
      releaseError = error
    }

    if (startupFailed) {
      if (releaseError !== undefined) {
        console.error(
          `[NexusManager] Failed to release startup lock after startup failure: ${String(releaseError)}`,
        )
      }
      throw startupError
    }

    if (releaseError !== undefined) {
      const child = this.child
      let terminationError: unknown
      if (child) {
        try {
          await this.terminateChild(child)
        } catch (error) {
          terminationError = error
        } finally {
          if (this.child === child) this.child = null
        }
      }
      const message = `Failed to release embedded Nexus startup lock at ${this.nexusDir}; spawned child was stopped`
      if (terminationError !== undefined) {
        throw new AggregateError([releaseError, terminationError], message)
      }
      throw new Error(message, { cause: releaseError })
    }
  }

  private async startEmbedded(dataDir: string): Promise<void> {
    await assertTcpPortAvailable(this.grpcPort)

    let resolvedBin: string
    let binaryVersion: string | null
    if (this.runtimeResolver) {
      ({ path: resolvedBin, version: binaryVersion } = this.runtimeResolver())
    } else {
      resolvedBin = this.resolveCompatibleBinary()
      binaryVersion = this.readBinaryVersion(resolvedBin)
    }
    this.isRustBinary = binaryVersion === NEXUS_VERSION
    console.log(`[NexusManager] Binary path: ${resolvedBin}`)
    console.log(`[NexusManager] Binary version: ${binaryVersion ?? 'unknown'} (expected ${NEXUS_VERSION})`)
    if (!this.isRustBinary) {
      throw new Error(
        `Expected nexusd-cluster ${NEXUS_VERSION}, found ${binaryVersion ?? 'unknown'} at ${resolvedBin}`,
      )
    }

    assertVaultPluginAvailable(this.pluginDir)
    const clusterInit = resolveEmbeddedNexusZoneId(dataDir, this.config.zoneId)
    const args = buildNexusArgs(this.grpcPort, dataDir, this.pluginDir, clusterInit)
    console.log(`[NexusManager] Spawning: ${resolvedBin} ${args.join(' ')}`)

    const child = this.spawnProcess(resolvedBin, args, {
      stdio: 'pipe',
      // vault 插件读 NEXUS_DATA_DIR 决定数据目录（含 master.key），不读
      // --data-dir 参数；不设置会把加密数据落到 cwd 的 ./nexus-data
      env: { ...process.env, NEXUS_DATA_DIR: dataDir },
    })
    this.child = child
    console.log(`[NexusManager] Spawned nexusd-cluster pid=${child.pid ?? 'unknown'}`)

    let lastStderr = ''
    let exitInfo: NexusExitInfo | null = null
    let spawnError: Error | null = null

    child.stdout?.on('data', (data: Buffer) => logChunk('[Nexus]', data, false))
    child.stderr?.on('data', (data: Buffer) => {
      lastStderr = appendBounded(lastStderr, data.toString())
      logChunk('[Nexus:err]', data, true)
    })
    child.once('error', error => {
      spawnError = error
      console.error(`[NexusManager] Failed to spawn nexusd-cluster: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      console.log(`[NexusManager] nexusd-cluster exited with code=${code} signal=${signal}`)
      if (this.child === child) this.child = null
    })

    try {
      await this.waitForGrpcReady(child, () => exitInfo, () => spawnError, () => lastStderr)
      this.writeReadyFile()
    } catch (error) {
      await this.terminateChild(child)
      if (this.child === child) this.child = null
      throw error
    }
    console.log(
      `[NexusManager] Nexus started (version=${NEXUS_VERSION}, pid=${child.pid ?? 'unknown'}, gRPC=127.0.0.1:${this.grpcPort})`,
    )
  }

  async stop(): Promise<void> {
    // External mode never spawns a child, so there is nothing to stop; the
    // cluster daemon lifecycle is managed independently.
    if (this.config.mode === 'external') return
    const child = this.child
    if (!child) return
    console.log(`[NexusManager] Stopping nexusd-cluster pid=${child.pid ?? 'unknown'}...`)
    await this.terminateChild(child)
    if (this.child === child) this.child = null
  }

  private resolveCompatibleBinary(): string {
    const localName = process.platform === 'win32' ? 'nexusd.exe' : 'nexusd'
    const directCandidates = [
      join(this.binDir, localName),
      join(process.cwd(), 'bin', 'nexus', localName),
    ]
    for (const candidate of directCandidates) {
      if (!existsSync(candidate)) continue
      const version = this.readBinaryVersion(candidate)
      if (version === NEXUS_VERSION) return candidate
      console.warn(
        `[NexusManager] Skipping incompatible binary at ${candidate}: expected ${NEXUS_VERSION}, found ${version ?? 'unknown'}`,
      )
    }

    const copied = this.copyCompatibleBinary(localName)
    if (copied) return copied

    throw new Error(
      `nexusd-cluster ${NEXUS_VERSION} not found. Expected ${join(this.binDir, localName)} ` +
      `or ${join(homedir(), '.nexus-vfs', 'bin', process.platform === 'win32' ? 'nexusd-cluster.exe' : 'nexusd-cluster')}.`,
    )
  }

  private readBinaryVersion(path: string): string | null {
    try {
      const result = spawnSync(path, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      })
      if (result.error || result.status !== 0) return null
      return parseNexusVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    } catch {
      return null
    }
  }

  private copyCompatibleBinary(localName: string): string | null {
    const clusterName = process.platform === 'win32' ? 'nexusd-cluster.exe' : 'nexusd-cluster'
    const candidates = [
      join(homedir(), '.nexus-vfs', 'bin', clusterName),
      join(homedir(), '.nexus', 'bin', localName),
    ]

    mkdirSync(this.binDir, { recursive: true })
    for (const source of candidates) {
      if (!existsSync(source)) continue
      const version = this.readBinaryVersion(source)
      if (version !== NEXUS_VERSION) {
        console.warn(
          `[NexusManager] Skipping incompatible source at ${source}: expected ${NEXUS_VERSION}, found ${version ?? 'unknown'}`,
        )
        continue
      }
      try {
        const destination = join(this.binDir, localName)
        copyFileSync(source, destination)
        console.log(`[NexusManager] Copied nexusd-cluster ${version} from ${source}`)
        return destination
      } catch (error) {
        console.error(`[NexusManager] Failed to copy nexusd-cluster from ${source}: ${String(error)}`)
      }
    }
    return null
  }

  /**
   * One RPC that only a serving VFS can answer. Built once and reused for the
   * whole startup poll: a client per attempt would open a channel per attempt.
   */
  private async probeServing(): Promise<void> {
    if (this.readinessProbe) {
      await this.readinessProbe()
      return
    }
    if (!this.probeClient) {
      const tls = this.tlsConfig
      this.probeClient = tls
        ? NexusVfsClient.withMtls(this.grpcUrl, tls)
        : new NexusVfsClient(this.grpcUrl)
    }
    await this.probeClient.serverInfo(this.authToken)
  }

  private async waitForGrpcReady(
    child: ChildProcess,
    getExitInfo: () => NexusExitInfo | null,
    getSpawnError: () => Error | null,
    getStderr: () => string,
  ): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
    let lastConnectError: unknown = null

    while (Date.now() < deadline) {
      const spawnError = getSpawnError()
      if (spawnError) {
        throw new Error(formatNexusStartupFailure({
          message: `Failed to spawn nexusd-cluster: ${spawnError.message}`,
          pid: child.pid,
          stderr: getStderr(),
        }))
      }

      const exit = getExitInfo()
      if (exit || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(formatNexusStartupFailure({
          message: 'nexusd-cluster exited before gRPC readiness',
          pid: child.pid,
          exit: exit ?? { code: child.exitCode, signal: child.signalCode },
          stderr: getStderr(),
        }))
      }

      try {
        // A real RPC, not a TCP connect. The port binds before the VFS service
        // can answer on it (it is the raft data plane first), so accepting a
        // connection here would declare nexus ready while the kernel is still
        // wiring and declared mounts have not yet applied. Everything moss does
        // in that window goes to a daemon that cannot answer for it yet — and
        // before v0.7.7 some of it was answered WRONGLY rather than refused.
        await this.probeServing()
        const afterConnectExit = getExitInfo()
        if (!afterConnectExit && child.exitCode === null && child.signalCode === null) return
      } catch (error) {
        lastConnectError = error
      }

      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
    }

    const reason = lastConnectError instanceof Error
      ? lastConnectError.message
      : String(lastConnectError ?? 'no connection accepted')
    throw new Error(formatNexusStartupFailure({
      message: `nexusd-cluster gRPC startup timed out after ${this.healthTimeoutMs}ms; last health error=${reason}`,
      pid: child.pid,
      exit: getExitInfo(),
      stderr: getStderr(),
    }))
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.pid === undefined) return
    await new Promise<void>(resolve => {
      let settled = false
      let killTimeout: NodeJS.Timeout | undefined
      let giveUpTimeout: NodeJS.Timeout | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (killTimeout) clearTimeout(killTimeout)
        if (giveUpTimeout) clearTimeout(giveUpTimeout)
        child.off('exit', finish)
        resolve()
      }
      child.once('exit', finish)
      try {
        if (!child.kill('SIGTERM')) {
          finish()
          return
        }
      } catch {
        finish()
        return
      }
      killTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            if (!child.kill('SIGKILL')) finish()
          } catch {
            finish()
          }
        }
      }, NEXUS_STOP_TIMEOUT_MS)
      giveUpTimeout = setTimeout(finish, NEXUS_STOP_TIMEOUT_MS + 1_000)
    })
  }

  private writeReadyFile(): void {
    const readyPath = join(this.binDir, '.nexus-bin-ready')
    mkdirSync(this.binDir, { recursive: true })
    writeFileSync(readyPath, NEXUS_VERSION, 'utf8')
  }
}
