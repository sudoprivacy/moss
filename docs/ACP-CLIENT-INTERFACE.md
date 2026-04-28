# ACP Client (Zed IDE) 接口详解

**协议版本**: ACP v1
**SDK 版本**: @agentclientprotocol/sdk@0.17.0
**分析日期**: 2026-04-27

---

## 一、Client 角色概述

在 ACP 协议中，Client（如 Zed IDE）是用户界面端，负责：
- 发送请求到 Agent（如 claude-agent-acp）
- 响应 Agent 的请求（权限请求、文件操作、终端创建等）
- 接收 Agent 的通知（session/update）

```
┌─────────────────┐                    ┌─────────────────┐
│  Client (Zed)   │                    │  Agent          │
│                 │  ClientRequest      │                 │
│  ─────────────  │ ──────────────────► │  ─────────────  │
│  initialize     │                     │  initialize()   │
│  newSession     │                     │  newSession()   │
│  prompt         │                     │  prompt()       │
│  ...            │                     │  ...            │
│                 │                     │                 │
│                 │  AgentRequest        │                 │
│                 │ ◄──────────────────  │                 │
│  requestPermiss │                     │  (permission)   │
│  readTextFile   │                     │  (file read)    │
│  writeTextFile  │                     │  (file write)   │
│  createTerminal │                     │  (terminal)     │
│  ...            │                     │                 │
│                 │                     │                 │
│                 │  AgentNotification   │                 │
│                 │ ◄──────────────────  │                 │
│  sessionUpdate  │                     │  (streaming)    │
│                 │                     │                 │
└─────────────────┘                    └─────────────────┘
```

---

## 二、ClientCapabilities（初始化时声明）

Client 在 `initialize` 请求中声明自己的能力：

```typescript
export type ClientCapabilities = {
  _meta?: { [key: string]: unknown };

  // 认证能力
  auth?: AuthCapabilities;  // { terminal?: boolean }

  // 文件系统能力
  fs?: FileSystemCapabilities;  // { readTextFile?: boolean, writeTextFile?: boolean }

  // 终端能力
  terminal?: boolean;  // 支持所有 terminal* 方法

  // Elicitation 能力（实验性）
  elicitation?: ElicitationCapabilities;  // { form?: {}, url?: {} }

  // NES 能力（实验性）
  nes?: ClientNesCapabilities;  // { jump?, rename?, searchAndReplace? }

  // 位置编码（实验性）
  positionEncodings?: Array<PositionEncodingKind>;
};
```

---

## 三、Client 发送的请求（ClientRequest）

| 方法 | 说明 | 参数 | 响应 |
|------|------|------|------|
| `initialize` | 协议握手 | `protocolVersion, clientCapabilities, clientInfo` | `protocolVersion, agentCapabilities, authMethods` |
| `authenticate` | 认证 | `methodId` | 空 |
| `newSession` | 创建新会话 | `cwd, mcpServers, additionalDirectories` | `sessionId, modes, models, configOptions` |
| `loadSession` | 加载会话 | `sessionId, cwd, mcpServers, additionalDirectories` | `sessionId, modes, models, configOptions` |
| `listSessions` | 列出会话 | `cwd, additionalDirectories, cursor` | `sessions, nextCursor` |
| `forkSession` | Fork 会话 | `sessionId, cwd, mcpServers` | `sessionId, modes, models` |
| `resumeSession` | 恢复会话 | `sessionId, cwd, additionalDirectories` | `sessionId, modes, models` |
| `closeSession` | 关闭会话 | `sessionId` | 空 |
| `setSessionMode` | 设置模式 | `sessionId, modeId` | 空 |
| `setSessionConfigOption` | 设置配置 | `sessionId, configId, value` | `configOptions` |
| `prompt` | 发送消息 | `sessionId, prompt (ContentBlock[])` | `stopReason, usage` |
| `setSessionModel` | 设置模型 | `sessionId, modelId` | 空 |
| `startNes` | 启动 NES | `sessionId, uri, text` | `nesSessionId` |
| `suggestNes` | NES 建议 | `nesSessionId, position` | `suggestions` |
| `closeNes` | 关闭 NES | `nesSessionId` | 空 |
| `listProviders` | 列出 Provider | 空 | `providers` |
| `setProviders` | 设置 Provider | `providers` | 空 |
| `disableProviders` | 禁用 Provider | `id` | 空 |
| `logout` | 登出 | 空 | 空 |
| `extMethod` | 扩展方法 | `method, params` | 自定义 |

---

## 四、Client 响应的请求（AgentRequest → ClientResponse）

Agent 会向 Client 发送请求，Client 必须响应：

### 4.1 requestPermission

Agent 请求用户授权工具调用：

```typescript
// Agent 发送
RequestPermissionRequest {
  sessionId: SessionId;
  toolCall: {
    toolCallId: string;
    rawInput: object;
    title: string;
    kind: ToolKind;  // read/edit/execute/think/search/fetch/switch_mode/other
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
  };
  options: Array<{
    kind: "allow_always" | "allow_once" | "reject_once";
    name: string;
    optionId: string;
  }>;
}

// Client 响应
RequestPermissionResponse {
  outcome: {
    outcome: "selected" | "cancelled";
    optionId?: string;  // 用户选择的选项
  };
}
```

### 4.2 readTextFile

Agent 请求读取文件：

```typescript
// Agent 发送
ReadTextFileRequest {
  uri: string;  // file:// 路径
}

// Client 响应
ReadTextFileResponse {
  content: string;  // 文件内容
}
```

### 4.3 writeTextFile

Agent 请求写入文件：

```typescript
// Agent 发送
WriteTextFileRequest {
  uri: string;
  content: string;
}

// Client 响应
WriteTextFileResponse {}  // 空（成功时）
```

### 4.4 createTerminal

Agent 请求创建终端执行命令：

```typescript
// Agent 发送
CreateTerminalRequest {
  sessionId: SessionId;
  command: string;
  args?: string[];
  cwd?: string;
  env?: EnvVariable[];
  outputByteLimit?: number;
}

// Client 响应
CreateTerminalResponse {
  terminalId: string;
}
```

### 4.5 terminalOutput

获取终端当前输出：

```typescript
// Agent 发送
TerminalOutputRequest {
  sessionId: SessionId;
  terminalId: string;
}

// Client 响应
TerminalOutputResponse {
  output: string;
  exitCode?: number;
  signal?: string;
}
```

### 4.6 releaseTerminal

释放终端资源：

```typescript
// Agent 发送
ReleaseTerminalRequest {
  sessionId: SessionId;
  terminalId: string;
}

// Client 响应
ReleaseTerminalResponse {}  // 空
```

### 4.7 waitForTerminalExit

等待终端退出：

```typescript
// Agent 发送
WaitForTerminalExitRequest {
  sessionId: SessionId;
  terminalId: string;
}

// Client 响应
WaitForTerminalExitResponse {
  exitCode: number;
  signal?: string;
}
```

### 4.8 killTerminal

终止终端命令：

```typescript
// Agent 发送
KillTerminalRequest {
  sessionId: SessionId;
  terminalId: string;
}

// Client 响应
KillTerminalResponse {}  // 空
```

### 4.9 createElicitation（实验性）

Agent 请求用户输入（表单或 URL）：

```typescript
// Agent 发送
CreateElicitationRequest {
  mode: "form" | "url";
  message: string;

  // form 模式
  requestedSchema?: ElicitationSchema;  // JSON Schema

  // url 模式
  elicitationId?: string;
  url?: string;

  // scope
  sessionId?: SessionId;
  toolCallId?: string;
  requestId?: RequestId;
}

// Client 响应
CreateElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: { [key: string]: value };  // accept 时用户提供的数据
}
```

### 4.10 extMethod

扩展方法：

```typescript
// Agent 发送
ExtRequest { method: string, params: object }

// Client 响应
ExtResponse { 自定义 }
```

---

## 五、Client 发送的通知（ClientNotification）

Client 可以发送以下通知（无需响应）：

| 通知 | 说明 | 参数 |
|------|------|------|
| `session/cancel` | 取消当前操作 | `sessionId` |
| `textDocument/didOpen` | 文档打开 | `sessionId, uri, languageId, text, version` |
| `textDocument/didChange` | 文档变更 | `sessionId, uri, version, contentChanges` |
| `textDocument/didClose` | 文档关闭 | `sessionId, uri` |
| `textDocument/didSave` | 文档保存 | `sessionId, uri` |
| `textDocument/didFocus` | 文档聚焦 | `sessionId, uri, version, position, visibleRange` |
| `nes/accept` | NES 建议被接受 | `sessionId, id` |
| `nes/reject` | NES 建议被拒绝 | `sessionId, id` |
| `cancelRequest` | 取消特定请求 | `requestId` |
| `extNotification` | 扩展通知 | 自定义 |

---

## 六、Client 接收的通知（AgentNotification）

Agent 发送给 Client 的通知：

### 6.1 session/update

核心通知，包含所有会话更新：

```typescript
SessionNotification {
  sessionId: SessionId;
  update: SessionUpdate;
}
```

**SessionUpdate 类型**：

| sessionUpdate | 说明 | 字段 |
|---------------|------|------|
| `agent_message_chunk` | Agent 文本流 | `content: ContentBlock` |
| `agent_thought_chunk` | Agent 思考流 | `content: ContentBlock` |
| `user_message_chunk` | 用户消息流 | `content: ContentBlock` |
| `tool_call` | 工具调用开始 | `toolCallId, title, kind, status, rawInput, content, locations` |
| `tool_call_update` | 工具调用更新 | `toolCallId, status, rawOutput, content, locations` |
| `plan` | 计划更新 | `entries: PlanEntry[]` |
| `usage_update` | Token 使用量 | `used, size, cost` |
| `config_option_update` | 配置更新 | `configOptions` |
| `available_commands_update` | 命令更新 | `availableCommands` |
| `current_mode_update` | 模式变更 | `currentModeId` |

### 6.2 completeElicitation

URL-based Elicitation 完成：

```typescript
CompleteElicitationNotification {
  elicitationId: string;
}
```

### 6.3 extNotification

扩展通知：

```typescript
ExtNotification { 自定义 }
```

---

## 七、ContentBlock 类型

用于消息和工具调用内容：

```typescript
export type ContentBlock =
  | { type: "text"; text: string; }
  | { type: "image"; data?: string; mimeType: string; uri?: string; }
  | { type: "audio"; data: string; mimeType: string; }
  | { type: "resource_link"; uri: string; }
  | { type: "resource"; resource: TextResourceContents | BlobResourceContents; };
```

---

## 八、ToolCallContent 类型

工具调用显示内容：

```typescript
export type ToolCallContent =
  | { type: "content"; content: ContentBlock; }
  | { type: "diff"; path: string; oldText?: string; newText: string; }
  | { type: "terminal"; terminalId: string; };
```

---

## 九、ToolKind 类型

工具类型分类：

```typescript
export type ToolKind =
  | "read"     // 文件读取
  | "edit"     // 文件编辑
  | "execute"  // 命令执行
  | "think"    // 思考/计划
  | "search"   // 搜索
  | "fetch"    // 网络请求
  | "switch_mode"  // 模式切换
  | "other";   // 其他
```

---

## 十、ToolCallLocation 类型

工具调用关联的位置：

```typescript
export type ToolCallLocation = {
  path: string;
  line?: number;
};
```

---

## 十一、Session Config Option

会话配置选项：

```typescript
export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string;
  category: string;  // "mode" | "model" | 其他
  type: "select" | "string" | "boolean";
  currentValue?: string | boolean;
  options?: Array<{
    value: string;
    name: string;
    description?: string;
  }>;
};
```

---

## 十二、完整 Client 接口定义

```typescript
export interface Client {
  // 必须实现的方法
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;

  // 可选方法（取决于 clientCapabilities）
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput?(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  releaseTerminal?(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | void>;
  waitForTerminalExit?(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse | void>;

  // 实验性方法
  unstable_createElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  unstable_completeElicitation?(params: CompleteElicitationNotification): Promise<void>;

  // 扩展方法
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>;
}
```

---

## 十三、Zed IDE 特有 _meta 扩展

Zed IDE 通过 `_meta` 字段支持额外功能：

### 13.1 terminal_output

```typescript
{
  sessionUpdate: "tool_call_update",
  _meta: {
    terminal_output: {
      terminal_id: string;
      data: string;  // 终端输出数据
    }
  }
}
```

### 13.2 terminal_exit

```typescript
{
  sessionUpdate: "tool_call_update",
  _meta: {
    terminal_exit: {
      terminal_id: string;
      exit_code: number;
      signal: string | null;
    }
  }
}
```

### 13.3 terminal-auth

```typescript
// ClientCapabilities._meta
{
  "terminal-auth": true
}

// AuthMethod._meta
{
  "terminal-auth": {
    command: string;
    args: string[];
    label: string;
  }
}
```

### 13.4 gateway 认证

```typescript
// ClientCapabilities._meta
{
  auth: {
    _meta: {
      gateway: true
    }
  }
}

// AuthMethod
{
  id: "gateway",
  _meta: {
    gateway: {
      protocol: "anthropic"
    }
  }
}
```

---

## 十四、参考资源

- [ACP 协议官网](https://agentclientprotocol.com)
- [协议文档 - Client](https://agentclientprotocol.com/protocol/overview#client)
- [协议文档 - Tool Calls](https://agentclientprotocol.com/protocol/tool-calls)
- [协议文档 - Terminals](https://agentclientprotocol.com/protocol/terminals)
- [协议文档 - Session Modes](https://agentclientprotocol.com/protocol/session-modes)