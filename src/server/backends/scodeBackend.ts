import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import {
  buildSessionEnv,
  resolveScodeCliPath,
  buildConfigDir,
  getAssistantRuntimeConfig,
  createSkillSymlinks,
} from './backendUtils.js'
import { createAcpBridgeHandle } from './acpBridge.js'
import { syncWorkspaceSkills } from '../../utils/scodeBridge.js'
import { buildAllModelsConfig } from '../modelListCache.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
} from '../sessionManager.js'

export class ScodeBackend implements SessionBackend {
  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    // 读取 assistant 配置
    const assistantConfig = await getAssistantRuntimeConfig(options.assistantName)

    // 确定最终使用的 enabledSkills
    // 优先级（与个人模式一致）：
    // 1. 如果指定了助手，使用助手的 enabledSkills（助手配置优先）
    // 2. 如果没有指定助手，使用客户端传递的 enabledSkillNames
    // 3. 如果都没有，使用所有可用 skills（已在 getAssistantRuntimeConfig 中处理）
    const enabledSkills = options.assistantName
      ? assistantConfig.enabledSkills
      : (options.enabledSkillNames ?? assistantConfig.enabledSkills)

    // 根据 memory_mode 决定 mode
    const mode = options.runtime?.hostMode
      || (assistantConfig.memoryMode === 'user' ? 'user' : 'session')

    // 构建 configDir
    const configDir = options.runtime?.configDir || buildConfigDir(options, mode)
    await mkdir(configDir, { recursive: true })

    // Sync skill/agent bridges so scode can discover Moss-installed skills
    try {
      await syncAllBridgesAsync(configDir)
    } catch (bridgeErr) {
      process.stderr.write(`[ScodeBackend] scode bridge sync warning: ${bridgeErr}\n`)
    }

    // 创建 skill symlinks
    if (enabledSkills.length > 0) {
      await createSkillSymlinks(configDir, enabledSkills)
    }

    // 创建 .nexus/sudocode/sudocode.json 配置文件
    // scode 需要 HOME 环境变量指向的目录下有这个配置文件来获取认证信息
    const dotNexusDir = join(configDir, '.nexus', 'sudocode')
    await mkdir(dotNexusDir, { recursive: true })

    const scodePath = resolveScodeCliPath(options.runtime?.scodePath)
    const env = buildSessionEnv(options, {
      ...(options.sessionToken ? { SESSION_TOKEN: options.sessionToken } : {}),
    })

    process.stderr.write(`\n[ScodeBackend] Session ${options.sessionId} - buildSessionEnv completed:\n`)
    process.stderr.write(`  - options.userId: ${options.userId}\n`)
    process.stderr.write(`  - env.MOSS_DEFAULT_MODEL: ${env.MOSS_DEFAULT_MODEL}\n`)
    process.stderr.write(`  - options.runtime?.model: ${options.runtime?.model || 'undefined'}\n`)

    const dummySudocodePath = join(dotNexusDir, 'sudocode.json')
    try {
      const baseUrl = env.ANTHROPIC_BASE_URL || 'https://hk.sudorouter.ai/v1'
      const apiKey = env.ANTHROPIC_API_KEY || ''
      // Use model from env (which includes user preference), or fallback
      // env.MOSS_DEFAULT_MODEL has priority: user preference > system settings > default
      const model = env.MOSS_DEFAULT_MODEL || options.runtime?.model || 'gemini-3-flash-preview'
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
      process.stderr.write(`[ScodeBackend] Preloaded ${Object.keys(allModels).length} models into sudocode.json\n`)
    } catch (e) {
      process.stderr.write(`[ScodeBackend] Failed to create dynamic sudocode.json: ${e}\n`)
    }

    // Use model from env (which includes user preference), or fallback
    const model = env.MOSS_DEFAULT_MODEL || options.runtime?.model || 'gemini-3-flash-preview'
    let scodeModel = model
    if (!scodeModel.includes('/') && !['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'].includes(scodeModel)) {
      scodeModel = `proxy/${scodeModel}`
    }
    process.stderr.write(`[ScodeBackend] Model for session ${options.sessionId}: ${scodeModel} (from env.MOSS_DEFAULT_MODEL: ${env.MOSS_DEFAULT_MODEL})\n`)

    // 同步技能到工作空间目录（新方案）
    // 在工作空间的 .nexus/sudocode/skills/ 目录创建符号链接
    // enabledSkills: 客户端传递 > 助手配置 > 默认（所有可用 skills）
    // visibilityFilter: 过滤用户无权访问的技能
    try {
      await syncWorkspaceSkills(options.cwd, enabledSkills, options.visibilityFilter)
      process.stderr.write(`[ScodeBackend] Workspace skills synced to ${options.cwd}/.nexus/sudocode/skills/ with ${enabledSkills.length} skills: ${enabledSkills.join(', ') || 'none'}\n`)
    } catch (err) {
      process.stderr.write(`[ScodeBackend] Workspace skills sync warning: ${err}\n`)
    }

    const args = [
      'acp',
      '--output-format', 'json',
      '--permission-mode', 'danger-full-access',
      '--auth', 'proxy',
      '--model', scodeModel,
    ]

    process.stderr.write(`\n[ScodeBackend] Spawning scode engine (ACP Bridge Mode):\n`)
    process.stderr.write(`  Path: ${scodePath}\n`)
    process.stderr.write(`  CWD: ${options.cwd}\n`)
    process.stderr.write(`  configDir: ${configDir}\n`)
    process.stderr.write(`  mode: ${mode}\n`)
    process.stderr.write(`  enabledSkills: ${enabledSkills.join(', ') || 'none'}\n`)
    process.stderr.write(`  Base URL: ${env.ANTHROPIC_BASE_URL}\n`)
    process.stderr.write(`  Auth: ${env.ANTHROPIC_API_KEY ? 'Present' : 'MISSING'}\n\n`)

    const child = spawn(scodePath, args, {
      cwd: options.cwd,
      env: {
        ...env,
        HOME: configDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    return createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: options.cwd,
      model: scodeModel,
      transcriptPath: (options as any).transcriptPath,
      // 新方案：传递智能体名称和启用的技能列表
      assistantName: options.assistantName,
      enabledSkillNames: options.enabledSkillNames,
      availableWikis: options.availableWikis,
      runtime: {
        type: 'host',
        engine: 'scode',
        configDir,
        hostMode: mode,
      },
    })
  }
}