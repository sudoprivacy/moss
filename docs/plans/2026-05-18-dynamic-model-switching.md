# 动态切换会话模型实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现用户在 sudowork 客户端企业模式下远程连接 moss 对话时动态切换可用模型的功能。

**Architecture:** Moss Server 在会话启动时预置所有可用模型到 sudocode.json,模型列表使用 24 小时缓存。切换模型时直接通过 ACP 协议通知 scode,无需修改文件。

**Tech Stack:** Node.js (Moss Server), TypeScript, WebSocket, ACP Protocol, Electron IPC (sudowork)

---

## 实现状态总览

| Phase | 描述 | 状态 |
|-------|------|------|
| Phase 1 | Moss Server API 实现 | ✅ 完成 |
| Phase 2 | 会话启动预置所有模型 | ✅ 完成 |
| Phase 3 | WebSocket 模型切换 | ✅ 完成 |
| Phase 4 | 会话创建应用用户偏好 | ✅ 完成 |
| Phase 5 | sudowork 客户端实现 | ✅ 完成 |
| Phase 6 | 测试验证 | ✅ 完成 |

---

## Phase 1: Moss Server API 实现 ✅

### Task 1.1: 创建用户模型偏好存储模块 ✅

**Files:**
- Created: `src/server/userModelPreference.ts`

**实现内容:**
- 内存存储用户模型偏好 (Map<userId, {modelId, updatedAt}>)
- `getUserModelPreference(userId)` - 获取用户偏好
- `setUserModelPreference(userId, modelId)` - 设置用户偏好
- `deleteUserModelPreference(userId)` - 删除用户偏好

---

### Task 1.2: 创建模型列表缓存模块 ✅

**Files:**
- Created: `src/server/modelListCache.ts`

**实现内容:**
- 24 小时缓存机制
- 从 sudorouter API (`https://hk.sudorouter.ai/api/specific_pricing`) 获取模型列表
- `fetchAvailableModels()` - 获取模型列表 (优先使用缓存)
- `getModelListCache()` - 获取当前缓存
- `clearModelListCache()` - 清除缓存

---

### Task 1.3: 添加获取可用模型列表 API ✅

**Files:**
- Modified: `src/server/server.ts`

**实现内容:**
- `GET /api/v1/models/available` - 返回可用模型列表

---

### Task 1.4: 添加用户模型偏好 API ✅

**Files:**
- Modified: `src/server/server.ts`

**实现内容:**
- `GET /api/v1/users/:userId/model` - 获取用户模型偏好
- `PUT /api/v1/users/:userId/model` - 设置用户模型偏好

---

## Phase 2: 会话启动预置所有模型 ✅

### Task 2.1: 创建模型配置生成函数 ✅

**Files:**
- Modified: `src/server/backends/backendUtils.ts`

**实现内容:**
- `buildAllModelsConfig()` - 从缓存获取所有可用模型并生成 sudocode.json 的 models 配置
- 每个模型配置为 `proxy/{modelId}` 格式

---

### Task 2.2: 修改 scodeBackend.ts ✅

**Files:**
- Modified: `src/server/backends/scodeBackend.ts`

**实现内容:**
- 在生成 sudocode.json 时调用 `buildAllModelsConfig()` 预置所有模型
- 日志输出预置模型数量

---

### Task 2.3: 修改 dockerBackend.ts ✅

**Files:**
- Modified: `src/server/backends/dockerBackend.ts`

**实现内容:**
- 在生成 sudocode.json 时调用 `buildAllModelsConfig()` 预置所有模型
- 日志输出预置模型数量

---

## Phase 3: WebSocket 模型切换 ✅

### Task 3.1: 扩展 acpBridge 处理 control_request ✅

**Files:**
- Modified: `src/server/backends/acpBridge.ts`

**实现内容:**
- 添加 `pendingRpcRequests` Map 用于跟踪等待响应的 RPC 请求
- 添加 `sendRpcAndWait()` 方法用于异步 RPC 调用 (带超时)
- 处理 `control_request` 消息 (subtype: 'set_model')
- 构建 scode 模型名称 (添加 `proxy/` 前缀)
- 使用 `session/set_model` (下划线) 方法名
- 使用 `sessionId`/`modelId` (驼峰) 参数名
- 等待 scode 响应后发送 `model_changed` 事件

**关键修复:**
- RPC 方法名必须是 `session/set_model` (下划线), 不是 `session/setModel` (驼峰)
- RPC 参数名必须是 `sessionId`/`modelId` (驼峰), 不是 `session_id`/`model_id` (下划线)

---

### Task 3.2: 处理 SetSessionModelResponse ✅

**Files:**
- Modified: `src/server/backends/acpBridge.ts`

**实现内容:**
- 处理 `m-set-model` 响应
- 成功时发送 `model_changed` 事件通知前端
- 失败时发送 error 事件

---

## Phase 4: 会话创建应用用户偏好 ✅

### Task 4.1: 修改 buildSessionEnv 函数 ✅

**Files:**
- Modified: `src/server/backends/backendUtils.ts`

**实现内容:**
- 在会话创建时获取用户模型偏好
- 模型优先级: 用户偏好 > 系统设置 > 默认值

---

## Phase 5: sudowork 客户端实现 ✅

### Task 5.1: 扩展 IPC Bridge 类型定义 ✅

**Files:**
- Modified: `src/common/ipcBridge.ts` (sudowork 项目)

**实现内容:**
- `moss.getAvailableModels` - 获取可用模型列表
- `moss.getUserModel` - 获取用户模型偏好
- `moss.setUserModel` - 设置用户模型偏好

---

### Task 5.2: 实现 mossBridge IPC 处理 ✅

**Files:**
- Modified: `src/process/bridge/mossBridge.ts` (sudowork 项目)

**实现内容:**
- 实现 `getAvailableModels` - 调用 Moss Server API
- 实现 `getUserModel` - 调用 Moss Server API
- 实现 `setUserModel` - 调用 Moss Server API

---

### Task 5.3: 扩展 MossWsConnection 消息处理 ✅

**Files:**
- Modified: `src/agent/remote/MossWsConnection.ts` (sudowork 项目)

**实现内容:**
- 添加 `pendingModelSwitches` Map 跟踪模型切换请求
- 添加 `MODEL_SWITCH_TIMEOUT_MS = 30000` 超时设置
- `setModel()` 方法发送 WebSocket 消息
- 处理 `model_changed` 事件并发送 `acp_model_info` 消息

---

### Task 5.4: 扩展 RemoteAgent ✅

**Files:**
- Modified: `src/process/task/RemoteAgent.ts` (sudowork 项目)

**实现内容:**
- `setModel()` 方法委托给 `MossWsConnection.setModel()`

---

### Task 5.5: 修改 AcpModelSelector 组件 ✅

**Files:**
- Modified: `src/renderer/components/AcpModelSelector.tsx` (sudowork 项目)

**实现内容:**
- 对于 `remote-agent` 后端, 从 Moss API 获取模型列表
- 添加 `pendingModelSwitchRef` 跟踪待确认的模型切换
- 监听 `acp_model_info` 事件处理模型切换确认
- 切换成功后显示成功消息
- 保留 `availableModels` 以保持下拉菜单功能

---

### Task 5.6: 修复 Guid 页面模型选择器重置问题 ✅

**Files:**
- Modified: `src/renderer/pages/guid/hooks/useGuidAgentSelection.ts` (sudowork 项目)

**实现内容:**
- 修复 `resetSelection()` 函数错误清除模型信息的问题
- 保留 `acpCachedModels` - 模型列表不因点击新会话而改变
- 保留 `selectedAcpModel` - 用户模型偏好应被保留

---

## Phase 6: 测试验证 ✅

### 已验证功能

1. **模型列表缓存** - 24 小时缓存正常工作
2. **会话启动预置模型** - sudocode.json 包含所有可用模型
3. **模型切换** - 通过 ACP 协议成功切换模型
4. **前端显示** - 模型选择器正确显示模型列表和当前模型
5. **新会话保留模型** - 点击新会话后模型选择器继续显示模型列表

---

## 关键技术发现

### ACP 协议注意事项

1. **RPC 方法名**: 必须使用 `session/set_model` (下划线), 不是 `session/setModel` (驼峰)
2. **RPC 参数名**: 必须使用 `sessionId`/`modelId` (驼峰), 不是 `session_id`/`model_id` (下划线)
3. **模型名称格式**: 需要 `proxy/` 前缀, 如 `proxy/gemini-3-flash-preview`

### 消息流

```
用户选择模型
    ↓
AcpModelSelector.setModel()
    ↓
ipcBridge.moss.setUserModel (保存偏好)
    ↓
ipcBridge.acpConversation.setModel (切换当前会话)
    ↓
RemoteAgent.setModel()
    ↓
MossWsConnection.setModel() → WebSocket
    ↓
Moss Server → SessionRunnerDaemon
    ↓
acpBridge.handleStdin() → sendRpcAndWait('session/set_model')
    ↓
scode 处理并响应
    ↓
acpBridge 发送 model_changed 事件
    ↓
MossWsConnection 发送 acp_model_info
    ↓
AcpModelSelector 收到并更新 UI, 显示成功消息
```

---

## 文件变更清单

### Moss Server (本项目)

| 文件 | 操作 | 描述 |
|------|------|------|
| `src/server/userModelPreference.ts` | 新建 | 用户模型偏好存储 |
| `src/server/modelListCache.ts` | 新建 | 模型列表缓存 |
| `src/server/server.ts` | 修改 | 添加模型相关 API |
| `src/server/backends/backendUtils.ts` | 修改 | 添加模型配置生成函数 |
| `src/server/backends/scodeBackend.ts` | 修改 | 预置所有模型 |
| `src/server/backends/dockerBackend.ts` | 修改 | 预置所有模型 |
| `src/server/backends/acpBridge.ts` | 修改 | 处理模型切换请求 |
| `src/server/runtimeService.ts` | 修改 | 传递用户偏好 |
| `src/server/sessionRunnerDaemon.ts` | 修改 | 添加日志 |

### sudowork 客户端

**模型切换相关文件 (8 个):**

| 文件 | 操作 | 描述 |
|------|------|------|
| `src/common/ipcBridge.ts` | 修改 | 添加模型相关 IPC 定义 |
| `src/process/bridge/mossBridge.ts` | 修改 | 实现模型相关 IPC 处理 |
| `src/process/bridge/acpConversationBridge.ts` | 修改 | setModel IPC 处理 |
| `src/process/remote/MossSessionApi.ts` | 修改 | 模型相关 API 方法 |
| `src/agent/remote/MossWsConnection.ts` | 修改 | 处理模型切换 WebSocket 消息 |
| `src/process/task/RemoteAgent.ts` | 修改 | 添加 setModel 方法 |
| `src/renderer/components/AcpModelSelector.tsx` | 修改 | 模型选择器 UI |
| `src/renderer/pages/guid/hooks/useGuidAgentSelection.ts` | 修改 | 修复重置问题 |

> **注意:** Git 显示有 124 个文件变更，但其中 116 个是格式化/import 重组等非功能性变更。只需关注上述 8 个模型切换相关的文件。
