import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, statSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import runtimeVersions from './runtime-versions.json' with { type: 'json' }

const NEXUS_VERSION = runtimeVersions.nexus
const NEXUS_DEFAULT_GRPC_PORT = Number(process.env.MOSS_NEXUS_GRPC_PORT) || 2126
const NEXUS_POLL_INTERVAL_MS = 200
const NEXUS_HEALTH_TIMEOUT_MS = 30_000

// Rust version (0.10.0+) uses gRPC only, no HTTP API
// We detect the binary type by checking if it's a small binary (< 20MB = Rust, > 30MB = Python)
const RUST_BINARY_MAX_SIZE = 20 * 1024 * 1024 // 20MB

export class NexusManager {
  private child: ChildProcess | null = null
  private readonly nexusDir: string
  private readonly binDir: string
  private readonly grpcPort: number
  private isRustBinary = false

  constructor() {
    this.nexusDir = join(homedir(), '.moss', 'nexus')
    this.binDir = join(this.nexusDir, 'bin')
    this.grpcPort = NEXUS_DEFAULT_GRPC_PORT
  }

  get baseUrl(): string {
    // Keep for backwards compatibility, but Rust version doesn't have HTTP
    return `http://127.0.0.1:12012`
  }

  get grpcUrl(): string {
    return `http://127.0.0.1:${this.grpcPort}`
  }

  get isRust(): boolean {
    return this.isRustBinary
  }

  async start(): Promise<void> {
    let binPath = this.resolveBinary()
    if (!binPath || !this.isRustBinaryFile(binPath)) {
      if (binPath) {
        console.log(`[NexusManager] Replacing non-Rust nexus binary at ${binPath}`)
      }
      const copied = this.copyFromSudowork()
      if (!copied) {
        throw new Error(
          `Rust Nexus binary not found. Expected at ${this.binDir}/nexusd or ${this.binDir}/nexusd.exe. ` +
          `Please download Nexus v${NEXUS_VERSION} and place it there.`,
        )
      }
      binPath = this.resolveBinary()
    }

    // Detect binary type (Rust vs Python)
    const resolvedBin = binPath!
    const binStat = statSync(resolvedBin)
    this.isRustBinary = this.isRustBinaryFile(resolvedBin)
    console.log(`[NexusManager] Binary path: ${resolvedBin}`)
    console.log(`[NexusManager] Binary size: ${binStat.size}, isRust: ${this.isRustBinary}`)
    if (!this.isRustBinary) {
      throw new Error(`Expected Rust nexus binary, got non-Rust binary at ${resolvedBin}`)
    }

    mkdirSync(this.nexusDir, { recursive: true })

    // Clean stale PID files to prevent OSError on Windows
    const pidLocations = [
      join(this.nexusDir, 'nexusd.pid'),
      join(homedir(), '.nexus', 'nexusd.pid'),
    ]
    for (const pidFile of pidLocations) {
      if (existsSync(pidFile)) {
        try { require('fs').unlinkSync(pidFile); console.log(`[NexusManager] Cleaned stale PID: ${pidFile}`) } catch { /* ignore */ }
      }
    }

    const dataDir = join(this.nexusDir, 'data')

    const args = [
      '--bind-addr', `127.0.0.1:${this.grpcPort}`,
      '--data-dir', dataDir,
      '--no-tls',
      // --bootstrap-mode was removed in nexus-vfs (Phase G): the daemon now
      // infers its boot action from on-disk state instead of an operator flag.
      // It is REQUIRED on v0.4.0 and REJECTED on >=v0.5.0, so dropping it is
      // atomic with the pin bump to v0.5.0 — either alone fails to boot.
      //
      // --no-tls stays. On the container's loopback, a plaintext tokenless
      // daemon is a trusted local backend; nexus-vfs's boot invariant only
      // refuses no-auth on a *reachable* bind, which this is not.
    ]

    console.log(`[NexusManager] Starting nexus (Rust version) on gRPC port ${this.grpcPort}...`)
    this.child = spawn(resolvedBin, args, {
      stdio: 'pipe',
      env: {
        ...process.env,
      },
    })

    this.child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg && msg.length < 200) {
        console.log(`[Nexus] ${msg}`)
      }
    })

    this.child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg && msg.length < 200) {
        console.error(`[Nexus:err] ${msg}`)
      }
    })

    this.child.on('exit', (code, signal) => {
      console.log(`[NexusManager] nexus exited with code=${code} signal=${signal}`)
      this.child = null
    })

    await this.waitForGrpcReady()
    this.writeReadyFile()
    console.log(`[NexusManager] Nexus started (gRPC on ${this.grpcPort})`)
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return
    console.log('[NexusManager] Stopping nexus...')
    this.child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        this.child?.kill('SIGKILL')
        resolve()
      }, 3000)
      this.child?.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.child = null
  }

  private resolveBinary(): string | null {
    const paths = [
      // 1. Moss-local nexus cache. This should contain the Rust nexus binary.
      join(this.binDir, 'nexusd.exe'),
      join(this.binDir, 'nexusd'),
      // 2. Bundled nexus in bin/nexus/ (relative to moss-server.mjs)
      join(process.cwd(), 'bin', 'nexus', 'nexusd.exe'),
      join(process.cwd(), 'bin', 'nexus', 'nexusd'),
    ]
    for (const p of paths) {
      if (existsSync(p)) return p
    }
    return null
  }

  private isRustBinaryFile(path: string): boolean {
    return statSync(path).size < RUST_BINARY_MAX_SIZE
  }

  private copyFromSudowork(): boolean {
    const sudoworkBinDir = join(homedir(), '.nexus', 'bin')
    const candidateBinaries = [
      process.platform === 'win32'
        ? join(sudoworkBinDir, 'nexusd.exe')
        : join(sudoworkBinDir, 'nexusd'),
      join(process.cwd(), 'bin', 'nexus', process.platform === 'win32' ? 'nexusd.exe' : 'nexusd'),
    ]

    mkdirSync(this.binDir, { recursive: true })
    const { copyFileSync, existsSync: exists, statSync } = require('fs')

    try {
      for (const sourceBinary of candidateBinaries) {
        if (!exists(sourceBinary)) continue

        const srcStat = statSync(sourceBinary)
        const isRustBinary = srcStat.size < RUST_BINARY_MAX_SIZE

        if (!isRustBinary) {
          console.log(`[NexusManager] Skipping non-Rust nexus binary at ${sourceBinary}`)
        } else {
          copyFileSync(sourceBinary, join(this.binDir, process.platform === 'win32' ? 'nexusd.exe' : 'nexusd'))
          console.log(`[NexusManager] Copied Rust nexus binary from ${sourceBinary}`)
          return true
        }
      }

      // Try sudowork resources directory (for bundled binaries)
      const resourcesDir = join(homedir(), 'repo', 'sudowork', 'resources')
      const versionedBinary = process.platform === 'win32'
        ? join(resourcesDir, `v${NEXUS_VERSION}-nexusd-cluster-windows-x86_64.exe`)
        : process.platform === 'darwin' && process.arch === 'arm64'
        ? join(resourcesDir, `v${NEXUS_VERSION}-nexusd-cluster-macos-arm64`)
        : join(resourcesDir, `v${NEXUS_VERSION}-nexusd-cluster-${process.platform}-${process.arch}`)

      if (exists(versionedBinary)) {
        copyFileSync(versionedBinary, join(this.binDir, process.platform === 'win32' ? 'nexusd.exe' : 'nexusd'))
        console.log(`[NexusManager] Copied bundled nexus binary from ${versionedBinary}`)
        return true
      }

      console.log(`[NexusManager] No nexus binary found in sudowork locations`)
      return false
    } catch (error) {
      console.error(`[NexusManager] Failed to copy nexus: ${error}`)
      return false
    }
  }

  private async waitForGrpcReady(): Promise<void> {
    const start = Date.now()
    let lastError: unknown = null
    while (Date.now() - start < NEXUS_HEALTH_TIMEOUT_MS) {
      if (this.child?.exitCode !== null) {
        throw new Error(`Nexus exited prematurely with code ${this.child?.exitCode}`)
      }
      // For Rust version, just wait a bit for the process to settle
      // gRPC server starts very fast in Rust
      await new Promise(r => setTimeout(r, 500))
      if (this.child?.exitCode === null) {
        // Try a simple gRPC write/read to verify it's ready
        try {
          const { NexusGrpcClient } = require('../../../native/nexus-napi')
          const testClient = new NexusGrpcClient(`http://127.0.0.1:${this.grpcPort}`)
          // Rust version doesn't have ping, use write/read instead
          testClient.write('/health/check.json', Buffer.from('{}'), '')
          testClient.read('/health/check.json', '')
          return
        } catch (error) {
          lastError = error
          // Not ready yet, continue waiting
        }
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`Nexus gRPC startup timed out after ${NEXUS_HEALTH_TIMEOUT_MS}ms. Last health check error: ${reason}`)
  }

  private writeReadyFile(): void {
    const readyPath = join(this.binDir, '.nexus-bin-ready')
    mkdirSync(this.binDir, { recursive: true })
    writeFileSync(readyPath, NEXUS_VERSION, 'utf8')
  }
}
