import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir, readdir, lstat, readlink, rm, symlink } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  MOSS_HOME,
  MOSS_SKILLS_HUB_DIR,
  MOSS_SKILLS_SYSTEM_DIR,
  MOSS_SKILLS_CUSTOM_DIR,
  MOSS_SKILLS_TENANT_DIR,
  USER_SKILLS_DIR,
  SKILL_HUB_META_FILE,
} from './skills/localSkillDirectories.js'
import {
  ASSISTANT_HUB_DIR,
  ASSISTANT_SYSTEM_DIR,
  ASSISTANT_SEARCH_DIRS,
  ASSISTANT_META_FILE,
} from '../server/agentStore.js'
import type { VisibilityFilterContext } from '../server/sessionManager.js'

// ============================================================================
// 工作空间技能同步函数 (新方案)
// ============================================================================

/**
 * 解析工作空间技能目录路径
 *
 * @param workspace - 工作空间路径
 * @returns 工作空间技能目录路径
 */
export function resolveWorkspaceSkillsDir(workspace: string): string {
  return path.join(workspace, '.nexus', 'sudocode', 'skills')
}

/**
 * 同步技能到工作空间目录
 *
 * 将全局安装的技能通过符号链接同步到工作空间的 .nexus/sudocode/skills/ 目录
 *
 * @param workspace - 工作空间路径
 * @param enabledSkillNames - 可选，只同步指定的技能名称列表
 * @param visibilityFilter - 可选，可见性过滤上下文，用于过滤用户无权访问的技能
 */
export async function syncWorkspaceSkills(
  workspace: string,
  enabledSkillNames?: string[],
  visibilityFilter?: VisibilityFilterContext | null
): Promise<void> {
  const workspaceSkillsDir = resolveWorkspaceSkillsDir(workspace)
  await mkdir(workspaceSkillsDir, { recursive: true })

  // 获取所有技能源目录
  const skillSourceDirs = [
    MOSS_SKILLS_HUB_DIR,
    MOSS_SKILLS_SYSTEM_DIR,
    MOSS_SKILLS_CUSTOM_DIR,
    MOSS_SKILLS_TENANT_DIR,
    USER_SKILLS_DIR,
  ]

  // 收集所有启用的技能
  const skillTargets = new Map<string, string>() // skillName -> sourcePath

  for (const sourceDir of skillSourceDirs) {
    try {
      const entries = await readdir(sourceDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const skillName = entry.name
        const skillSourcePath = path.join(sourceDir, skillName)

        // 检查是否有 SKILL.md
        try {
          await lstat(path.join(skillSourcePath, 'SKILL.md'))
        } catch {
          continue // 没有 SKILL.md，跳过
        }

        // undefined 表示同步所有启用的技能；显式数组（包括空数组）表示严格按列表同步
        if (Array.isArray(enabledSkillNames) && !enabledSkillNames.includes(skillName)) {
          continue
        }

        // 检查技能是否启用
        if (!isSkillEnabledSync(skillSourcePath)) {
          continue
        }

        // 检查技能是否对用户可见
        if (!isSkillVisibleToSync(skillSourcePath, visibilityFilter ?? null)) {
          continue
        }

        // custom 优先级最高，然后是 hub，最后是 system
        if (!skillTargets.has(skillName) || sourceDir === MOSS_SKILLS_CUSTOM_DIR) {
          skillTargets.set(skillName, skillSourcePath)
        }
      }
    } catch {
      // 目录不存在，跳过
    }
  }

  // 清理旧的符号链接
  const existingEntries = await readdir(workspaceSkillsDir, { withFileTypes: true }).catch(() => [])
  for (const entry of existingEntries) {
    const entryPath = path.join(workspaceSkillsDir, entry.name)

    // 只清理符号链接
    try {
      const stat = await lstat(entryPath)
      if (stat.isSymbolicLink()) {
        // 检查目标是否还在预期列表中
        if (!skillTargets.has(entry.name)) {
          await rm(entryPath, { force: true })
        } else {
          // 检查链接目标是否正确
          const currentTarget = await readlink(entryPath)
          const resolvedTarget = path.resolve(path.dirname(entryPath), currentTarget)
          const expectedTarget = skillTargets.get(entry.name)

          if (resolvedTarget !== expectedTarget) {
            await rm(entryPath, { force: true })
          } else {
            // 链接正确，从待创建列表中移除
            skillTargets.delete(entry.name)
          }
        }
      }
    } catch {
      // 忽略错误
    }
  }

  // 创建新的符号链接
  for (const [skillName, sourcePath] of skillTargets) {
    const linkPath = path.join(workspaceSkillsDir, skillName)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'

    try {
      await symlink(sourcePath, linkPath, linkType)
    } catch (err) {
      console.warn(`[scodeBridge] Failed to create symlink for skill "${skillName}":`, err)
    }
  }
}

/**
 * 检查技能是否启用（同步版本）
 */
function isSkillEnabledSync(skillDir: string): boolean {
  const metaPath = path.join(skillDir, SKILL_HUB_META_FILE)
  try {
    const content = readFileSync(metaPath, 'utf8')
    const meta = JSON.parse(content)
    return meta.enabled !== false
  } catch {
    return true // 默认启用
  }
}

/**
 * 检查技能是否对用户可见
 */
function isSkillVisibleToSync(skillDir: string, filter: VisibilityFilterContext | null): boolean {
  // 如果没有提供过滤上下文，默认可见（向后兼容）
  if (!filter) return true

  // 管理员始终可见
  if (filter.isAdmin) return true

  const metaPath = path.join(skillDir, SKILL_HUB_META_FILE)
  let meta: { visible_to?: { department_ids?: string[] | null; user_ids?: string[] | null } | null } | null = null
  try {
    const content = readFileSync(metaPath, 'utf8')
    meta = JSON.parse(content)
  } catch {
    return true // 无法读取 meta，默认可见
  }

  const visibleTo = meta?.visible_to

  // visible_to 为 null 或 undefined → 所有人可见
  if (!visibleTo) return true

  // 检查用户白名单
  const userIds = visibleTo.user_ids
  if (userIds !== null && userIds !== undefined) {
    if (userIds.length === 0) {
      // 空数组表示仅管理员可见
      return false
    }
    if (userIds.includes(filter.userId)) {
      return true
    }
  }

  // 检查部门白名单
  const departmentIds = visibleTo.department_ids
  if (departmentIds !== null && departmentIds !== undefined) {
    if (departmentIds.length === 0) {
      // 空数组表示仅管理员可见
      return false
    }
    if (!filter.departmentId) {
      return false
    }
    for (const deptId of filter.visibleDepartmentIds ?? new Set()) {
      if (departmentIds.includes(deptId)) return true
    }
  }

  return false
}

// ============================================================================
// 首次消息注入函数 (新方案)
// ============================================================================

/**
 * 构建首次消息内容，注入技能和智能体信息
 */
export async function prepareFirstMessageForScode(
  userContent: string,
  config: {
    assistantName?: string | null
    workspace: string
    enabledSkillNames?: string[]
    sharedMemory?: string | null
    /**
     * Document Center: wikis the current Assistant is authorised to query.
     * When non-empty, an `[Available Wikis]` block is prepended to the
     * system instructions so the LLM knows the knowledge bases it can
     * pull from via the in-container `wiki` CLI.
     *
     * Pass only `{ id, name, description }` — the full content is
     * fetched on-demand by the agent calling `wiki read|search`.
     */
    availableWikis?: Array<{ id: string; name: string; description?: string | null }>
  }
): Promise<string> {
  const instructions: string[] = []

  // 1. 加载智能体身份和规则。AGENTS.md 仍会写入 configDir 作为
  // runtime-level override；首条消息注入保证 scode 没有读取该文件时
  // 也能收到同一套约束。
  if (config.assistantName) {
    instructions.push(buildIdentityBlock(config.assistantName))
    const assistantRules = await loadAssistantRules(config.assistantName)
    if (assistantRules) {
      instructions.push(assistantRules)
    }
  }

  // 2. 构建工作空间技能目录提示
  const skillsHint = await buildWorkspaceSkillsHint(config.workspace, config.enabledSkillNames)
  if (skillsHint) {
    instructions.push(skillsHint)
  }

  // 3. Shared user memory is duplicated here only as a fallback. The primary
  // path is the generated configDir/.nexus/sudocode/AGENTS.md override.
  if (config.sharedMemory && config.sharedMemory.trim()) {
    instructions.push(
      `[Shared User Memory]\nThe following facts were explicitly remembered across sessions for this user. Treat them as persisted user memory unless the user corrects them.\nWhen the user asks who they are, what their name is, or asks you to recall known preferences, answer from this memory first instead of guessing from the system environment.\n\n${config.sharedMemory.trim()}`,
    )
  }

  // 4. Document Center: available wikis hint
  if (config.availableWikis && config.availableWikis.length > 0) {
    const lines: string[] = []
    lines.push('[Available Wikis]')
    lines.push(
      'You have access to the following knowledge bases. Use the `wiki` CLI inside your shell to query them — DO NOT make up answers when these wikis can be searched first.',
    )
    lines.push('')
    for (const w of config.availableWikis) {
      const desc = (w.description ?? '').trim() || '(no description)'
      lines.push(`- ${w.id} — ${w.name}: ${desc}`)
    }
    lines.push('')
    lines.push('Commands:')
    lines.push('  wiki list                          # refresh the list above')
    lines.push('  wiki read <wikiId>                 # read WIKI.md (overview + chunk index)')
    lines.push('  wiki read <wikiId> --file <path>   # read a specific chunk')
    lines.push('  wiki search <wikiId> <query>       # full-text grep (recommended for large wikis)')
    lines.push('  wiki metadata <wikiId>             # build time / chunk count / etc.')
    instructions.push(lines.join('\n'))
  }

  if (instructions.length === 0) {
    return userContent
  }

  const systemInstructions = instructions.join('\n\n')
  return `[Assistant Rules - You MUST follow these instructions]\n${systemInstructions}\n\n[User Request]\n${userContent}`
}

/**
 * 构建身份覆盖块
 */
export function buildIdentityBlock(assistantName: string): string {
  return `[Identity Override - 最高优先级]
你的身份是：${assistantName}
当用户询问"你是谁"或类似身份问题时，必须回答："我是${assistantName}，有什么可以帮助你的吗？"
此身份声明优先级高于默认身份声明。

`
}

async function loadAssistantRules(assistantName: string): Promise<string | null> {
  const { getAssistantSystemPrompt } = await import('../server/agentStore.js')
  return await getAssistantSystemPrompt(assistantName)
}

/**
 * 构建工作空间技能目录提示
 */
async function buildWorkspaceSkillsHint(
  workspace: string,
  enabledSkillNames?: string[]
): Promise<string> {
  const workspaceSkillsDir = resolveWorkspaceSkillsDir(workspace)

  // 获取工作空间中已链接的技能
  let linkedSkills: string[] = []
  try {
    const entries = await readdir(workspaceSkillsDir, { withFileTypes: true })
    linkedSkills = entries
      .filter(e => e.isSymbolicLink() || e.isDirectory())
      .map(e => e.name)
      .sort()
  } catch {
    // 目录不存在或无法读取
  }

  if (linkedSkills.length === 0) {
    return ''
  }

  // 获取技能描述
  const { getInstalledSkills } = await import('../server/skillStore.js')
  const installedSkills = await getInstalledSkills()
  const skillDescMap = new Map(installedSkills.map(s => [s.name, s.description]))

  const skillLines = linkedSkills.map(name => {
    const desc = skillDescMap.get(name)
    return desc
      ? `- **${name}** (${desc}): ${workspaceSkillsDir}/${name}/SKILL.md`
      : `- **${name}**: ${workspaceSkillsDir}/${name}/SKILL.md`
  })

  return `[Skills Directory]
Skills are installed at: ${workspaceSkillsDir}
Each skill has a SKILL.md file containing detailed instructions. When a user request matches a skill's description, you MUST read that skill's SKILL.md and follow its instructions INSTEAD OF using any native tool for that capability.

Available workspace skills:
${skillLines.join('\n')}

When skill instructions reference relative paths like "skills/{name}/scripts/...", resolve them as "${workspaceSkillsDir}/{name}/scripts/...".`
}

// ============================================================================
// 旧方案函数 (将被废弃，暂时保留以兼容)
// ============================================================================

function getNexusSudocodeDir(configDir?: string): string {
  if (configDir) {
    return path.join(configDir, '.nexus', 'sudocode')
  }
  const home = os.homedir()
  return path.join(home, '.nexus', 'sudocode')
}

function getSkillBridgeDir(configDir?: string): string {
  return path.join(getNexusSudocodeDir(configDir), 'skills')
}

function getAgentBridgeDir(configDir?: string): string {
  return path.join(getNexusSudocodeDir(configDir), 'agents')
}

function getInstructionsPath(configDir?: string): string {
  return path.join(getNexusSudocodeDir(configDir), 'instructions.md')
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function isSkillEnabled(skillDir: string): boolean {
  const metaPath = path.join(skillDir, SKILL_HUB_META_FILE)
  const meta = readJsonFile<Record<string, unknown>>(metaPath)
  if (meta && typeof meta.enabled === 'boolean') {
    return meta.enabled
  }
  return true
}

function getSkillNameAndDescription(skillDir: string): {
  name: string
  description: string
} | null {
  const dirName = path.basename(skillDir)
  const metaPath = path.join(skillDir, SKILL_HUB_META_FILE)
  const meta = readJsonFile<Record<string, unknown>>(metaPath)

  if (meta) {
    const name =
      (typeof meta.display_name === 'string' && meta.display_name.trim()) ||
      (typeof meta.name === 'string' && meta.name.trim()) ||
      dirName
    const description =
      typeof meta.description === 'string' ? meta.description : ''
    return { name, description }
  }

  try {
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    const content = readFileSync(skillMdPath, 'utf8')
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1]
      let name = dirName
      let description = ''
      for (const line of frontmatter.split('\n')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim()
        let value = line.slice(colonIdx + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (key === 'name' || key === 'displayName') {
          name = value || name
        }
        if (key === 'description') {
          description = value
        }
      }
      return { name, description }
    }
  } catch {
    // SKILL.md not readable
  }

  return { name: dirName, description: '' }
}

function isAssistantEnabled(assistantDir: string): boolean {
  const metaPath = path.join(assistantDir, ASSISTANT_META_FILE)
  const meta = readJsonFile<Record<string, unknown>>(metaPath)
  if (meta && typeof meta.enabled === 'boolean') {
    return meta.enabled
  }
  return true
}

function getAssistantRuleFileContent(assistantDir: string): string | null {
  const COMMON_RULE_FILES = [
    'system.md',
    'prompt.md',
    'assistant.md',
    'instructions.md',
    'rules.md',
  ]
  const dirName = path.basename(assistantDir)
  const metaPath = path.join(assistantDir, ASSISTANT_META_FILE)
  const meta = readJsonFile<Record<string, unknown>>(metaPath)

  const candidateFiles: string[] = []
  if (meta && typeof meta.ruleFile === 'string' && meta.ruleFile.trim()) {
    const normalized = meta.ruleFile.replace(/\\/g, '/').replace(/^\.\/+/, '')
    if (normalized && !normalized.startsWith('/') && !normalized.startsWith('..')) {
      candidateFiles.push(normalized)
    }
  }
  candidateFiles.push(`${dirName}.md`)
  candidateFiles.push(...COMMON_RULE_FILES)

  for (const candidate of candidateFiles) {
    if (!candidate.toLowerCase().endsWith('.md')) continue
    const fullPath = path.resolve(assistantDir, candidate)
    try {
      const stat = lstatSync(fullPath)
      if (stat.isFile()) {
        return readFileSync(fullPath, 'utf8').trim() || null
      }
    } catch {
      // continue
    }
  }

  try {
    const entries = readdirSync(assistantDir, { withFileTypes: true })
    const mdFiles = entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .filter(
        e =>
          !/^readme/i.test(e.name) &&
          !/^changelog/i.test(e.name) &&
          !/^license/i.test(e.name) &&
          !/^contributing/i.test(e.name),
      )
    if (mdFiles.length === 1) {
      return readFileSync(path.join(assistantDir, mdFiles[0]!.name), 'utf8').trim() || null
    }
  } catch {
    // ignore
  }

  return null
}

function getAssistantNameAndDescription(assistantDir: string): {
  name: string
  displayName: string
  description: string
} | null {
  const dirName = path.basename(assistantDir)
  const metaPath = path.join(assistantDir, ASSISTANT_META_FILE)
  const meta = readJsonFile<Record<string, unknown>>(metaPath)

  if (meta) {
    const name =
      (typeof meta.name === 'string' && meta.name.trim()) || dirName
    const displayName =
      (typeof meta.display_name === 'string' && meta.display_name.trim()) ||
      (typeof meta.name === 'string' && meta.name.trim()) ||
      dirName
    const description =
      typeof meta.description === 'string' ? meta.description : ''
    return { name, displayName, description }
  }

  return { name: dirName, displayName: dirName, description: '' }
}

function getEnabledAssistantName(): string | null {
  return process.env.MOSS_ASSISTANT_NAME?.trim() || null
}

const SKILL_SEARCH_DIRS = [
  MOSS_SKILLS_HUB_DIR,
  MOSS_SKILLS_SYSTEM_DIR,
  MOSS_SKILLS_CUSTOM_DIR,
  USER_SKILLS_DIR,
]

/**
 * @deprecated 使用 syncWorkspaceSkills 替代
 */
export function bridgeSkill(
  skillName: string,
  sourcePath: string,
  configDir?: string,
): void {
  const bridgeDir = getSkillBridgeDir(configDir)
  ensureDir(bridgeDir)
  const linkPath = path.join(bridgeDir, skillName)

  if (existsSync(linkPath)) {
    try {
      const stat = lstatSync(linkPath)
      if (stat.isSymbolicLink()) {
        const realTarget = readlinkSync(linkPath)
        const resolvedTarget = path.resolve(
          path.dirname(linkPath),
          realTarget,
        )
        if (resolvedTarget === path.resolve(sourcePath)) {
          return
        }
        // Target changed, remove old symlink and continue
        unlinkSync(linkPath)
      } else {
        // Real file/dir exists, don't overwrite
        console.warn(
          `[scodeBridge] Skipping skill bridge for "${skillName}": real file exists at ${linkPath}`,
        )
        return
      }
    } catch {
      // Fall through to recreate
    }
    try {
      unlinkSync(linkPath)
    } catch {
      rmSync(linkPath, { recursive: true, force: true })
    }
  }

  symlinkSync(sourcePath, linkPath)
}

/**
 * @deprecated 使用 syncWorkspaceSkills 替代
 */
export function unbridgeSkill(skillName: string, configDir?: string): void {
  const bridgeDir = getSkillBridgeDir(configDir)
  const linkPath = path.join(bridgeDir, skillName)

  if (!existsSync(linkPath)) return

  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      unlinkSync(linkPath)
    }
  } catch {
    // Not a symlink or doesn't exist, ignore
  }
}

/**
 * @deprecated 不再需要，智能体规则通过首次消息注入
 */
export function bridgeAgent(
  assistantName: string,
  sourcePath: string,
  configDir?: string,
): void {
  const bridgeDir = getAgentBridgeDir(configDir)
  ensureDir(bridgeDir)

  const info = getAssistantNameAndDescription(sourcePath)
  const displayName = info?.displayName || assistantName
  const description = info?.description || ''

  const tomlContent = [
    `name = "${assistantName}"`,
    `description = "Moss Agent: ${displayName}${description ? ' - ' + description : ''}"`,
    `model = ""`,
    `model_reasoning_effort = ""`,
  ].join('\n')

  const tomlPath = path.join(bridgeDir, `${assistantName}.toml`)
  writeFileSync(tomlPath, tomlContent, 'utf8')
}

/**
 * @deprecated 不再需要
 */
export function unbridgeAgent(assistantName: string, configDir?: string): void {
  const bridgeDir = getAgentBridgeDir(configDir)
  const tomlPath = path.join(bridgeDir, `${assistantName}.toml`)

  try {
    if (existsSync(tomlPath)) {
      unlinkSync(tomlPath)
    }
  } catch {
    // Ignore errors
  }
}

/**
 * @deprecated 使用 prepareFirstMessageForScode 替代
 */
export async function refreshInstructionsFile(configDir?: string): Promise<void> {
  const {
    getInstalledSkills,
  } = await import('../server/skillStore.js')
  const {
    getAssistantSystemPrompt,
    getInstalledAssistants,
  } = await import('../server/agentStore.js')

  const installedSkills = await getInstalledSkills()
  const enabledSkills = installedSkills.filter(s => s.enabled)

  const installedAssistants = await getInstalledAssistants()
  const enabledAssistants = installedAssistants.filter(a => a.enabled)

  const lines: string[] = []

  if (enabledAssistants.length > 0) {
    lines.push('# Moss 已安装 Agent')
    lines.push(
      `调用方式：使用 Agent 工具，在 subagent_type 参数中指定标识符。需复杂规划、架构设计时主动委托给对应的智能体。`,
    )
    lines.push('')
    const agentItems = enabledAssistants.map(agent => {
      // 截短描述，避免超出 scode 的 4000 字符限制
      let desc = agent.description ? ` — ${agent.description}` : ''
      if (desc.length > 50) desc = desc.substring(0, 47) + '...'
      return `- **${agent.name}**${desc}`
    })
    lines.push(agentItems.join('\n'))
    lines.push('')
  }

  if (enabledSkills.length > 0) {
    lines.push('# Moss 已安装技能')
    lines.push(
      `调用方式：Skill("技能名")。当用户需求匹配时主动调用。使用 Skill 工具或执行 /skills 命令可查详情。`,
    )
    lines.push('')

    // 由于 scode 限制 instruction files 最大 4000 字符，我们要非常精简
    const skillNames = enabledSkills.map(s => s.name)
    lines.push('可用技能列表（仅名称）：')
    lines.push(skillNames.join(', '))
    lines.push('')
  }

  const assistantName = getEnabledAssistantName()
  if (assistantName) {
    const prompt = await getAssistantSystemPrompt(assistantName)
    if (prompt) {
      lines.push('# 当前智能体指令')
      lines.push('')
      lines.push(
        `你正在使用 **${assistantName}** 智能体。请遵循以下指令：`,
      )
      lines.push('')
      lines.push(prompt)
      lines.push('')
    }
  }

  const instructionsPath = getInstructionsPath(configDir)
  ensureDir(path.dirname(instructionsPath))

  if (lines.length > 0) {
    writeFileSync(instructionsPath, lines.join('\n'), 'utf8')
  } else {
    try {
      unlinkSync(instructionsPath)
    } catch {
      // File may not exist, that's fine
    }
  }
}

/**
 * @deprecated 使用 syncWorkspaceSkills 替代
 */
export function syncAllSkillBridges(configDir?: string): void {
  const bridgeDir = getSkillBridgeDir(configDir)
  ensureDir(bridgeDir)

  // Clean up existing symlinks in bridge dir
  try {
    const entries = readdirSync(bridgeDir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(bridgeDir, entry.name)
      try {
        const stat = lstatSync(entryPath)
        if (stat.isSymbolicLink()) {
          // Check if target still exists
          try {
            const target = readlinkSync(entryPath)
            const resolvedTarget = path.resolve(path.dirname(entryPath), target)
            if (!existsSync(resolvedTarget)) {
              unlinkSync(entryPath)
            }
          } catch {
            unlinkSync(entryPath)
          }
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Bridge dir doesn't exist yet, that's fine
  }

  // Create symlinks for all enabled skills from moss skill directories
  for (const baseDir of SKILL_SEARCH_DIRS) {
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillDir = path.join(baseDir, entry.name)
        const skillMdPath = path.join(skillDir, 'SKILL.md')
        try {
          lstatSync(skillMdPath)
        } catch {
          continue // No SKILL.md, skip
        }

        if (!isSkillEnabled(skillDir)) continue

        const skillName = entry.name
        try {
          bridgeSkill(skillName, skillDir, configDir)
        } catch (err) {
          console.warn(
            `[scodeBridge] Failed to bridge skill "${skillName}": ${err}`,
          )
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }
}

/**
 * @deprecated 不再需要，智能体规则通过首次消息注入
 */
export function syncAllAgentBridges(configDir?: string): void {
  const bridgeDir = getAgentBridgeDir(configDir)
  ensureDir(bridgeDir)

  // Clean up existing TOML files for agents that no longer exist
  try {
    const entries = readdirSync(bridgeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.toml')) continue
      const assistantName = entry.name.replace(/\.toml$/, '')
      let found = false
      for (const searchDir of ASSISTANT_SEARCH_DIRS) {
        const candidateDir = path.join(searchDir, assistantName)
        try {
          if (lstatSync(candidateDir).isDirectory()) {
            found = true
            break
          }
        } catch {
          // Continue
        }
      }
      if (!found) {
        try {
          unlinkSync(path.join(bridgeDir, entry.name))
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Bridge dir doesn't exist yet
  }

  // Create TOML files for all enabled agents
  for (const searchDir of ASSISTANT_SEARCH_DIRS) {
    try {
      const entries = readdirSync(searchDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue
        const assistantDir = path.join(searchDir, entry.name)
        if (!isAssistantEnabled(assistantDir)) continue

        try {
          bridgeAgent(entry.name, assistantDir, configDir)
        } catch (err) {
          console.warn(
            `[scodeBridge] Failed to bridge agent "${entry.name}": ${err}`,
          )
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }
}

/**
 * @deprecated 使用 syncWorkspaceSkills 替代
 */
export function syncAllBridges(configDir?: string): void {
  syncAllSkillBridges(configDir)
  syncAllAgentBridges(configDir)
}

/**
 * @deprecated 使用 syncWorkspaceSkills 替代
 */
export async function syncAllBridgesAsync(configDir?: string): Promise<void> {
  syncAllSkillBridges(configDir)
  syncAllAgentBridges(configDir)
  await refreshInstructionsFile(configDir)
  await writeMcpServersToConfig(configDir)
}

/**
 * @deprecated 不再需要，MCP 服务器通过首次消息注入路径提示
 */
export async function writeMcpServersToConfig(configDir?: string): Promise<void> {
  const { getInstalledSkills } = await import('../server/skillStore.js')
  const installedSkills = await getInstalledSkills()
  const enabledSkills = installedSkills.filter(s => s.enabled)

  const nexusDir = getNexusSudocodeDir(configDir)
  ensureDir(nexusDir)
  const settingsPath = path.join(nexusDir, 'settings.json')

  // Read existing settings if present
  let existingSettings: Record<string, any> = {}
  try {
    const content = readFileSync(settingsPath, 'utf8')
    existingSettings = JSON.parse(content)
  } catch {
    // File doesn't exist or invalid JSON, start fresh
  }

  // Build mcpServers object for Scode config
  const mcpServers: Record<string, any> = {}
  for (const skill of enabledSkills) {
    mcpServers[skill.name] = {
      command: skill.source,
      args: [],
      env: {}
    }
  }

  // Merge with existing settings
  const newSettings = {
    ...existingSettings,
    mcpServers
  }

  writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), 'utf8')
}

/**
 * @deprecated 不再需要，通过首次消息注入路径提示
 */
export async function buildDynamicMcpServers(): Promise<any[]> {
  const { getInstalledSkills } = await import('../server/skillStore.js')
  const installedSkills = await getInstalledSkills()
  const enabledSkills = installedSkills.filter(s => s.enabled)

  const mcpServers: any[] = []

  for (const skill of enabledSkills) {
    mcpServers.push({
      name: skill.name,
      command: skill.source,
      args: [],
      env: []
    })
  }

  return mcpServers
}

/**
 * @deprecated 不再需要，通过首次消息注入
 */
export async function buildDynamicAgents(): Promise<any[]> {
  const { getInstalledAssistants, getAssistantSystemPrompt } = await import('../server/agentStore.js')
  const installedAssistants = await getInstalledAssistants()
  const enabledAssistants = installedAssistants.filter(a => a.enabled)

  const agents: any[] = []

  for (const agent of enabledAssistants) {
    const prompt = await getAssistantSystemPrompt(agent.name)
    agents.push({
      name: agent.name,
      displayName: agent.displayName || agent.name,
      description: agent.description || '',
      instructions: prompt || '',
      model: agent.meta?.model || '',
      mcpServers: agent.meta?.enabledSkills || [],
      enabled: true
    })
  }

  return agents
}

/**
 * @deprecated 使用 prepareFirstMessageForScode 替代
 */
export async function buildDynamicInstructions(mcpServers: any[], agents: any[], currentAssistantName: string | null): Promise<string> {
  const lines: string[] = []

  if (agents.length > 0) {
    lines.push('# Moss 已安装 Agent')
    lines.push('调用方式：使用 Agent 工具，在 subagent_type 参数中指定标识符。需复杂规划、架构设计时主动委托给对应的智能体。\n')
    lines.push(agents.map(a => `- **${a.name}** — ${a.description.substring(0, 50)}`).join('\n'))
    lines.push('')
  }

  if (mcpServers.length > 0) {
    lines.push('# Moss 已安装技能')
    lines.push('调用方式：Skill("技能名")。当用户需求匹配时主动调用。使用 Skill 工具或执行 /skills 命令可查详情。\n')
    lines.push('可用技能列表（仅名称）：')
    lines.push(mcpServers.map(s => s.name).join(', '))
    lines.push('')
  }

  if (currentAssistantName) {
    const agent = agents.find(a => a.name === currentAssistantName)
    if (agent && agent.instructions) {
      lines.push('# 当前智能体指令\n')
      lines.push(`你正在使用 **${currentAssistantName}** 智能体。请遵循以下指令：\n`)
      lines.push(agent.instructions)
      lines.push('')
    }
  }

  const fullText = lines.join('\n')
  return fullText.length > 3900 ? fullText.substring(0, 3900) + '... (truncated)' : fullText
}

// Helper to check if path exists (avoiding fs/promises for sync operations)
function existsSync(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
