/**
 * Adapter Process Manager — 按 (orgId, userId, platform) 管理 Bot 子进程
 *
 * 每个用户可以独立启停自己的 Telegram 和飞书 Bot。
 * 进程以 detached child process 运行，通过 status file 监控。
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { open } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createServerLogger, type ServerLogger } from './serverLog.js'

type AdapterName = 'telegram' | 'feishu'
type ProcessKey = `${string}:${string}:${AdapterName}` // orgId:userId:platform

type AdapterProcessState = {
  status: 'running' | 'stopped' | 'error'
  pid: number | null
  error: string | null
  startedAt: number | null
}

const MOSS_HOME = path.join(os.homedir(), '.moss')
const ADAPTER_RUNTIMES_DIR = path.join(MOSS_HOME, 'adapter-runtimes')

function makeKey(orgId: string, userId: string, platform: AdapterName): ProcessKey {
  return `${orgId}:${userId}:${platform}`
}

export class AdapterProcessManager {
  private processes: Map<ProcessKey, ChildProcess | null> = new Map()
  private states: Map<ProcessKey, AdapterProcessState> = new Map()
  private logger: ServerLogger

  constructor(logger?: ServerLogger) {
    this.logger = logger ?? createServerLogger()
  }

  private getState(key: ProcessKey): AdapterProcessState {
    const state = this.states.get(key)
    if (!state) return { status: 'stopped', pid: null, error: null, startedAt: null }
    // Check if process is still alive
    if (state.pid) {
      try {
        process.kill(state.pid, 0)
      } catch {
        this.states.set(key, { status: 'stopped', pid: null, error: null, startedAt: null })
        return { status: 'stopped', pid: null, error: null, startedAt: null }
      }
    }
    return { ...state }
  }

  getStatus(adapter: AdapterName, orgId: string, userId: string): AdapterProcessState {
    return this.getState(makeKey(orgId, userId, adapter))
  }

  getAllStatuses(): Record<string, AdapterProcessState & { orgId: string; userId: string; platform: string }> {
    const result: Record<string, AdapterProcessState & { orgId: string; userId: string; platform: string }> = {}
    for (const [key, _] of this.states) {
      const [orgId, userId, platform] = key.split(':')
      const state = this.getState(key)
      result[key] = { ...state, orgId: orgId!, userId: userId!, platform: platform! }
    }
    return result
  }

  async start(adapter: AdapterName, orgId: string, userId: string): Promise<void> {
    const key = makeKey(orgId, userId, adapter)
    const current = this.getState(key)
    if (current.status === 'running') {
      this.logger.info(`[AdapterProcess] ${key} already running (pid ${current.pid}), restarting...`)
      await this.stop(adapter, orgId, userId)
    }

    const entryFile = this.findEntryFile(adapter)
    if (!entryFile) {
      const errMsg = `Adapter entry file not found for ${adapter}. Run 'cd adapters && bun install' first.`
      this.logger.error(`[AdapterProcess] ${errMsg}`)
      this.states.set(key, { status: 'error', pid: null, error: errMsg, startedAt: null })
      return
    }

    const logDir = path.join(ADAPTER_RUNTIMES_DIR, orgId, userId, adapter)
    mkdirSync(logDir, { recursive: true })

    const logOut = path.join(logDir, 'stdout.log')
    const logErr = path.join(logDir, 'stderr.log')

    const stdoutFd = await open(logOut, 'a')
    const stderrFd = await open(logErr, 'a')

    // Pass user/org identity and server URL via env
    const serverPort = process.env.MOSS_SERVER_PORT || String(process.env.PORT || 43127)
    const serverHost = process.env.MOSS_SERVER_HOST || '127.0.0.1'
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ADAPTER_SERVER_URL: `ws://${serverHost}:${serverPort}`,
      ADAPTER_ORG_ID: orgId,
      ADAPTER_USER_ID: userId,
      MOSS_CONFIG_DIR: process.env.MOSS_CONFIG_DIR || MOSS_HOME,
    }

    const runtimePath = process.execPath
    this.logger.info(`[AdapterProcess] Starting ${key} from ${entryFile}`)

    const child = spawn(runtimePath, [entryFile], {
      cwd: path.resolve(path.dirname(entryFile), '..'),
      detached: true,
      stdio: ['ignore', stdoutFd.fd, stderrFd.fd],
      env,
    })

    child.unref()

    const pid = child.pid ?? 0
    this.processes.set(key, child)
    this.states.set(key, {
      status: 'running',
      pid,
      error: null,
      startedAt: Date.now(),
    })

    this.logger.info(`[AdapterProcess] ${key} started with pid ${pid}`)

    child.on('error', (err) => {
      this.logger.error(`[AdapterProcess] ${key} error: ${err.message}`)
      this.states.set(key, { status: 'error', pid: null, error: err.message, startedAt: null })
    })

    child.on('exit', (code, signal) => {
      const msg = `${key} exited with code=${code} signal=${signal}`
      if (code === 0) {
        this.logger.info(`[AdapterProcess] ${msg}`)
      } else {
        this.logger.error(`[AdapterProcess] ${msg}`)
      }
      this.states.set(key, {
        status: 'stopped',
        pid: null,
        error: code !== 0 ? `Process exited with code ${code}` : null,
        startedAt: null,
      })
    })

    // Close log fds after child has inherited them
    setTimeout(async () => {
      await stdoutFd.close()
      await stderrFd.close()
    }, 5000)
  }

  async stop(adapter: AdapterName, orgId: string, userId: string): Promise<void> {
    const key = makeKey(orgId, userId, adapter)
    const child = this.processes.get(key)
    if (!child || !child.pid) {
      this.logger.info(`[AdapterProcess] ${key} not running, nothing to stop`)
      this.states.set(key, { status: 'stopped', pid: null, error: null, startedAt: null })
      return
    }

    this.logger.info(`[AdapterProcess] Stopping ${key} (pid ${child.pid})`)
    try {
      process.kill(child.pid, 'SIGTERM')
      setTimeout(() => {
        try { process.kill(child.pid!, 'SIGKILL') } catch {}
      }, 5000)
    } catch {
      // Process already dead
    }

    this.processes.set(key, null)
    this.states.set(key, { status: 'stopped', pid: null, error: null, startedAt: null })
  }

  async restart(adapter: AdapterName, orgId: string, userId: string): Promise<void> {
    await this.stop(adapter, orgId, userId)
    await this.start(adapter, orgId, userId)
  }

  private findEntryFile(adapter: AdapterName): string | null {
    const candidates = [
      path.resolve(process.cwd(), 'adapters', adapter, 'index.ts'),
      path.resolve(process.cwd(), 'adapters', adapter, 'index.js'),
      path.resolve(path.dirname(process.argv[1] ?? ''), '..', 'adapters', adapter, 'index.js'),
      path.resolve(path.dirname(process.argv[1] ?? ''), 'adapters', adapter, 'index.js'),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    return null
  }
}

export const adapterProcessManager = new AdapterProcessManager()