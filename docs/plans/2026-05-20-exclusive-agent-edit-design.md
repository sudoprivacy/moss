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

**当前行为**: 点击"创建专属智能体"按钮打开创建对话框，创建后状态为 `pending`，需要审批

**新行为**:
- 点击"创建专属智能体"按钮打开创建对话框
- 填写信息后提交
- 后端直接设置 `status = 'approved'` 且 `enabled = 1`
- 无需审批流程

### 4. UI 变更

**专属智能体卡片**:
- 移除"审批"按钮（因为创建后直接启用）
- 保留可见性编辑按钮
- 保留启用/禁用开关
- 保留删除按钮
- 点击卡片打开编辑对话框

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

1. `POST /api/tenant-assistants` - 创建专属智能体
   - 直接设置 `status: 'approved'` 和 `enabled: 1`
   - 支持所有编辑对话框字段

2. `PUT /api/tenant-assistants/:id` - 更新专属智能体完整信息
   - 支持所有编辑对话框字段

## 实现计划

### Phase 1: 前端编辑对话框适配

1. 创建 `openTenantEdit` 函数，复用编辑对话框结构
2. 添加 TenantAssistantInfo 编辑状态变量
3. 修改专属智能体卡片点击行为

### Phase 2: 创建流程修改

1. 修改创建对话框提交逻辑
2. 调用新的创建 API，直接创建为已启用状态

### Phase 3: 后端 API 扩展

1. 扩展 `createTenantAssistant` API 支持完整字段并直接启用
2. 扩展 `updateTenantAssistantMeta` API 支持所有编辑字段

### Phase 4: UI 清理

1. 移除审批相关 UI（审批按钮、审批对话框）
2. 简化专属智能体卡片操作按钮

## 文件改动

### 前端

- `admin/src/pages/agent-hub-page.tsx` - 主要改动文件
- `admin/src/lib/api/agent-hub.ts` - API 扩展

### 后端

- 需要确认后端 API 文件位置并扩展