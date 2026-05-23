# Moss Scode Agent 技能和智能体发现机制改造设计

## 问题分析

### 当前实现的问题

当前 Moss 项目使用 **配置文件同步 + ACP session/new 注入** 的方式：

1. **同步到用户目录**：
   - Skills: 符号链接到 `~/.nexus/sudocode/skills/`
   - Agents: TOML 文件到 `~/.nexus/sudocode/agents/`

2. **ACP session/new 注入**：
   - 通过 `mcpServers` 参数传递 MCP 服务器
   - 通过 `_meta.agents` 传递智能体
   - 通过 `_meta.instructions` 传递指令

**问题**：
1. Scode 的 ACP 实现会 **忽略** `session/new` 中的 `mcpServers` 和 `_meta` 参数
2. 符号链接位置错误 - 应该是 **工作空间目录** 下的 `.nexus/sudocode/skills/`，而不是用户主目录

### Sudowork 的成功方案

Sudowork 使用 **工作空间符号链接 + 首次消息注入** 的组合方案：

#### 1. 工作空间技能目录

```
全局安装目录                      工作空间技能目录
~/.nexus/skills/_hub/browser  →  {workspace}/.nexus/sudocode/skills/browser (符号链接)
~/.nexus/skills/_hub/docx     →  {workspace}/.nexus/sudocode/skills/docx (符号链接)
```

**关键代码** ([workspaceSkillsDir.ts](sudowork/src/process/utils/workspaceSkillsDir.ts)):

```typescript
export function resolveWorkspaceSkillsDir(conversation): string | undefined {
  const workspace = conversation?.extra?.workspace;
  if (!workspace) return undefined;

  if (conversation.extra?.backend === 'scode') {
    return path.join(workspace, '.nexus', 'sudocode', 'skills');
  }
  // ...
}
```

#### 2. 首次消息注入

在 User Message 中注入技能路径提示：

```
[Assistant Rules - You MUST follow these instructions]
├── [Identity Override] - 身份声明
├── presetContext - 助手规则
├── [Available Skills] - 内置 skills 索引
├── [Skills Location] - Builtin skills 路径
├── [Skills Directory] - Workspace skills 路径及列表
└── [User Request] - 用户实际输入
```

## 改造方案

### 整体架构

```
Moss 全局安装目录                  工作空间技能目录
~/.moss/skills/hub/browser    →   {workspace}/.nexus/sudocode/skills/browser (符号链接)
~/.moss/skills/hub/docx       →   {workspace}/.nexus/sudocode/skills/docx (符号链接)

首次消息注入
├── 身份声明 (当前智能体)
├── 智能体规则 (从 ~/.moss/assistants/hub/{name}/ 读取)
└── 技能路径提示 (指向 {workspace}/.nexus/sudocode/skills/)
```

### 关键区别：Host 模式 vs Docker 模式

| 模式 | 工作空间路径 | 技能目录路径 | 符号链接目标 |
|------|-------------|-------------|-------------|
| **Host** | `/Users/yobach/projects/myapp` | `{workspace}/.nexus/sudocode/skills/` | `~/.moss/skills/hub/{skill}/` |
| **Docker** | `/Users/yobach/projects/myapp` | `{workspace}/.nexus/sudocode/skills/` | 容器内挂载的路径 |

**Docker 模式特殊处理**：

Docker 容器会挂载工作空间目录，所以：
- 工作空间内的 `.nexus/sudocode/skills/` 目录会被挂载到容器内
- 符号链接在宿主机创建，容器内可以正常解析（因为目标路径也被挂载）

### 核心改造点

#### 1. 新增工作空间技能同步函数

**文件**: `src/utils/scodeBridge.ts`

```typescript
import path from 'path'
import { symlink, mkdir, readdir, lstat, readlink, rm } from 'fs/promises'
import { MOSS_SKILLS_HUB_DIR, MOSS_SKILLS_SYSTEM_DIR, MOSS_SKILLS_CUSTOM_DIR } from './skills/localSkillDirectories.js'

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
 */
export async function syncWorkspaceSkills(
  workspace: string,
  enabledSkillNames?: string[]
): Promise<void> {
  const workspaceSkillsDir = resolveWorkspaceSkillsDir(workspace)
  await mkdir(workspaceSkillsDir, { recursive: true })

  // 获取所有技能源目录
  const skillSourceDirs = [
    MOSS_SKILLS_HUB_DIR,
    MOSS_SKILLS_SYSTEM_DIR,
    MOSS_SKILLS_CUSTOM_DIR,
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

        // 如果指定了启用列表，只同步列表中的技能
        if (enabledSkillNames && !enabledSkillNames.includes(skillName)) {
          continue
        }

        // 检查技能是否启用
        if (!await isSkillEnabled(skillSourcePath)) {
          continue
        }

        skillTargets.set(skillName, skillSourcePath)
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
 * 检查技能是否启用
 */
async function isSkillEnabled(skillDir: string): Promise<boolean> {
  const { getInstalledSkills } = await import('../server/skillStore.js')
  const installedSkills = await getInstalledSkills()
  const skillName = path.basename(skillDir)
  const skill = installedSkills.find(s => s.name === skillName || s.source === skillDir)
  return skill?.enabled ?? true
}
```

#### 2. 新增首次消息注入函数

**文件**: `src/utils/scodeBridge.ts`

```typescript
/**
 * 构建首次消息内容，注入技能和智能体信息
 */
export async function prepareFirstMessageForScode(
  userContent: string,
  config: {
    assistantName?: string | null
    workspace: string
    enabledSkillNames?: string[]
  }
): Promise<string> {
  const instructions: string[] = []

  // 1. 加载智能体规则（如果有）
  if (config.assistantName) {
    const assistantRules = await loadAssistantRules(config.assistantName)
    if (assistantRules) {
      const identityBlock = buildIdentityBlock(config.assistantName)
      instructions.push(identityBlock)
      instructions.push(assistantRules)
    }
  }

  // 2. 构建工作空间技能目录提示
  const skillsHint = await buildWorkspaceSkillsHint(config.workspace, config.enabledSkillNames)
  if (skillsHint) {
    instructions.push(skillsHint)
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
function buildIdentityBlock(assistantName: string): string {
  return `[Identity Override - 最高优先级]
你的身份是：${assistantName}
当用户询问"你是谁"或类似身份问题时，必须回答："我是${assistantName}，有什么可以帮助你的吗？"
此身份声明优先级高于默认身份声明。

`
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

/**
 * 加载智能体规则
 */
async function loadAssistantRules(assistantName: string): Promise<string | null> {
  const { getAssistantSystemPrompt } = await import('../server/agentStore.js')
  return await getAssistantSystemPrompt(assistantName)
}
```

#### 3. 修改 acpBridge.ts

**文件**: `src/server/backends/acpBridge.ts`

```typescript
type AcpBridgeOptions = {
  child: ChildProcess
  sessionId: string
  cwd: string  // 工作空间路径
  model: string
  transcriptPath?: string
  runtime: SessionRuntimeInfo
  // 新增参数
  assistantName?: string
  enabledSkillNames?: string[]
}

export function createAcpBridgeHandle(options: AcpBridgeOptions): BackendHandle {
  const { child, sessionId, cwd, model, runtime } = options

  // 新增状态
  let isFirstMessage = true

  // ... 现有代码 ...

  const processUserMessage = async (data: string) => {
    let cleanText = data
    // ... 解析逻辑 ...

    const trimmedText = typeof cleanText === 'string' ? cleanText.trim() : String(cleanText)

    // 首次消息注入
    let finalText = trimmedText
    if (isFirstMessage) {
      finalText = await prepareFirstMessageForScode(trimmedText, {
        assistantName: options.assistantName,
        workspace: cwd,
        enabledSkillNames: options.enabledSkillNames,
      })
      isFirstMessage = false
    } else if (options.assistantName) {
      // 后续消息只注入身份声明
      const identityBlock = buildIdentityBlock(options.assistantName)
      finalText = `${identityBlock}[User Request]\n${trimmedText}`
    }

    // ... 发送给 scode ...
  }

  // ... 其余代码 ...
}
```

#### 4. 修改 scodeBackend.ts (Host 模式)

**文件**: `src/server/backends/scodeBackend.ts`

```typescript
export class ScodeBackend implements SessionBackend {
  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const scodePath = resolveScodeCliPath(options.runtime?.scodePath)
    const env = buildSessionEnv(options)
    const model = options.runtime?.model || process.env.MOSS_DEFAULT_MODEL || 'gemini-3-flash-preview'

    // 同步技能到工作空间目录
    try {
      await syncWorkspaceSkills(options.cwd, options.enabledSkillNames)
    } catch (err) {
      process.stderr.write(`[ScodeBackend] Workspace skills sync warning: ${err}\n`)
    }

    const args = [
      'acp',
      '--output-format', 'json',
      '--permission-mode', 'danger-full-access',
      '--auth', 'proxy',
      '--model', model,
    ]

    process.stderr.write(`\n[ScodeBackend] Spawning scode engine:\n`)
    process.stderr.write(`  Path: ${scodePath}\n`)
    process.stderr.write(`  CWD: ${options.cwd}\n`)
    process.stderr.write(`  Model: ${model}\n\n`)

    const child = spawn(scodePath, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    return createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: options.cwd,
      model,
      transcriptPath: (options as any).transcriptPath,
      assistantName: options.assistantName,
      enabledSkillNames: options.enabledSkillNames,
      runtime: {
        type: 'host',
        engine: 'scode',
        configDir: options.runtime?.configDir,
      },
    })
  }
}
```

#### 5. 修改 dockerBackend.ts (Docker 模式)

**文件**: `src/server/backends/dockerBackend.ts`

```typescript
export class DockerBackend implements SessionBackend {
  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    // ... 现有 docker 配置代码 ...

    const safeCwd = options.cwd === '/' ? os.homedir() : options.cwd

    // 同步技能到工作空间目录（在宿主机上创建符号链接）
    // Docker 会挂载工作空间，所以容器内可以访问这些符号链接
    try {
      await syncWorkspaceSkills(safeCwd, options.enabledSkillNames)
    } catch (err) {
      process.stderr.write(`[DockerBackend] Workspace skills sync warning: ${err}\n`)
    }

    // ... docker run 参数构建 ...

    // 挂载工作空间（包含 .nexus/sudocode/skills/ 符号链接）
    const mounts = uniqueMounts([
      safeCwd,  // 工作空间会被挂载，包括其中的 .nexus/sudocode/skills/
      configDir,
      MOSS_HOME,  // Moss 安装目录也需要挂载，因为符号链接指向这里
    ]).filter(p => p !== '/')

    // ... 其余 docker 启动代码 ...

    return createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: safeCwd,
      model,
      transcriptPath: (options as any).transcriptPath,
      assistantName: options.assistantName,
      enabledSkillNames: options.enabledSkillNames,
      runtime: runtimeInfo,
    })
  }
}
```

### Docker 模式关键点

Docker 模式下需要确保：

1. **工作空间挂载**: `{workspace}` 挂载到容器内相同路径
2. **Moss 安装目录挂载**: `~/.moss` 挂载到容器内（因为符号链接指向这里）
3. **符号链接在宿主机创建**: 容器内可以正常解析符号链接

```
宿主机:
  /Users/yobach/projects/myapp/.nexus/sudocode/skills/browser → /Users/yobach/.moss/skills/hub/browser

Docker 容器 (挂载后):
  /Users/yobach/projects/myapp/.nexus/sudocode/skills/browser → /Users/yobach/.moss/skills/hub/browser
  (两个路径都被挂载，符号链接可以正常解析)
```

### 数据流对比

#### 改造前

```
用户消息 → acpBridge.processUserMessage
         → session/prompt (原始内容)
         → scode 无法发现 skills/agents
```

#### 改造后

```
Host 模式:
  启动时: syncWorkspaceSkills(workspace, enabledSkillNames)
         → 创建符号链接: {workspace}/.nexus/sudocode/skills/{skill} → ~/.moss/skills/hub/{skill}

  首次消息: prepareFirstMessageForScode
         → 注入技能路径提示: {workspace}/.nexus/sudocode/skills/
         → scode 通过 Read 工具读取 SKILL.md

Docker 模式:
  启动时: syncWorkspaceSkills(workspace, enabledSkillNames)
         → 在宿主机创建符号链接
         → Docker 挂载工作空间和 Moss 目录

  首次消息: prepareFirstMessageForScode
         → 注入技能路径提示: {workspace}/.nexus/sudocode/skills/
         → scode 在容器内通过 Read 工具读取 SKILL.md
```

## 实施步骤

### Phase 1: 新增核心函数

1. 在 `scodeBridge.ts` 中新增：
   - `resolveWorkspaceSkillsDir` - 解析工作空间技能目录
   - `syncWorkspaceSkills` - 同步技能到工作空间
   - `prepareFirstMessageForScode` - 构建首次消息
   - `buildIdentityBlock` - 构建身份声明
   - `buildWorkspaceSkillsHint` - 构建技能路径提示
   - `loadAssistantRules` - 加载智能体规则

### Phase 2: 修改 acpBridge

1. 添加 `isFirstMessage` 状态变量
2. 添加 `assistantName` 和 `enabledSkillNames` 参数
3. 修改消息处理逻辑，在首次消息时注入提示词

### Phase 3: 修改 Backend

1. 修改 `scodeBackend.ts`：
   - 调用 `syncWorkspaceSkills`
   - 传递 `assistantName` 和 `enabledSkillNames`

2. 修改 `dockerBackend.ts`：
   - 调用 `syncWorkspaceSkills`
   - 确保 `MOSS_HOME` 被挂载
   - 传递 `assistantName` 和 `enabledSkillNames`

### Phase 4: 清理旧代码

1. 移除 `scodeBridge.ts` 中不再需要的函数：
   - `syncAllSkillBridges` (替换为 `syncWorkspaceSkills`)
   - `syncAllAgentBridges` (不再需要)
   - `syncAllBridges` / `syncAllBridgesAsync`
   - `writeMcpServersToConfig`
   - `buildDynamicMcpServers`
   - `buildDynamicAgents`
   - `buildDynamicInstructions`
   - `bridgeAgent` / `unbridgeAgent`
   - `bridgeSkill` / `unbridgeSkill` (替换为 `syncWorkspaceSkills`)

### Phase 5: 测试验证

1. **Host 模式测试**：
   - 验证符号链接创建在 `{workspace}/.nexus/sudocode/skills/`
   - 验证首次消息注入正确
   - 验证 scode 可以读取 SKILL.md

2. **Docker 模式测试**：
   - 验证符号链接在容器内可解析
   - 验证 MOSS_HOME 挂载正确
   - 验证首次消息注入正确
   - 验证 scode 在容器内可以读取 SKILL.md

## 总结

通过采用 Sudowork 的 **工作空间符号链接 + 首次消息注入** 方案，Moss 可以：

1. **正确的符号链接位置**: 在工作空间目录下创建，而非用户主目录
2. **支持 Host 和 Docker 模式**: 通过挂载机制确保两种模式都能正常工作
3. **绕过 Scode ACP 的限制**: 不依赖被忽略的 session/new 参数
4. **确保技能被发现**: 通过 User Message 注入，Scode 一定会处理
5. **简化代码逻辑**: 移除复杂的配置文件同步
