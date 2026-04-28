# @zed-industries/claude-agent-acp 实现原理详解

**版本**: 0.23.1
**分析日期**: 2026-04-27
**目的**: 分析迁移到 Claude Code 的可行性

---

## 一、概述

`@zed-industries/claude-agent-acp` 是 Zed Industries 维护的 ACP (Agent Client Protocol) 桥接包，它将 Anthropic 官方的 `@anthropic-ai/claude-agent-sdk` 包装成 ACP 协议兼容的 Agent 实现。

### 1.1 核心依赖关系

```
@zed-industries/claude-agent-acp@0.23.1
├── @agentclientprotocol/sdk@0.17.0  (协议层)
└── @anthropic-ai/claude-agent-sdk@0.2.83  (Agent 能力层)
```

### 1.2 通信模型

```
┌─────────────┐                    ┌──────────────────────────────┐
│   Client    │                    │  claude-agent-acp (Bridge)   │
│  (Zed IDE)  │  stdin/stdout      │                              │
│             │◄──────────────────►│  ClaudeAcpAgent              │
│             │  JSON-RPC 2.0      │  ├─ AgentSideConnection      │
│             │                    │  ├─ SettingsManager          │
│             │                    │  └─ Tools转换层              │
└─────────────┘                    │                              │
                                   │      ↓ SDK API               │
                                   │                              │
                                   │  @anthropic-ai/claude-agent-sdk │
                                   │      ↓ HTTP API              │
                                   │                              │
                                   │  Anthropic API Server        │
                                   └──────────────────────────────┘
```

---

## 二、核心组件分析

### 2.1 ClaudeAcpAgent 类 (acp-agent.js)

这是核心 Agent 实现，实现了 ACP 协议的 `Agent` 接口。

```typescript
export class ClaudeAcpAgent {
  sessions: { [key: string]: Session };  // 会话存储
  toolUseCache: {};                       // 工具调用缓存
  backgroundTerminals: {};                // 后台终端
  client: AgentSideConnection;            // ACP 连接
  gatewayAuthMeta?: object;               // Gateway 认证元数据

  constructor(client: AgentSideConnection, logger?: Logger) {}
}
```

**实现的 ACP 方法**:

| 方法 | 实现细节 |
|------|----------|
| `initialize` | 返回协议版本、Agent 能力、认证方法 |
| `newSession` | 创建会话，调用 SDK `query()` |
| `loadSession` | 恢复会话 + 回放历史消息 |
| `listSessions` | 调用 SDK `listSessions()` |
| `prompt` | 核心：处理用户输入，驱动 SDK 流 |
| `cancel` | 中断当前操作 |
| `authenticate` | 处理 Gateway 认证 |
| `setSessionMode` | 切换权限模式 |
| `unstable_setSessionModel` | 切换模型 |
| `setSessionConfigOption` | 设置配置选项 |
| `readTextFile` | 转发给 client |
| `writeTextFile` | 转发给 client |
| `unstable_forkSession` | Fork 会话 |
| `unstable_resumeSession` | 恢复会话（无回放） |
| `unstable_closeSession` | 关闭会话 |

### 2.2 initialize 实现

```javascript
async initialize(request) {
  this.clientCapabilities = request.clientCapabilities;

  // Gateway 认证支持
  const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;
  const gatewayAuthMethod = {
    id: "gateway",
    name: "Custom model gateway",
    description: "Use a custom gateway to authenticate and access models",
    _meta: { gateway: { protocol: "anthropic" } }
  };

  // Terminal 认证支持
  const terminalAuthMethod = {
    id: "claude-login",
    type: "terminal",
    args: ["--cli"]
  };

  return {
    protocolVersion: 1,
    agentCapabilities: {
      _meta: { claudeCode: { promptQueueing: true } },
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      loadSession: true,
      sessionCapabilities: { fork: {}, list: {}, resume: {}, close: {} }
    },
    agentInfo: { name: packageJson.name, title: "Claude Agent", version: packageJson.version },
    authMethods: [...]
  };
}
```

### 2.3 newSession 实现

```javascript
async newSession(params) {
  // 检查认证状态
  if (!this.gatewayAuthMeta && 存在备份文件问题) {
    throw RequestError.authRequired();
  }

  const response = await this.createSession(params, {
    resume: params._meta?.claudeCode?.options?.resume
  });

  // 发送可用命令更新
  setTimeout(() => this.sendAvailableCommandsUpdate(response.sessionId), 0);
  return response;
}
```

### 2.4 createSession 核心

这是最复杂的方法，负责启动 SDK query：

```javascript
async createSession(params, creationOpts = {}) {
  const sessionId = creationOpts.resume || randomUUID();
  const input = new Pushable();  // 可推送的消息流
  const settingsManager = new SettingsManager(params.cwd);
  await settingsManager.initialize();

  // 构建 MCP 服务器配置
  const mcpServers = {};
  for (const server of params.mcpServers) {
    if ("type" in server) {
      mcpServers[server.name] = { type: server.type, url: server.url, headers: ... };
    } else {
      mcpServers[server.name] = { type: "stdio", command: server.command, args: ... };
    }
  }

  // 权限模式解析
  const permissionMode = resolvePermissionMode(settingsManager.getSettings().permissions?.defaultMode);

  // 核心 query 配置
  const options = {
    systemPrompt: { type: "preset", preset: "claude_code" },
    cwd: params.cwd,
    mcpServers,
    permissionMode,
    canUseTool: this.canUseTool(sessionId),  // 权限回调
    includePartialMessages: true,
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    hooks: {
      PostToolUse: [createPostToolUseHook(...)]
    },
    disallowedTools: ["AskUserQuestion"],
    ...creationOpts
  };

  // 启动 SDK query
  const q = query({ prompt: input, options });
  const initializationResult = await q.initializationResult();

  // 构建会话对象
  this.sessions[sessionId] = {
    query: q,
    input: input,
    cwd: params.cwd,
    settingsManager,
    modes: { currentModeId: permissionMode, availableModes: [...] },
    models: await getAvailableModels(q, initializationResult.models, settingsManager),
    configOptions: buildConfigOptions(modes, models),
    pendingMessages: new Map(),
    ...
  };

  return { sessionId, models, modes, configOptions };
}
```

### 2.5 prompt 实现（核心消息处理循环）

```javascript
async prompt(params) {
  const session = this.sessions[params.sessionId];
  session.cancelled = false;

  const userMessage = promptToClaude(params);
  session.input.push(userMessage);

  session.promptRunning = true;
  try {
    while (true) {
      const { value: message, done } = await session.query.next();

      switch (message.type) {
        case "system":
          // 处理 init, status, compact_boundary, local_command_output 等
          break;

        case "result":
          // 处理成功/错误结果，发送 usage_update
          break;

        case "stream_event":
          // 流式事件 → 转换为 ACP notifications
          for (const notification of streamEventToAcpNotifications(message, ...)) {
            await this.client.sessionUpdate(notification);
          }
          break;

        case "user":
        case "assistant":
          // 处理消息回放、权限模式变更
          break;
      }
    }
  } finally {
    session.promptRunning = false;
  }
}
```

---

## 三、消息转换层

### 3.1 promptToClaude (ACP → SDK 格式)

```javascript
export function promptToClaude(prompt) {
  const content = [];
  const context = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text":
        content.push({ type: "text", text: chunk.text });
        break;

      case "resource_link":
        content.push({ type: "text", text: formatUriAsLink(chunk.uri) });
        break;

      case "resource":
        if ("text" in chunk.resource) {
          content.push({ type: "text", text: formatUriAsLink(chunk.resource.uri) });
          context.push({ type: "text", text: `<context ref="...">${chunk.resource.text}</context>` });
        }
        break;

      case "image":
        if (chunk.data) {
          content.push({ type: "image", source: { type: "base64", data: chunk.data, media_type: chunk.mimeType } });
        } else if (chunk.uri) {
          content.push({ type: "image", source: { type: "url", url: chunk.uri } });
        }
        break;
    }
  }

  content.push(...context);
  return { type: "user", message: { role: "user", content }, session_id: prompt.sessionId };
}
```

### 3.2 toAcpNotifications (SDK → ACP 格式)

```javascript
export function toAcpNotifications(content, role, sessionId, toolUseCache, client, logger, options) {
  const output = [];

  for (const chunk of content) {
    switch (chunk.type) {
      case "text":
      case "text_delta":
        output.push({
          sessionId,
          update: {
            sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: { type: "text", text: chunk.text }
          }
        });
        break;

      case "thinking":
      case "thinking_delta":
        output.push({
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: chunk.thinking }
          }
        });
        break;

      case "tool_use":
        // 工具调用开始
        output.push({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: chunk.id,
            title: ...,  // 从 toolInfoFromToolUse 提取
            kind: ...,   // read/edit/execute/think/search/fetch/switch_mode/other
            status: "pending",
            rawInput: chunk.input
          }
        });
        break;

      case "tool_result":
        // 工具调用完成
        output.push({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: chunk.tool_use_id,
            status: chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content
          }
        });
        break;
    }
  }

  return output;
}
```

### 3.3 toolInfoFromToolUse (工具信息提取)

```javascript
export function toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd) {
  const name = toolUse.name;

  switch (name) {
    case "Bash":
      return { title: input.command, kind: "execute", content: [{ type: "terminal", terminalId: toolUse.id }] };

    case "Read":
      return { title: "Read " + displayPath, kind: "read", locations: [{ path: input.file_path, line: input.offset }] };

    case "Edit":
      return { title: "Edit " + displayPath, kind: "edit", content: [{ type: "diff", path: ..., oldText: ..., newText: ... }] };

    case "Write":
      return { title: "Write " + displayPath, kind: "edit", content: [{ type: "diff", ... }] };

    case "Glob":
      return { title: "Find ...", kind: "search" };

    case "Grep":
      return { title: "grep ...", kind: "search" };

    case "WebFetch":
      return { title: "Fetch " + url, kind: "fetch" };

    case "WebSearch":
      return { title: query, kind: "fetch" };

    case "TodoWrite":
      return { title: "Update TODOs", kind: "think" };

    case "ExitPlanMode":
      return { title: "Ready to code?", kind: "switch_mode" };

    default:
      return { title: name, kind: "other" };
  }
}
```

---

## 四、权限管理

### 4.1 canUseTool 回调

```javascript
canUseTool(sessionId) {
  return async (toolName, toolInput, { signal, suggestions, toolUseID }) => {
    const session = this.sessions[sessionId];

    // bypassPermissions 模式直接放行
    if (session.modes.currentModeId === "bypassPermissions") {
      return { behavior: "allow", updatedInput: toolInput, updatedPermissions: suggestions };
    }

    // ExitPlanMode 特殊处理
    if (toolName === "ExitPlanMode") {
      const response = await this.client.requestPermission({
        options: [
          { kind: "allow_always", name: "Yes, and auto-accept edits", optionId: "acceptEdits" },
          { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
          { kind: "reject_once", name: "No, keep planning", optionId: "plan" }
        ],
        sessionId,
        toolCall: { toolCallId: toolUseID, rawInput: toolInput, ... }
      });

      // 根据用户选择更新模式
      if (response.outcome?.optionId === "acceptEdits") {
        await this.updateConfigOption(sessionId, "mode", "acceptEdits");
      }

      return { behavior: "allow" } or { behavior: "deny" };
    }

    // 通用权限请求
    const response = await this.client.requestPermission({
      options: [
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" }
      ],
      ...
    });

    return response.outcome?.optionId === "allow" ? { behavior: "allow" } : { behavior: "deny" };
  };
}
```

### 4.2 权限模式映射

```javascript
const PERMISSION_MODE_ALIASES = {
  default: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions"
};

export function resolvePermissionMode(defaultMode) {
  const normalized = defaultMode?.trim().toLowerCase();
  return PERMISSION_MODE_ALIASES[normalized] || "default";
}
```

---

## 五、SettingsManager

管理 Claude Code 的多级设置：

```javascript
export class SettingsManager {
  cwd: string;
  userSettings: {};      // ~/.claude/settings.json
  projectSettings: {};   // <cwd>/.claude/settings.json
  localSettings: {};     // <cwd>/.claude/settings.local.json
  enterpriseSettings: {};// 系统级管理设置

  async initialize() {
    await this.loadAllSettings();
    this.setupWatchers();  // 文件变更监听
  }

  mergeSettings() {
    // 权限模式优先级：enterprise > local > project > user
    // 环境变量合并
    // 模型设置覆盖
  }

  getSettings(): ClaudeCodeSettings {
    return this.mergedSettings;
  }
}
```

---

## 六、SDK 层接口

### 6.1 query() 核心 API

```typescript
// @anthropic-ai/claude-agent-sdk
const q = query({
  prompt: Pushable,    // 用户消息输入流
  options: {
    systemPrompt: string | { type: "preset", preset: "claude_code" },
    cwd: string,
    mcpServers: McpServerConfig,
    permissionMode: PermissionMode,
    canUseTool: CanUseToolCallback,
    includePartialMessages: boolean,
    hooks: HooksConfig,
    disallowedTools: string[],
    env: Record<string, string>,
    sessionId?: string,  // 恢复会话时使用
    // ...
  }
});

// 流式消费
while (true) {
  const { value: message, done } = await q.next();
  // message.type: system | result | stream_event | user | assistant | tool_progress
}

// 其他方法
await q.initializationResult();
await q.setModel(modelId);
await q.setPermissionMode(mode);
await q.interrupt();
await q.supportedCommands();
```

### 6.2 getSessionMessages

```typescript
// 获取会话历史消息
const messages = await getSessionMessages(sessionId);
// 用于 loadSession 回放
```

### 6.3 listSessions

```typescript
// 列出所有会话
const sessions = await listSessions({ dir?: cwd });
// 返回 sessionId, cwd, summary, lastModified
```

---

## 七、ACP SDK 层接口

### 7.1 AgentSideConnection

```typescript
// Agent 端连接
const connection = new AgentSideConnection(
  (client) => new ClaudeAcpAgent(client),
  ndJsonStream(stdout, stdin)
);

// 提供的方法
await connection.sessionUpdate(params);
await connection.requestPermission(params);
await connection.readTextFile(params);
await connection.writeTextFile(params);
await connection.createTerminal(params);
await connection.extMethod(method, params);
await connection.extNotification(method, params);

// 属性
connection.signal: AbortSignal;  // 连接中断信号
connection.closed: Promise<void>; // 连接关闭 Promise
```

### 7.2 ClientSideConnection

```typescript
// Client 端连接
const connection = new ClientSideConnection(
  (agent) => new MyClient(agent),
  ndJsonStream(stdin, stdout)
);

// 提供的方法
await connection.initialize(params);
await connection.newSession(params);
await connection.loadSession(params);
await connection.prompt(params);
await connection.cancel(params);
await connection.setSessionMode(params);
await connection.authenticate(params);
// ...
```

---

## 八、Session Update 类型

### 8.1 标准类型

| sessionUpdate | 说明 |
|---------------|------|
| `agent_message_chunk` | 流式文本块 |
| `agent_thought_chunk` | 思考过程块 |
| `user_message_chunk` | 用户消息块 |
| `tool_call` | 工具调用开始 |
| `tool_call_update` | 工具调用状态更新 |
| `plan` | 计划更新 (TodoWrite) |
| `usage_update` | Token 使用量更新 |
| `config_option_update` | 配置选项更新 |
| `available_commands_update` | 可用命令更新 |
| `current_mode_update` | 当前模式更新 |

### 8.2 _meta 扩展

```typescript
// Claude Code 特有 _meta
{
  sessionUpdate: "tool_call",
  _meta: {
    claudeCode: {
      toolName: string,
      toolResponse: object,  // PostToolUse hook 数据
      parentToolUseId: string  // 子 Agent 工具调用
    },
    terminal_info: { terminal_id: string },
    terminal_output: { terminal_id: string, data: string },
    terminal_exit: { terminal_id: string, exit_code: number, signal: string | null }
  }
}
```

---

## 九、迁移到 Claude Code 可行性分析

### 9.1 当前架构对比

| 层级 | claude-agent-acp | Claude Code CLI |
|------|-----------------|-----------------|
| 协议层 | @agentclientprotocol/sdk | 无 |
| Agent 层 | ClaudeAcpAgent (TypeScript) | Rust runtime |
| SDK 层 | @anthropic-ai/claude-agent-sdk | 内置 SDK 调用 |
| CLI 层 | npx 启动 | 直接执行 |

### 9.2 迁移方案

**方案 A: Rust 原生实现（推荐）**

类似 SCode 的 `acp_server.rs`，在 Claude Code Rust runtime 中添加 ACP Server：

```rust
// 参考 sudo-code/rust/crates/runtime/src/acp_server.rs
pub struct AcpServer {
    sessions: HashMap<String, Session>,
    client_capabilities: ClientCapabilities,
}

impl AcpServer {
    async fn handle_initialize(&self, request: InitializeRequest) -> InitializeResponse;
    async fn handle_new_session(&self, request: NewSessionRequest) -> NewSessionResponse;
    async fn handle_prompt(&self, request: PromptRequest) -> PromptResponse;
    // ...
}
```

**优势**:
- 性能最优，无 npx 启动开销
- 与现有 Rust runtime 架构一致
- 无需依赖外部 npm 包

**工作量**:
- 实现 JSON-RPC 2.0 协议层（约 2000 行）
- 实现消息转换层（约 1500 行）
- 实现权限回调（约 500 行）
- 总计约 4000-5000 行 Rust 代码

---

**方案 B: Node.js Bridge（轻量）**

在 Claude Code 中内置 Node.js runtime，启动 claude-agent-acp：

```rust
// Rust 侧
let child = Command::new("node")
    .arg(path_to_embedded_acp_agent)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .spawn()?;
```

**优势**:
- 工作量小（约 200 行 Rust）
- 可复用现有 claude-agent-acp 实现
- 维护成本低

**劣势**:
- npx 启动开销（约 1-2 秒）
- 需要 Node.js runtime
- 版本依赖管理

---

### 9.3 关键接口映射

| ACP 方法 | Claude Code CLI 对应 |
|----------|---------------------|
| `initialize` | CLI 启动 + --model 参数 |
| `newSession` | 会话初始化 |
| `loadSession` | `--resume <session-id>` |
| `prompt` | 用户输入处理 |
| `cancel` | Ctrl+C 中断 |
| `setSessionMode` | `--permission-mode` |
| `setSessionModel` | `/model` 命令 |

### 9.4 推荐实施步骤

1. **Phase 1**: 研究 SCode 的 `acp_server.rs` 实现
2. **Phase 2**: 实现 ACP 协议层（JSON-RPC 2.0 + ndjson stream）
3. **Phase 3**: 实现核心方法（initialize, newSession, prompt）
4. **Phase 4**: 添加权限回调（requestPermission）
5. **Phase 5**: 添加高级特性（loadSession, setSessionMode）
6. **Phase 6**: 测试与 Zed IDE 集成

---

## 十、附录

### 10.1 源码位置

| 文件 | 说明 |
|------|------|
| `/tmp/package/dist/acp-agent.js` | ClaudeAcpAgent 实现 (71KB) |
| `/tmp/package/dist/tools.js` | 工具信息转换 (21KB) |
| `/tmp/package/dist/settings.js` | 设置管理 (7KB) |
| `/tmp/package/dist/index.js` | 入口 + runAcp() |
| `/Users/bgd/repo/sudowork/package/dist/acp.d.ts` | ACP SDK 类型定义 |
| `/Users/bgd/repo/sudowork/package/dist/schema/types.gen.d.ts` | ACP 协议类型 |

### 10.2 参考资源

- [ACP 协议官网](https://agentclientprotocol.com)
- [SCode ACP 实现](~/repo/sudo-code/rust/crates/runtime/src/acp_server.rs)
- [SCode ACP API 文档](~/repo/moss/docs/SCODE-ACP-API.md)
- [Sudowork ACP 客户端](~/repo/sudowork/src/agent/acp/)