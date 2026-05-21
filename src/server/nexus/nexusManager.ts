import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import runtimeVersions from './runtime-versions.json' with { type: 'json' }

const NEXUS_VERSION = runtimeVersions.nexus
const NEXUS_DEFAULT_PORT = Number(process.env.MOSS_NEXUS_PORT) || 12012
const NEXUS_POLL_INTERVAL_MS = 200
const NEXUS_HEALTH_TIMEOUT_MS = 30_000

export class NexusManager {
  private child: ChildProcess | null = null
  private readonly nexusDir: string
  private readonly binDir: string
  private readonly port: number
  private readonly dbPath: string

  constructor() {
    this.nexusDir = join(homedir(), '.moss', 'nexus')
    this.binDir = join(this.nexusDir, 'bin')
    this.port = NEXUS_DEFAULT_PORT
    this.dbPath = join(this.nexusDir, 'nexus_record_store.db')
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    const binPath = this.resolveBinary()
    if (!binPath) {
      // Try to copy from sudowork installation
      const copied = this.copyFromSudowork()
      if (!copied) {
        throw new Error(
          `Nexus binary not found. Expected at ${this.binDir}/nexusd or ${this.binDir}/nexusd.exe. ` +
          `Please download Nexus v${NEXUS_VERSION} and place it there.`,
        )
      }
    }

    mkdirSync(this.nexusDir, { recursive: true })

    // Clean stale PID files to prevent OSError on Windows
    // Nexus checks both the data dir and the default ~/.nexus/ dir
    const pidLocations = [
      join(this.nexusDir, 'nexusd.pid'),
      join(homedir(), '.nexus', 'nexusd.pid'),
    ]
    for (const pidFile of pidLocations) {
      if (existsSync(pidFile)) {
        try { require('fs').unlinkSync(pidFile); console.log(`[NexusManager] Cleaned stale PID: ${pidFile}`) } catch { /* ignore */ }
      }
    }

    const dbUrl = `sqlite:///${this.dbPath.replace(/\\/g, '/')}`

    console.log(`[NexusManager] Starting nexus on port ${this.port}...`)
    this.child = spawn(
      this.resolveBinary()!,
      ['--host', 'localhost', '--profile', 'cluster', '--auth-type', 'none', '--port', String(this.port)],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          NEXUS_DATABASE_URL: dbUrl,
        },
      },
    )

    this.child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg && !msg.includes('HTTP/1.1') && msg.length < 200) {
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

    await this.waitForHealthy()
    this.writeReadyFile()
    console.log(`[NexusManager] Nexus started on port ${this.port}`)
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
      // 1. User-installed nexus in ~/.moss/nexus/bin/
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

  private copyFromSudowork(): boolean {
    const sudoworkBinDir = join(homedir(), '.nexus', 'bin')
    const sudoworkBinary = process.platform === 'win32'
      ? join(sudoworkBinDir, 'nexusd.exe')
      : join(sudoworkBinDir, 'nexusd')
    if (!existsSync(sudoworkBinary)) return false

    mkdirSync(this.binDir, { recursive: true })
    // Copy the entire bin directory (including _internal for Python runtime)
    const { cpSync, existsSync: exists } = require('fs')
    try {
      // Copy _internal directory if it exists (Python runtime files)
      const internalDir = join(sudoworkBinDir, '_internal')
      if (exists(internalDir)) {
        cpSync(internalDir, join(this.binDir, '_internal'), { recursive: true })
        console.log(`[NexusManager] Copied _internal directory`)
      }
      // Copy nexusd binary
      const { copyFileSync } = require('fs')
      copyFileSync(sudoworkBinary, join(this.binDir, process.platform === 'win32' ? 'nexusd.exe' : 'nexusd'))
      // Copy mcporter if exists (needed by nexusd)
      const mcporter = join(sudoworkBinDir, process.platform === 'win32' ? 'mcporter.cmd' : 'mcporter')
      if (exists(mcporter)) {
        copyFileSync(mcporter, join(this.binDir, process.platform === 'win32' ? 'mcporter.cmd' : 'mcporter'))
      }
      console.log(`[NexusManager] Copied nexus binary from ${sudoworkBinDir}`)
      return true
    } catch (error) {
      console.error(`[NexusManager] Failed to copy nexus: ${error}`)
      return false
    }
  }

  private async waitForHealthy(): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < NEXUS_HEALTH_TIMEOUT_MS) {
      if (this.child?.exitCode !== null) {
        throw new Error(`Nexus exited prematurely with code ${this.child?.exitCode}`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.timeout(1000),
        })
        if (res.ok) {
          const body = await res.json() as { status?: string }
          if (body.status === 'healthy') return
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, NEXUS_POLL_INTERVAL_MS))
    }
    throw new Error(`Nexus health check timed out after ${NEXUS_HEALTH_TIMEOUT_MS}ms`)
  }

  private writeReadyFile(): void {
    const readyPath = join(this.binDir, '.nexus-bin-ready')
    writeFileSync(readyPath, NEXUS_VERSION, 'utf8')
  }
}
