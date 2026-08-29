import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  buildSessionEnv,
  resolveScodeCliPath,
  buildConfigDir,
  getAssistantRuntimeConfig,
  createSkillSymlinks,
  buildAvailableSkillSnapshot,
} from './backendUtils.js'
import { createAcpBridgeHandle } from './acpBridge.js'
import { syncWorkspaceSkills, type WorkspaceSkillLink } from '../../utils/scodeBridge.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
} from '../sessionManager.js'

async function readScodeSessionId(filePath: string): Promise<string | undefined> {
  try {
    const value = (await readFile(filePath, 'utf8')).trim()
    return value || undefined
  } catch {
    return undefined
  }
}

export class ScodeBackend implements SessionBackend {
  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    // 读取 assistant 配置
    const assistantConfig = await getAssistantRuntimeConfig(options.assistantName)

    // 确定最终使用的 enabledSkills
    // 优先级（与个人模式一致）：
    // 1. 如果指定了智能体，使用智能体的 enabledSkills（智能体配置优先）
    // 2. 如果没有指定智能体，使用客户端传递的 enabledSkillNames
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

      // Only supply the proxy connection. Models are resolved dynamically by
      // scode: unknown aliases fall through to proxy passthrough, and the
      // wire format is picked from the model-capabilities SSOT (populated from
      // sudorouter /v1/models). A static model list here would pin every model
      // to one hard-coded wire format and drift from sudorouter's catalog.
      const scodeConfig = {
        auth_modes: {
          proxy: {
            "moss-proxy": {
              baseUrl,
              apiKey
            }
          }
        }
      }
      writeFileSync(dummySudocodePath, JSON.stringify(scodeConfig, null, 2), 'utf8')
      process.stderr.write(`[ScodeBackend] Wrote sudocode.json (proxy connection only; models resolved dynamically via sudorouter)\n`)
    } catch (e) {
      process.stderr.write(`[ScodeBackend] Failed to create sudocode.json: ${e}\n`)
    }

    const scodeSettings = buildScodeSettings(options)
    // Write per-session scode settings (same dir as sudocode.json) so scode
    // loads them on startup.
    if (Object.keys(scodeSettings).length > 0) {
      try {
        writeFileSync(join(dotNexusDir, 'settings.json'), JSON.stringify(scodeSettings, null, 2), 'utf8')
        process.stderr.write(`[ScodeBackend] Wrote per-session scode settings.json\n`)
      } catch (e) {
        process.stderr.write(`[ScodeBackend] Failed to write settings.json: ${e}\n`)
      }
    }

    // Use model from env (which includes user preference), or fallback.
    // Pass the bare model id: `--auth proxy` already selects the proxy auth
    // mode, and scode's proxy passthrough forwards the id verbatim to
    // sudorouter. A `proxy/` prefix here would reach sudorouter as part of the
    // model name and 400 ("No available channel for model proxy/...").
    const scodeModel = env.MOSS_DEFAULT_MODEL || options.runtime?.model || 'gemini-3-flash-preview'
    process.stderr.write(`[ScodeBackend] Model for session ${options.sessionId}: ${scodeModel} (from env.MOSS_DEFAULT_MODEL: ${env.MOSS_DEFAULT_MODEL})\n`)

    // 同步技能到工作空间目录（新方案）
    // 在工作空间的 .nexus/sudocode/skills/ 目录创建符号链接
    // enabledSkills: 客户端传递 > 智能体配置 > 默认（所有可用 skills）
    // visibilityFilter: 过滤用户无权访问的技能
    let workspaceSkillLinks: WorkspaceSkillLink[] = []
    try {
      workspaceSkillLinks = await syncWorkspaceSkills(options.cwd, enabledSkills, options.visibilityFilter)
      process.stderr.write(`[ScodeBackend] Workspace skills synced to ${options.cwd}/.nexus/sudocode/skills/ with ${enabledSkills.length} skills: ${enabledSkills.join(', ') || 'none'}\n`)
    } catch (err) {
      process.stderr.write(`[ScodeBackend] Workspace skills sync warning: ${err}\n`)
    }
    const availableSkills = await buildAvailableSkillSnapshot(workspaceSkillLinks)

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
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_REMOTE_MEMORY_DIR: configDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const scodeSessionIdPath = join(options.cwd, '.moss', 'scode-session-id')
    const resumeSessionId = options.resumeSessionId
      ? await readScodeSessionId(scodeSessionIdPath)
      : undefined

    const handle = createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: options.cwd,
      model: scodeModel,
      transcriptPath: (options as any).transcriptPath,
      resumeSessionId,
      scodeSessionIdPath,
      // 新方案：传递智能体名称和启用的技能列表
      assistantName: options.assistantName,
      assistantDisplayName: options.assistantDisplayName,
      enabledSkillNames: enabledSkills,
      availableWikis: options.availableWikis,
      availableCorpApps: options.availableCorpApps,
      sharedMemory: options.sharedMemory,
      runtime: {
        type: 'host',
        engine: 'scode',
        configDir,
        hostMode: mode,
      },
    })
    handle.availableSkills = availableSkills
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
