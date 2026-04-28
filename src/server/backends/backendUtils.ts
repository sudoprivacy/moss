import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  MOSS_HOME,
} from '../../utils/skills/localSkillDirectories.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionRuntimeInfo,
} from '../sessionManager.js'
import { getSystemSettings } from '../systemSettings.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function resolveNodeCliPath(): string {
  const configured = process.env.CLAUDE_CODE_CLI_PATH
  const candidates = [
    configured,
    path.join(process.cwd(), 'cli-node.js'),
    path.join(__dirname, 'cli-node.js'),
    path.join(__dirname, '../cli-node.js'),
    path.join(__dirname, '../../cli-node.js'),
    path.join(__dirname, '../../../cli-node.js'),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[0] || path.join(process.cwd(), 'cli-node.js')
}

export function ensureCliExists(nodeCliPath: string): void {
  if (!fs.existsSync(nodeCliPath)) {
    throw new Error(
      `Missing ${nodeCliPath}. Run "bun run build:node" before starting the session server.`,
    )
  }
}

export function buildSessionEnv(
  options: BackendSpawnOptions,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  // Read moss settings so the ACP subprocess inherits the configured API URL
  // and auth token even when the server process itself doesn't have them in env
  // (e.g. standalone moss-server that wasn't launched from the Electron host).
  const mossSettings = getSystemSettings()
  return {
    ...process.env,
    MOSS_HOME,
    ...(options.userId ? { MOSS_SESSION_USER_ID: options.userId } : {}),
    ...(options.orgId ? { MOSS_SESSION_ORG_ID: options.orgId } : {}),
    ...(options.role ? { MOSS_SESSION_ROLE: options.role } : {}),
    ...(options.scopes
      ? { MOSS_SESSION_SCOPES: options.scopes.join(',') }
      : {}),
    ...(options.assistantName
      ? { MOSS_ASSISTANT_NAME: options.assistantName }
      : {}),
    // Inject API base URL and auth token from ~/.moss/settings.json so the
    // ACP subprocess talks to the right provider with the right credentials.
    ...(mossSettings.url ? { ANTHROPIC_BASE_URL: mossSettings.url } : {}),
    ...(mossSettings.apiKey ? { ANTHROPIC_AUTH_TOKEN: mossSettings.apiKey } : {}),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ),
  }
}

export function createStreamBackendHandle(
  child: ChildProcess,
  options: BackendSpawnOptions,
  runtime: SessionRuntimeInfo,
): BackendHandle {
  if (!child.stdin || !child.stdout) {
    throw new Error('Failed to start direct-connect child process')
  }

  const stdoutListeners = new Set<(line: string) => void>()
  const stderrListeners = new Set<(line: string) => void>()
  const exitListeners = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >()

  const stdoutRl = createInterface({ input: child.stdout })
  stdoutRl.on('line', line => {
    const payload = `${line}\n`
    for (const listener of stdoutListeners) {
      listener(payload)
    }
  })

  if (child.stderr) {
    const stderrRl = createInterface({ input: child.stderr })
    stderrRl.on('line', line => {
      const payload = `${line}\n`
      for (const listener of stderrListeners) {
        listener(payload)
      }
      process.stderr.write(
        `[direct-connect child ${options.sessionId}] ${line}\n`,
      )
    })
  }

  child.on('close', (code, signal) => {
    stdoutRl.close()
    for (const listener of exitListeners) {
      listener(code, signal)
    }
  })

  child.on('error', error => {
    process.stderr.write(
      `[direct-connect child ${options.sessionId}] spawn error: ${error.message}\n`,
    )
  })

  return {
    workDir: options.cwd,
    runtime,
    writeStdin(data: string) {
      if (!child.stdin?.destroyed) {
        child.stdin.write(data)
      }
    },
    onStdoutLine(listener) {
      stdoutListeners.add(listener)
      return () => {
        stdoutListeners.delete(listener)
      }
    },
    onStderrLine(listener) {
      stderrListeners.add(listener)
      return () => {
        stderrListeners.delete(listener)
      }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => {
        exitListeners.delete(listener)
      }
    },
    destroy(force = false) {
      if (child.killed) {
        return
      }
      if (process.platform === 'win32') {
        child.kill()
        return
      }
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    },
  }
}

export function spawnLocalCliProcess(
  options: BackendSpawnOptions,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const nodeCliPath = resolveNodeCliPath()
  ensureCliExists(nodeCliPath)

  // Use --acp flag to run as ACP Agent Server (JSON-RPC 2.0 over stdin/stdout)
  const args = [
    nodeCliPath,
    '--acp',
  ]

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId)
  }

  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions')
  }

  return spawn(process.execPath, args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}
