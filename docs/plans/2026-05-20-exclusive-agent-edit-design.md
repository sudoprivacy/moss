# 专属智能体编辑与创建功能设计

## 概述

将专属智能体的编辑体验与自定义智能体统一，点击卡片可编辑所有字段，创建专属智能体后直接启用无需审批。

## 需求

1. **专属智能体点击编辑**: 完全复用自定义智能体的编辑对话框（名称、描述、头像、技能、可见性、工作模式等）
2. **创建按钮**: "创建专属智能体"按钮直接创建专属智能体
3. **审批流程**: 跳过审批，创建后直接启用

## 设计详情

### 1. 专属智能体卡片点击行为

**当前行为**: 点击卡片打开详情视图 (`tenantAssistantDetail`)

**新行为**: 点击卡片打开编辑对话框，与自定义智能体一致

**实现方式**:
- 移除 `setTenantAssistantDetail` 点击逻辑
- 改为调用新的 `openTenantEdit(assistant: TenantAssistantInfo)` 函数
- 复用现有编辑对话框结构，适配 TenantAssistantInfo 数据结构

### 2. 编辑对话框内容

**字段** (与自定义智能体完全一致):
- 显示名称 (`display_name`)
- 头像地址 (`avatar`)
- Emoji (`emoji`)
- 描述 (`description`)
- 工作模式 (`agent_type`: chat/workflow)
- 记忆模式 (`memory_mode`: session/user)
- 可见性设置 (`visible_to`: 全员可见/指定部门/指定用户/仅管理员)
- 关联技能 (`skills`, `enabled_skills`)
- 文档中心 Wiki 配置 (`enabled_wikis`)
- 工作流配置 (`workflow`: trigger/cron/webhook/timeout/output_targets)

### 3. 创建专属智能体流程

**两种创建方式：**

1. **Admin 页面创建** - "创建专属智能体"按钮
   - 点击按钮打开创建对话框
   - 填写信息后提交
   - 后端直接设置 `status = 'approved'` 且 `enabled = 1`
   - **无需审批，直接启用**

2. **用户通过 API 发布** - `/api/v1/agents/tenant/publish`
   - 保持现有流程
   - 创建后状态为 `pending`
   - **需要管理员审批**

**审批流程保留：**
- 审批按钮和审批对话框保留
- 用于处理用户通过 API 发布的专属智能体

### 4. UI 变更

**专属智能体卡片**:
- 点击卡片打开编辑对话框
- 保留"审批"按钮（用于处理 API 发布的智能体）
- 保留可见性编辑按钮
- 保留启用/禁用开关
- 保留删除按钮

**创建对话框**:
- 标题保持"创建专属智能体"
- 表单字段与编辑对话框一致
- 提交后直接创建为已启用的专属智能体

### 5. 数据结构适配

TenantAssistantInfo 需要支持以下字段：

```typescript
interface TenantAssistantInfo {
  id: string
  name: string
  display_name: string
  description: string
  avatar?: string
  emoji?: string
  agent_type: 'chat' | 'workflow'
  memory_mode?: 'session' | 'user'
  skills: string[]
  enabled_skills?: string[]
  enabled_wikis?: string[]
  visible_to?: {
    department_ids?: string[] | null
    user_ids?: string[] | null
  }
  workflow?: {
    trigger?: 'cron' | 'webhook' | 'manual'
    cron?: string
    webhook_path?: string
    output_webhook?: string
    timeout_minutes?: number
    output_targets?: string[]
  }
  status: 'pending' | 'approved' | 'rejected'
  enabled: number
  author_id: string
  author_name?: string
  created_at: string
  updated_at?: string
}
```

### 6. 后端 API 变更

**新增/修改 API**:

1. `POST /api/v1/agents/tenant/create` - Admin 页面创建专属智能体
   - 直接设置 `status: 'approved'` 和 `enabled: 1`
   - 支持所有编辑对话框字段
   - 创建智能体文件到 tenant 目录

2. 扩展 `PATCH /api/v1/agents/tenant/:id` - 更新专属智能体完整信息
   - 新增支持字段：`display_name`, `description`, `avatar`, `emoji`, `agent_type`, `memory_mode`, `workflow`, `skills`
   - 同步更新文件元数据

**保留现有 API**:
- `POST /api/v1/agents/tenant/publish` - 用户发布智能体，仍需审批

## 实现计划

### Phase 1: 前端编辑对话框适配

1. 创建 `openTenantEdit` 函数，复用编辑对话框结构
2. 添加 TenantAssistantInfo 编辑状态变量
3. 修改专属智能体卡片点击行为（打开编辑对话框）

### Phase 2: 创建流程修改

1. 新增 `createTenantAssistant` API 调用
2. 修改创建对话框提交逻辑，调用新 API
3. 新 API 创建后直接设为 approved + enabled

### Phase 3: 后端 API 扩展

1. 新增 `POST /api/v1/agents/tenant/create` 端点
2. 扩展 `updateTenantAssistantMeta` 支持所有编辑字段
3. 扩展数据库 `updateTenantAssistantMeta` 支持新字段

### Phase 4: 文件元数据同步

1. 编辑保存时同步更新 tenant 目录下的 `_moss_meta.json`
2. 创建时生成智能体文件到 tenant 目录

## 文件改动

### 前端

- `admin/src/pages/agent-hub-page.tsx` - 主要改动文件
- `admin/src/lib/api/agent-hub.ts` - API 扩展

### 后端

- 需要确认后端 API 文件位置并扩展