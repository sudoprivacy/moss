# Moss Server API 改动文档

本文档记录为支持 ACP 协议对现有 HTTP/WebSocket 接口的改动。

**版本**: v2.0.0
**状态**: 设计阶段

---

## 一、HTTP API 改动

### 1.1 POST `/api/v1/sessions` - 创建会话

**改动**: 增加 ACP 协议相关参数

#### 新增请求参数

```json
{
  // 现有参数（保持不变）
  "cwd": "/abs/path/project",
  "dangerously_skip_permissions": false,
  "assistant_name": "claude",

  // 新增参数
  "protocol": "cli",                     // 可选，默认 "cli"。可选值: "cli" | "acp"
  "acp_backend": "claude",               // protocol="acp" 时必填
  "acp_cli_path": "/usr/local/bin/claude", // 可选，自定义 CLI 路径
  "acp_args": ["--experimental-acp"],    // 可选，自定义 ACP 启动参数
  "acp_env": {                           // 可选，自定义环境变量
    "ANTHROPIC_API_KEY": "sk-xxx"
  },
  "acp_session_id": "prev-session-id",   // 可选，恢复 ACP 会话
  "acp_mode": "default"                  // 可选，ACP 会话模式: "default" | "yolo" | "bypassPermissions"
}
```

#### 新增响应字段

```json
{
  "session_id": "uuid",
  "ws_url": "ws://127.0.0.1:43127/ws/sessions/uuid",
  "work_dir": "/abs/path/project",
  "runtime": { ... },

  // 新增字段
  "protocol": "acp",                     // 会话使用的协议类型
  "acp_session_id": "agent-session-id",  // ACP agent 返回的内部 session ID（用于恢复）
  "acp_backend": "claude"                // ACP backend 类型
}
```

#### `acp_backend` 可选值

| 值 | 说明 | CLI 命令 |
|---|------|---------|
| `claude` | Claude Code ACP | `npx @zed-industries/claude-agent-acp` |
| `gemini` | Google Gemini CLI | `gemini --experimental-acp` |
| `qwen` | Qwen Code | `npx @qwen-code/qwen-code --acp` |
| `codex` | OpenAI Codex | `npx @zed-industries/codex-acp` |
| `nexus` | Nexus AI | `nexus chat --acp` |
| `custom` | 自定义 Agent | 用户配置的 CLI |

---

### 1.2 Session shape 改动

**改动**: Session 对象增加协议相关字段

```json
{
  "sessionId": "uuid",
  "transcriptSessionId": "uuid",
  "workDir": "/abs/path/project",
  "userId": "user-id",
  "orgId": "org-id",
  "role": "user",
  "scopes": [...],
  "runtime": { ... },
  "status": "creating|active|detached|ended|terminated|failed|lost",
  "desiredState": "active|ended|terminated",
  "createdAt": 0,
  "lastActiveAt": 0,
  "endedAt": null,

  // 新增字段
  "protocol": "cli|acp",                 // 协议类型
  "acpBackend": "claude|null",           // ACP backend 类型（仅 protocol=acp）
  "acpSessionId": "agent-sid|null",      // ACP agent 内部 session ID
  "acpMode": "default|null",             // 当前会话模式
  "acpModelId": "claude-sonnet-4|null",  // 当前模型 ID
  "acpSessionUpdatedAt": 0|null          // ACP session 更新时间（用于恢复）
}
```

---

### 1.3 POST `/api/v1/sessions/:sessionId/cancel` - 取消操作（新增）

**说明**: 取消当前正在执行的 agent 操作

**请求**:
```json
{
  "force": false    // 可选，是否强制终止（绕过 graceful cancel）
}
```

**响应**:
```json
{
  "ok": true,
  "result": "cancelled" | "disconnected",   // cancelled=优雅取消成功，disconnected=强制终止
  "session": { ... }
}
```

**行为差异**:

| 协议 | 实现方式 |
|------|---------|
| `cli` | 发送 SIGTERM 到 runner 进程 |
| `acp` | 发送 `session/cancel` JSON-RPC，等待 agent 响应 |

---

### 1.4 POST `/api/v1/sessions/:sessionId/model` - 切换模型（新增）

**说明**: 仅 ACP 协议支持，切换当前会话的模型

**请求**:
```json
{
  "model_id": "claude-opus-4"
}
```

**响应**:
```json
{
  "ok": true,
  "model_info": {
    "current_model_id": "claude-opus-4",
    "current_model_label": "Claude Opus 4",
    "available_models": [
      { "id": "claude-sonnet-4", "label": "Claude Sonnet 4" },
      { "id": "claude-opus-4", "label": "Claude Opus 4" }
    ],
    "can_switch": true
  }
}
```

**错误**:
- `404`: Session 不存在
- `400`: Session 不是 ACP 协议
- `400`: 模型 ID 不在可用列表中

---

### 1.5 POST `/api/v1/sessions/:sessionId/mode` - 切换模式（新增）

**说明**: 仅 ACP 协议支持，切换当前会话的操作模式

**请求**:
```json
{
  "mode": "bypassPermissions"    // 可选值: "default" | "yolo" | "bypassPermissions"
}
```

**响应**:
```json
{
  "ok": true,
  "mode": "bypassPermissions"
}
```

**模式说明**:

| 模式 | 说明 |
|------|------|
| `default` | 正常模式，所有操作需要权限确认 |
| `yolo` | 自动批准所有操作（部分 backend 支持） |
| `bypassPermissions` | 跳过权限检查（Claude backend） |

---

### 1.6 GET `/api/v1/sessions/:sessionId/model` - 获取模型信息（新增）

**说明**: 获取当前会话的模型信息

**响应**:
```json
{
  "model_info": {
    "source": "configOption",          // 数据来源: "configOption" 或 "models"
    "current_model_id": "claude-sonnet-4",
    "current_model_label": "Claude Sonnet 4",
    "can_switch": true,
    "available_models": [
      { "id": "claude-sonnet-4", "label": "Claude Sonnet 4" },
      { "id": "claude-opus-4", "label": "Claude Opus 4" }
    ]
  }
}
```

**注意**: `cli` 协议的 session 返回 `can_switch: false`

---

### 1.7 GET `/api/v1/acp/backends` - 获取 ACP backend 列表（新增）

**说明**: 返回支持的 ACP backend 配置列表

**响应**:
```json
{
  "backends": [
    {
      "id": "claude",
      "name": "Claude Code",
      "cli_command": "claude",
      "default_cli_path": "npx @zed-industries/claude-agent-acp",
      "auth_required": true,
      "enabled": true,
      "acp_args": [],
      "supports_streaming": false
    },
    {
      "id": "gemini",
      "name": "Google CLI",
      "cli_command": "gemini",
      "auth_required": true,
      "enabled": true,
      "acp_args": ["--experimental-acp"]
    },
    {
      "id": "nexus",
      "name": "Nexus",
      "cli_command": "nexus",
      "auth_required": false,
      "enabled": true,
      "acp_args": ["chat", "--acp"],
      "supports_streaming": true
    }
  ]
}
```

---

### 1.8 GET `/api/v1/sessions/:sessionId/config-options` - 获取配置选项（新增）

**说明**: 仅 ACP 协议支持，返回 session 可配置选项（模型、模式等）

**响应**:
```json
{
  "config_options": [
    {
      "id": "model",
      "name": "Model",
      "category": "model",
      "type": "select",
      "current_value": "claude-sonnet-4",
      "options": [
        { "value": "claude-sonnet-4", "label": "Claude Sonnet 4" },
        { "value": "claude-opus-4", "label": "Claude Opus 4" }
      ]
    },
    {
      "id": "auto_approve",
      "name": "Auto Approve",
      "category": "mode",
      "type": "boolean",
      "current_value": "false"
    }
  ]
}
```

---

### 1.9 PATCH `/api/v1/sessions/:sessionId/config-options/:configId` - 设置配置选项（新增）

**说明**: 仅 ACP 协议支持，设置特定配置选项值

**请求**:
```json
{
  "value": "claude-opus-4"
}
```

**响应**:
```json
{
  "ok": true,
  "config_options": [ ... ]    // 返回更新后的完整配置选项列表
}
```

---

## 二、WebSocket 改动

### 2.1 WS `/ws/sessions/:sessionId` - 消息格式扩展

**改动**: 支持两种协议的消息格式，通过 session 的 `protocol` 字段自动选择

#### CLI 协议（现有，保持不变）

**Client → Server**:
```json
{ "type": "user_message", "content": "..." }
```

**Server → Client**:
```json
{ "type": "content", "data": "..." }
{ "type": "control_request", "request": { ... }, "request_id": "..." }
{ "type": "control_response", "response": { ... } }
{ "type": "finish", "data": null }
```

---

#### ACP 协议（新增）

**Client → Server 消息类型**:

| type | 说明 | 参数 |
|------|------|------|
| `user_message` | 发送消息 | `{ content: string, images?: [...] }` |
| `permission_response` | 权限响应 | `{ request_id: string, option_id: string }` |
| `cancel` | 取消操作 | `{ force?: boolean }` |
| `interrupt` | 中断当前操作 | `{}` |

**请求示例**:

```json
// 发送消息
{
  "type": "user_message",
  "content": "帮我分析这个项目结构",
  "images": [
    { "type": "image", "data": "base64...", "mime_type": "image/png" }
  ]
}

// 权限响应
{
  "type": "permission_response",
  "request_id": "tool-call-123",
  "option_id": "allow_always"
}

// 取消操作
{
  "type": "cancel",
  "force": false
}
```

---

**Server → Client 消息类型**:

| type | 说明 | 参数 |
|------|------|------|
| `start` | 开始响应 | `{}` |
| `content` | 流式文本 | `{ data: string }` |
| `thought` | 思考过程 | `{ subject: string, description: string }` |
| `tool_call` | 工具调用 | `{ tool_call_id, title, kind, status, ... }` |
| `tool_call_update` | 工具状态更新 | `{ tool_call_id, status, content, ... }` |
| `plan` | 计划更新 | `{ entries: [...] }` |
| `permission_request` | 权限请求 | `{ request_id, tool_call: {...}, options: [...] }` |
| `model_info` | 模型信息更新 | `{ model_info: {...} }` |
| `context_usage` | Token 使用量 | `{ used: number, size: number }` |
| `finish` | 响应完成 | `{ stop_reason?: string }` |
| `error` | 错误 | `{ data: string }` |
| `agent_status` | Agent 状态 | `{ status: string, backend?: string }` |

---

**响应示例**:

```json
// 开始响应
{ "type": "start", "msg_id": "uuid" }

// 流式文本
{ "type": "content", "msg_id": "uuid", "data": "我来分析..." }

// 思考过程
{ "type": "thought", "msg_id": "uuid", "data": { "subject": "分析项目", "description": "..." } }

// 工具调用开始
{
  "type": "tool_call",
  "msg_id": "tool-123",
  "data": {
    "tool_call_id": "tool-123",
    "title": "Read File",
    "kind": "read",
    "status": "pending",
    "raw_input": { "path": "/src/index.ts" }
  }
}

// 工具调用完成
{
  "type": "tool_call_update",
  "msg_id": "tool-123",
  "data": {
    "tool_call_id": "tool-123",
    "status": "completed",
    "content": [{ "type": "content", "content": { "type": "text", "text": "..." } }]
  }
}

// 权限请求
{
  "type": "permission_request",
  "msg_id": "uuid",
  "data": {
    "request_id": "tool-123",
    "tool_call": {
      "tool_call_id": "tool-123",
      "title": "Execute Command",
      "kind": "execute",
      "raw_input": { "command": "rm -rf /" }
    },
    "options": [
      { "option_id": "allow_once", "name": "Allow Once", "kind": "allow_once" },
      { "option_id": "allow_always", "name": "Always Allow", "kind": "allow_always" },
      { "option_id": "reject_once", "name": "Reject Once", "kind": "reject_once" },
      { "option_id": "reject_always", "name": "Always Reject", "kind": "reject_always" }
    ]
  }
}

// Token 使用量
{
  "type": "context_usage",
  "msg_id": "uuid",
  "data": {
    "used": 15000,
    "size": 200000,
    "cost": { "amount": 0.15, "currency": "USD" }
  }
}

// 响应完成
{ "type": "finish", "msg_id": "uuid", "data": null }
```

---

### 2.2 权限处理流程改动

**现有 CLI 协议流程**:
```
Agent → Server: control_request (can_use_tool)
Server → Client: control_request
Client → Server: control_response
Server → Agent: control_response
```

**ACP 协议流程**:
```
Agent → Server: session/request_permission (JSON-RPC)
Server → Client: permission_request
Client → Server: permission_response
Server → Agent: JSON-RPC response { outcome: "selected", optionId: "..." }
```

**映射关系**:

| CLI | ACP |
|-----|-----|
| `can_use_tool` | `session/request_permission` |
| `allow_once` | `allow_once` |
| `allow_always` | `allow_always` |
| `reject_once` | `reject_once` |

---

### 2.3 错误处理改动

**新增错误类型**:

| code | 说明 | retryable |
|------|------|-----------|
| `CONNECTION_NOT_READY` | Agent 连接未就绪 | true |
| `AUTHENTICATION_FAILED` | Agent 认证失败 | false |
| `SESSION_EXPIRED` | ACP session 过期 | true |
| `MODEL_NOT_FOUND` | 模型不存在 | false |
| `MODE_NOT_SUPPORTED` | 模式不支持 | false |
| `BACKEND_NOT_AVAILABLE` | Backend CLI 未安装 | false |

**错误响应格式**:
```json
{
  "type": "error",
  "msg_id": "uuid",
  "data": "Model 'claude-opus-4' is not available. Available models: claude-sonnet-4",
  "error_code": "MODEL_NOT_FOUND",
  "retryable": false
}
```

---

## 三、向后兼容性

### 3.1 默认行为

- `protocol` 参数默认为 `"cli"`，保持现有客户端兼容
- 现有 `/api/v1/sessions` 参数保持不变
- WebSocket CLI 协议消息格式保持不变

### 3.2 新接口访问控制

| 接口 | Scope 要求 |
|------|-----------|
| `GET /api/v1/acp/backends` | 无需特殊 scope |
| `POST /api/v1/sessions/:id/model` | `sessions:attach` |
| `POST /api/v1/sessions/:id/mode` | `sessions:attach` |
| `POST /api/v1/sessions/:id/cancel` | `sessions:attach` |
| `GET /api/v1/sessions/:id/config-options` | `sessions:attach` |
| `PATCH /api/v1/sessions/:id/config-options/:id` | `sessions:attach` |

### 3.3 错误码兼容

- 非 ACP session 调用 ACP 接口返回 `400 Bad Request`，message: `"Session is not using ACP protocol"`

---

## 四、实现优先级

### P0 - 必须实现

1. `POST /api/v1/sessions` 参数扩展（protocol, acp_backend）
2. WebSocket ACP 消息格式支持
3. AcpBackend 实现
4. `POST /api/v1/sessions/:id/cancel`

### P1 - 重要功能

1. `POST /api/v1/sessions/:id/model`
2. `POST /api/v1/sessions/:id/mode`
3. `GET /api/v1/acp/backends`

### P2 - 可选功能

1. `GET /api/v1/sessions/:id/config-options`
2. `PATCH /api/v1/sessions/:id/config-options/:id`
3. Token 使用量推送（context_usage）
4. 计划更新推送（plan）

---

## 五、代码改动清单

| 文件 | 改动类型 | 改动内容 |
|------|---------|---------|
| `src/server/types.ts` | 修改 | 增加 `protocol`, `acpBackend`, `acpSessionId` 等字段 |
| `src/server/types/acpTypes.ts` | 新增 | ACP JSON-RPC 类型定义 |
| `src/server/server.ts` | 修改 | 新增 HTTP 接口、WebSocket ACP 适配 |
| `src/server/backends/acpBackend.ts` | 新增 | ACP Backend 实现 |
| `src/server/acp/acpConnection.ts` | 新增 | ACP 连接管理 |
| `src/server/acp/acpUtils.ts` | 新增 | ACP 工具函数 |
| `src/server/sessionRunnerDaemon.ts` | 修改 | 支持 ACP 协议处理 |
| `src/server/runtimeBackend.ts` | 修改 | 增加 ACP backend 路由 |
| `src/server/sessionManager.ts` | 修改 | 增加 ACP session 支持 |