# Moss Server ACP 协议支持文档

本文档描述 Moss Server 对 ACP（Agent Client Protocol）协议的支持。

**版本**: v1.0.0
**状态**: 设计阶段

---

## 一、概述

### 1.1 什么是 ACP

ACP（Agent Client Protocol）是一个标准化的 Agent 客户端通信协议，基于 JSON-RPC 2.0，通过 stdin/stdout 进行双向通信。

**协议特点**：
- JSON-RPC 2.0 格式，每行一个 JSON 对象
- 流式消息传递，支持实时更新
- 标准化的会话管理（创建、恢复、取消）
- 权限请求/响应机制
- 配置选项动态查询和修改
- 文件操作请求（读/写）

**优势**：
- 支持 Claude Code、Gemini CLI、Qwen Code 等多种 Agent
- 标准化接口，便于集成新 Agent
- 会话恢复能力
- 实时状态更新

---

### 1.2 Moss Server ACP 架构

```
┌────────────────────────────────────────────────────────────┐
│                    Moss Server                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              HTTP API Layer                           │  │
│  │  /api/v1/sessions (创建)                              │  │
│  │  /api/v1/sessions/:id/cancel (取消)                   │  │
│  │  /api/v1/sessions/:id/model (切换模型)                │  │
│  │  /api/v1/sessions/:id/mode (切换模式)                 │  │
│  │  /api/v1/acp/backends (backend列表)                   │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              WebSocket Layer                          │  │
│  │  /ws/sessions/:sessionId                              │  │
│  │  ├─ CliProtocolAdapter (protocol=cli)                 │  │
│  │  └─ AcpProtocolAdapter (protocol=acp)                 │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Backend Layer                            │  │
│  │  ├─ DangerousBackend (CLI runner)                     │  │
│  │  └─ AcpBackend (ACP agent)                            │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                              │
                              │ stdin/stdout JSON-RPC
                              ▼
┌────────────────────────────────────────────────────────────┐
│              ACP Agent Process                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │  Claude Code   │  │  Gemini CLI    │  │  Qwen Code     │ │
│  │  (claude-acp)  │  │  (gemini)      │  │  (qwen-code)   │ │
│  └────────────────┘  └────────────────┘  └────────────────┘ │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │  Codex         │  │  Nexus         │  │  Custom Agent  │ │
│  │  (codex-acp)   │  │  (nexus chat)  │  │  (user config) │ │
│  └────────────────┘  └────────────────┘  └────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

---

## 二、支持的 ACP Backend

### 2.1 Backend 配置表

| Backend ID | 名称 | CLI 命令 | ACP 参数 | 认证要求 | 流式支持 |
|------------|------|---------|---------|---------|---------|
| `claude` | Claude Code | `claude` | `--experimental-acp` | 是 | 否 |
| `gemini` | Google Gemini CLI | `gemini` | `--experimental-acp` | 是 | 是 |
| `qwen` | Qwen Code | `qwen-code` | `--acp` | 是 | 是 |
| `codex` | OpenAI Codex | `codex-acp` | 无 | 是 | 否 |
| `nexus` | Nexus AI | `nexus` | `chat --acp` | 否 | 是 |
| `auggie` | Augment Code | `auggie` | `--acp` | 否 | 否 |
| `goose` | Goose | `goose` | `acp` | 否 | 否 |
| `kimi` | Kimi CLI | `kimi` | `acp` | 否 | 否 |
| `opencode` | OpenCode | `opencode` | `acp` | 否 | 否 |
| `copilot` | GitHub Copilot | `copilot` | `--acp --stdio` | 否 | 否 |
| `droid` | Factory Droid | `droid` | `exec --output-format acp` | 否 | 否 |
| `vibe` | Mistral Vibe | `vibe-acp` | 无 | 否 | 否 |
| `nanobot` | Nano Bot | `nanobot` | `--experimental-acp` | 否 | 否 |
| `custom` | 自定义 Agent | 用户配置 | 用户配置 | 可选 | 可选 |

### 2.2 Backend 详细配置

#### Claude Code ACP

```json
{
  "id": "claude",
  "name": "Claude Code",
  "cli_command": "claude",
  "acp_args": ["--experimental-acp"],
  "auth_required": true,
  "supports_streaming": false,
  "default_cli_path": "npx @zed-industries/claude-agent-acp",
  "modes": ["default", "bypassPermissions"],
  "env_keys": ["ANTHROPIC_API_KEY"]
}
```

启动命令：
```bash
npx @zed-industries/claude-agent-acp --yes --prefer-offline
# 或
claude --experimental-acp
```

#### Gemini CLI ACP

```json
{
  "id": "gemini",
  "name": "Google Gemini CLI",
  "cli_command": "gemini",
  "acp_args": ["--experimental-acp"],
  "auth_required": true,
  "supports_streaming": true,
  "modes": [],
  "env_keys": ["GOOGLE_API_KEY"]
}
```

启动命令：
```bash
gemini --experimental-acp
```

#### Qwen Code ACP

```json
{
  "id": "qwen",
  "name": "Qwen Code",
  "cli_command": "qwen-code",
  "acp_args": ["--acp"],
  "auth_required": true,
  "supports_streaming": true,
  "default_cli_path": "npx @qwen-code/qwen-code",
  "modes": ["yolo"],
  "env_keys": ["QWEN_API_KEY"]
}
```

启动命令：
```bash
npx @qwen-code/qwen-code --acp
```

#### Nexus ACP

```json
{
  "id": "nexus",
  "name": "Nexus AI",
  "cli_command": "nexus",
  "acp_args": ["chat", "--acp"],
  "auth_required": false,
  "supports_streaming": true,
  "modes": []
}
```

启动命令：
```bash
nexus chat --acp
```

---

## 三、ACP 协议消息格式

### 3.1 JSON-RPC 基础格式

所有消息遵循 JSON-RPC 2.0 规范：

**Request**（Client → Agent）:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/prompt",
  "params": { ... }
}
```

**Response**（Agent → Client）:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

**Notification**（Agent → Client，无 id）:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": { ... }
}
```

**Error Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Internal error"
  }
}
```

---

### 3.2 协议方法

#### Client → Agent 方法

| Method | 说明 | 参数 |
|--------|------|------|
| `initialize` | 初始化协议 | `{ protocolVersion: 1, clientCapabilities: { ... } }` |
| `authenticate` | 认证 | `{ methodId?: string }` |
| `session/new` | 创建会话 | `{ cwd, mcpServers, _meta?, resumeSessionId?, forkSession? }` |
| `session/load` | 恢复会话 | `{ sessionId, cwd, mcpServers }` |
| `session/prompt` | 发送消息 | `{ sessionId, prompt: [{ type, text?, data?, mimeType? }] }` |
| `session/cancel` | 取消操作 | `{ sessionId }` |
| `session/set_mode` | 设置模式 | `{ sessionId, modeId }` |
| `session/set_model` | 设置模型 | `{ sessionId, modelId }` |
| `session/set_config_option` | 设置配置 | `{ sessionId, configId, value }` |

#### Agent → Client 方法（Notification）

| Method | 说明 | 参数 |
|--------|------|------|
| `session/update` | 会话状态更新 | `{ sessionId, update: { sessionUpdate, ... } }` |
| `session/request_permission` | 权限请求 | `{ sessionId, options, toolCall }` |
| `fs/read_text_file` | 文件读取请求 | `{ sessionId, path }` |
| `fs/write_text_file` | 文件写入请求 | `{ sessionId, path, content }` |

---

### 3.3 Session Update 类型

```typescript
type SessionUpdateType =
  | 'agent_message_chunk'     // 流式文本块
  | 'agent_thought_chunk'     // 思考过程块
  | 'tool_call'               // 工具调用开始
  | 'tool_call_update'        // 工具调用状态更新
  | 'plan'                    // 计划更新
  | 'config_option_update'    // 配置选项更新
  | 'usage_update'            // Token 使用量更新
  | 'available_commands_update' // 可用命令更新
  | 'user_message_chunk'      // 用户消息块（回显）
```

#### agent_message_chunk

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-uuid",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {
        "type": "text",
        "text": "我来帮你分析..."
      }
    }
  }
}
```

#### tool_call

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-uuid",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "tool-123",
      "status": "pending",
      "title": "Read File",
      "kind": "read",
      "rawInput": { "path": "/src/index.ts" },
      "content": [],
      "locations": [{ "path": "/src/index.ts" }]
    }
  }
}
```

#### tool_call_update

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-uuid",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "tool-123",
      "status": "completed",
      "content": [{
        "type": "content",
        "content": { "type": "text", "text": "file content..." }
      }]
    }
  }
}
```

#### session/request_permission

```json
{
  "jsonrpc": "2.0",
  "method": "session/request_permission",
  "params": {
    "sessionId": "session-uuid",
    "options": [
      { "optionId": "allow_once", "name": "Allow Once", "kind": "allow_once" },
      { "optionId": "allow_always", "name": "Always Allow", "kind": "allow_always" },
      { "optionId": "reject_once", "name": "Reject Once", "kind": "reject_once" },
      { "optionId": "reject_always", "name": "Always Reject", "kind": "reject_always" }
    ],
    "toolCall": {
      "toolCallId": "tool-456",
      "title": "Execute Command",
      "kind": "execute",
      "rawInput": { "command": "npm install" }
    }
  }
}
```

---

### 3.4 权限响应格式

Client 需响应 `session/request_permission`，返回选中的选项：

```json
{
  "jsonrpc": "2.0",
  "id": 5,  // 对应 request 的 id
  "result": {
    "outcome": "selected",
    "optionId": "allow_once"
  }
}
```

**outcome 值**:
- `selected`: 用户选择了一个选项
- `rejected`: 超时或被拒绝

---

## 四、会话生命周期

### 4.1 创建流程

```
Client                          Server                          Agent
  │                               │                               │
  │ POST /api/v1/sessions         │                               │
  │ { protocol: "acp",            │                               │
  │   acp_backend: "claude" }     │                               │
  │──────────────────────────────>│                               │
  │                               │ spawn claude-acp              │
  │                               │──────────────────────────────>│
  │                               │                               │ initialize
  │                               │<──────────────────────────────│
  │                               │ initialize response           │
  │                               │──────────────────────────────>│
  │                               │                               │ authenticate
  │                               │<──────────────────────────────│
  │                               │ authenticate response         │
  │                               │──────────────────────────────>│
  │                               │                               │ session/new
  │                               │<──────────────────────────────│
  │                               │ session/new response          │
  │                               │ (sessionId, models, ...)      │
  │                               │──────────────────────────────>│
  │ { session_id, ws_url,         │                               │
  │   acp_session_id, ... }       │                               │
  │<──────────────────────────────│                               │
  │                               │                               │
  │ WS connect                    │                               │
  │──────────────────────────────>│                               │
  │                               │                               │
```

### 4.2 恢复流程

```
Client                          Server                          Agent
  │                               │                               │
  │ POST /api/v1/sessions         │                               │
  │ { protocol: "acp",            │                               │
  │   acp_backend: "claude",      │                               │
  │   acp_session_id: "prev-id" } │                               │
  │──────────────────────────────>│                               │
  │                               │ spawn claude-acp              │
  │                               │──────────────────────────────>│
  │                               │                               │ initialize
  │                               │                               │ authenticate
  │                               │                               │ session/new
  │                               │<──────────────────────────────│
  │                               │  { resumeSessionId: "prev-id"}│
  │                               │──────────────────────────────>│
  │                               │                               │ session/new
  │                               │<──────────────────────────────│
  │                               │ (恢复的会话状态)              │
  │                               │──────────────────────────────>│
  │                               │                               │
```

### 4.3 取消流程

**优雅取消（ACP 支持时）**:

```
Client                          Server                          Agent
  │                               │                               │
  │ { type: "cancel" }            │                               │
  │──────────────────────────────>│                               │
  │                               │ session/cancel                │
  │                               │──────────────────────────────>│
  │                               │                               │ 响应 session/prompt
  │                               │<──────────────────────────────│
  │                               │ { stopReason: "cancelled" }   │
  │                               │──────────────────────────────>│
  │ { type: "finish",             │                               │
  │   stop_reason: "cancelled" }  │                               │
  │<──────────────────────────────│                               │
```

**强制终止**:

```
Client                          Server                          Agent
  │                               │                               │
  │ { type: "cancel",             │                               │
  │   force: true }               │                               │
  │──────────────────────────────>│                               │
  │                               │ SIGTERM to agent process      │
  │                               │──────────────────────────────X│
  │                               │                               │
  │ { type: "finish",             │                               │
  │   stop_reason: "disconnected" }                               │
  │<──────────────────────────────│                               │
```

---

## 五、WebSocket 消息映射

### 5.1 Client → Server 消息

| WebSocket 消息 | ACP 映射 | 说明 |
|---------------|----------|------|
| `{ type: "user_message", content: "..." }` | `session/prompt` | 发送消息 |
| `{ type: "permission_response", request_id, option_id }` | JSON-RPC response | 权限响应 |
| `{ type: "cancel", force?: bool }` | `session/cancel` / SIGTERM | 取消操作 |
| `{ type: "interrupt" }` | `session/cancel` | 中断当前操作 |

### 5.2 Server → Client 消息

| ACP Notification | WebSocket 消息 | 说明 |
|-----------------|---------------|------|
| `session/update` (agent_message_chunk) | `{ type: "content", data: "..." }` | 流式文本 |
| `session/update` (agent_thought_chunk) | `{ type: "thought", data: { subject, description } }` | 思考过程 |
| `session/update` (tool_call) | `{ type: "tool_call", data: { ... } }` | 工具调用开始 |
| `session/update` (tool_call_update) | `{ type: "tool_call_update", data: { ... } }` | 工具状态更新 |
| `session/update` (plan) | `{ type: "plan", data: { entries } }` | 计划更新 |
| `session/update` (usage_update) | `{ type: "context_usage", data: { used, size } }` | Token 使用量 |
| `session/update` (config_option_update) | `{ type: "model_info", data: { ... } }` | 配置更新 |
| `session/request_permission` | `{ type: "permission_request", data: { ... } }` | 权限请求 |
| `fs/read_text_file` | `{ type: "file_read", data: { path } }` | 文件读取请求 |
| `fs/write_text_file` | `{ type: "file_write", data: { path, content } }` | 文件写入请求 |
| `session/prompt` response | `{ type: "finish", stop_reason }` | 响应完成 |

---

## 六、配置选项

### 6.1 查询配置选项

通过 `session/new` 响应获取：

```json
{
  "result": {
    "sessionId": "...",
    "configOptions": [
      {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "claude-sonnet-4",
        "options": [
          { "value": "claude-sonnet-4", "label": "Claude Sonnet 4" },
          { "value": "claude-opus-4", "label": "Claude Opus 4" }
        ]
      },
      {
        "id": "autoApprove",
        "name": "Auto Approve",
        "category": "mode",
        "type": "boolean",
        "currentValue": "false"
      }
    ],
    "models": {
      "currentModelId": "claude-sonnet-4",
      "availableModels": [
        { "id": "claude-sonnet-4" },
        { "id": "claude-opus-4" }
      ]
    }
  }
}
```

### 6.2 设置配置选项

通过 `session/set_config_option`：

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/set_config_option",
  "params": {
    "sessionId": "session-uuid",
    "configId": "model",
    "value": "claude-opus-4"
  }
}
```

---

## 七、会话模式

### 7.1 支持的模式

| Backend | 支持的模式 | 说明 |
|---------|-----------|------|
| Claude | `default`, `bypassPermissions` | bypassPermissions = 跳过所有权限检查 |
| Qwen | `default`, `yolo` | yolo = 自动批准所有操作 |
| iFlow | `default`, `yolo` | |
| Codex | `default`, `yolo` | |

### 7.2 设置模式

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "session/set_mode",
  "params": {
    "sessionId": "session-uuid",
    "modeId": "bypassPermissions"
  }
}
```

---

## 八、错误处理

### 8.1 ACP 错误码

| Code | Message | 说明 |
|------|---------|------|
| -32700 | Parse error | JSON 解析失败 |
| -32600 | Invalid Request | 请求格式无效 |
| -32601 | Method not found | 方法不存在 |
| -32602 | Invalid params | 参数无效 |
| -32603 | Internal error | 内部错误 |
| -32001 | Authentication failed | 认证失败 |
| -32002 | Session not found | 会话不存在 |
| -32003 | Model not found | 模型不存在 |

### 8.2 Moss Server 错误映射

| ACP Error | HTTP Response | WebSocket Error |
|-----------|--------------|-----------------|
| Authentication failed | 401 Unauthorized | `{ type: "error", error_code: "AUTH_FAILED" }` |
| Session not found | 404 Not Found | `{ type: "error", error_code: "SESSION_NOT_FOUND" }` |
| Model not found | 400 Bad Request | `{ type: "error", error_code: "MODEL_NOT_FOUND" }` |
| Internal error | 500 Internal Error | `{ type: "error", error_code: "INTERNAL_ERROR" }` |

---

## 九、文件操作

### 9.1 文件读取请求

Agent 发送：
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "fs/read_text_file",
  "params": {
    "sessionId": "session-uuid",
    "path": "src/index.ts"
  }
}
```

Server 响应：
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": {
    "content": "file content here..."
  }
}
```

### 9.2 文件写入请求

Agent 发送：
```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "fs/write_text_file",
  "params": {
    "sessionId": "session-uuid",
    "path": "src/new.ts",
    "content": "new file content"
  }
}
```

Server 响应：
```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "result": null
}
```

---

## 十、环境变量配置

### 10.1 Backend 环境变量

| Backend | 环境变量 | 说明 |
|---------|---------|------|
| Claude | `ANTHROPIC_API_KEY` | Anthropic API Key |
| Gemini | `GOOGLE_API_KEY` | Google API Key |
| Qwen | `QWEN_API_KEY`, `DASHSCOPE_API_KEY` | 通义千问 API Key |
| Codex | `OPENAI_API_KEY`, `CODEX_API_KEY` | OpenAI API Key |
| Nexus | 无 | 无需认证 |

### 10.2 启动环境清理

Server 在启动 ACP agent 时会清理以下环境变量：
- `NODE_OPTIONS` - Electron 注入的 Node 选项
- `NODE_INSPECT` - Node 调试选项
- `npm_*` - npm 生命周期变量
- `CLAUDECODE` - 防止嵌套会话检测

---

## 十一、实现状态

### 11.1 功能清单

| 功能 | 状态 | 优先级 |
|------|------|--------|
| ACP Backend 框架 | 待实现 | P0 |
| Claude Code ACP | 待实现 | P0 |
| Gemini CLI ACP | 待实现 | P0 |
| WebSocket ACP 适配 | 待实现 | P0 |
| Session 取消接口 | 待实现 | P0 |
| 模型切换接口 | 待实现 | P1 |
| 模式切换接口 | 待实现 | P1 |
| Backend 列表接口 | 待实现 | P1 |
| 配置选项接口 | 待实现 | P2 |
| Token 使用量推送 | 待实现 | P2 |
| Nexus ACP | 待实现 | P2 |
| 自定义 Agent | 待实现 | P2 |

---

## 十二、参考资源

- [ACP Protocol Spec](https://github.com/anthropics/anthropic-quickstarts/tree/main/agent-client-protocol)
- [Claude Agent ACP](https://www.npmjs.com/package/@zed-industries/claude-agent-acp)
- [Codex ACP Bridge](https://www.npmjs.com/package/@zed-industries/codex-acp)
- [Qwen Code](https://www.npmjs.com/package/@qwen-code/qwen-code)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)