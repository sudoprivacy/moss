# 智能体和技能可见性扩展 + 技能自动安装修复

## 需求概述

1. **可见性扩展**：智能体和技能的可见性从部门级别扩展到用户级别
2. **技能自动安装**：从 Hub 安装智能体时，自动安装关联的未安装技能

---

## 需求1：可见性扩展

### 当前状态

- `visible_to` 只支持 `department_ids`（部门级别）
- `VisibilityFilter` 基于 `isAdmin`、`departmentId`、`visibleDepartmentIds` 进行过滤

### 目标设计

前端展示四种可见性选项：

| 选项 | 对应配置 |
|------|----------|
| 全员可见 | `visible_to: null` |
| 指定部门可见 | `visible_to: { department_ids: ["dept1", "dept2"], user_ids: null }` |
| 指定人员可见 | `visible_to: { department_ids: null, user_ids: ["user1", "user2"] }` |
| 仅管理员可见 | `visible_to: { department_ids: [], user_ids: [] }` |

### 数据模型变更

#### 1. 扩展 `VisibleTo` 类型

```typescript
// src/server/visibilityFilter.ts

export type VisibleTo = {
  department_ids: string[] | null   // 部门白名单（现有字段）
  user_ids: string[] | null         // 用户白名单（新增）
} | null
```

#### 2. 扩展 `VisibilityFilter` 类型

```typescript
export type VisibilityFilter = {
  isAdmin: boolean
  userId: string                    // 新增：当前用户ID
  departmentId: string | null
  visibleDepartmentIds: Set<string> | null
}
```

#### 3. 可见性判断逻辑

```typescript
export function isVisibleTo(
  visibleTo: VisibleTo | null | undefined,
  filter: VisibilityFilter,
): boolean {
  // 1. 管理员始终可见
  if (filter.isAdmin) return true

  // 2. visible_to 为 null → 所有人可见
  if (!visibleTo) return true

  // 3. 检查用户白名单
  const userIds = visibleTo.user_ids
  if (userIds !== null) {
    if (userIds.length === 0) {
      // 空数组表示仅管理员可见
      return false
    }
    if (userIds.includes(filter.userId)) {
      return true
    }
  }

  // 4. 检查部门白名单
  const departmentIds = visibleTo.department_ids
  if (departmentIds !== null) {
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
```

#### 4. 更新 `buildVisibilityFilter`

```typescript
export function buildVisibilityFilter(
  auth: AuthContext,
  getUserByIdAndOrg: (userId: string, orgId: string) => { role: string; departmentId: string | null } | null,
  listDepartmentsByOrg: (orgId: string) => Array<{ id: string; parentId: string | null }>,
): VisibilityFilter {
  const isAdmin = auth.role === 'admin' || hasScope(auth.scopes, '*')
  if (isAdmin) {
    return { isAdmin: true, userId: auth.userId, departmentId: null, visibleDepartmentIds: null }
  }

  const user = getUserByIdAndOrg(auth.userId, auth.orgId)
  const departmentId = user?.departmentId ?? null
  const visibleDepartmentIds = getUserAncestorIds(
    auth.userId,
    auth.orgId,
    getUserByIdAndOrg,
    listDepartmentsByOrg,
  )

  return { isAdmin: false, userId: auth.userId, departmentId, visibleDepartmentIds }
}
```

### 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `src/server/visibilityFilter.ts` | 扩展类型和函数 |
| `src/server/agentStore.ts` | 更新 `AssistantStoreMeta.visible_to` 类型 |
| `src/server/skillStore.ts` | 更新 `SkillStoreMeta.visible_to` 类型 |
| `admin/lib/api/agent-hub.ts` | 更新前端类型定义 |
| `admin/lib/api/skill-store.ts` | 更新前端类型定义 |
| `admin/src/pages/agent-hub-page.tsx` | 添加可见性选择 UI |
| `admin/src/pages/skill-hub-page.tsx` | 添加可见性选择 UI |

### 向后兼容性

- 现有数据只有 `department_ids`，`user_ids` 为 `null`
- 新字段为可选，旧数据无需迁移
- 现有过滤逻辑保持不变

---

## 需求2：技能自动安装

### 当前状态

代码逻辑已实现，但需要确认是否正常工作：

```typescript
// src/server/agentStore.ts - installHubAssistant
for (const skillId of selectedSkillIds) {
  const detail = await fetchSkillHubSkillDetail(skillId).catch(() => null)
  if (!detail) {
    failedSkillIds.push(skillId)
    continue
  }

  const existingSkill = installedSkillLookup.get(skillId) || installedSkillLookup.get(detail.name)
  if (existingSkill) {
    enabledSkillNames.add(existingSkill.name || detail.name)
    continue
  }

  const latestVersion = detail.versions?.[0]
  if (!latestVersion?.source_url) {
    failedSkillIds.push(skillId)
    continue
  }

  await installHubSkill({ ... })
}
```

### 问题排查

从服务器数据看：
- 智能体 `wechat-assistant` 的 `skills` 字段有 2 个技能 ID
- `enabledSkills` 为空，说明技能没有被启用

可能的问题：
1. `fetchSkillHubSkillDetail(skillId)` 返回 null
2. 技能详情中没有 `versions` 或 `source_url`
3. `installHubSkill` 执行失败

### 修复方案

#### 1. 添加详细日志

```typescript
for (const skillId of selectedSkillIds) {
  console.log(`[AgentHub] Installing skill ${skillId} for assistant ${assistantName}`)

  const detail = await fetchSkillHubSkillDetail(skillId).catch((err) => {
    console.error(`[AgentHub] Failed to fetch skill detail ${skillId}:`, err)
    return null
  })

  if (!detail) {
    console.warn(`[AgentHub] Skill detail not found: ${skillId}`)
    failedSkillIds.push(skillId)
    continue
  }

  const existingSkill = installedSkillLookup.get(skillId) || installedSkillLookup.get(detail.name)
  if (existingSkill) {
    console.log(`[AgentHub] Skill already installed: ${detail.name}`)
    enabledSkillNames.add(existingSkill.name || detail.name)
    continue
  }

  const latestVersion = detail.versions?.[0]
  if (!latestVersion?.source_url) {
    console.warn(`[AgentHub] Skill has no download URL: ${skillId}`, detail)
    failedSkillIds.push(skillId)
    continue
  }

  try {
    await installHubSkill({ ... })
    console.log(`[AgentHub] Skill installed: ${detail.name}`)
    installedSkillNames.push(detail.name)
    enabledSkillNames.add(detail.name)
  } catch (err) {
    console.error(`[AgentHub] Failed to install skill ${skillId}:`, err)
    failedSkillIds.push(skillId)
  }
}
```

#### 2. 检查 Hub API 响应格式

确保 `fetchSkillHubSkillDetail` 正确解析 Hub API 响应：

```typescript
export async function fetchSkillHubSkillDetail(
  skillId: string,
): Promise<SkillHubDetail | null> {
  const url = `${getSkillHubBaseUrl()}/${encodeURIComponent(skillId)}`
  console.log(`[SkillStore] Fetching skill detail from: ${url}`)

  const result = await fetchJson(url)
  const unwrapped = unwrapHubResponse(result)

  if (!isRecord(unwrapped.data)) {
    console.warn(`[SkillStore] Invalid skill detail response for ${skillId}`)
    return null
  }

  console.log(`[SkillStore] Skill detail fetched: ${JSON.stringify(unwrapped.data)}`)
  return unwrapped.data as SkillHubDetail
}
```

### 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `src/server/agentStore.ts` | 添加详细日志 |
| `src/server/skillStore.ts` | 添加详细日志 |

---

## 实现步骤

### Phase 1: 可见性扩展

1. 修改 `src/server/visibilityFilter.ts`
   - 扩展 `VisibleTo` 类型
   - 扩展 `VisibilityFilter` 类型
   - 更新 `isVisibleTo` 函数
   - 更新 `buildVisibilityFilter` 函数

2. 修改 `src/server/agentStore.ts`
   - 更新 `AssistantStoreMeta.visible_to` 类型

3. 修改 `src/server/skillStore.ts`
   - 更新 `SkillStoreMeta.visible_to` 类型

4. 修改前端类型定义
   - `admin/lib/api/agent-hub.ts`
   - `admin/lib/api/skill-store.ts`

5. 添加前端 UI
   - 可见性选择组件
   - 部门选择器
   - 用户选择器

### Phase 2: 技能自动安装修复

1. 添加详细日志到 `installHubAssistant`
2. 添加详细日志到 `fetchSkillHubSkillDetail`
3. 测试验证

---

## 测试计划

### 可见性测试

1. 创建智能体，设置为"全员可见"
2. 创建智能体，设置为"指定部门可见"，选择部门
3. 创建智能体，设置为"指定人员可见"，选择用户
4. 创建智能体，设置为"仅管理员可见"
5. 验证不同用户看到的智能体列表

### 技能自动安装测试

1. 安装一个关联了技能的智能体
2. 验证关联技能是否自动安装
3. 验证已安装的技能是否正确关联
4. 验证安装失败的技能是否正确报告
