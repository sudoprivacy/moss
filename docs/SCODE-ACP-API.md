# SCode ACP 接口文档

本文档描述 `scode` (sudo-code) CLI 对 ACP（Agent Client Protocol）协议的支持。

**版本**: v1.0.0
**源码**: [sudo-code/rust/crates/runtime/src/acp_server.rs](https://github.com/sudoprivacy/sudo-code/tree/main/rust/crates/runtime/src/acp_server.rs)
**状态**: 已实现（最小化版本）

---

## 一、启动方式

### 1.1 命令格式

```bash
# 三种等效的启动方式
scode acp
scode acp serve
scode --acp      # flag 形式
scode -acp       # 短 flag 形式
```

### 1.2 支持的 CLI 参数

ACP 模式支持以下全局参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `--model MODEL` | 指定模型 | `--model opus`, `--model claude-sonnet-4-6`, `--model anthropic/claude-opus-4-6` |
| `--auth MODE` | 认证模式 | `subscription`, `proxy`, `api-key` |
| `--permission-mode MODE` | 权限模式 | `read-only`, `workspace-write`, `danger-full-access` |
| `--dangerously-skip-permissions` | 跳过所有权限检查 | 等同于 `--permission-mode danger-full-access` |
| `--allowedTools TOOLS` | 限制可用工具 | `--allowedTools read,glob,bash` |
| `--reasoning-effort LEVEL` | 推理强度 | `low`, `medium`, `high` |

### 1.3 模型别名

SCode 支持以下模型别名：

| 别名 | 实际模型 |
|------|---------|
| `opus` | `claude-opus-4-6` |
| `claude-opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-6` |
| `claude-sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5-20251213` |
| `claude-haiku` | `claude-haiku-4-5-20251213` |

也可使用 `provider/model` 格式（如 `anthropic/claude-opus-4-6`），或通过 `sudocode.json` 配置自定义模型别名。

### 1.4 使用示例

```bash
# 基本启动
scode acp

# 指定模型
scode --model opus acp

# 指定模型 + 权限模式
scode --model claude-sonnet-4-6 --permission-mode workspace-write acp

# 通过代理认证
scode --auth proxy --model anthropic/claude-opus-4-6 acp

# 跳过权限检查
scode --dangerously-skip-permissions acp

# 限制工具集
scode --allowedTools read,glob acp
```

---

## 二、协议实现

### 2.1 支持的方法

| Method | 说明 | 实现状态 |
|--------|------|---------|
| `initialize` | 协议握手 | ✅ 已实现 |
| `session/new` | 创建新会话 | ✅ 已实现 |
| `session/prompt` | 发送用户消息 | ✅ 已实现 |
| `session/load` | 恢复会话 | ❌ 不支持 (`loadSession: false`) |
| `session/cancel` | 取消当前操作 | ❌ 未实现 |
| `session/set_mode` | 设置会话模式 | ❌ 未实现 |
| `session/set_model` | 切换模型 | ❌ 未实现（通过 `/model` slash command） |
| `session/set_config_option` | 设置配置选项 | ❌ 未实现 |
| `session/request_permission` | 权限请求 | ❌ 未实现 |
| `fs/read_text_file` | 文件读取请求 | ❌ 未实现 |
| `fs/write_text_file` | 文件写入请求 | ❌ 未实现 |

### 2.2 Session Update 类型

| Update Type | 说明 | 实现状态 |
|-------------|------|---------|
| `agent_message_chunk` | 流式文本块 | ✅ 已实现 |
| `agent_thought_chunk` | 思考过程块 | ❌ 未实现 |
| `tool_call` | 工具调用开始 | ✅ 已实现 |
| `tool_call_update` | 工具调用状态更新 | ✅ 已实现 |
| `plan` | 计划更新 | ❌ 未实现 |
| `config_option_update` | 配置选项更新 | ❌ 未实现 |
| `usage_update` | Token 使用量更新 | ❌ 未实现 |
| `available_commands_update` | 可用命令更新 | ❌ 未实现 |

---

## 三、API 详细说明

### 3.1 initialize

初始化协议握手。

**Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      }
    }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentInfo": {
      "name": "scode",
      "version": "<version>"
    },
    "agentCapabilities": {
      "loadSession": false,
      "promptCapabilities": {
        "image": false,
        "audio": false,
        "embeddedContext": false
      },
      "mcpCapabilities": {
        "http": false,
        "sse": false
      },
      "sessionCapabilities": {}
    },
    "authMethods": []
  }
}
```

**参数说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `protocolVersion` | number | 协议版本，默认为 1 |
| `clientCapabilities` | object | 客户端能力声明 |

**返回字段说明**:

| 字段 | 说明 |
|------|------|
| `agentInfo.name` | 固定为 `"scode"` |
| `agentInfo.version` | CLI 版本号 |
| `agentCapabilities.loadSession` | 是否支持 session/load（当前为 `false`） |
| `promptCapabilities.image` | 是否支持图片输入（当前为 `false`） |
| `promptCapabilities.audio` | 是否支持音频输入（当前为 `false`） |
| `mcpCapabilities.http` | 是否支持 HTTP MCP（当前为 `false`） |
| `authMethods` | 认证方法列表（当前为空数组） |

---

### 3.2 session/new

创建新会话。

**Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/absolute/path/to/workspace",
    "mcpServers": []
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "session-uuid-string"
  }
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | string | 否 | 工作目录，**必须是绝对路径**。未提供时使用当前目录 |
| `mcpServers` | array | 否 | MCP 服务器配置，当前未使用 |

**错误情况**:

| 错误 | 说明 |
|------|------|
| `params.cwd must be a string` | cwd 不是字符串 |
| `params.cwd must be an absolute path` | cwd 是相对路径 |
| `params.cwd must be a directory` | cwd 不是目录 |
| `params.cwd is not accessible` | cwd 无法访问 |

**注意事项**:
- `cwd` 必须是绝对路径，不支持相对路径（如 `.` 或 `src/`）
- 会话文件会自动保存到 `.scode/sessions/<session-id>.jsonl`

---

### 3.3 session/prompt

发送用户消息。

**Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "session-uuid-string",
    "prompt": {
      "content": [
        { "type": "text", "text": "用户消息内容" }
      ]
    }
  }
}
```

**Response** (在所有 session/update 发送完毕后):
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "stopReason": "end_turn"
  }
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话 ID，必须是 `session/new` 返回的有效 ID |
| `prompt` | object | 是 | 消息内容 |
| `prompt.content` | array | 是 | 内容块数组，必须包含至少一个 `text` 类型块 |

**Prompt Content Block 格式**:

```typescript
interface PromptContentBlock {
  type: "text" | "image" | "resource_link";  // 当前仅支持 text
  text?: string;  // type=text 时必填
}
```

**示例 - 多个文本块**:
```json
{
  "prompt": {
    "content": [
      { "type": "text", "text": "First message" },
      { "type": "resource_link", "uri": "file:///tmp/a.txt" },  // 被忽略
      { "type": "text", "text": "Second message" }
    ]
  }
}
```

实际发送的文本为 `First message\nSecond message`（多个文本块以换行符连接）。

**错误情况**:

| 错误 | 说明 |
|------|------|
| `params.sessionId must be a non-empty string` | sessionId 为空或缺失 |
| `params.prompt is required` | prompt 参数缺失 |
| `params.prompt.content must be an array` | content 不是数组 |
| `params.prompt must include at least one text content block` | 没有 text 类型块 |
| `unknown sessionId: <id>` | sessionId 不存在 |

---

## 四、Session Update 消息格式

### 4.1 agent_message_chunk

流式文本输出。

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
        "text": "文本片段..."
      }
    }
  }
}
```

### 4.2 tool_call

工具调用开始。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-uuid",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "toolu_123",
      "title": "read_file",
      "kind": "other",
      "status": "in_progress",
      "rawInput": { "file_path": "Cargo.toml" }
    }
  }
}
```

**字段说明**:

| 字段 | 说明 |
|------|------|
| `toolCallId` | 工具调用唯一 ID |
| `title` | 工具名称 |
| `kind` | 工具类型：`read`, `edit`, `execute`, `other` |
| `status` | 状态：`pending`, `in_progress`, `completed`, `failed` |
| `rawInput` | 工具输入参数（JSON 或字符串） |

### 4.3 tool_call_update

工具调用完成/失败。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-uuid",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "toolu_123",
      "status": "completed",
      "rawOutput": { "ok": true },
      "content": [
        {
          "type": "content",
          "content": {
            "type": "text",
            "text": "工具输出内容..."
          }
        }
      ]
    }
  }
}
```

---

## 五、ACP 模式下的 Slash Commands

SCode 在 ACP 模式下支持本地 slash commands，这些命令不会发送到 LLM，而是在本地执行。

### 5.1 支持的 Slash Commands

| Command | 说明 | 示例 |
|---------|------|------|
| `/help` | 显示帮助信息 | `/help` |
| `/model <model-id>` | 切换模型 | `/model opus`, `/model claude-sonnet-4-6` |
| `/status` | 显示当前状态 | `/status` |
| `/cost` | 显示 Token 使用量 | `/cost` |
| `/config [section]` | 显示配置 | `/config`, `/config env` |
| `/diff` | 显示 Git diff | `/diff` |

### 5.2 Slash Command 示例

发送 `/model opus` 作为 prompt：

**Request**:
```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "...",
    "prompt": {
      "content": [
        { "type": "text", "text": "/model opus" }
      ]
    }
  }
}
```

**Session Updates**:
```json
{
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {
        "type": "text",
        "text": "Model switched to opus (claude-opus-4-6)"
      }
    }
  }
}
```

**Response**:
```json
{
  "result": { "stopReason": "end_turn" }
}
```

---

## 六、与标准 ACP 的差异

### 6.1 不支持的特性

| 特性 | 标准 ACP | SCode 状态 |
|------|---------|------------|
| `session/load` | 支持恢复会话 | ❌ `loadSession: false` |
| `session/cancel` | 支持取消当前操作 | ❌ 未实现 |
| `session/set_mode` | 支持会话模式切换 | ❌ 未实现 |
| `session/set_model` | 支持模型切换 API | ❌ 通过 `/model` 命令实现 |
| `session/set_config_option` | 支持配置选项 | ❌ 未实现 |
| 图片输入 | 支持 `image` 类型块 | ❌ 仅支持 `text` |
| 权限请求 | 支持 `request_permission` | ❌ 未实现 |
| 文件操作请求 | 支持 `fs/read_text_file`, `fs/write_text_file` | ❌ 未实现 |
| Token 使用量 | 支持 `usage_update` | ❌ 通过 `/cost` 命令查看 |
| MCP 集成 | 支持 HTTP/SSE MCP | ❌ 未实现 |

### 6.2 SCode 特有特性

| 特性 | 说明 |
|------|------|
| Slash Commands | 支持本地执行的 `/model`, `/status`, `/cost` 等命令 |
| 自动会话持久化 | 会话自动保存到 `.scode/sessions/` |
| sudocode.json 配置 | 支持通过配置文件定义模型别名和认证方式 |
| 多认证模式 | 支持 `subscription`, `proxy`, `api-key` 三种认证方式 |

---

## 七、错误码

SCode ACP 使用标准 JSON-RPC 错误码：

| Code | 名称 | 说明 |
|------|------|------|
| -32700 | Parse Error | JSON 解析失败 |
| -32600 | Invalid Request | 请求格式无效（不是对象） |
| -32601 | Method Not Found | 方法不存在 |
| -32602 | Invalid Params | 参数无效 |
| -32603 | Internal Error | 内部错误 |

**错误响应示例**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "params.cwd must be an absolute path"
  }
}
```

---

## 八、会话管理

### 8.1 会话存储

SCode ACP 会话自动保存到：
```
.scode/sessions/<session-id>.jsonl
```

### 8.2 会话文件格式

会话文件使用 JSONL 格式，每行一个 JSON 对象，记录消息和工具调用。

---

## 九、环境变量

### 9.1 认证相关

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API Key（api-key 认证模式） |
| `SUDO_CODE_PERMISSION_MODE` | 默认权限模式 |
| `ANTHROPIC_MODEL` | 默认模型（未指定 `--model` 时使用） |

### 9.2 代理配置

当使用 `--auth proxy` 模式时，API 请求会通过 `sudocode.json` 中配置的代理服务发送。

---

## 十、参考资源

- [SCode 源码](https://github.com/sudoprivacy/sudo-code)
- [ACP 协议概述](./ACP-SUPPORT.md)
- [Sudowork ACP 客户端实现](./API-ACP-OVERVIEW.md)