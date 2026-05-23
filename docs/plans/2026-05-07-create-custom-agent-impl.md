# 创建自定义智能体 (Create Custom Agent) 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Moss 中实现本地创建自定义智能体的功能，包括元数据持久化、指令文件生成以及与 scode 的自动同步。

**Architecture:** 
1. 在 `agentStore.ts` 中新增 `createCustomAssistant` 核心逻辑，负责文件 IO 和 scode 桥接同步。
2. 在 `server.ts` 中新增 `POST /api/v1/agents/create` 路由，处理外部 API 调用。
3. 遵循 TDD 模式，先编写 API 联调测试（如适用）或单元测试。

**Tech Stack:** Node.js, TypeScript, FS Promises, Scode Bridge.

---

### Task 1: 在 `agentStore.ts` 中实现创建逻辑

**Files:**
- Modify: `src/server/agentStore.ts`

**Step 1: 添加 `createCustomAssistant` 函数定义**

```typescript
export async function createCustomAssistant(params: {
  name: string
  displayName: string
  description?: string
  avatar?: string
  emoji?: string | null
  rules: string
  skills?: string[]
}): Promise<{ assistantName: string }> {
  const assistantName = params.name.trim().replace(/\s+/g, '-')
  if (!assistantName) throw new Error('Name is required')

  // 1. 检查是否已存在
  const existing = await findAssistantDir(assistantName)
  if (existing) throw new Error(`Assistant already exists: ${assistantName}`)

  // 2. 准备目录
  await mkdir(ASSISTANT_CUSTOM_DIR, { recursive: true })
  const assistantDir = path.join(ASSISTANT_CUSTOM_DIR, assistantName)
  await mkdir(assistantDir, { recursive: true })

  // 3. 写入指令文件
  const ruleFile = 'instructions.md'
  await writeFile(path.join(assistantDir, ruleFile), params.rules.trim(), 'utf8')

  // 4. 写入元数据
  const meta: AssistantStoreMeta = {
    id: assistantName,
    name: assistantName,
    display_name: params.displayName,
    description: params.description || '',
    avatar: params.avatar || '',
    emoji: params.emoji || null,
    source_type: 'custom',
    tag: 'custom',
    is_builtin: false,
    enabled: true,
    installed_version: '1.0.0',
    installed_at: new Date().toISOString(),
    ruleFile,
    skills: params.skills || [],
    enabledSkills: params.skills || [],
  }
  await writeAssistantMeta(assistantDir, meta)

  // 5. 同步到 scode
  try {
    bridgeAgentToScode(assistantName, assistantDir)
    await refreshInstructionsFile()
  } catch (err) {
    console.warn(`[AgentStore] Scode bridge sync failed: ${err}`)
  }

  return { assistantName }
}
```

**Step 2: 导出新函数并确保依赖正确**
检查 `agentStore.ts` 是否已经导入了 `ASSISTANT_CUSTOM_DIR`, `findAssistantDir`, `writeAssistantMeta` 等。

**Step 3: 运行验证**
由于是服务端代码，目前主要通过后续 API 联调验证。

**Step 4: Commit**
```bash
git add src/server/agentStore.ts
git commit -m "feat(agent): implement createCustomAssistant logic"
```

---

### Task 2: 在 `server.ts` 中添加 API 路由

**Files:**
- Modify: `src/server/server.ts`

**Step 1: 导入 `createCustomAssistant`**

在 `server.ts` 的导入部分添加：
```typescript
import {
  // ...
  createCustomAssistant,
} from './agentStore.js'
```

**Step 2: 注册 `POST /api/v1/agents/create` 路由**

在 `server.ts` 的路由逻辑中（建议放在 `/api/v1/agents/install` 附近）：

```typescript
      if (req.method === 'POST' && pathname === '/api/v1/agents/create') {
        authService.requireScope(auth, 'admin:settings')
        const body = await readJsonBody(req)
        
        const result = await createCustomAssistant({
          name: typeof body.name === 'string' ? body.name : '',
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
          description: typeof body.description === 'string' ? body.description : undefined,
          avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
          emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
          rules: typeof body.rules === 'string' ? body.rules : '',
          skills: Array.isArray(body.skills) ? body.skills.filter(s => typeof s === 'string') : undefined,
        })
        
        writeJson(res, 200, { success: true, data: result })
        return
      }
```

**Step 3: Commit**
```bash
git add src/server/server.ts
git commit -m "feat(api): add POST /api/v1/agents/create endpoint"
```

---

### Task 3: 最终验证与测试

**Step 1: 启动服务端 (如果环境允许)**
使用 `bun run start` 启动。

**Step 2: 使用 curl 发送测试请求**
```bash
curl -X POST http://localhost:PORT/api/v1/agents/create \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-agent",
    "displayName": "测试助手",
    "rules": "你是一个测试助手。",
    "emoji": "🧪"
  }'
```

**Step 3: 检查文件系统**
验证 `~/.moss/assistants/custom/test-agent/` 目录及其文件是否存在。

**Step 4: 验证 Scode 发现**
检查 scode 端是否能看到该助手。

**Step 5: Commit**
```bash
git commit -m "test: verify custom agent creation and scode sync"
```
