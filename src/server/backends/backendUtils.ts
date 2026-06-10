import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { mkdir, readFile, symlink } from 'fs/promises'
import {
  MOSS_HOME,
} from '../../utils/skills/localSkillDirectories.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findAssistantDir, readAssistantMeta } from '../agentStore.js'
import type {
  BackendAvailableSkill,
  BackendHandle,
  BackendSpawnOptions,
  SessionRuntimeInfo,
} from '../sessionManager.js'
import { getSystemSettings } from '../systemSettings.js'
import { getUserModelPreference } from '../userModelPreference.js'
import { readSkillMeta } from '../skillStore.js'
import type { WorkspaceSkillLink } from '../../utils/scodeBridge.js'

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

/**
 * Document Center v2: locate the `bin/` directory that contains the
 * wiki CLI binary (built by scripts/build.js into bin/wiki). The scode
 * subprocess gets this dir prepended to PATH so `wiki list / read`
 * resolves without manual install. Returns null if no binary found.
 */
function resolveMossBinDir(): string | null {
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // dev: cwd is repo root
    path.join(process.cwd(), 'bin'),
    // packaged: bin/ next to moss-server.mjs
    path.join(dirname, '..', 'bin'),
    path.join(dirname, '..', '..', 'bin'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'wiki'))) {
      return dir
    }
  }
  return null
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

  // Document Center v2: prepend bin/ to PATH so scode can find the wiki
  // CLI without manual installation. Falls back silently if bin/wiki
  // wasn't built (Go missing on build host).
  const mossBinDir = resolveMossBinDir()
  if (mossBinDir) {
    const currentPath = (overrides.PATH ?? process.env.PATH) || ''
    env.PATH = currentPath
      ? `${mossBinDir}${path.delimiter}${currentPath}`
      : mossBinDir
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
 * Build the per-session SUDO_CODE_CONFIG_HOME path. Always per-session even when
 * dockerMode='user' (which shares configDir for shared memory) — keeps
 * sudocode.json / settings.json out of the shared configDir and prevents
 * concurrent write collisions.
 */
export function buildSessionScodeHomeDir(
  runtimeDir: string,
  sessionId: string,
): string {
  return path.join(runtimeDir, 'sessions', sessionId, 'scode-home', '.nexus', 'sudocode')
}

/**
 * 获取所有可用的 skill 名称列表
 *
 * 从所有 skill 目录中收集已启用且有效的 skill 名称
 * 用于非助手会话场景（同步所有可见 skills）
 *
 * @returns 所有可用 skill 名称数组
 */
export async function getAllAvailableSkillNames(): Promise<string[]> {
  const { getInstalledSkills } = await import('../skillStore.js')
  const installedSkills = await getInstalledSkills()

  // 过滤出启用的 skills，返回名称
  return installedSkills
    .filter(skill => skill.enabled !== false)
    .map(skill => skill.name.trim())
    .filter(Boolean)
}

/**
 * 读取 assistant 的 memory_mode 和 enabledSkills
 *
 * @param assistantName - assistant 名称
 * @returns memoryMode 和 enabledSkills
 *
 * enabledSkills 返回值说明:
 * - 指定了 assistantName 且助手有配置 enabledSkills: 返回配置的 skill 列表
 * - 指定了 assistantName 但助手没有配置 enabledSkills: 返回所有可用 skills
 * - 未指定 assistantName: 返回所有可用 skills
 */
export async function getAssistantRuntimeConfig(
  assistantName?: string,
): Promise<{
  memoryMode: 'session' | 'user'
  enabledSkills: string[]
}> {
  // 未指定助手时，返回所有可用 skills
  if (!assistantName) {
    const allSkills = await getAllAvailableSkillNames()
    return { memoryMode: 'session', enabledSkills: allSkills }
  }

  try {
    const result = await findAssistantDir(assistantName)
    if (!result) {
      // 找不到助手时，返回所有可用 skills
      const allSkills = await getAllAvailableSkillNames()
      return { memoryMode: 'session', enabledSkills: allSkills }
    }

    const meta = await readAssistantMeta(result.dir)

    // 助手没有配置 enabledSkills 时，返回所有可用 skills
    if (!Array.isArray(meta?.enabledSkills)) {
      const allSkills = await getAllAvailableSkillNames()
      return {
        memoryMode: meta?.memory_mode === 'user' ? 'user' : 'session',
        enabledSkills: allSkills,
      }
    }

    // 助手配置了 enabledSkills，返回配置的列表（过滤并 trim）
    return {
      memoryMode: meta?.memory_mode === 'user' ? 'user' : 'session',
      enabledSkills: meta.enabledSkills
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
        .filter(Boolean),
    }
  } catch (error) {
    process.stderr.write(`[Backend] Failed to read assistant config: ${error}\n`)
    // 出错时返回所有可用 skills
    const allSkills = await getAllAvailableSkillNames()
    return { memoryMode: 'session', enabledSkills: allSkills }
  }
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const key = line.slice(0, colonIndex).trim()
    let value = line.slice(colonIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) result[key] = value
  }
  return result
}

export async function buildAvailableSkillSnapshot(
  skillLinks: WorkspaceSkillLink[],
): Promise<BackendAvailableSkill[]> {
  const snapshots: BackendAvailableSkill[] = []
  const seen = new Set<string>()

  for (const link of skillLinks) {
    if (seen.has(link.name)) continue
    seen.add(link.name)

    const [meta, frontmatter] = await Promise.all([
      readSkillMeta(link.sourcePath).catch(() => null),
      readFile(path.join(link.sourcePath, 'SKILL.md'), 'utf8')
        .then(parseSkillFrontmatter)
        .catch(() => ({})),
    ])
    const icon =
      typeof meta?.icon === 'string'
        ? meta.icon
        : typeof frontmatter.icon === 'string'
          ? frontmatter.icon
          : undefined

    snapshots.push({
      name: link.name,
      displayName:
        meta?.display_name ||
        meta?.name ||
        frontmatter.name ||
        frontmatter.displayName ||
        link.name,
      description:
        typeof meta?.description === 'string'
          ? meta.description
          : frontmatter.description || '',
      ...(icon ? { icon } : {}),
      ...(icon?.startsWith('http') ? { iconUrl: icon } : {}),
      emoji:
        typeof meta?.emoji === 'string'
          ? meta.emoji
          : typeof frontmatter.emoji === 'string'
            ? frontmatter.emoji
            : null,
      source: typeof meta?.source_type === 'string' ? meta.source_type : undefined,
      path: link.workspacePath,
    })
  }

  return snapshots
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
