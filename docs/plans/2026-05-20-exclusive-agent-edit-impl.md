# 专属智能体编辑与创建功能实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让专属智能体点击后可编辑所有字段（与自定义智能体一致），Admin 页面创建的专属智能体直接启用无需审批。

**Architecture:** 复用现有编辑对话框结构，为 TenantAssistantInfo 添加编辑支持；新增后端 API 支持直接创建已启用的专属智能体；扩展更新 API 支持所有编辑字段。

**Tech Stack:** React, TypeScript, Express, SQLite

---

## Task 1: 扩展 TenantAssistantInfo 类型定义

**Files:**
- Modify: `admin/lib/api/agent-hub.ts:241-264`

**Step 1: 扩展 TenantAssistantInfo 接口**

添加缺失的字段以支持完整编辑功能：

```typescript
export interface TenantAssistantInfo {
  id: string
  name: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string
  version?: string
  author_id: string
  author_name?: string
  status: 'pending' | 'approved' | 'rejected'
  source_url?: string
  checksum?: string
  file_path?: string
  skills?: string[]
  enabled_skills?: string[]
  enabled_wikis?: string[]
  memory_mode?: 'session' | 'user'
  agent_type?: 'chat' | 'workflow'
  publish_note?: string
  review_note?: string
  reviewed_by?: string
  reviewed_at?: number
  enabled: number
  visible_to?: VisibleTo | null
  workflow?: {
    trigger?: 'cron' | 'webhook' | 'manual'
    cron?: string
    webhook_path?: string
    output_webhook?: string
    timeout_minutes?: number
    output_targets?: string[]
  } | null
  created_at: number
  updated_at: number
}
```

**Step 2: 提交**

```bash
git add admin/lib/api/agent-hub.ts
git commit -m "feat(api): extend TenantAssistantInfo type for full editing support"
```

---

## Task 2: 新增前端 API 函数

**Files:**
- Modify: `admin/lib/api/agent-hub.ts`

**Step 1: 添加 createTenantAssistant API**

用于 Admin 页面直接创建已启用的专属智能体：

```typescript
export interface CreateTenantAssistantRequest {
  name: string
  display_name: string
  description?: string
  avatar?: string
  emoji?: string
  skills?: string[]
  enabled_skills?: string[]
  enabled_wikis?: string[]
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: TenantAssistantInfo['workflow']
}

export function createTenantAssistant(
  data: CreateTenantAssistantRequest,
): Promise<{ success: boolean; data: TenantAssistantInfo }> {
  return authClient.post<{ success: boolean; data: TenantAssistantInfo }>(
    '/api/v1/agents/tenant/create',
    data,
  )
}
```

**Step 2: 扩展 updateTenantAssistantMeta 参数**

修改现有函数支持更多字段：

```typescript
export function updateTenantAssistantMeta(params: {
  id: string
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string
  agent_type?: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  visible_to?: VisibleTo | null
  workflow?: TenantAssistantInfo['workflow']
  enabled?: boolean
  enabledSkills?: string[]
  enabledWikis?: string[]
  skills?: string[]
}): Promise<{ ok: boolean }> {
  return authClient.patch<{ ok: boolean }>(
    `/api/v1/agents/tenant/${encodeURIComponent(params.id)}`,
    params,
  )
}
```

**Step 3: 提交**

```bash
git add admin/lib/api/agent-hub.ts
git commit -m "feat(api): add createTenantAssistant and extend updateTenantAssistantMeta"
```

---

## Task 3: 后端 - 扩展数据库操作

**Files:**
- Modify: `src/server/db.ts:1549-1571`

**Step 1: 扩展 updateTenantAssistantMeta 支持新字段**

```typescript
updateTenantAssistantMeta(id: string, updates: {
  display_name?: string
  description?: string
  avatar?: string
  emoji?: string
  agent_type?: string
  memory_mode?: string
  enabled?: number
  visible_to?: string | null
  enabled_skills?: string | null
  enabled_wikis?: string | null
  skills?: string | null
  workflow?: string | null
}): void {
  const ts = now()
  const existing = this.getTenantAssistant(id)
  if (!existing) return

  const displayName = updates.display_name ?? existing.display_name
  const description = updates.description ?? existing.description
  const avatar = updates.avatar ?? existing.avatar
  const emoji = updates.emoji ?? existing.emoji
  const agentType = updates.agent_type ?? existing.agent_type
  const memoryMode = updates.memory_mode ?? existing.memory_mode
  const enabled = updates.enabled ?? existing.enabled
  const visibleTo = updates.visible_to !== undefined ? updates.visible_to : existing.visible_to
  const enabledSkills = updates.enabled_skills ?? existing.enabled_skills
  const enabledWikis = updates.enabled_wikis ?? existing.enabled_wikis
  const skills = updates.skills ?? existing.skills
  const workflow = updates.workflow ?? existing.workflow

  this.db.prepare(`
    UPDATE tenant_assistants
    SET display_name = ?, description = ?, avatar = ?, emoji = ?,
        agent_type = ?, memory_mode = ?, enabled = ?, visible_to = ?,
        enabled_skills = ?, enabled_wikis = ?, skills = ?, workflow = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    displayName as string,
    description as string,
    avatar as string | null,
    emoji as string | null,
    agentType as string,
    memoryMode as string,
    enabled as number,
    visibleTo as string | null,
    enabledSkills as string | null,
    enabledWikis as string | null,
    skills as string | null,
    workflow as string | null,
    ts,
    id,
  )
}
```

**Step 2: 提交**

```bash
git add src/server/db.ts
git commit -m "feat(db): extend updateTenantAssistantMeta for full editing support"
```

---

## Task 4: 后端 - 新增创建专属智能体 API

**Files:**
- Modify: `src/server/server.ts` (在 tenant assistant routes 区域)

**Step 1: 添加 POST /api/v1/agents/tenant/create 端点**

在 `// POST /api/v1/agents/tenant/publish` 之前添加：

```typescript
// POST /api/v1/agents/tenant/create - Create tenant assistant directly (admin only)
if (req.method === 'POST' && pathname === '/api/v1/agents/tenant/create') {
  authService.requireScope(auth, 'admin:settings')
  const body = await readJsonBody(req)

  // Validate required fields
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : name

  if (!name) {
    throw new HttpError(400, 'name is required')
  }

  // Generate UUID for the assistant
  const assistantId = randomUUID()

  // Get author info
  const authorUser = authService.getUserOrNull(auth.userId, auth.orgId, auth)
  const authorName = authorUser?.name || undefined

  // Create assistant directory in tenant folder
  const MOSS_HOME = process.env.MOSS_HOME || join(os.homedir(), '.moss')
  const ASSISTANT_TENANT_DIR = join(MOSS_HOME, 'assistants', 'tenant')
  const assistantDir = join(ASSISTANT_TENANT_DIR, assistantId)

  await mkdir(assistantDir, { recursive: true })

  // Create metadata
  const meta: AssistantStoreMeta = {
    id: assistantId,
    name,
    display_name: displayName,
    description: typeof body.description === 'string' ? body.description : undefined,
    avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
    emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
    source_type: 'tenant',
    enabled: true,
    skills: Array.isArray(body.skills) ? body.skills : [],
    enabledSkills: Array.isArray(body.enabled_skills) ? body.enabled_skills : [],
    enabledWikis: Array.isArray(body.enabled_wikis) ? body.enabled_wikis : [],
    agent_type: body.agent_type || 'chat',
    memory_mode: body.memory_mode || 'session',
    visible_to: body.visible_to || null,
    workflow: body.workflow || null,
  }

  await writeAssistantMeta(assistantDir, meta)

  // Create default rules file
  const rulesContent = `# ${displayName}\n\n${body.description || '这是一个专属智能体。'}\n`
  await writeFile(join(assistantDir, 'system.md'), rulesContent)

  // Create database record with approved status
  runtime.store.createTenantAssistant({
    id: assistantId,
    name,
    display_name: displayName,
    description: meta.description,
    avatar: meta.avatar,
    emoji: meta.emoji,
    author_id: auth.userId,
    author_name: authorName,
    status: 'approved',
    file_path: assistantDir,
    skills: meta.skills ? JSON.stringify(meta.skills) : null,
    enabled_skills: meta.enabledSkills ? JSON.stringify(meta.enabledSkills) : null,
    enabled_wikis: meta.enabledWikis ? JSON.stringify(meta.enabledWikis) : null,
    agent_type: meta.agent_type,
    memory_mode: meta.memory_mode,
    visible_to: meta.visible_to ? JSON.stringify(meta.visible_to) : null,
    workflow: meta.workflow ? JSON.stringify(meta.workflow) : null,
    enabled: 1,
  })

  const result = runtime.store.getTenantAssistant(assistantId)
  writeJson(res, 200, { success: true, data: result })
  return
}
```

**Step 2: 提交**

```bash
git add src/server/server.ts
git commit -m "feat(server): add POST /api/v1/agents/tenant/create endpoint"
```

---

## Task 5: 后端 - 扩展更新 API

**Files:**
- Modify: `src/server/server.ts:2994-3040`

**Step 1: 扩展 PATCH /api/v1/agents/tenant/:id 处理更多字段**

修改现有的 PATCH 处理逻辑，支持所有编辑字段：

```typescript
// PATCH /api/v1/agents/tenant/:id - Update tenant assistant meta
const agentTenantPatchMatch = pathname.match(/^\/api\/v1\/agents\/tenant\/([^/]+)$/)
if (req.method === 'PATCH' && agentTenantPatchMatch) {
  authService.requireScope(auth, 'admin:settings')
  const tenantAssistantId = agentTenantPatchMatch[1] || ''
  const body = await readJsonBody(req)

  const updates: Record<string, unknown> = {}
  if (typeof body.display_name === 'string') {
    updates.display_name = body.display_name
  }
  if (typeof body.description === 'string') {
    updates.description = body.description
  }
  if (typeof body.avatar === 'string') {
    updates.avatar = body.avatar
  }
  if (typeof body.emoji === 'string') {
    updates.emoji = body.emoji
  }
  if (typeof body.agent_type === 'string') {
    updates.agent_type = body.agent_type
  }
  if (typeof body.memory_mode === 'string') {
    updates.memory_mode = body.memory_mode
  }
  if (typeof body.enabled === 'boolean') {
    updates.enabled = body.enabled ? 1 : 0
  }
  if (body.visible_to !== undefined) {
    updates.visible_to = body.visible_to ? JSON.stringify(body.visible_to) : null
  }
  if (Array.isArray(body.enabledSkills)) {
    updates.enabled_skills = JSON.stringify(body.enabledSkills.filter((s: unknown) => typeof s === 'string'))
  }
  if (Array.isArray(body.enabledWikis)) {
    updates.enabled_wikis = JSON.stringify(body.enabledWikis.filter((s: unknown) => typeof s === 'string'))
  }
  if (Array.isArray(body.skills)) {
    updates.skills = JSON.stringify(body.skills.filter((s: unknown) => typeof s === 'string'))
  }
  if (body.workflow !== undefined) {
    updates.workflow = body.workflow ? JSON.stringify(body.workflow) : null
  }

  runtime.store.updateTenantAssistantMeta(tenantAssistantId, updates)

  // Sync to file metadata if approved
  const tenantAssistant = runtime.store.getTenantAssistant(tenantAssistantId)
  if (tenantAssistant && tenantAssistant.status === 'approved') {
    const assistantName = tenantAssistant.name as string
    const MOSS_HOME_LOCAL = process.env.MOSS_HOME || join(os.homedir(), '.moss')
    const ASSISTANT_TENANT_DIR = join(MOSS_HOME_LOCAL, 'assistants', 'tenant')
    const assistantDir = join(ASSISTANT_TENANT_DIR, assistantName)
    if (existsSync(assistantDir)) {
      const meta = await readAssistantMeta(assistantDir)
      if (meta) {
        if (updates.display_name !== undefined) meta.display_name = updates.display_name as string
        if (updates.description !== undefined) meta.description = updates.description as string
        if (updates.avatar !== undefined) meta.avatar = updates.avatar as string
        if (updates.emoji !== undefined) meta.emoji = updates.emoji as string
        if (updates.agent_type !== undefined) meta.agent_type = updates.agent_type as 'chat' | 'workflow'
        if (updates.memory_mode !== undefined) meta.memory_mode = updates.memory_mode as 'session' | 'user'
        if (updates.enabled !== undefined) meta.enabled = updates.enabled === 1
        if (body.visible_to !== undefined) meta.visible_to = body.visible_to as VisibleTo | null
        if (body.enabledSkills !== undefined) meta.enabledSkills = body.enabledSkills as string[]
        if (body.enabledWikis !== undefined) meta.enabledWikis = body.enabledWikis as string[]
        if (body.skills !== undefined) meta.skills = body.skills as string[]
        if (body.workflow !== undefined) meta.workflow = body.workflow as AssistantStoreMeta['workflow']
        await writeAssistantMeta(assistantDir, meta)
      }
    }
  }

  writeJson(res, 200, { ok: true })
  return
}
```

**Step 2: 提交**

```bash
git add src/server/server.ts
git commit -m "feat(server): extend PATCH /api/v1/agents/tenant/:id for full editing"
```

---

## Task 6: 前端 - 添加专属智能体编辑状态和函数

**Files:**
- Modify: `admin/src/pages/agent-hub-page.tsx`

**Step 1: 添加编辑专属智能体的状态变量**

在现有状态变量区域添加：

```typescript
// Tenant assistant edit states
const [tenantEditOpen, setTenantEditOpen] = useState(false)
const [editingTenantAgent, setEditingTenantAgent] = useState<TenantAssistantInfo | null>(null)
const [tenantEditName, setTenantEditName] = useState('')
const [tenantEditDescription, setTenantEditDescription] = useState('')
const [tenantEditAvatar, setTenantEditAvatar] = useState('')
const [tenantEditEmoji, setTenantEditEmoji] = useState('')
const [tenantEditAgentType, setTenantEditAgentType] = useState<'chat' | 'workflow'>('chat')
const [tenantEditMemoryMode, setTenantEditMemoryMode] = useState<'session' | 'user'>('session')
const [tenantEditVisibilityMode, setTenantEditVisibilityMode] = useState<'all' | 'departments' | 'users' | 'admin'>('all')
const [tenantEditVisibleTo, setTenantEditVisibleTo] = useState<string[]>([])
const [tenantEditVisibleUserIds, setTenantEditVisibleUserIds] = useState<string[]>([])
const [tenantEditSkills, setTenantEditSkills] = useState<string[]>([])
const [tenantEditEnabledSkills, setTenantEditEnabledSkills] = useState<string[]>([])
const [tenantEditEnabledWikis, setTenantEditEnabledWikis] = useState<string[]>([])
const [tenantEditWorkflow, setTenantEditWorkflow] = useState<TenantAssistantInfo['workflow']>(null)
const [savingTenantEdit, setSavingTenantEdit] = useState(false)
```

**Step 2: 添加 openTenantEdit 函数**

```typescript
const openTenantEdit = useCallback((assistant: TenantAssistantInfo) => {
  setEditingTenantAgent(assistant)
  setTenantEditName(assistant.display_name || assistant.name)
  setTenantEditDescription(assistant.description || '')
  setTenantEditAvatar(assistant.avatar || '')
  setTenantEditEmoji(assistant.emoji || '')
  setTenantEditAgentType(assistant.agent_type || 'chat')
  setTenantEditMemoryMode(assistant.memory_mode || 'session')
  setTenantEditSkills(assistant.skills || [])
  setTenantEditEnabledSkills(assistant.enabled_skills || [])
  setTenantEditEnabledWikis(assistant.enabled_wikis || [])
  setTenantEditWorkflow(assistant.workflow || null)

  // Set visibility
  const deptIds = assistant.visible_to?.department_ids
  const userIds = assistant.visible_to?.user_ids

  if (deptIds === null && userIds === null) {
    setTenantEditVisibilityMode('all')
  } else if ((deptIds?.length === 0 && (userIds === null || userIds?.length === 0)) ||
             (userIds?.length === 0 && (deptIds === null || deptIds?.length === 0))) {
    setTenantEditVisibilityMode('admin')
  } else if (userIds !== null && userIds !== undefined && userIds.length > 0) {
    setTenantEditVisibilityMode('users')
  } else if (deptIds !== null && deptIds !== undefined && deptIds.length > 0) {
    setTenantEditVisibilityMode('departments')
  } else {
    setTenantEditVisibilityMode('all')
  }

  setTenantEditVisibleTo(deptIds || [])
  setTenantEditVisibleUserIds(userIds || [])

  // Load available wikis
  void (async () => {
    try {
      const { listWikis } = await import('@/lib/api/document-center')
      const list = await listWikis()
      setAvailableWikis(list.map(w => ({
        id: w.id,
        name: w.name,
        description: w.description,
        buildStatus: w.buildStatus,
      })))
    } catch {
      setAvailableWikis([])
    }
  })()

  setTenantEditOpen(true)
}, [])
```

**Step 3: 提交**

```bash
git add admin/src/pages/agent-hub-page.tsx
git commit -m "feat(ui): add tenant assistant edit states and openTenantEdit function"
```

---

## Task 7: 前端 - 修改专属智能体卡片点击行为

**Files:**
- Modify: `admin/src/pages/agent-hub-page.tsx:1834-1846`

**Step 1: 修改卡片 onClick**

将 `setTenantAssistantDetail(assistant)` 改为 `openTenantEdit(assistant)`：

```typescript
<div
  key={assistant.id}
  role="button"
  tabIndex={0}
  onClick={() => openTenantEdit(assistant)}
  onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openTenantEdit(assistant)
    }
  }}
  className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/30"
>
```

**Step 2: 提交**

```bash
git add admin/src/pages/agent-hub-page.tsx
git commit -m "feat(ui): change tenant assistant card click to open edit dialog"
```

---

## Task 8: 前端 - 添加专属智能体编辑对话框

**Files:**
- Modify: `admin/src/pages/agent-hub-page.tsx`

**Step 1: 复制编辑对话框结构，适配 TenantAssistantInfo**

在现有编辑对话框之后添加专属智能体编辑对话框。结构相同，但使用 tenantEdit* 状态变量和 updateTenantAssistantMeta API。

**Step 2: 添加保存处理函数**

```typescript
const handleSaveTenantEdit = useCallback(async () => {
  if (!editingTenantAgent) return
  setSavingTenantEdit(true)

  try {
    const visible_to = tenantEditVisibilityMode === 'all'
      ? null
      : tenantEditVisibilityMode === 'admin'
        ? { department_ids: [], user_ids: [] }
        : tenantEditVisibilityMode === 'departments'
          ? { department_ids: tenantEditVisibleTo, user_ids: null }
          : { department_ids: null, user_ids: tenantEditVisibleUserIds }

    await updateTenantAssistantMeta({
      id: editingTenantAgent.id,
      display_name: tenantEditName,
      description: tenantEditDescription,
      avatar: tenantEditAvatar,
      emoji: tenantEditEmoji,
      agent_type: tenantEditAgentType,
      memory_mode: tenantEditMemoryMode,
      visible_to,
      enabled_skills: tenantEditEnabledSkills,
      enabled_wikis: tenantEditEnabledWikis,
      skills: tenantEditSkills,
      workflow: tenantEditWorkflow,
    })

    toast.success('保存成功')
    setTenantEditOpen(false)
    setEditingTenantAgent(null)
    await fetchTenantAssistants()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    setSavingTenantEdit(false)
  }
}, [editingTenantAgent, tenantEditName, tenantEditDescription, tenantEditAvatar, tenantEditEmoji,
    tenantEditAgentType, tenantEditMemoryMode, tenantEditVisibilityMode, tenantEditVisibleTo,
    tenantEditVisibleUserIds, tenantEditEnabledSkills, tenantEditEnabledWikis, tenantEditSkills,
    tenantEditWorkflow, fetchTenantAssistants])
```

**Step 3: 提交**

```bash
git add admin/src/pages/agent-hub-page.tsx
git commit -m "feat(ui): add tenant assistant edit dialog"
```

---

## Task 9: 前端 - 修改创建专属智能体逻辑

**Files:**
- Modify: `admin/src/pages/agent-hub-page.tsx`

**Step 1: 修改创建对话框提交处理**

找到创建对话框的保存处理函数，改为调用 `createTenantAssistant` API：

```typescript
const handleCreateTenantAssistant = useCallback(async () => {
  if (!createName.trim()) {
    toast.error('请输入智能体名称')
    return
  }

  setCreatingAssistant(true)

  try {
    const visible_to = createVisibilityMode === 'all'
      ? null
      : createVisibilityMode === 'admin'
        ? { department_ids: [], user_ids: [] }
        : createVisibilityMode === 'departments'
          ? { department_ids: createVisibleTo, user_ids: null }
          : { department_ids: null, user_ids: createVisibleUserIds }

    const workflow: TenantAssistantInfo['workflow'] = createAgentType === 'workflow'
      ? {
          trigger: createWorkflowTrigger,
          cron: createWorkflowCron || undefined,
          webhook_path: createWorkflowWebhookPath || undefined,
          output_webhook: createWorkflowOutputWebhook || undefined,
          timeout_minutes: createWorkflowTimeout ? parseInt(createWorkflowTimeout, 10) : undefined,
          output_targets: createWorkflowOutputTargets,
        }
      : null

    await createTenantAssistant({
      name: createName.trim(),
      display_name: createDisplayName.trim() || createName.trim(),
      description: createDescription || undefined,
      avatar: createAvatar || undefined,
      emoji: createEmoji || undefined,
      skills: createSelectedSkills,
      enabled_skills: createSelectedSkills,
      agent_type: createAgentType,
      memory_mode: createMemoryMode,
      visible_to,
      workflow,
    })

    toast.success('创建成功')
    setCreateOpen(false)
    // Reset form
    setCreateName('')
    setCreateDisplayName('')
    setCreateDescription('')
    setCreateAvatar('')
    setCreateEmoji('')
    setCreateRules('')
    setCreateAgentType('chat')
    setCreateMemoryMode('session')
    setCreateVisibilityMode('all')
    setCreateVisibleTo([])
    setCreateVisibleUserIds([])
    setCreateSelectedSkills([])
    await fetchTenantAssistants()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建失败')
  } finally {
    setCreatingAssistant(false)
  }
}, [createName, createDisplayName, createDescription, createAvatar, createEmoji,
    createAgentType, createMemoryMode, createVisibilityMode, createVisibleTo,
    createVisibleUserIds, createSelectedSkills, createWorkflowTrigger, createWorkflowCron,
    createWorkflowWebhookPath, createWorkflowOutputWebhook, createWorkflowTimeout,
    createWorkflowOutputTargets, fetchTenantAssistants])
```

**Step 2: 提交**

```bash
git add admin/src/pages/agent-hub-page.tsx
git commit -m "feat(ui): use createTenantAssistant API for direct creation"
```

---

## Task 10: 数据库迁移 - 添加新字段

**Files:**
- Modify: `src/server/db.ts` (schema 初始化部分)

**Step 1: 确保 tenant_assistants 表有新字段**

检查并添加缺失的列：`avatar`, `emoji`, `skills`, `enabled_wikis`, `workflow`。

**Step 2: 提交**

```bash
git add src/server/db.ts
git commit -m "feat(db): add new columns to tenant_assistants table"
```

---

## Task 11: 测试验证

**Step 1: 测试 Admin 页面创建专属智能体**

1. 打开 Admin 页面 → 智能体管理 → 专属智能体
2. 点击"创建专属智能体"
3. 填写表单并提交
4. 验证：创建后状态为"已通过"且"已启用"

**Step 2: 测试专属智能体编辑**

1. 点击已创建的专属智能体卡片
2. 验证：打开编辑对话框
3. 修改字段并保存
4. 验证：修改生效

**Step 3: 测试 API 发布仍需审批**

1. 通过 `/api/v1/agents/tenant/publish` 发布智能体
2. 验证：状态为"待审批"
3. 审批通过后变为"已通过"

---

## 文件改动总结

### 前端
- `admin/lib/api/agent-hub.ts` - 扩展类型定义，新增 API 函数
- `admin/src/pages/agent-hub-page.tsx` - 主要改动文件

### 后端
- `src/server/db.ts` - 扩展数据库操作
- `src/server/server.ts` - 新增/扩展 API 端点
