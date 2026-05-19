import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { mkdir, symlink } from 'fs/promises'
import {
  MOSS_HOME,
} from '../../utils/skills/localSkillDirectories.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findAssistantDir, readAssistantMeta } from '../agentStore.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionRuntimeInfo,
} from '../sessionManager.js'
import { getSystemSettings } from '../systemSettings.js'
import { getUserModelPreference } from '../userModelPreference.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function resolveScodeCliPath(configPath?: string): string {
  if (configPath && fs.existsSync(configPath)) {
    return configPath
  }

  const defaultRelativePath = path.join(process.cwd(), '../sudocode/scode')
  if (fs.existsSync(defaultRelativePath)) {
    return defaultRelativePath
  }

  return 'scode'
}

export function buildSessionEnv(
  options: BackendSpawnOptions,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const settings = getSystemSettings()

  let fileApiKey = ''
  let fileBaseUrl = ''
  try {
    const settingsPath = path.join(os.homedir(), '.moss', 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const content = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      fileApiKey = content.env?.ANTHROPIC_AUTH_TOKEN || content.env?.ANTHROPIC_API_KEY || content.apiKey || ''
      fileBaseUrl = content.env?.ANTHROPIC_BASE_URL || content.url || ''
    }
  } catch {
    // Ignore read errors
  }

  const apiKey = fileApiKey
    || settings.apiKey
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN

  // Document Center: in-container scode talks back to moss-server through
  // the `wiki` CLI. The CLI refuses to run unless these two env vars are
  // set. MOSS_SERVER_URL defaults to the local moss process; SESSION_TOKEN
  // is provided by the caller (RuntimeService / WikiJobExecutor) via the
  // `overrides` map — buildSessionEnv itself does not sign tokens.
  const inferredServerUrl =
    process.env.MOSS_SERVER_URL
      || (settings as { serverUrl?: string }).serverUrl
      || ''

  // Get user model preference if available
  // Model priority: user preference > system settings > default
  // NOTE: In session runner process, userPref is null (no DB access)
  // The main process passes user preference via MOSS_DEFAULT_MODEL env var
  // So we prioritize process.env.MOSS_DEFAULT_MODEL over settings.model
  const userPref = options.userId ? getUserModelPreference(options.userId) : null
  const defaultModel = userPref?.modelId
    || process.env.MOSS_DEFAULT_MODEL  // From main process (includes user preference)
    || settings.model
    || 'gemini-3-flash-preview'

  process.stderr.write(`\n[buildSessionEnv] Model selection for session ${options.sessionId}:\n`)
  process.stderr.write(`  - userId: ${options.userId || 'undefined'}\n`)
  process.stderr.write(`  - userPref: ${JSON.stringify(userPref)}\n`)
  process.stderr.write(`  - settings.model: ${settings.model || 'undefined'}\n`)
  process.stderr.write(`  - MOSS_DEFAULT_MODEL env: ${process.env.MOSS_DEFAULT_MODEL || 'undefined'}\n`)
  process.stderr.write(`  - selected defaultModel: ${defaultModel}\n`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOSS_HOME,
    ...(apiKey ? { ANTHROPIC_AUTH_TOKEN: apiKey } : {}),
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    ...(apiKey ? { PROXY_AUTH_TOKEN: apiKey } : {}),
    ANTHROPIC_BASE_URL: fileBaseUrl
      || settings.url
      || process.env.ANTHROPIC_BASE_URL
      || 'https://hk.sudorouter.ai/v1',
    ...(options.userId ? { MOSS_SESSION_USER_ID: options.userId } : {}),
    ...(options.orgId ? { MOSS_SESSION_ORG_ID: options.orgId } : {}),
    ...(options.role ? { MOSS_SESSION_ROLE: options.role } : {}),
    ...(options.scopes
      ? { MOSS_SESSION_SCOPES: options.scopes.join(',') }
      : {}),
    ...(options.assistantName
      ? { MOSS_ASSISTANT_NAME: options.assistantName }
      : {}),
    ...(inferredServerUrl ? { MOSS_SERVER_URL: inferredServerUrl } : {}),
    MOSS_DEFAULT_MODEL: defaultModel,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ),
  }

  return env
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

/**
 * 根据 memory_mode 构建 configDir 路径
 *
 * @param options - Backend spawn options
 * @param mode - 'session' 或 'user'
 * @returns configDir 绝对路径
 */
export function buildConfigDir(
  options: BackendSpawnOptions,
  mode: 'session' | 'user',
): string {
  if (mode === 'user' && options.userId) {
    return path.join(
      getClaudeConfigHomeDir(),
      'direct-connect-runtime',
      'users',
      options.userId,
    )
  }
  return path.join(
    getClaudeConfigHomeDir(),
    'direct-connect-runtime',
    'sessions',
    options.sessionId,
  )
}

/**
 * 读取 assistant 的 memory_mode 和 enabledSkills
 *
 * @param assistantName - assistant 名称
 * @returns memoryMode 和 enabledSkills
 */
export async function getAssistantRuntimeConfig(
  assistantName?: string,
): Promise<{
  memoryMode: 'session' | 'user'
  enabledSkills: string[]
}> {
  if (!assistantName) {
    return { memoryMode: 'session', enabledSkills: [] }
  }

  try {
    const result = await findAssistantDir(assistantName)
    if (!result) {
      return { memoryMode: 'session', enabledSkills: [] }
    }

    const meta = await readAssistantMeta(result.dir)
    return {
      memoryMode: meta?.memory_mode === 'user' ? 'user' : 'session',
      enabledSkills: Array.isArray(meta?.enabledSkills)
        ? meta.enabledSkills.filter((s): s is string => typeof s === 'string')
        : [],
    }
  } catch (error) {
    process.stderr.write(`[Backend] Failed to read assistant config: ${error}\n`)
    return { memoryMode: 'session', enabledSkills: [] }
  }
}

/**
 * 创建 skill symlinks 到 configDir/.claude/commands/
 *
 * 通过 symlink 让 scode 只发现 enabledSkills 中的 skill
 *
 * @param configDir - configDir 路径
 * @param enabledSkills - 要启用的 skill 名称列表
 */
export async function createSkillSymlinks(
  configDir: string,
  enabledSkills: string[],
): Promise<void> {
  if (!enabledSkills.length) {
    return
  }

  const commandsDir = path.join(configDir, '.claude', 'commands')

  // 确保 commands 目录存在
  await mkdir(commandsDir, { recursive: true })

  for (const skillName of enabledSkills) {
    // skill 的 SKILL.md 文件路径
    const skillMdPath = path.join(MOSS_HOME, 'skills', 'hub', skillName, 'SKILL.md')

    // symlink 目标路径
    const linkPath = path.join(commandsDir, `${skillName}.md`)

    try {
      await symlink(skillMdPath, linkPath)
      process.stderr.write(`[Backend] Created skill symlink: ${skillName}\n`)
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        // user 模式下可能已存在，跳过
        process.stderr.write(`[Backend] Skill symlink already exists: ${skillName}\n`)
      } else {
        // 其他错误记录日志但不中断流程
        process.stderr.write(`[Backend] Failed to create symlink for ${skillName}: ${e.message}\n`)
      }
    }
  }
}