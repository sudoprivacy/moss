import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import os from 'os'
import { join } from 'path'
import { MOSS_HOME } from '../../utils/skills/localSkillDirectories.js'
import { syncWorkspaceSkills } from '../../utils/scodeBridge.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeInfo,
} from '../sessionManager.js'
import {
  buildSessionEnv,
  buildConfigDir,
  getAssistantRuntimeConfig,
  createSkillSymlinks,
} from './backendUtils.js'
import { createAcpBridgeHandle } from './acpBridge.js'
import { buildAllModelsConfig } from '../modelListCache.js'

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

export class DockerBackend implements SessionBackend {
  constructor(private readonly defaults: DockerBackendDefaults = {}) {}

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    if (process.platform === 'win32') {
      throw new Error('Docker runtime is not supported on Windows by this build')
    }

    const runtime = options.runtime
    const image = runtime?.dockerImage || this.defaults.image

    if (!image) {
      throw new Error(
        'Docker runtime requested but no docker image was configured',
      )
    }

    // 读取 assistant 配置
    const assistantConfig = await getAssistantRuntimeConfig(options.assistantName)

    // 根据 memory_mode 决定 mode
    const mode = runtime?.dockerMode
      || (assistantConfig.memoryMode === 'user' ? 'user' : undefined)
      || this.defaults.mode
      || 'session'

    const configDir = runtime?.configDir || buildConfigDir(options, mode)
    await mkdir(configDir, { recursive: true })

    const scodePath = '/usr/local/bin/scode'

    const safeCwd = options.cwd === '/' ? os.homedir() : options.cwd

    // 同步技能到工作空间目录（新方案）
    // 在工作空间的 .nexus/sudocode/skills/ 目录创建符号链接
    // Docker 会挂载工作空间，所以容器内可以访问这些符号链接
    try {
      await syncWorkspaceSkills(safeCwd, options.enabledSkillNames)
      process.stderr.write(`[DockerBackend] Workspace skills synced to ${safeCwd}/.nexus/sudocode/skills/\n`)
    } catch (err) {
      process.stderr.write(`[DockerBackend] Workspace skills sync warning: ${err}\n`)
    }

    const containerName =
      runtime?.containerName || `moss-session-${options.sessionId.slice(0, 12)}`

    const passthroughEnvKeys = [
      'MOSS_SESSION_USER_ID',
      'MOSS_SESSION_ORG_ID',
      'MOSS_SESSION_ROLE',
      'MOSS_SESSION_SCOPES',
      'MOSS_ASSISTANT_NAME',
      'MOSS_DEFAULT_MODEL',
      'MOSS_SERVER_URL',
      'SESSION_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'PROXY_AUTH_TOKEN',
    ]

    const env = buildSessionEnv(options, {
      ...(options.sessionToken ? { SESSION_TOKEN: options.sessionToken } : {}),
    })

    const dotNexusDir = join(configDir, '.nexus', 'sudocode')
    await mkdir(dotNexusDir, { recursive: true })

    // Sync skill/agent bridges into the config directory so scode can discover them
    try {
      await syncAllBridgesAsync(configDir)
    } catch (bridgeErr) {
      process.stderr.write(`[DockerBackend] scode bridge sync warning: ${bridgeErr}\n`)
    }

    // 创建 skill symlinks
    await createSkillSymlinks(configDir, assistantConfig.enabledSkills)

    const dummySudocodePath = join(dotNexusDir, 'sudocode.json')

    try {
      const baseUrl = env.ANTHROPIC_BASE_URL || 'https://hk.sudorouter.ai/v1'
      const apiKey = env.ANTHROPIC_API_KEY || ''
      // Use model from env (which includes user preference), or fallback
      // env.MOSS_DEFAULT_MODEL has priority: user preference > system settings > default
      const model = env.MOSS_DEFAULT_MODEL || runtime?.model || 'gemini-3-flash-preview'
      let scodeModelName = model
      if (!scodeModelName.includes('/') && !['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'].includes(scodeModelName)) {
        scodeModelName = `proxy/${scodeModelName}`
      }

      // Preload all available models from sudorouter API
      // This allows dynamic model switching without modifying sudocode.json
      const allModels = await buildAllModelsConfig(baseUrl)

      const scodeConfig = {
        auth_modes: {
          proxy: {
            "moss-proxy": {
              baseUrl,
              apiKey
            }
          }
        },
        models: allModels  // Preload all available models
      }
      writeFileSync(dummySudocodePath, JSON.stringify(scodeConfig, null, 2), 'utf8')
      process.stderr.write(`[DockerBackend] Preloaded ${Object.keys(allModels).length} models into sudocode.json\n`)
    } catch (e) {
      process.stderr.write(`[DockerBackend] Failed to create dynamic sudocode.json: ${e}\n`)
    }

    // 挂载列表：工作空间、配置目录、Moss 安装目录
    // MOSS_HOME 需要挂载，因为符号链接指向这里
    const mounts = uniqueMounts([
      safeCwd,
      configDir,
      MOSS_HOME,
    ]).filter(p => p !== '/')

    // Use model from env (which includes user preference), or fallback
    let model = env.MOSS_DEFAULT_MODEL || runtime?.model || 'gemini-3-flash-preview'
    if (model && !model.includes('/') && !['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'].includes(model)) {
      model = `proxy/${model}`
    }
    console.log(`[DockerBackend] Model for session ${options.sessionId}: ${model} (from env.MOSS_DEFAULT_MODEL: ${env.MOSS_DEFAULT_MODEL})`)

    const args = ['run', '--rm', '-i', '--name', containerName]
    // Add security options to allow Tokio runtime to spawn threads
    // Without this, scode fails with "OS can't spawn worker thread: Operation not permitted"
    args.push('--security-opt', 'seccomp=unconfined')
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

    args.push('-w', safeCwd)
    for (const key of passthroughEnvKeys) {
      if (env[key]) {
        args.push('-e', `${key}=${env[key]}`)
      }
    }
    args.push('-e', `HOME=${configDir}`)
    args.push('-e', `MOSS_HOME=${MOSS_HOME}`)

    args.push(
      image,
      scodePath,
      'acp',
      '--output-format', 'json',
      '--permission-mode', 'danger-full-access',
      '--auth', 'proxy',
      '--model', model,
    )

    process.stderr.write(`\n[DockerBackend] Spawning scode engine inside Docker:\n`)
    process.stderr.write(`  Image: ${image}\n`)
    process.stderr.write(`  scode: ${scodePath}\n`)
    process.stderr.write(`  CWD: ${safeCwd}\n`)
    process.stderr.write(`  configDir: ${configDir}\n`)
    process.stderr.write(`  mode: ${mode}\n`)
    process.stderr.write(`  enabledSkills: ${assistantConfig.enabledSkills.join(', ') || 'none'}\n`)
    process.stderr.write(`  Model: ${model}\n`)
    process.stderr.write(`  Mounts: ${mounts.join(', ')}\n\n`)

    const child = spawn('docker', args, {
      cwd: safeCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const runtimeInfo: SessionRuntimeInfo = {
      type: 'docker',
      engine: 'scode',
      dockerImage: image,
      dockerMode: mode,
      containerName,
      configDir,
    }

    const handle = createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: safeCwd,
      model,
      transcriptPath: (options as any).transcriptPath,
      // 新方案：传递智能体名称和启用的技能列表
      assistantName: options.assistantName,
      enabledSkillNames: options.enabledSkillNames,
      availableWikis: options.availableWikis,
      runtime: runtimeInfo,
    })

    const originalDestroy = handle.destroy.bind(handle)
    handle.destroy = (force = false) => {
      // 先执行原有销毁逻辑（停止容器）
      if (force) {
        const cleanup = spawn('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          windowsHide: true,
        })
        cleanup.unref()
      }
      originalDestroy(force)

      // Session 模式下异步清理 configDir
      if (mode === 'session' && configDir) {
        rm(configDir, { recursive: true, force: true }).catch(() => {
          // 忽略清理错误
        })
      }
    }

    return handle
  }
}
