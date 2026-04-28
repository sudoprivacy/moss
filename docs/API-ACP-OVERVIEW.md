# Moss Server ACP 接口总览

本文档汇总 Moss Server 支持的 HTTP API 和 WebSocket 接口，包括 CLI 协议和 ACP 协议。

**版本**: v2.0.0
**状态**: 设计阶段

---

## 一、HTTP API 总览

### 1.1 会话管理 API

| 方法 | 路径 | 说明 | 协议支持 |
|------|------|------|---------|
| POST | `/api/v1/sessions` | 创建会话 | CLI, ACP |
| GET | `/api/v1/sessions` | 列出会话 | CLI, ACP |
| GET | `/api/v1/sessions/:id` | 获取会话详情 | CLI, ACP |
| POST | `/api/v1/sessions/:id/resume` | 恢复会话 | CLI, ACP |
| POST | `/api/v1/sessions/:id/terminate` | 终止会话 | CLI, ACP |
| POST | `/api/v1/sessions/:id/cancel` | 取消当前操作 | CLI, ACP |
| GET | `/api/v1/sessions/:id/context` | 获取会话上下文 | CLI, ACP |
| POST | `/api/v1/sessions/:id/model` | 切换模型 | ACP only |
| GET | `/api/v1/sessions/:id/model` | 获取模型信息 | ACP only |
| POST | `/api/v1/sessions/:id/mode` | 切换操作模式 | ACP only |
| GET | `/api/v1/sessions/:id/config-options` | 获取配置选项 | ACP only |
| PATCH | `/api/v1/sessions/:id/config-options/:configId` | 设置配置选项 | ACP only |

### 1.2 ACP Backend API

| 方法 | 路径 | 说明 | 协议支持 |
|------|------|------|---------|
| GET | `/api/v1/acp/backends` | 获取支持的 ACP backend 列表 | 所有 |

### 1.3 其他 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 存活检查 |
| GET | `/readyz` | 就绪检查 |
| GET | `/api/v1/dashboard/stats` | 看板统计 |
| GET | `/api/v1/budget/stats` | 预算统计 |

---

## 二、POST /api/v1/sessions 详细参数

### 2.1 通用参数（CLI & ACP）

```json
{
  "cwd": "/abs/path/project",           // 必填，工作目录
  "assistant_name": "claude",           // 可选，助手名称
  "dangerously_skip_permissions": false // 可选，跳过权限检查
}
```

### 2.2 CLI 协议参数

```json
{
  "protocol": "cli",                    // 默认值，可选

  // Runtime 配置
  "runtime": {
    "type": "host" | "docker",
    "dockerImage": "image:tag",         // type=docker 时可选
    "dockerMode": "session" | "user",   // type=docker 时可选
    "configDir": "/path/config"         // 可选，配置目录
  }
}
```

### 2.3 ACP 协议参数

```json
{
  "protocol": "acp",                    // ACP 协议标识

  // ACP Backend 配置
  "acp_backend": "claude",              // 必填，backend 类型
  "acp_cli_path": "/usr/bin/claude",    // 可选，自定义 CLI 路径
  "acp_args": ["--experimental-acp"],   // 可选，自定义启动参数
  "acp_env": {                          // 可选，自定义环境变量
    "ANTHROPIC_API_KEY": "sk-xxx"
  },

  // Session 恢复
  "acp_session_id": "prev-session-id",  // 可选，恢复的 ACP session ID

  // 会话模式
  "acp_mode": "default" | "yolo" | "bypassPermissions"  // 可选
}
```

### 2.4 响应格式

```json
{
  // 通用字段
  "session_id": "uuid",
  "ws_url": "ws://host:port/ws/sessions/uuid",
  "work_dir": "/abs/path/project",

  // Runtime 信息
  "runtime": {
    "type": "host" | "docker",
    "configDir": "/path/config"
  },

  // ACP 特有字段
  "protocol": "acp",
  "acp_session_id": "agent-session-id",   // 用于恢复
  "acp_backend": "claude",

  // 模型信息（ACP）
  "model_info": {
    "current_model_id": "claude-sonnet-4",
    "can_switch": true,
    "available_models": [
      { "id": "claude-sonnet-4", "label": "Claude Sonnet 4" },
      { "id": "claude-opus-4", "label": "Claude Opus 4" }
    ]
  }
}
```

---

## 三、WebSocket 消息格式

### 3.1 WS `/ws/sessions/:sessionId`

连接后根据 session 的 `protocol` 字段自动选择消息格式。

### 3.2 CLI 协议消息格式

**Client → Server**:
```json
{ "type": "user_message", "content": "帮我分析代码" }
```

**Server → Client**:
```json
{ "type": "start" }
{ "type": "content", "data": "我来分析..." }
{ "type": "control_request", "request": {...}, "request_id": "..." }
{ "type": "control_response", "response": {...} }
{ "type": "finish", "data": null }
```

### 3.3 ACP 协议消息格式

**Client → Server**:

| type | 参数 | 说明 |
|------|------|------|
| `user_message` | `{ content, images? }` | 发送消息 |
| `permission_response` | `{ request_id, option_id }` | 权限响应 |
| `cancel` | `{ force? }` | 取消操作 |
| `interrupt` | `{}` | 中断当前操作 |

```json
// 发送消息
{
  "type": "user_message",
  "content": "帮我分析代码",
  "images": [
    { "type": "image", "data": "base64...", "mime_type": "image/png" }
  ]
}

// 权限响应
{
  "type": "permission_response",
  "request_id": "tool-123",
  "option_id": "allow_once"
}

// 取消操作
{
  "type": "cancel",
  "force": false
}
```

**Server → Client**:

| type | 参数 | 说明 |
|------|------|------|
| `start` | `{ msg_id }` | 开始响应 |
| `content` | `{ msg_id, data }` | 流式文本 |
| `thought` | `{ msg_id, data: { subject, description } }` | 思考过程 |
| `tool_call` | `{ msg_id, data: { tool_call_id, title, kind, status, ... } }` | 工具调用开始 |
| `tool_call_update` | `{ msg_id, data: { tool_call_id, status, content, ... } }` | 工具状态更新 |
| `plan` | `{ msg_id, data: { entries } }` | 计划更新 |
| `permission_request` | `{ msg_id, data: { request_id, tool_call, options } }` | 权限请求 |
| `model_info` | `{ msg_id, data: { ... } }` | 模型信息更新 |
| `context_usage` | `{ msg_id, data: { used, size } }` | Token 使用量 |
| `finish` | `{ msg_id, stop_reason? }` | 响应完成 |
| `error` | `{ msg_id, data, error_code, retryable }` | 错误 |

```json
// 流式文本
{
  "type": "content",
  "msg_id": "msg-uuid",
  "data": "我来分析这段代码..."
}

// 工具调用
{
  "type": "tool_call",
  "msg_id": "tool-123",
  "data": {
    "tool_call_id": "tool-123",
    "title": "Read File",
    "kind": "read",
    "status": "pending",
    "raw_input": { "path": "src/index.ts" }
  }
}

// 权限请求
{
  "type": "permission_request",
  "msg_id": "perm-uuid",
  "data": {
    "request_id": "tool-456",
    "tool_call": {
      "tool_call_id": "tool-456",
      "title": "Execute Command",
      "kind": "execute",
      "raw_input": { "command": "npm test" }
    },
    "options": [
      { "option_id": "allow_once", "name": "Allow Once" },
      { "option_id": "allow_always", "name": "Always Allow" },
      { "option_id": "reject_once", "name": "Reject Once" }
    ]
  }
}

// Token 使用量
{
  "type": "context_usage",
  "msg_id": "usage-uuid",
  "data": {
    "used": 15000,
    "size": 200000
  }
}

// 完成
{
  "type": "finish",
  "msg_id": "msg-uuid",
  "stop_reason": "end_turn"
}
```

---

## 四、ACP Backend 配置

### 4.1 GET /api/v1/acp/backends 响应

```json
{
  "backends": [
    {
      "id": "claude",
      "name": "Claude Code",
      "cli_command": "claude",
      "default_cli_path": "npx @zed-industries/claude-agent-acp",
      "acp_args": ["--experimental-acp"],
      "auth_required": true,
      "enabled": true,
      "supports_streaming": false,
      "modes": ["default", "bypassPermissions"],
      "env_keys": ["ANTHROPIC_API_KEY"]
    },
    {
      "id": "gemini",
      "name": "Google Gemini CLI",
      "cli_command": "gemini",
      "acp_args": ["--experimental-acp"],
      "auth_required": true,
      "enabled": true,
      "supports_streaming": true
    },
    {
      "id": "nexus",
      "name": "Nexus AI",
      "cli_command": "nexus",
      "acp_args": ["chat", "--acp"],
      "auth_required": false,
      "enabled": true,
      "supports_streaming": true
    }
  ]
}
```

### 4.2 支持的 Backend ID

| ID | 名称 | 认证 | 模式支持 |
|----|------|------|---------|
| `claude` | Claude Code | 需要 | default, bypassPermissions |
| `gemini` | Gemini CLI | 需要 | 无 |
| `qwen` | Qwen Code | 需要 | default, yolo |
| `codex` | Codex | 需要 | default, yolo |
| `nexus` | Nexus AI | 无 | 无 |
| `auggie` | Augment Code | 无 | 无 |
| `goose` | Goose | 无 | 无 |
| `copilot` | GitHub Copilot | 无 | 无 |
| `custom` | 自定义 Agent | 可选 | 可选 |

---

## 五、Session 对象完整定义

```json
{
  "sessionId": "uuid",
  "transcriptSessionId": "uuid",
  "workDir": "/abs/path/project",
  "userId": "user-id",
  "orgId": "org-id",
  "role": "user",
  "scopes": ["sessions:create", "sessions:attach"],
  "assistantName": "claude",

  // Runtime
  "runtime": {
    "type": "host" | "docker",
    "dockerImage": "image:tag",
    "dockerMode": "session" | "user",
    "containerName": "container-name",
    "configDir": "/path/config"
  },

  // 状态
  "status": "creating|active|detached|ended|terminated|failed|lost",
  "desiredState": "active|ended|terminated",
  "createdAt": 0,
  "lastActiveAt": 0,
  "endedAt": null,

  // 协议信息（新增）
  "protocol": "cli" | "acp",
  "acpBackend": "claude" | null,
  "acpSessionId": "agent-sid" | null,
  "acpMode": "default" | null,
  "acpModelId": "claude-sonnet-4" | null
}
```

---

## 六、错误响应格式

### 6.1 HTTP 错误

```json
{
  "error": "Model 'claude-opus-4' is not available"
}
```

### 6.2 WebSocket 错误

```json
{
  "type": "error",
  "msg_id": "uuid",
  "data": "Authentication failed",
  "error_code": "AUTH_FAILED",
  "retryable": false
}
```

### 6.3 错误码

| error_code | 说明 | retryable |
|------------|------|-----------|
| `AUTH_FAILED` | 认证失败 | false |
| `SESSION_NOT_FOUND` | 会话不存在 | false |
| `MODEL_NOT_FOUND` | 模型不存在 | false |
| `MODE_NOT_SUPPORTED` | 模式不支持 | false |
| `BACKEND_NOT_AVAILABLE` | Backend CLI 未安装 | false |
| `CONNECTION_NOT_READY` | Agent 连接未就绪 | true |
| `SESSION_EXPIRED` | ACP session 过期 | true |
| `INTERNAL_ERROR` | 内部错误 | false |

---

## 七、相关文档

- [API 改动文档](./API-ACP-CHANGES.md) - 详细的接口改动说明
- [ACP 支持文档](./ACP-SUPPORT.md) - ACP 协议实现详情
- [现有 API 文档](../src/server/API.md) - CLI 协议接口定义