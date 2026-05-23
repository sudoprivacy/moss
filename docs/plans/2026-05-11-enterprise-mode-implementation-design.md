# Moss Server 企业模式功能实现设计

## 一、概述

### 1.1 背景

根据 `M7-enterprise-skill-assistant-full-design.md` 设计文档和 `docs/需求.txt` 需求文件，需要在 Moss Server 端实现企业模式下的技能和智能体管理功能，支持 SudoWork 客户端进行下载、上传、发布技能和智能体。

### 1.2 目标

1. **前端改造**：智能体/技能管理页面改为三个页签（库|专属|自定义）
2. **自定义上传**：支持客户端上传自定义技能/智能体
3. **专属内容管理**：支持专属技能/智能体的发布、审批、列表展示
4. **下载功能**：支持已安装和专属内容的下载
5. **可见性规则**：
   - 用户上传/创建的技能/智能体：默认仅上传者可见
   - 审批通过的专属技能/智能体：默认全员可见

### 1.3 当前状态分析

**已有功能**：
- `skillStore.ts` - 技能存储管理，支持 hub 安装、本地导入、可见性设置
- `agentStore.ts` - 智能体存储管理，支持 hub 安装、自定义创建、可见性设置
- `visibilityFilter.ts` - 可见性过滤逻辑
- `server.ts` - HTTP API 路由处理
- 前端页面 `skill-store-page.tsx` 和 `agent-hub-page.tsx` 已有基础结构

**需要新增**：
- 自定义技能/智能体上传 API（客户端调用）
- 专属技能/智能体数据表和管理逻辑
- 专属内容发布、审批流程
- 技能/智能体包下载 API
- 前端页面页签改造

---

## 二、数据库设计

### 2.1 专属技能表 (tenant_skills)

```sql
CREATE TABLE tenant_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  version TEXT,
  author_id TEXT NOT NULL,
  author_name TEXT,
  status TEXT DEFAULT 'pending',  -- pending | approved | rejected
  source_url TEXT,
  checksum TEXT,
  file_path TEXT,
  publish_note TEXT,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  enabled INTEGER DEFAULT 1,     -- 启用/禁用状态
  visible_to TEXT,               -- JSON: { department_ids: [...], user_ids: [...] }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tenant_skills_author ON tenant_skills (author_id);
CREATE INDEX idx_tenant_skills_status ON tenant_skills (status);
```

### 2.2 专属智能体表 (tenant_assistants)

```sql
CREATE TABLE tenant_assistants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  version TEXT,
  author_id TEXT NOT NULL,
  author_name TEXT,
  status TEXT DEFAULT 'pending',  -- pending | approved | rejected
  source_url TEXT,
  checksum TEXT,
  file_path TEXT,
  enabled_skills TEXT,           -- JSON array
  memory_mode TEXT DEFAULT 'session',  -- session | user
  publish_note TEXT,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  enabled INTEGER DEFAULT 1,     -- 启用/禁用状态
  visible_to TEXT,               -- JSON: { department_ids: [...], user_ids: [...] }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tenant_assistants_author ON tenant_assistants (author_id);
CREATE INDEX idx_tenant_assistants_status ON tenant_assistants (status);
```

### 2.3 数据库迁移

在 `src/server/db.ts` 的 `DirectConnectStore` 构造函数中添加表创建逻辑。

---

## 三、后端 API 设计

### 3.1 P0 优先级接口

#### 3.1.1 上传自定义技能

**端点**: `POST /api/v1/skills/custom`

**请求头**:
```
Authorization: Bearer <access_token>
Content-Type: multipart/form-data
```

**请求体**:
```
file: <skill-package.zip>
name: "my-custom-skill"
displayName: "My Custom Skill"
description: "技能描述"
version: "1.0.0"
```

**响应**:
```json
{
  "id": "custom-skill-001",
  "name": "my-custom-skill",
  "displayName": "My Custom Skill",
  "version": "1.0.0",
  "status": "active",
  "visibleTo": {
    "user_ids": ["user-001"]
  },
  "createdAt": "2026-05-11T10:00:00Z"
}
```

**可见性规则**：
- 上传成功后，自动设置可见性为当前上传用户（`visible_to: { user_ids: [uploader_id] }`）
- 只有上传者和管理员可以看到此技能

**实现位置**: `src/server/skillStore.ts` 新增 `uploadCustomSkill` 函数

#### 3.1.2 上传自定义助手

**端点**: `POST /api/v1/agents/custom`

**请求头**:
```
Authorization: Bearer <access_token>
Content-Type: multipart/form-data
```

**请求体**:
```
file: <assistant-package.zip>
name: "my-custom-assistant"
displayName: "My Custom Assistant"
description: "助手描述"
version: "1.0.0"
enabledSkills: ["skill-a", "skill-b"]  // JSON string
memoryMode: "session"
```

**响应**:
```json
{
  "id": "custom-agent-001",
  "name": "my-custom-assistant",
  "displayName": "My Custom Assistant",
  "version": "1.0.0",
  "status": "active",
  "visibleTo": {
    "user_ids": ["user-001"]
  },
  "createdAt": "2026-05-11T10:00:00Z"
}
```

**可见性规则**：
- 上传成功后，自动设置可见性为当前上传用户（`visible_to: { user_ids: [uploader_id] }`）
- 只有上传者和管理员可以看到此助手

**实现位置**: `src/server/agentStore.ts` 新增 `uploadCustomAssistant` 函数

#### 3.1.3 获取专属技能列表

**端点**: `GET /api/v1/skills/tenant`

**请求头**:
```
Authorization: Bearer <access_token>
```

**查询参数**:
- `status` (可选): 筛选状态，可选值 `pending` | `approved` | `rejected`，不传则返回全部

**响应**:
```json
[
  {
    "id": "tenant-skill-001",
    "name": "company-code-review",
    "displayName": "公司代码审查",
    "description": "公司内部代码审查技能",
    "version": "1.0.0",
    "status": "approved",
    "author": "user-001",
    "authorName": "张三",
    "approvedAt": "2026-05-11T12:00:00Z",
    "sourceUrl": "https://moss-server/api/v1/skills/tenant/tenant-skill-001/download",
    "checksum": "sha256:abc123...",
    "enabled": true,
    "visibleTo": null,
    "installed": true
  },
  {
    "id": "tenant-skill-002",
    "name": "internal-doc-gen",
    "displayName": "内部文档生成",
    "status": "pending",
    "author": "user-002",
    "authorName": "李四",
    "submittedAt": "2026-05-11T11:00:00Z",
    "publishNote": "这是一个用于文档生成的专属技能"
  }
]
```

**实现位置**: `src/server/tenantStore.ts` 新增 `getTenantSkills` 函数

#### 3.1.4 获取专属助手列表

**端点**: `GET /api/v1/agents/tenant`

**响应结构同上**

**实现位置**: `src/server/tenantStore.ts` 新增 `getTenantAssistants` 函数

#### 3.1.5 下载已安装技能包

**端点**: `GET /api/v1/skills/installed/{id}/download`

**请求头**:
```
Authorization: Bearer <access_token>
```

**响应**:
- Content-Type: `application/zip`
- Content-Disposition: `attachment; filename="{name}.zip"`
- 二进制 zip 文件流

**实现位置**: `src/server/server.ts` 新增路由处理

#### 3.1.6 下载已安装助手包

**端点**: `GET /api/v1/agents/installed/{id}/download`

**响应同上**

**实现位置**: `src/server/server.ts` 新增路由处理

### 3.2 P1 优先级接口

#### 3.2.1 发布专属技能申请

**端点**: `POST /api/v1/skills/tenant/publish`

**请求体**:
```json
{
  "skillId": "custom-skill-001",
  "publishNote": "这是一个用于代码审查的专属技能"
}
```

**响应**:
```json
{
  "id": "publish-request-001",
  "skillId": "custom-skill-001",
  "skillName": "公司代码审查",
  "status": "pending",
  "submittedAt": "2026-05-11T10:00:00Z",
  "message": "发布申请已提交，等待管理员审批"
}
```

#### 3.2.2 发布专属助手申请

**端点**: `POST /api/v1/agents/tenant/publish`

**结构同上**

#### 3.2.3 下载专属技能包

**端点**: `GET /api/v1/skills/tenant/{id}/download`

#### 3.2.4 下载专属助手包

**端点**: `GET /api/v1/agents/tenant/{id}/download`

### 3.3 P2 优先级接口（审批功能）

#### 3.3.1 管理员审批技能

**端点**: `POST /api/v1/admin/skills/tenant/{id}/approve`

**请求体**:
```json
{
  "approved": true,
  "reviewNote": "审批通过，符合企业规范"
}
```

**响应**:
```json
{
  "id": "tenant-skill-001",
  "name": "company-code-review",
  "status": "approved",
  "approvedAt": "2026-05-11T12:00:00Z",
  "approvedBy": "admin-001"
}
```

**审批通过后的处理流程**：
1. 更新数据库记录状态为 `approved`
2. 将 custom 目录下的技能文件复制到 tenant 目录
3. 设置可见性为全员可见（`visible_to: null`）- 所有企业用户都可以看到和使用
4. 生成 sourceUrl 和 checksum

#### 3.3.2 管理员审批助手

**端点**: `POST /api/v1/admin/agents/tenant/{id}/approve`

**处理流程同上**

### 3.4 专属内容管理接口

#### 3.4.1 更新专属技能元数据

**端点**: `PATCH /api/v1/skills/tenant/{id}`

**请求体**:
```json
{
  "enabled": true,
  "visibleTo": {
    "department_ids": ["dept-001"],
    "user_ids": null
  }
}
```

#### 3.4.2 更新专属助手元数据

**端点**: `PATCH /api/v1/agents/tenant/{id}`

**请求体**:
```json
{
  "enabled": true,
  "visibleTo": {
    "department_ids": null,
    "user_ids": null
  },
  "enabledSkills": ["skill-a", "skill-b"]
}
```

#### 3.4.3 删除专属技能

**端点**: `DELETE /api/v1/skills/tenant/{id}`

#### 3.4.4 删除专属助手

**端点**: `DELETE /api/v1/agents/tenant/{id}`

---

## 四、后端实现方案

### 4.1 新增文件

```
src/server/
├── tenantStore.ts          # 专属内容存储管理
└── api/
    └── tenant.ts           # 专属内容 API 路由
```

### 4.2 修改文件

#### 4.2.1 `src/server/db.ts`

添加 `tenant_skills` 和 `tenant_assistants` 表的创建和迁移逻辑。

```typescript
// 在构造函数中添加
this.db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    description TEXT,
    version TEXT,
    author_id TEXT NOT NULL,
    author_name TEXT,
    status TEXT DEFAULT 'pending',
    source_url TEXT,
    checksum TEXT,
    file_path TEXT,
    publish_note TEXT,
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenant_assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    description TEXT,
    version TEXT,
    author_id TEXT NOT NULL,
    author_name TEXT,
    status TEXT DEFAULT 'pending',
    source_url TEXT,
    checksum TEXT,
    file_path TEXT,
    enabled_skills TEXT,
    memory_mode TEXT DEFAULT 'session',
    publish_note TEXT,
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tenant_skills_author ON tenant_skills (author_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_skills_status ON tenant_skills (status);
  CREATE INDEX IF NOT EXISTS idx_tenant_assistants_author ON tenant_assistants (author_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_assistants_status ON tenant_assistants (status);
`)

// 添加 CRUD 方法
getTenantSkills(status?: string): TenantSkillRecord[]
getTenantSkill(id: string): TenantSkillRecord | null
createTenantSkill(record: TenantSkillInput): TenantSkillRecord
updateTenantSkillStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): void
// 类似的助手方法...
```

#### 4.2.2 `src/server/skillStore.ts`

新增函数：

```typescript
// 上传自定义技能
export async function uploadCustomSkill(params: {
  file: Buffer
  name: string
  displayName: string
  description?: string
  version?: string
  userId: string
}): Promise<{ id: string; name: string; version: string }>

// 打包技能为 zip
export async function packageSkillZip(skillName: string): Promise<Buffer>

// 获取技能下载 URL
export function getSkillDownloadUrl(skillId: string): string
```

#### 4.2.3 `src/server/agentStore.ts`

新增函数：

```typescript
// 上传自定义助手
export async function uploadCustomAssistant(params: {
  file: Buffer
  name: string
  displayName: string
  description?: string
  version?: string
  enabledSkills?: string[]
  memoryMode?: 'session' | 'user'
  userId: string
}): Promise<{ id: string; name: string; version: string }>

// 打包助手为 zip
export async function packageAssistantZip(assistantName: string): Promise<Buffer>

// 获取助手下载 URL
export function getAssistantDownloadUrl(assistantId: string): string
```

#### 4.2.4 `src/server/tenantStore.ts` (新建)

```typescript
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'crypto'
import type { DirectConnectStore } from './db.js'

export type TenantSkillRecord = {
  id: string
  name: string
  display_name: string
  description: string
  version: string
  author_id: string
  author_name: string
  status: 'pending' | 'approved' | 'rejected'
  source_url: string
  checksum: string
  file_path: string
  publish_note: string
  review_note: string
  reviewed_by: string | null
  reviewed_at: number | null
  created_at: number
  updated_at: number
}

export type TenantAssistantRecord = TenantSkillRecord & {
  enabled_skills: string[]
  memory_mode: 'session' | 'user'
}

export class TenantStore {
  constructor(private db: DatabaseSync) {}

  // 技能相关
  listTenantSkills(status?: string): TenantSkillRecord[]
  getTenantSkill(id: string): TenantSkillRecord | null
  getTenantSkillByName(name: string): TenantSkillRecord | null
  createTenantSkill(input: CreateTenantSkillInput): TenantSkillRecord
  updateTenantSkillStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): void
  deleteTenantSkill(id: string): void

  // 助手相关
  listTenantAssistants(status?: string): TenantAssistantRecord[]
  getTenantAssistant(id: string): TenantAssistantRecord | null
  getTenantAssistantByName(name: string): TenantAssistantRecord | null
  createTenantAssistant(input: CreateTenantAssistantInput): TenantAssistantRecord
  updateTenantAssistantStatus(id: string, status: string, reviewedBy: string, reviewNote?: string): void
  deleteTenantAssistant(id: string): void
}
```

#### 4.2.5 `src/server/server.ts`

新增路由处理：

```typescript
// P0 接口
'POST /api/v1/skills/custom'           // 上传自定义技能
'POST /api/v1/agents/custom'           // 上传自定义助手
'GET /api/v1/skills/tenant'            // 获取专属技能列表
'GET /api/v1/agents/tenant'            // 获取专属助手列表
'GET /api/v1/skills/installed/:id/download'  // 下载已安装技能
'GET /api/v1/agents/installed/:id/download'  // 下载已安装助手

// P1 接口
'POST /api/v1/skills/tenant/publish'   // 发布专属技能申请
'POST /api/v1/agents/tenant/publish'   // 发布专属助手申请
'GET /api/v1/skills/tenant/:id/download'     // 下载专属技能
'GET /api/v1/agents/tenant/:id/download'     // 下载专属助手

// P2 接口
'POST /api/v1/admin/skills/tenant/:id/approve'   // 审批技能
'POST /api/v1/admin/agents/tenant/:id/approve'   // 审批助手
```

---

## 五、前端实现方案

### 5.1 页签改造

#### 5.1.1 技能管理页面 (`skill-store-page.tsx`)

**当前页签**: 技能库 | 专属技能 | 我的技能

**改造为**: 技能库 | 专属技能 | 自定义技能

| 页签 | 数据来源 | 展示内容 | 功能操作 |
|------|----------|----------|----------|
| 技能库 | Hub API | Hub 上的所有技能 | 未安装：安装；已安装：启用/禁用、可见性设置、编辑、删除 |
| 专属技能 | `/api/v1/skills/tenant` + 本地 tenant 目录 | 审批通过的专属技能 + 待审批的申请 | 待审批：审批通过/拒绝；已通过：启用/禁用、可见性设置、编辑、删除 |
| 自定义技能 | 本地 custom 目录 | 用户上传的自定义技能 | 启用/禁用、可见性设置、编辑、删除 |

#### 5.1.2 智能体管理页面 (`agent-hub-page.tsx`)

**当前页签**: 智能体库 | 已安装

**改造为**: 智能体库 | 专属智能体 | 自定义智能体

| 页签 | 数据来源 | 展示内容 | 功能操作 |
|------|----------|----------|----------|
| 智能体库 | Hub API | Hub 上的所有智能体 | 未安装：安装；已安装：启用/禁用、可见性设置、编辑、删除 |
| 专属智能体 | `/api/v1/agents/tenant` + 本地 tenant 目录 | 审批通过的专属智能体 + 待审批的申请 | 待审批：审批通过/拒绝；已通过：启用/禁用、可见性设置、编辑、删除 |
| 自定义智能体 | 本地 custom 目录 | 用户上传的自定义智能体 | 启用/禁用、可见性设置、编辑、删除 |

### 5.2 页签详细设计

#### 5.2.1 技能库/智能体库页签

**展示内容**：
- 从 Hub 获取的技能/智能体列表
- 已安装的显示安装状态、版本信息、可见性状态

**已安装项的操作按钮**：
- **启用/禁用开关**：控制是否在会话中可用
- **可见性设置**：设置哪些部门/用户可见
- **编辑**：修改显示名称、描述等信息
- **删除**：卸载技能/智能体

**未安装项的操作按钮**：
- **安装**：从 Hub 下载并安装

**注意**：移除"未配置专属技能租户 ID"的提示，专属技能/智能体通过发布审批流程产生，不依赖租户 ID 配置。

#### 5.2.2 专属技能/智能体页签

**展示内容**：
- **待审批列表**：status = 'pending' 的申请记录
- **已通过列表**：status = 'approved' 且已安装到 tenant 目录的技能/智能体
- **已拒绝列表**：status = 'rejected' 的申请记录（可选展示）

**可见性规则**：
- 审批通过后的专属技能/智能体，默认可见性为全员可见（`visible_to: null`）
- 所有企业用户都可以看到和使用

**待审批项的操作按钮**：
- **审批通过**：将文件复制到 tenant 目录，更新状态为 approved，设置可见性为全员可见
- **审批拒绝**：更新状态为 rejected，填写拒绝原因

**已通过项的操作按钮**：
- **启用/禁用开关**：控制是否在会话中可用
- **可见性设置**：设置哪些部门/用户可见（默认全员可见）
- **编辑**：修改显示名称、描述等信息
- **删除**：从 tenant 目录卸载

#### 5.2.3 自定义技能/智能体页签

**展示内容**：
- 本地 custom 目录下的技能/智能体列表
- 包括：
  1. 用户通过 SudoWork 客户端上传的技能/智能体
  2. 用户通过 Moss Server 前端创建的自定义智能体（调用 `createCustomAssistant` API）
- 显示上传时间、版本信息、可见性状态

**可见性规则**：
- 用户上传/创建的技能/智能体，默认可见性设置为当前上传用户（`visible_to: { user_ids: [uploader_id] }`）
- 只有上传者和管理员可以看到

**操作按钮**：
- **启用/禁用开关**：控制是否在会话中可用
- **可见性设置**：设置哪些部门/用户可见
- **编辑**：修改显示名称、描述、关联技能等信息
- **删除**：从 custom 目录删除

**注意**：发布申请由 SudoWork 客户端调用 API，不在 Moss Server 前端操作

### 5.3 新增 API 调用函数

#### 5.3.1 `admin/lib/api/skill-store.ts`

```typescript
// 获取专属技能列表（包含待审批和已通过）
export async function getTenantSkills(): Promise<TenantSkillInfo[]>

// 审批专属技能
export async function approveTenantSkill(params: {
  id: string
  approved: boolean
  reviewNote?: string
}): Promise<{ id: string; status: string }>

// 更新专属技能元数据（启用/禁用、可见性等）
export async function updateTenantSkillMeta(params: {
  id: string
  enabled?: boolean
  visibleTo?: VisibleTo
}): Promise<void>

// 删除专属技能
export async function deleteTenantSkill(id: string): Promise<void>

// 下载技能包
export async function downloadSkill(skillId: string, type: 'installed' | 'tenant'): Promise<Blob>
```

#### 5.3.2 `admin/lib/api/agent-hub.ts`

```typescript
// 获取专属助手列表（包含待审批和已通过）
export async function getTenantAssistants(): Promise<TenantAssistantInfo[]>

// 审批专属助手
export async function approveTenantAssistant(params: {
  id: string
  approved: boolean
  reviewNote?: string
}): Promise<{ id: string; status: string }>

// 更新专属助手元数据（启用/禁用、可见性等）
export async function updateTenantAssistantMeta(params: {
  id: string
  enabled?: boolean
  visibleTo?: VisibleTo
  enabledSkills?: string[]
}): Promise<void>

// 删除专属助手
export async function deleteTenantAssistant(id: string): Promise<void>

// 下载助手包
export async function downloadAssistant(assistantId: string, type: 'installed' | 'tenant'): Promise<Blob>
```

### 5.4 UI 组件

#### 5.4.1 技能库卡片（已安装）

```tsx
type InstalledSkillCardProps = {
  skill: InstalledSkillInfo
  onToggleEnabled: (skill: InstalledSkillInfo, enabled: boolean) => void
  onEditVisibility: (skill: InstalledSkillInfo) => void
  onEdit: (skill: InstalledSkillInfo) => void
  onDelete: (skill: InstalledSkillInfo) => void
}
```

#### 5.4.2 专属技能卡片

```tsx
type TenantSkillCardProps = {
  skill: TenantSkillInfo
  // 待审批状态
  onApprove: (skill: TenantSkillInfo, approved: boolean, reviewNote?: string) => void
  // 已通过状态
  onToggleEnabled?: (skill: TenantSkillInfo, enabled: boolean) => void
  onEditVisibility?: (skill: TenantSkillInfo) => void
  onEdit?: (skill: TenantSkillInfo) => void
  onDelete?: (skill: TenantSkillInfo) => void
}
```

#### 5.4.3 审批对话框

```tsx
type ApprovalDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: TenantSkillInfo | TenantAssistantInfo
  type: 'skill' | 'assistant'
  onApprove: (approved: boolean, reviewNote?: string) => void
}
```

#### 5.4.4 可见性编辑对话框

```tsx
type VisibilityDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemName: string
  itemType: 'skill' | 'assistant'
  currentVisibility: VisibleTo
  onSave: (visibility: VisibleTo) => void
}
```

---

## 六、目录结构

### 6.1 服务器端目录

```
~/.moss/
├── skills/
│   ├── hub/           # 从 Hub 安装的技能
│   ├── custom/        # 用户上传的自定义技能
│   ├── tenant/        # 企业专属技能（审批通过后）
│   └── system/        # 系统内置技能
└── assistants/
    ├── hub/           # 从 Hub 安装的智能体
    ├── custom/        # 用户上传的自定义智能体
    ├── tenant/        # 企业专属智能体（审批通过后）
    └── system/        # 系统内置智能体
```

### 6.2 元数据文件格式

`_moss_meta.json`:

```json
{
  "id": "skill-001",
  "name": "my-skill",
  "display_name": "My Skill",
  "description": "技能描述",
  "version": "1.0.0",
  "source_type": "hub | custom | tenant | system",
  "source_url": "https://...",
  "checksum": "sha256:abc123...",
  "installed_at": "2026-05-11T10:00:00Z",
  "visible_to": {
    "department_ids": ["dept-001"],
    "user_ids": ["user-001"]
  }
}
```

---

## 七、实现优先级与里程碑

### 7.1 Milestone 1: P0 核心功能（预计 2-3 天）

**后端任务**:
- [ ] 数据库表创建（tenant_skills, tenant_assistants）
- [ ] `POST /api/v1/skills/custom` 上传自定义技能
- [ ] `POST /api/v1/agents/custom` 上传自定义助手
- [ ] `GET /api/v1/skills/tenant` 获取专属技能列表（含待审批和已通过）
- [ ] `GET /api/v1/agents/tenant` 获取专属助手列表（含待审批和已通过）
- [ ] `GET /api/v1/skills/installed/{id}/download` 下载已安装技能
- [ ] `GET /api/v1/agents/installed/{id}/download` 下载已安装助手

**前端任务**:
- [ ] 技能管理页面页签改造（技能库 | 专属技能 | 自定义技能）
- [ ] 智能体管理页面页签改造（智能体库 | 专属智能体 | 自定义智能体）
- [ ] 技能库页签：已安装项的启用/禁用、可见性设置、编辑、删除功能
- [ ] 智能体库页签：已安装项的启用/禁用、可见性设置、编辑、删除功能
- [ ] 专属技能/智能体页签：列表展示（待审批 + 已通过）
- [ ] 自定义技能/智能体页签：列表展示及管理功能

### 7.2 Milestone 2: P1 发布功能（预计 1-2 天）

**后端任务**:
- [ ] `POST /api/v1/skills/tenant/publish` 发布专属技能申请（SudoWork 客户端调用）
- [ ] `POST /api/v1/agents/tenant/publish` 发布专属助手申请（SudoWork 客户端调用）
- [ ] `GET /api/v1/skills/tenant/{id}/download` 下载专属技能
- [ ] `GET /api/v1/agents/tenant/{id}/download` 下载专属助手

**前端任务**:
- [ ] 发布状态展示（在专属页签显示 pending 状态的申请）
- [ ] 专属内容安装功能（下载并安装到本地 tenant 目录）

### 7.3 Milestone 3: P2 审批功能（预计 1 天）

**后端任务**:
- [ ] `POST /api/v1/admin/skills/tenant/{id}/approve` 审批技能（含文件复制到 tenant 目录）
- [ ] `POST /api/v1/admin/agents/tenant/{id}/approve` 审批助手（含文件复制到 tenant 目录）
- [ ] `PATCH /api/v1/skills/tenant/{id}` 更新专属技能元数据
- [ ] `PATCH /api/v1/agents/tenant/{id}` 更新专属助手元数据
- [ ] `DELETE /api/v1/skills/tenant/{id}` 删除专属技能
- [ ] `DELETE /api/v1/agents/tenant/{id}` 删除专属助手

**前端任务**:
- [ ] 审批对话框组件
- [ ] 专属页签的审批操作按钮（待审批项显示审批通过/拒绝按钮）
- [ ] 已通过项的启用/禁用、可见性设置、编辑、删除功能

---

## 八、可见性过滤逻辑

### 8.1 可见性数据结构

```typescript
type VisibleTo = {
  department_ids: string[] | null  // 部门白名单
  user_ids: string[] | null        // 用户白名单
} | null                           // null 表示全员可见
```

### 8.2 过滤规则

当前 `visibilityFilter.ts` 已实现完整的可见性过滤逻辑：

1. **管理员**：始终可见所有内容
2. **`visible_to: null`**：全员可见
3. **`user_ids: [...]`**：仅指定用户可见
   - 空数组 `[]` 表示仅管理员可见
4. **`department_ids: [...]`**：仅指定部门（含子部门）的用户可见
   - 空数组 `[]` 表示仅管理员可见
5. **同时设置 `user_ids` 和 `department_ids`**：用户白名单 OR 部门白名单（满足其一即可）

### 8.3 已安装技能/智能体接口的可见性过滤

**当前实现**：`server.ts` 中获取已安装技能/智能体列表时，已通过 `isVisibleTo` 函数进行过滤

**需要确认的逻辑**：
- `GET /api/v1/skills/installed` - 返回当前用户可见的已安装技能
- `GET /api/v1/agents/installed` - 返回当前用户可见的已安装智能体

### 8.4 专属技能/智能体接口的可见性过滤

**专属列表接口**：
- `GET /api/v1/skills/tenant` - 返回所有待审批和已通过的专属技能（管理员可见全部，普通用户仅见已通过且可见的）
- `GET /api/v1/agents/tenant` - 同上

**过滤规则**：
- 待审批记录（status = 'pending'）：仅管理员可见
- 已通过记录（status = 'approved'）：根据 `visible_to` 字段过滤

### 8.5 可见性设置场景汇总

| 场景 | 默认可见性 | 说明 |
|------|-----------|------|
| 用户上传自定义技能 | `{ user_ids: [uploader_id] }` | 仅上传者和管理员可见 |
| 用户上传自定义智能体 | `{ user_ids: [uploader_id] }` | 仅上传者和管理员可见 |
| 用户通过前端创建自定义智能体 | `{ user_ids: [creator_id] }` | 仅创建者和管理员可见 |
| 审批通过的专属技能 | `null` | 全员可见 |
| 审批通过的专属智能体 | `null` | 全员可见 |
| 从 Hub 安装的技能/智能体 | 继承 Hub 设置或管理员设置 | 可通过前端修改 |

### 8.6 前端可见性设置选项

在可见性编辑对话框中，提供以下选项：

1. **全员可见**：`visible_to: null`
2. **指定部门可见**：`visible_to: { department_ids: [...], user_ids: null }`
3. **指定人员可见**：`visible_to: { department_ids: null, user_ids: [...] }`
4. **仅管理员可见**：`visible_to: { department_ids: [], user_ids: [] }`

---

## 九、风险与注意事项

### 9.1 安全风险

| 风险 | 应对措施 |
|------|---------|
| 恶意文件上传 | 限制文件大小、校验文件类型、扫描恶意代码 |
| 敏感信息泄露 | 下载接口需要认证、权限校验 |
| 路径遍历攻击 | 校验文件路径、限制解压目录 |

### 9.2 兼容性

| 场景 | 处理方式 |
|------|---------|
| 现有数据迁移 | 新增表不影响现有功能，平滑迁移 |
| 版本升级 | 元数据文件版本控制，兼容旧版本 |

### 9.3 性能考虑

| 场景 | 优化方案 |
|------|---------|
| 大文件上传/下载 | 支持流式传输、限制并发数 |
| 列表数据量大 | 分页查询、增量同步 |

---

## 十、测试计划

### 9.1 单元测试

- `tenantStore.ts` 的 CRUD 操作测试
- 文件上传/下载测试
- 权限校验测试

### 9.2 集成测试

- API 端点测试
- 前后端联调测试
- 发布审批流程测试

### 9.3 E2E 测试

- 用户上传自定义技能/助手流程
- 管理员审批流程
- 下载安装流程
