import { spawn, spawnSync, type ChildProcess } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'fs'
import { connect, createServer } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import runtimeVersions from './runtime-versions.json' with { type: 'json' }

const NEXUS_VERSION = runtimeVersions['nexusd-cluster']
const NEXUS_DEFAULT_GRPC_PORT = Number(process.env.MOSS_NEXUS_GRPC_PORT) || 2126
const NEXUS_POLL_INTERVAL_MS = 200
const NEXUS_HEALTH_TIMEOUT_MS = 30_000
const NEXUS_CONNECT_TIMEOUT_MS = 1_000
const NEXUS_STOP_TIMEOUT_MS = 3_000
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
}

/** mTLS material for connecting to an external `nexusd-cluster`. */
export type NexusTlsConfig = {
  caPath: string
  certPath: string
  keyPath: string
  /** Server-cert SAN to validate; defaults to the cluster's `nexus-node`. */
  serverName?: string
}

export type NexusMode = 'embedded' | 'external'

/**
 * Resolved nexus runtime config.
 *
 * - `embedded`: moss spawns its own `nexusd serve-local` (trusted loopback,
 *   `--no-tls`) — the standalone/dev default, unchanged behavior.
 * - `external`: moss connects to an already-running production
 *   `nexusd-cluster` over its advertise bind, optionally with mTLS. moss does
 *   NOT spawn or manage the daemon lifecycle in this mode.
 */
export type ResolvedNexusConfig =
  | { mode: 'embedded'; grpcPort: number }
  | { mode: 'external'; endpoint: string; authToken: string; tls: NexusTlsConfig | null }

/**
 * Resolve the nexus runtime config from the environment.
 *
 * `MOSS_NEXUS_MODE=external` switches moss from the embedded serve-local
 * daemon to an external cluster client:
 *   - `MOSS_NEXUS_ENDPOINT`   host+scheme+port, e.g. `https://127.0.0.1:8443`
 *   - `MOSS_NEXUS_TLS_CA`     cluster CA cert (PEM path)
 *   - `MOSS_NEXUS_TLS_CERT`   moss client cert (PEM path)
 *   - `MOSS_NEXUS_TLS_KEY`    moss client key  (PEM path)
 *   - `MOSS_NEXUS_TLS_SERVER_NAME`  optional SAN override (default `nexus-node`)
 *   - `MOSS_NEXUS_AUTH_TOKEN` optional per-RPC auth token
 *
 * Anything else stays `embedded` (default), preserving the current
 * spawn-serve-local behavior for standalone/dev.
 */
export function resolveNexusConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedNexusConfig {
  const mode: NexusMode = env.MOSS_NEXUS_MODE?.trim() === 'external' ? 'external' : 'embedded'
  if (mode === 'embedded') {
    return { mode, grpcPort: Number(env.MOSS_NEXUS_GRPC_PORT) || NEXUS_DEFAULT_GRPC_PORT }
  }

  const endpoint = env.MOSS_NEXUS_ENDPOINT?.trim()
  if (!endpoint) {
    throw new Error(
      'MOSS_NEXUS_MODE=external requires MOSS_NEXUS_ENDPOINT (e.g. https://127.0.0.1:8443)',
    )
  }

  const caPath = env.MOSS_NEXUS_TLS_CA?.trim()
  const certPath = env.MOSS_NEXUS_TLS_CERT?.trim()
  const keyPath = env.MOSS_NEXUS_TLS_KEY?.trim()
  let tls: NexusTlsConfig | null = null
  if (caPath || certPath || keyPath) {
    if (!caPath || !certPath || !keyPath) {
      throw new Error(
        'mTLS to the external nexus requires all of MOSS_NEXUS_TLS_CA, MOSS_NEXUS_TLS_CERT, MOSS_NEXUS_TLS_KEY',
      )
    }
    tls = { caPath, certPath, keyPath, serverName: env.MOSS_NEXUS_TLS_SERVER_NAME?.trim() || undefined }
  } else if (endpoint.startsWith('https://')) {
    throw new Error(
      'MOSS_NEXUS_ENDPOINT uses https:// but no client certs were provided; set MOSS_NEXUS_TLS_CA/CERT/KEY for mTLS',
    )
  }

  return { mode, endpoint, authToken: env.MOSS_NEXUS_AUTH_TOKEN?.trim() ?? '', tls }
}

export function buildNexusArgs(grpcPort: number, dataDir: string, pluginDir: string): string[] {
  return [
    'serve-local',
    '--port', String(grpcPort),
    '--data-dir', dataDir,
    '--no-tls',
    '--plugin-dir', pluginDir,
  ]
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

/** 校验插件目录下存在当前平台的 vault 插件（.so/.dll 与 .sig 成对，缺失即 fail-fast）。 */
export function assertVaultPluginAvailable(pluginDir: string): void {
  const dylibName = process.platform === 'win32' ? 'nexus_vault.dll' : 'libnexus_vault.so'
  const dylibPath = join(pluginDir, dylibName)
  const sigPath = `${dylibPath}.sig`
  if (!existsSync(dylibPath) || !existsSync(sigPath)) {
    throw new Error(
      `vault plugin not found at ${dylibPath} (+ .sig). ` +
        `Secrets cannot be stored encrypted without it. ` +
        `Download nexus-vault-${process.platform === 'win32' ? 'windows' : 'linux'}-x86_64 ` +
        `from the nexi-lab/nexus releases (see runtime-versions.json "nexus-vault") ` +
        `and place both the dylib and its .sig into the plugins directory.`,
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

function connectTcp(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      error ? reject(error) : resolve()
    }
    socket.once('connect', () => finish())
    socket.once('error', error => finish(error))
    socket.setTimeout(timeoutMs, () => finish(new Error('connect timeout')))
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
    if (this.config.mode === 'external') {
      // Connect-only: the production nexusd-cluster owns the daemon lifecycle.
      // moss neither spawns nor claims the port; it just points its client at
      // the configured endpoint.
      console.log(
        `[NexusManager] External nexus mode: connecting to ${this.config.endpoint}` +
          `${this.config.tls ? ' over mTLS' : ' (plaintext)'} — not spawning serve-local`,
      )
      return
    }

    await assertTcpPortAvailable(this.grpcPort)

    const resolvedBin = this.resolveCompatibleBinary()
    const binaryVersion = this.readBinaryVersion(resolvedBin)
    this.isRustBinary = binaryVersion === NEXUS_VERSION
    console.log(`[NexusManager] Binary path: ${resolvedBin}`)
    console.log(`[NexusManager] Binary version: ${binaryVersion ?? 'unknown'} (expected ${NEXUS_VERSION})`)
    if (!this.isRustBinary) {
      throw new Error(
        `Expected nexusd-cluster ${NEXUS_VERSION}, found ${binaryVersion ?? 'unknown'} at ${resolvedBin}`,
      )
    }

    mkdirSync(this.nexusDir, { recursive: true })

    const dataDir = join(this.nexusDir, 'data')
    const pluginDir = resolveNexusPluginDir()
    assertVaultPluginAvailable(pluginDir)
    const args = buildNexusArgs(this.grpcPort, dataDir, pluginDir)
    console.log(`[NexusManager] Spawning: ${resolvedBin} ${args.join(' ')}`)

    const child = spawn(resolvedBin, args, {
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
        await connectTcp(this.grpcPort, this.connectTimeoutMs)
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
