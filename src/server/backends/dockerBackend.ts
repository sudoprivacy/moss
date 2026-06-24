import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import os from 'os'
import { dirname, join } from 'path'
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
  buildAvailableSkillSnapshot,
} from './backendUtils.js'
import { createAcpBridgeHandle } from './acpBridge.js'
import { buildAllModelsConfig, ensureOpenAIModelConfig } from '../modelListCache.js'
import { reapInUserContainer } from '../runtime/reaper.js'
import { toHostPath } from '../runtime/dockerPathMap.js'
import { logRuntimeEvent, logRuntimeMetric } from '../runtime/runtimeMetrics.js'

type DockerBackendDefaults = {
  image?: string
  mode?: 'session' | 'user'
  /**
   * Container reuse boundary fallback when manifest didn't pin it. Defaults
   * to 'session' (legacy behavior).
   */
  containerMode?: 'session' | 'user'
  execKillGraceMs?: number
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

async function readScodeSessionId(filePath: string): Promise<string | undefined> {
  try {
    const value = (await readFile(filePath, 'utf8')).trim()
    return value || undefined
  } catch {
    return undefined
  }
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

    const enabledSkills = options.assistantName
      ? assistantConfig.enabledSkills
      : (options.enabledSkillNames ?? assistantConfig.enabledSkills)

    // 根据 memory_mode 决定 mode
    const mode = runtime?.dockerMode
      || (assistantConfig.memoryMode === 'user' ? 'user' : undefined)
      || this.defaults.mode
      || 'session'

    const configDir = runtime?.configDir || buildConfigDir(options, mode)
    await mkdir(configDir, { recursive: true })

    // scodePath: use runtime config or fallback to default
    const scodePath = runtime?.scodePath || '/usr/local/bin/scode'

    // C2: containerMode controls whether we `docker run` per session (legacy)
    // or `docker exec` into a long-lived per-user container.
    const containerMode: 'session' | 'user' =
      runtime?.containerMode || this.defaults.containerMode || 'session'

    // safeCwd: prefer workspace dir under runtimeDir if the requested cwd is
    // '/' because in user-container mode the moss-server home is not mounted.
    const fallbackCwd = runtime?.tmpDirInContainer
      ? dirname(runtime.tmpDirInContainer)
      : os.homedir()
    const safeCwd = options.cwd === '/' ? fallbackCwd : options.cwd

    // 同步技能到工作空间目录（新方案）
    // 在工作空间的 .nexus/sudocode/skills/ 目录创建符号链接
    // Docker 会挂载工作空间，所以容器内可以访问这些符号链接
    // enabledSkills: 由 getAssistantRuntimeConfig 统一处理
    // visibilityFilter: 过滤用户无权访问的技能
    let workspaceSkillLinks = [] as Awaited<ReturnType<typeof syncWorkspaceSkills>>
    try {
      workspaceSkillLinks = await syncWorkspaceSkills(safeCwd, enabledSkills, options.visibilityFilter)
      process.stderr.write(`[DockerBackend] Workspace skills synced to ${safeCwd}/.nexus/sudocode/skills/ with ${enabledSkills.length} skills\n`)
    } catch (err) {
      process.stderr.write(`[DockerBackend] Workspace skills sync warning: ${err}\n`)
    }
    const availableSkills = await buildAvailableSkillSnapshot(workspaceSkillLinks)

    // In session mode the session-level container name is used for `docker run`.
    // In user mode the *user* container name is used for `docker exec` and the
    // session-level containerName is only diagnostic.
    const userContainerName = runtime?.userContainerName
    const containerName =
      runtime?.containerName || `moss-session-${options.sessionId.slice(0, 12)}`
    if (containerMode === 'user' && !userContainerName) {
      throw new Error(
        'containerMode=user requires runtime.userContainerName to be set by the main process',
      )
    }

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
      // Auth proxy (skills reach external services through it; URL must be the
      // moss-server container name on moss-network, not localhost — see
      // MOSS_AUTH_PROXY_URL in runtimeService).
      'SUDOWORK_AUTH_PROXY_URL',
      'SUDOWORK_AUTH_PROXY_BASE_URL',
      'SUDOWORK_AUTH_PROXY_TOKEN',
      'CABIN_CONTROL_BASE_URL',
      'CABIN_CONTROL_AUTH',
      'CABIN_CONTROL_TIMEOUT_MS',
    ]

    const env = buildSessionEnv(options, {
      ...(options.sessionToken ? { SESSION_TOKEN: options.sessionToken } : {}),
    })

    // A1: per-session SUDO_CODE_CONFIG_HOME (always — even in session mode the
    // shared user-mode configDir caused write collisions on concurrent runs).
    // Falls back to the legacy <configDir>/.nexus/sudocode path when the main
    // process did not populate scodeHomeDir (e.g. very old manifests).
    const scodeHomeDir = runtime?.scodeHomeDir || join(configDir, '.nexus', 'sudocode')
    await mkdir(scodeHomeDir, { recursive: true })

    // Skill symlinks: only useful in legacy session mode where each session
    // has its own configDir / .claude/commands. In user-container mode we
    // rely on syncWorkspaceSkills (workspace is per-session) instead.
    if (enabledSkills.length > 0 && containerMode === 'session') {
      await createSkillSymlinks(configDir, enabledSkills)
    }

    const dummySudocodePath = join(scodeHomeDir, 'sudocode.json')

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
      const allModels = ensureOpenAIModelConfig(await buildAllModelsConfig(baseUrl), model)

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

    const scodeSettings = buildScodeSettings(options)
    // Write per-session scode settings. Lives in scode-home so concurrent
    // sessions in the same dockerMode=user configDir don't overwrite each other.
    if (Object.keys(scodeSettings).length > 0) {
      try {
        writeFileSync(join(scodeHomeDir, 'settings.json'), JSON.stringify(scodeSettings, null, 2), 'utf8')
        process.stderr.write(`[DockerBackend] Wrote per-session scode settings.json\n`)
      } catch (e) {
        process.stderr.write(`[DockerBackend] Failed to write settings.json: ${e}\n`)
      }
    }

    // 挂载列表：工作空间、配置目录、Moss 安装目录、scode-home
    // MOSS_HOME 需要挂载，因为符号链接指向这里
    const mounts = uniqueMounts([
      safeCwd,
      configDir,
      MOSS_HOME,
      ...(scodeHomeDir ? [scodeHomeDir] : []),
    ]).filter(p => p !== '/')

    // Use model from env (which includes user preference), or fallback
    let model = env.MOSS_DEFAULT_MODEL || runtime?.model || 'gemini-3-flash-preview'
    if (model && !model.includes('/') && !['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'].includes(model)) {
      model = `proxy/${model}`
    }
    console.log(`[DockerBackend] Model for session ${options.sessionId}: ${model} (from env.MOSS_DEFAULT_MODEL: ${env.MOSS_DEFAULT_MODEL})`)

    let args: string[]
    if (containerMode === 'user') {
      // docker exec into long-lived user container. moss-session-launch writes
      // pid + start_ticks for the reaper.
      args = ['exec', '-i', '-w', safeCwd]
      for (const key of passthroughEnvKeys) {
        if (env[key]) {
          args.push('-e', `${key}=${env[key]}`)
        }
      }
      args.push('-e', `HOME=${configDir}`)
      args.push('-e', `MOSS_HOME=${MOSS_HOME}`)
      args.push('-e', `SUDO_CODE_CONFIG_HOME=${scodeHomeDir}`)
      args.push('-e', `CLAUDE_CONFIG_DIR=${configDir}`)
      args.push('-e', `CLAUDE_CODE_REMOTE_MEMORY_DIR=${configDir}`)
      args.push('-e', `MOSS_SESSION_ID=${options.sessionId}`)
      if (runtime?.tmpDirInContainer) {
        args.push('-e', `TMPDIR=${runtime.tmpDirInContainer}`)
        args.push('-e', `TMP=${runtime.tmpDirInContainer}`)
        args.push('-e', `TEMP=${runtime.tmpDirInContainer}`)
      }
      args.push(userContainerName!)
      args.push('/usr/local/bin/moss-session-launch', options.sessionId, '--')
      args.push(
        scodePath,
        'acp',
        '--output-format', 'json',
        '--permission-mode', 'danger-full-access',
        '--auth', 'proxy',
        '--model', model,
      )

      process.stderr.write(`\n[DockerBackend] docker exec into user container:\n`)
      process.stderr.write(`  userContainer: ${userContainerName}\n`)
      process.stderr.write(`  scode: ${scodePath}\n`)
      process.stderr.write(`  CWD: ${safeCwd}\n`)
      process.stderr.write(`  configDir: ${configDir}\n`)
      process.stderr.write(`  scodeHomeDir: ${scodeHomeDir}\n`)
      process.stderr.write(`  mode: ${mode}\n`)
      process.stderr.write(`  containerMode: user\n`)
      process.stderr.write(`  enabledSkills: ${enabledSkills.join(', ') || 'none'}\n`)
      process.stderr.write(`  Model: ${model}\n\n`)
    } else {
      // Legacy `docker run --rm` per session.
      args = ['run', '--rm', '-i', '--name', containerName]
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
        const hostPath = toHostPath(mount)
        args.push('-v', `${hostPath}:${mount}`)
      }
      args.push('-w', safeCwd)
      for (const key of passthroughEnvKeys) {
        if (env[key]) {
          args.push('-e', `${key}=${env[key]}`)
        }
      }
      args.push('-e', `HOME=${configDir}`)
      args.push('-e', `MOSS_HOME=${MOSS_HOME}`)
      args.push('-e', `SUDO_CODE_CONFIG_HOME=${scodeHomeDir}`)
      args.push('-e', `CLAUDE_CONFIG_DIR=${configDir}`)
      args.push('-e', `CLAUDE_CODE_REMOTE_MEMORY_DIR=${configDir}`)
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
      process.stderr.write(`  scodeHomeDir: ${scodeHomeDir}\n`)
      process.stderr.write(`  mode: ${mode}\n`)
      process.stderr.write(`  containerMode: session\n`)
      process.stderr.write(`  enabledSkills: ${enabledSkills.join(', ') || 'none'}\n`)
      process.stderr.write(`  Model: ${model}\n`)
      process.stderr.write(`  Mounts: ${mounts.join(', ')}\n\n`)
    }

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
      containerMode,
      containerName,
      userContainerName,
      configDir,
      scodeHomeDir,
      inContainerPidFile: runtime?.inContainerPidFile,
      tmpDirInContainer: runtime?.tmpDirInContainer,
    }
    const scodeSessionIdPath = join(safeCwd, '.moss', 'scode-session-id')
    const resumeSessionId = options.resumeSessionId
      ? await readScodeSessionId(scodeSessionIdPath)
      : undefined

    const handle = createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: safeCwd,
      model,
      transcriptPath: (options as any).transcriptPath,
      resumeSessionId,
      scodeSessionIdPath,
      containerMode,
      assistantName: options.assistantName,
      enabledSkillNames: enabledSkills,
      availableWikis: options.availableWikis,
      availableCorpApps: options.availableCorpApps,
      sharedMemory: options.sharedMemory,
      runtime: runtimeInfo,
    })
    handle.availableSkills = availableSkills

    let cleanedUp = false
    const cleanupSessionMode = () => {
      if (cleanedUp) return
      cleanedUp = true

      // Legacy: best-effort backup `docker rm -f` because `--rm` sometimes
      // misses reaping if the container died abnormally.
      const cleanup = spawn('docker', ['rm', '-f', containerName], {
        stdio: 'ignore',
        windowsHide: true,
      })
      cleanup.unref()

      if (mode === 'session' && configDir) {
        rm(configDir, { recursive: true, force: true }).catch(() => {})
      }
      // A1: scode-home is per-session in all modes — always safe to clear.
      if (scodeHomeDir) {
        rm(scodeHomeDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    const cleanupUserMode = async (force: boolean) => {
      if (cleanedUp) return
      cleanedUp = true

      // Step 1: persist partial assistant text on graceful destroy.
      if (!force && handle.persistInProgressTurn) {
        try {
          await handle.persistInProgressTurn()
          logRuntimeMetric('session_persist_in_progress_ok', {})
        } catch (err) {
          process.stderr.write(`[DockerBackend] persistInProgressTurn failed: ${err}\n`)
          logRuntimeMetric('session_persist_in_progress_failed', { reason: 'exception' })
          logRuntimeEvent('session_persist_in_progress_failed', {
            sessionId: options.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Step 2: real kill inside the container via reaper.
      const graceMs = force ? 0 : (this.defaults.execKillGraceMs ?? 5000)
      if (userContainerName) {
        const outcome = await reapInUserContainer({
          userContainerName,
          sessionId: options.sessionId,
          graceMs,
        })
        if (outcome.ok) {
          logRuntimeMetric('session_reap_ok', {})
        } else if (outcome.timedOut) {
          logRuntimeMetric('session_reap_timeout', { reason: 'grace_timeout' })
          logRuntimeEvent('session_reap_timeout', {
            sessionId: options.sessionId,
            containerName: userContainerName,
            graceMs,
          })
        } else {
          logRuntimeMetric('session_reap_failed', { reason: 'exec_error' })
          logRuntimeEvent('session_reap_failed', {
            sessionId: options.sessionId,
            containerName: userContainerName,
            graceMs,
            code: outcome.code,
            stderr: outcome.stderr.trim().slice(0, 200),
          })
        }
        if (!outcome.ok) {
          process.stderr.write(
            `[DockerBackend] reap failed sid=${options.sessionId} timedOut=${outcome.timedOut} code=${outcome.code} stderr=${outcome.stderr.trim()}\n`,
          )
        }
      }

      // Step 3: best-effort host fd cleanup. scode is already dead; the host
      // docker exec CLI usually exits on its own. Only SIGKILL if still alive
      // after a short grace.
      const waitForExit = new Promise<void>(resolve => {
        if (child.exitCode !== null) return resolve()
        const timer = setTimeout(() => resolve(), 3000)
        child.once('close', () => { clearTimeout(timer); resolve() })
      })
      await waitForExit
      if (child.exitCode === null && !child.killed) {
        try { child.stdin?.end() } catch {}
        try { child.kill('SIGKILL') } catch {}
        logRuntimeMetric('session_host_exec_force_kill', {})
        logRuntimeEvent('session_host_exec_force_kill', {
          sessionId: options.sessionId,
          containerName: userContainerName,
        })
      }

      // Step 4: per-session disk cleanup. Transcript is intentionally NOT
      // touched (A3 — preserved for /sessions/:id/context).
      if (runtime?.tmpDirInContainer) {
        rm(runtime.tmpDirInContainer, { recursive: true, force: true }).catch(() => {})
      }
      if (runtime?.inContainerPidFile) {
        // The reaper already removed pidfile + start_ticks. Removing the
        // runtime dir is harmless and cleans up session_id stub.
        const runtimeMeta = dirname(runtime.inContainerPidFile)
        rm(runtimeMeta, { recursive: true, force: true }).catch(() => {})
      }
      // scodeHomeDir is session-scoped, not attempt-scoped. Do not remove it
      // here: reconnects can create the next attempt while this async cleanup
      // is still running, racing with sudocode.json creation.
      if (mode === 'session' && configDir) {
        rm(configDir, { recursive: true, force: true }).catch(() => {})
      }
      // Step 5 (registry.releaseSession) NOT done here — main process
      // child.once('close') handler triggers it.
    }

    if (containerMode === 'user') {
      child.once('close', () => {
        // If the runner exited without an explicit destroy(), still run the
        // reaper to clean orphaned scode trees.
        void cleanupUserMode(false).catch(() => {})
      })
    } else {
      child.once('close', () => {
        cleanupSessionMode()
      })
    }

    const originalDestroy = handle.destroy.bind(handle)
    handle.destroy = async (force = false) => {
      // Call AcpBridge's destroy first so it can:
      //  - session mode: send signal to docker run process
      //  - user mode: just end stdin (no signal — would be ignored by daemon)
      const destroyResult = originalDestroy(force)
      if (destroyResult instanceof Promise) {
        await destroyResult.catch(() => {})
      }

      if (containerMode === 'user') {
        await cleanupUserMode(force).catch(err => {
          process.stderr.write(`[DockerBackend] cleanupUserMode error: ${err}\n`)
        })
      } else if (force) {
        cleanupSessionMode()
      }
    }

    return handle
  }
}

function buildScodeSettings(options: BackendSpawnOptions): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  if (options.mcpSettings && Object.keys(options.mcpSettings.mcpServers).length > 0) {
    Object.assign(settings, options.mcpSettings)
  }
  if (options.enabledSkillNames?.includes('cabin-hardware-control')) {
    settings.sandbox = {
      ...(typeof settings.sandbox === 'object' && settings.sandbox !== null ? settings.sandbox : {}),
      enabled: false,
      enabledPlatforms: ['macos'],
      allowUnsandboxedCommands: true,
    }
  }
  return settings
}
