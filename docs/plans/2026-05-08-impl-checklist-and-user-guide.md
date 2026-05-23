# 尹斌臣模块实现清单 & 用户操作流程

## 一、实现清单

### M1：Skill Hub 本地化配置

| 项目 | 状态 | 文件 |
|------|------|------|
| server.json 新增 `hub` 配置段 | ✅ | `src/server/types.ts` |
| Hub 配置解析模块（优先级：server.json > 环境变量 > 默认值） | ✅ | `src/server/hubConfig.ts` |
| 启动时初始化 Hub 配置 | ✅ | `src/server/startStandaloneServer.ts` |
| config.ts 集成 hub 字段解析 | ✅ | `src/server/config.ts` |

**配置字段：**

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hub.apiBaseUrl` | string? | undefined | Hub API 地址，自动补 `/api` 后缀 |
| `hub.authorization` | string? | undefined | Hub 认证 token |

**优先级：** server.json > 环境变量 `MOSS_HUB_API_BASE_URL` / `MOSS_HUB_AUTHORIZATION` > 硬编码默认值

---

### M2：批量安装 + 增量同步

| 项目 | 状态 | 文件 |
|------|------|------|
| `batchSyncSkills()` 带 onProgress 回调 | ✅ | `src/server/skillStore.ts` |
| `batchSyncAssistants()` 带 onProgress 回调 | ✅ | `src/server/agentStore.ts` |
| 增量版本对比（installed_version vs hubLatestVersion） | ✅ | skillStore.ts, agentStore.ts |
| `syncProgress.ts` 进度状态管理模块 | ✅ | `src/server/syncProgress.ts` |
| POST /skills/sync-from-hub 异步同步路由 | ✅ | `src/server/server.ts` |
| POST /agents/sync-from-hub 异步同步路由 | ✅ | `src/server/server.ts` |
| GET /skills/sync-status 进度查询路由 | ✅ | `src/server/server.ts` |
| GET /agents/sync-status 进度查询路由 | ✅ | `src/server/server.ts` |
| POST /skills/sync 向后兼容别名 | ✅ | `src/server/server.ts` |
| POST /agents/sync 向后兼容别名 | ✅ | `src/server/server.ts` |
| 同步进行中拒绝重复请求（409） | ✅ | `src/server/server.ts` |
| 前端批量同步按钮 | ✅ | skill-store-page.tsx, agent-hub-page.tsx |
| 前端同步进度弹窗（轮询 + 进度条） | ✅ | skill-store-page.tsx, agent-hub-page.tsx |
| 前端 API 客户端函数 | ✅ | admin/lib/api/skill-store.ts, agent-hub.ts |

---

### M5：Meta 字段扩展 + AdminHub 统一管理

#### 5.1 Meta 字段扩展

| 项目 | 状态 | 文件 |
|------|------|------|
| AssistantStoreMeta: agent_type | ✅ | `src/server/agentStore.ts` |
| AssistantStoreMeta: memory_mode | ✅ | `src/server/agentStore.ts` |
| AssistantStoreMeta: visible_to | ✅ | `src/server/agentStore.ts` |
| AssistantStoreMeta: workflow | ✅ | `src/server/agentStore.ts` |
| SkillStoreMeta: visible_to | ✅ | `src/server/skillStore.ts` |
| 前端 InstalledAgentMeta 类型扩展 | ✅ | `admin/lib/api/agent-hub.ts` |
| 前端 InstalledSkillMeta 类型扩展 | ✅ | `admin/lib/api/skill-store.ts` |

#### 5.2 可见性过滤

| 项目 | 状态 | 文件 |
|------|------|------|
| visibilityFilter.ts 模块 | ✅ | `src/server/visibilityFilter.ts` |
| isVisibleTo() 过滤函数 | ✅ | visibilityFilter.ts |
| buildVisibilityFilter() 构建函数 | ✅ | visibilityFilter.ts |
| getUserAncestorIds() 部门祖先链 | ✅ | visibilityFilter.ts |
| AuthService.buildVisibilityFilter() | ✅ | `src/server/auth/service.ts` |
| AuthService.getUserDepartmentAncestorIds() | ✅ | `src/server/auth/service.ts` |
| admin 返回 null（admin 无需过滤） | ✅ | service.ts |
| GET /agents/installed 可见性过滤 | ✅ | `src/server/server.ts` |
| GET /skills/installed 可见性过滤 | ✅ | `src/server/server.ts` |
| 可见性过滤单元测试（10 cases） | ✅ | `src/server/__tests__/visibility-filter.test.ts` |

#### 5.3 HTTP 路由变更

| 路由 | 变更 | 状态 |
|------|------|------|
| GET /api/v1/agents/installed | 新增可见性过滤 | ✅ |
| GET /api/v1/skills/installed | 新增可见性过滤 | ✅ |
| PATCH /api/v1/agents/visibility | 新增端点 | ✅ |
| PATCH /api/v1/skills/visibility | 新增端点 | ✅ |
| PATCH /api/v1/agents/meta | 扩展接受 agent_type, memory_mode, visible_to, workflow | ✅ |
| POST /api/v1/agents/create | 扩展接受 agent_type, memory_mode, visible_to, workflow | ✅ |

#### 5.4 AdminHub UI

| 项目 | 状态 | 文件 |
|------|------|------|
| 已安装卡片 agent_type 标签（对话助手/业务流程） | ✅ | agent-hub-page.tsx |
| 已安装卡片 Shield 可见性快捷按钮 | ✅ | agent-hub-page.tsx |
| 编辑 Dialog：工作模式、记忆模式、可见范围、业务流程配置 | ✅ | agent-hub-page.tsx |
| 创建 Dialog：工作模式、记忆模式、可见范围、业务流程配置 | ✅ | agent-hub-page.tsx |
| 独立可见性编辑 Dialog（智能体） | ✅ | agent-hub-page.tsx |
| 独立可见性编辑 Dialog（技能） | ✅ | skill-store-page.tsx |
| updateAgentVisibility API 客户端函数 | ✅ | admin/lib/api/agent-hub.ts |
| updateSkillVisibility API 客户端函数 | ✅ | admin/lib/api/skill-store.ts |

---

## 二、API 接口清单

### 同步相关

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | /api/v1/skills/sync-from-hub | admin:settings | 启动技能异步同步，返回 `{ started: true }` |
| POST | /api/v1/agents/sync-from-hub | admin:settings | 启动智能体异步同步，返回 `{ started: true }` |
| GET | /api/v1/skills/sync-status | admin:settings | 查询技能同步进度 |
| GET | /api/v1/agents/sync-status | admin:settings | 查询智能体同步进度 |
| POST | /api/v1/skills/sync | admin:settings | 向后兼容别名，等同 sync-from-hub |
| POST | /api/v1/agents/sync | admin:settings | 向后兼容别名，等同 sync-from-hub |

### 可见性相关

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| PATCH | /api/v1/skills/visibility | admin:settings | 更新技能可见性，body: `{ skillName, visible_to }` |
| PATCH | /api/v1/agents/visibility | admin:settings | 更新智能体可见性，body: `{ assistantName, visible_to }` |

### 智能体扩展

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | /api/v1/agents/create | admin:settings | 创建自定义智能体（支持 agent_type, memory_mode, visible_to, workflow） |
| PATCH | /api/v1/agents/meta | admin:settings | 更新智能体元数据（支持 agent_type, memory_mode, visible_to, workflow） |
| GET | /api/v1/agents/installed | 无额外权限 | 列出已安装智能体（按可见性过滤） |
| GET | /api/v1/skills/installed | admin:settings | 列出已安装技能（按可见性过滤） |

### SyncProgress 响应结构

```typescript
{
  status: 'idle' | 'running' | 'done' | 'error'
  total: number        // 总条目数
  processed: number    // 已处理数
  installed: number    // 新安装数
  updated: number      // 更新数
  skipped: number      // 跳过数
  failed: number       // 失败数
  error?: string       // 错误信息
  startedAt: number    // 开始时间戳
}
```

---

## 三、用户操作流程

### 流程 1：配置 Hub 连接

```
1. 编辑 server.json，添加 hub 配置：
   {
     "hub": {
       "apiBaseUrl": "http://skill-hub-internal/api",
       "authorization": "your-token"
     }
   }

2. 重启 moss server

3. 打开 AdminHub → 技能商店 → 确认能从 Hub 拉取技能列表
```

### 流程 2：批量同步技能

```
1. 进入「技能商店」页面
2. 点击顶部「批量同步」按钮
3. 弹出同步进度弹窗，实时显示：
   - 进度条：已处理 x / 总共 y
   - 统计：新安装 x 个 / 更新 y 个 / 跳过 z 个 / 失败 w 项
4. 同步完成后进度弹窗可关闭
5. 已安装列表自动刷新
```

### 流程 3：批量同步智能体

```
1. 进入「智能体管理」页面
2. 点击顶部「批量同步」按钮
3. 同上进度弹窗交互
4. 同步完成后已安装列表自动刷新
```

### 流程 4：创建自定义智能体（含新字段）

```
1. 进入「智能体管理」→ 已安装 tab
2. 点击「+ 创建」按钮
3. 填写表单：
   - 标识名称（必填）
   - 显示名称（必填）
   - 系统指令（必填）
   - 工作模式：对话助手 / 业务流程
   - 如果选择「对话助手」：
     → 记忆模式：会话独立 / 跨会话共享
   - 如果选择「业务流程」：
     → 触发方式：手动 / 定时 / Webhook
     → Cron 表达式（定时模式下）
     → 输出目标：对话 / Webhook / 文件（多选）
   - 可见范围：勾选部门（留空 = 全员可见）
4. 点击「创建」
```

### 流程 5：编辑已安装智能体

```
1. 在已安装列表中，点击智能体卡片或「编辑」按钮
2. 编辑弹窗中可修改：
   - 显示名称、头像、Emoji、描述
   - 工作模式、记忆模式、业务流程配置
   - 可见范围（部门多选）
3. 点击「保存」
```

### 流程 6：快捷编辑可见性

```
1. 在已安装列表中，点击卡片上的 Shield 🛡️ 图标按钮
2. 弹出可见性编辑弹窗（仅含部门选择器）
3. 勾选/取消部门
   - 不勾选任何部门 = 全员可见
   - 勾选指定部门 = 仅这些部门可见
4. 点击「保存」
```

### 流程 7：编辑技能可见性

```
1. 在已安装技能列表中，点击 Shield 图标
2. 或在技能详情弹窗中点击「编辑可见性」
3. 同上部门多选交互
4. 点击「保存」
```

---

## 四、可见性过滤规则

| visible_to 值 | 含义 | 普通用户 | admin 用户 |
|---------------|------|---------|-----------|
| null / 未设置 | 全员可见 | ✅ 可见 | ✅ 可见 |
| { department_ids: ['d01'] } | 仅指定部门可见 | 仅 d01 部门（含子部门）可见 | ✅ 可见 |
| { department_ids: [] } | 仅管理员可见 | ❌ 不可见 | ✅ 可见 |

**祖先链匹配：** 如果用户所属部门是 d02，d02 的父部门是 d01，当 visible_to 包含 d01 时，d02 用户也能看到。

---

## 五、新增文件清单

| 文件 | 说明 |
|------|------|
| `src/server/hubConfig.ts` | Hub 配置解析模块 |
| `src/server/visibilityFilter.ts` | 可见性过滤逻辑 |
| `src/server/syncProgress.ts` | 同步进度状态管理 |
| `src/server/__tests__/visibility-filter.test.ts` | 可见性过滤测试（10 cases） |

## 六、修改文件清单

| 文件 | 变更概述 |
|------|---------|
| `src/server/types.ts` | serverFileConfigSchema 新增 hub 段，ServerConfig 新增 hubApiBaseUrl/hubAuthorization |
| `src/server/config.ts` | 解析 hub 配置，传入 resolveServerConfig |
| `src/server/startStandaloneServer.ts` | 启动时调用 initHubConfig |
| `src/server/agentStore.ts` | 扩展 AssistantStoreMeta、createCustomAssistant、batchSyncAssistants、updateInstalledAssistantMeta |
| `src/server/skillStore.ts` | 扩展 SkillStoreMeta、batchSyncSkills |
| `src/server/auth/service.ts` | 新增 buildVisibilityFilter、getUserDepartmentAncestorIds 方法 |
| `src/server/server.ts` | 新增 6 个路由 + 2 个路由扩展可见性过滤 |
| `admin/lib/api/agent-hub.ts` | 扩展 CreateAssistantRequest、新增 batchSyncAgents/getAgentSyncStatus/updateAgentVisibility |
| `admin/lib/api/skill-store.ts` | 新增 getSkillSyncStatus，更新 batchSyncSkills 返回类型 |
| `admin/src/pages/agent-hub-page.tsx` | 创建/编辑/可见性 Dialog 扩展 + 同步进度弹窗 |
| `admin/src/pages/skill-store-page.tsx` | 同步进度弹窗 + 可见性编辑 |
