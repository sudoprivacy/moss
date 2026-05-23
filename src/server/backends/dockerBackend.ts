import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { MOSS_HOME } from '../../utils/skills/localSkillDirectories.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeInfo,
  SessionRuntimeOptions,
} from '../sessionManager.js'
import {
  buildSessionEnv,
  createStreamBackendHandle,
  ensureCliExists,
  resolveNodeCliPath,
} from './backendUtils.js'

type DockerBackendDefaults = {
  image?: string
  mode?: 'session' | 'user'
  network?: string
  labels?: Record<string, string>
}

function uniqueMounts(paths: string[]): string[] {
  return [...new Set(paths)]
}

function resolveDockerUser(): string | null {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return null
  }
  return `${process.getuid()}:${process.getgid()}`
}

function buildConfigDir(
  options: BackendSpawnOptions,
  mode: 'session' | 'user',
): string {
  if (mode === 'user' && options.userId) {
    return join(
      getClaudeConfigHomeDir(),
      'direct-connect-runtime',
      'users',
      options.userId,
    )
  }
  return join(
    getClaudeConfigHomeDir(),
    'direct-connect-runtime',
    'sessions',
    options.sessionId,
  )
}

function getHostSettingsPath(): string {
  return join(getClaudeConfigHomeDir(), 'settings.json')
}

export class DockerBackend implements SessionBackend {
  constructor(private readonly defaults: DockerBackendDefaults = {}) {}

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    if (process.platform === 'win32') {
      throw new Error('Docker runtime is not supported on Windows by this build')
    }

    const runtime = options.runtime
    const image = runtime?.dockerImage || this.defaults.image
    const mode = runtime?.dockerMode || this.defaults.mode || 'session'
    if (!image) {
      throw new Error(
        'Docker runtime requested but no docker image was configured',
      )
    }

    const nodeCliPath = resolveNodeCliPath()
    ensureCliExists(nodeCliPath)

    const configDir = runtime?.configDir || buildConfigDir(options, mode)
    await mkdir(configDir, { recursive: true })
    const hostSettingsPath = getHostSettingsPath()

    const mounts = uniqueMounts([
      options.cwd,
      dirname(nodeCliPath),
      configDir,
      MOSS_HOME,
    ])

    const containerName =
      runtime?.containerName || `moss-session-${options.sessionId.slice(0, 12)}`
    const env = buildSessionEnv(options, {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_CLI_PATH: nodeCliPath,
    })

    const args = ['run', '--rm', '-i', '--name', containerName]
    // Add security options to allow sandbox (unshare) to work in container
    args.push('--security-opt', 'seccomp=unconfined')
    args.push('--cap-add', 'SYS_ADMIN')
    const dockerUser = resolveDockerUser()
    if (dockerUser) {
      args.push('--user', dockerUser)
    }
    if (this.defaults.network) {
      args.push('--network', this.defaults.network)
    }
    for (const [key, value] of Object.entries(this.defaults.labels || {})) {
      args.push('--label', `${key}=${value}`)
    }
    for (const mount of mounts) {
      args.push('-v', `${mount}:${mount}`)
    }
    if (existsSync(hostSettingsPath)) {
      args.push('-v', `${hostSettingsPath}:${join(configDir, 'settings.json')}:ro`)
    }

    args.push('-w', options.cwd)
    const passthroughEnvKeys = [
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_CLI_PATH',
      'MOSS_SESSION_USER_ID',
      'MOSS_SESSION_ORG_ID',
      'MOSS_SESSION_ROLE',
      'MOSS_SESSION_SCOPES',
      'MOSS_SESSION_RUNTIME_TYPE',
      'MOSS_ASSISTANT_NAME',
    ]
    for (const key of passthroughEnvKeys) {
      if (env[key]) {
        args.push('-e', `${key}=${env[key]}`)
      }
    }
    args.push('-e', `HOME=${configDir}`)
    args.push('-e', `MOSS_HOME=${MOSS_HOME}`)

    args.push(
      image,
      'node',
      nodeCliPath,
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
    )

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId)
    } else {
      args.push('--session-id', options.sessionId)
    }

    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions')
    }

    const child = spawn('docker', args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const runtimeInfo: SessionRuntimeInfo = {
      type: 'docker',
      dockerImage: image,
      dockerMode: mode,
      containerName,
      configDir,
    }

    const handle = createStreamBackendHandle(child, options, runtimeInfo)
    return {
      ...handle,
      destroy(force = false) {
        if (child.killed) {
          return
        }
        if (force) {
          const cleanup = spawn('docker', ['rm', '-f', containerName], {
            stdio: 'ignore',
            windowsHide: true,
          })
          cleanup.unref()
        }
        handle.destroy(force)
      },
    }
  }
}
