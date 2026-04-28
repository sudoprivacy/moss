# Claude Code ACP Server 实现计划

**目标**: 在 moss/src（Claude Code 源代码）中添加 `--acp` 参数支持，使其作为 ACP Agent Server 运行

**日期**: 2026-04-27

**状态**: ✅ 已完成基本实现

---

## 一、现状分析

### 1.1 已有基础设施

| 文件 | 功能 | 状态 |
|------|------|------|
| `server/types/acpTypes.ts` | ACP 类型定义 | ✅ 完整 |
| `server/backends/acpBackend.ts` | ACP Client 实现 | ✅ 完整（连接其他 agents） |
| `server/server.ts` | HTTP Server | ✅ 有 ACP 字段存储 |
| `server/db.ts` | Session 存储 | ✅ 有 ACP 字段 |
| `main.tsx` | CLI 入口 | ❌ 无 --acp 参数 |

### 1.2 需要新增

- CLI 参数 `--acp`
- ACP Server 实现（stdin/stdout JSON-RPC）
- 消息转换层（Claude Code → ACP 格式）
- ACP Agent 实现（initialize, newSession, prompt, cancel 等）

---

## 二、实现方案

### 2.1 新增文件

```
src/server/acpServer/
├── index.ts              # 入口，启动 ACP Server
├── acpAgent.ts           # ACP Agent 实现（核心）
├── messageConverter.ts   # 消息转换层
├── sessionManager.ts     # ACP Session 管理
└── permissionHandler.ts  # 权限请求处理
```

### 2.2 CLI 参数添加

在 `main.tsx` 中添加：

```typescript
program
  .option('--acp', 'Start as ACP Agent Server (stdin/stdout JSON-RPC)')
  .option('--acp-mode <mode>', 'ACP permission mode (default, plan, acceptEdits, bypassPermissions)')
  .option('--acp-model <model>', 'ACP model override')
```

### 2.3 ACP Server 入口

```typescript
// src/server/acpServer/index.ts
export async function startAcpServer(options: AcpServerOptions): Promise<void> {
  // 创建 ndjson stream
  const stream = createNdJsonStream(process.stdin, process.stdout)

  // 创建 Agent
  const agent = new ClaudeCodeAcpAgent(options)

  // 启动 JSON-RPC 连接
  await runJsonRpcServer(stream, agent)
}
```

---

## 三、ACP Agent 核心实现

### 3.1 ClaudeCodeAcpAgent 类

```typescript
export class ClaudeCodeAcpAgent {
  sessions: Map<string, AcpSessionState>
  clientCapabilities: ClientCapabilities

  // 必须实现的方法
  async initialize(request: InitializeRequest): InitializeResponse
  async newSession(request: NewSessionRequest): NewSessionResponse
  async loadSession(request: LoadSessionRequest): LoadSessionResponse
  async listSessions(request: ListSessionsRequest): ListSessionsResponse
  async prompt(request: PromptRequest): PromptResponse
  async cancel(request: CancelNotification): void
  async setSessionMode(request: SetSessionModeRequest): SetSessionModeResponse
  async setSessionConfigOption(request: SetSessionConfigOptionRequest): SetSessionConfigOptionResponse
  async authenticate(request: AuthenticateRequest): AuthenticateResponse

  // Client 请求处理
  async handleRequestPermission(request: RequestPermissionRequest): RequestPermissionResponse
  async handleReadTextFile(request: ReadTextFileRequest): ReadTextFileResponse
  async handleWriteTextFile(request: WriteTextFileRequest): WriteTextFileResponse
}
```

### 3.2 initialize 实现

```typescript
async initialize(request: InitializeRequest): InitializeResponse {
  this.clientCapabilities = request.clientCapabilities

  return {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      loadSession: true,
      sessionCapabilities: { fork: {}, list: {}, resume: {}, close: {} }
    },
    agentInfo: {
      name: 'claude-code',
      title: 'Claude Code',
      version: getVersion()
    },
    authMethods: []  // Claude Code 自带认证
  }
}
```

### 3.3 newSession 实现

```typescript
async newSession(request: NewSessionRequest): NewSessionResponse {
  const sessionId = request.sessionId || generateSessionId()
  const cwd = request.cwd || process.cwd()

  // 创建 Claude Code Query
  const query = await createQuery({
    cwd,
    mcpServers: request.mcpServers,
    permissionMode: this.options.acpMode || 'default',
    model: this.options.acpModel,
    // ... 其他配置
  })

  this.sessions.set(sessionId, {
    query,
    cwd,
    modes: { currentModeId: 'default', availableModes: [...] },
    models: { currentModelId: ..., availableModels: [...] },
    configOptions: [...]
  })

  return {
    sessionId,
    modes: session.modes,
    models: session.models,
    configOptions: session.configOptions
  }
}
```

### 3.4 prompt 实现（核心）

```typescript
async prompt(request: PromptRequest): PromptResponse {
  const session = this.sessions.get(request.sessionId)
  if (!session) throw new Error('Session not found')

  // 转换 ACP prompt → Claude Code message
  const userMessage = convertAcpPromptToClaudeCode(request.prompt)

  // 发送到 Query
  session.query.sendUserMessage(userMessage)

  // 处理流式响应
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, ... }

  try {
    while (true) {
      const event = await session.query.nextEvent()

      switch (event.type) {
        case 'message_chunk':
          await this.sendSessionUpdate({
            sessionId: request.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: event.content }
          })
          break

        case 'tool_call':
          await this.sendSessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: event.toolCallId,
              title: event.title,
              kind: event.kind,
              status: 'pending',
              rawInput: event.input
            }
          })
          break

        case 'tool_result':
          await this.sendSessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: event.toolCallId,
              status: event.isError ? 'failed' : 'completed',
              rawOutput: event.output
            }
          })
          break

        case 'end_turn':
          return { stopReason: 'end_turn', usage: accumulatedUsage }

        case 'cancelled':
          return { stopReason: 'cancelled' }
      }
    }
  } catch (error) {
    return { stopReason: 'error', error: error.message }
  }
}
```

---

## 四、消息转换层

### 4.1 ACP → Claude Code

```typescript
export function convertAcpPromptToClaudeCode(prompt: AcpPrompt): UserMessage {
  const content: ContentBlock[] = []

  for (const block of prompt.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break

      case 'image':
        if (block.data) {
          content.push({
            type: 'image',
            source: { type: 'base64', data: block.data, media_type: block.mimeType }
          })
        }
        break

      case 'resource_link':
        content.push({ type: 'text', text: formatResourceLink(block.uri) })
        break

      case 'resource':
        if ('text' in block.resource) {
          content.push({ type: 'text', text: formatResourceLink(block.resource.uri) })
          // 添加嵌入式上下文
          content.push({
            type: 'text',
            text: `<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>`
          })
        }
        break
    }
  }

  return { role: 'user', content }
}
```

### 4.2 Claude Code → ACP

```typescript
export function convertClaudeCodeToAcpUpdate(
  event: ClaudeCodeEvent,
  sessionId: string
): AcpSessionUpdate {
  switch (event.type) {
    case 'text_chunk':
      return {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.text }
        }
      }

    case 'thinking_chunk':
      return {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: event.thinking }
        }
      }

    case 'tool_use':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: event.id,
          title: getToolTitle(event.name, event.input),
          kind: getToolKind(event.name),
          status: 'pending',
          rawInput: event.input
        }
      }

    case 'tool_result':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolUseId,
          status: event.isError ? 'failed' : 'completed',
          rawOutput: event.output,
          content: formatToolOutput(event)
        }
      }

    case 'todo_update':
      return {
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: event.todos.map(t => ({
            content: t.content,
            status: t.status,
            priority: 'medium'
          }))
        }
      }
  }
}
```

---

## 五、工具信息提取

```typescript
export function getToolTitle(name: string, input: any): string {
  switch (name) {
    case 'Bash':
      return input?.command || 'Terminal'
    case 'Read':
      return `Read ${input?.file_path || 'File'}`
    case 'Edit':
      return `Edit ${input?.file_path || 'File'}`
    case 'Write':
      return `Write ${input?.file_path || 'File'}`
    case 'Glob':
      return `Find ${input?.pattern || ''}`
    case 'Grep':
      return `grep "${input?.pattern || ''}"`
    case 'WebFetch':
      return `Fetch ${input?.url || ''}`
    case 'WebSearch':
      return `"${input?.query || ''}"`
    default:
      return name
  }
}

export function getToolKind(name: string): ToolKind {
  switch (name) {
    case 'Read': return 'read'
    case 'Edit': return 'edit'
    case 'Write': return 'edit'
    case 'Bash': return 'execute'
    case 'Glob': return 'search'
    case 'Grep': return 'search'
    case 'WebFetch': return 'fetch'
    case 'WebSearch': return 'fetch'
    case 'TodoWrite': return 'think'
    case 'ExitPlanMode': return 'switch_mode'
    default: return 'other'
  }
}
```

---

## 六、JSON-RPC Server 实现

```typescript
// src/server/acpServer/jsonRpcServer.ts
export async function runJsonRpcServer(
  stream: NdJsonStream,
  agent: ClaudeCodeAcpAgent
): Promise<void> {
  const pendingRequests = new Map<string, PendingRequest>()

  // 处理 incoming messages
  stream.onMessage(async (message) => {
    try {
      // Request（有 id）
      if ('id' in message && 'method' in message) {
        const result = await handleRequest(agent, message)
        stream.write({
          jsonrpc: '2.0',
          id: message.id,
          result
        })
      }

      // Notification（无 id）
      if (!('id' in message) && 'method' in message) {
        await handleNotification(agent, message)
      }
    } catch (error) {
      if ('id' in message) {
        stream.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error.message }
        })
      }
    }
  })
}
```

---

## 七、与 main.tsx 集成

```typescript
// main.tsx 添加
import { startAcpServer } from './server/acpServer/index.js'

// 在 run() 函数的 program option 中添加
program
  .option('--acp', 'Start as ACP Agent Server')
  .option('--acp-mode <mode>', 'ACP permission mode')

// 在 action handler 开头检查
if (options.acp) {
  await startAcpServer({
    mode: options.acpMode,
    model: options.model,
    cwd: getCwd()
  })
  return  // 不进入 REPL
}
```

---

## 八、实现优先级

| 优先级 | 方法 | 重要性 |
|--------|------|--------|
| P0 | initialize | 必须（协议握手） |
| P0 | newSession | 必须（创建会话） |
| P0 | prompt | 必须（核心功能） |
| P1 | cancel | 重要（用户中断） |
| P1 | setSessionMode | 重要（模式切换） |
| P2 | loadSession | 可选（恢复会话） |
| P2 | listSessions | 可选（列出会话） |
| P3 | forkSession | 可选 |
| P3 | resumeSession | 可选 |

---

## 九、测试策略

### 9.1 手动测试

```bash
# 启动 ACP Server
claude --acp

# 用 Python 测试脚本连接
python test_acp_client.py
```

### 9.2 与 Zed IDE 集成测试

配置 Zed 使用本地 ACP agent：
```json
{
  "assistant": {
    "default_agent": "claude-code-local",
    "agents": {
      "claude-code-local": {
        "type": "acp",
        "command": "claude",
        "args": ["--acp"]
      }
    }
  }
}
```

---

## 十、参考实现

- SCode ACP Server: `~/repo/sudo-code/rust/crates/runtime/src/acp_server.rs`
- claude-agent-acp: `~/repo/moss/docs/CLAUDE-AGENT-ACP-IMPLEMENTATION.md`
- ACP Client Interface: `~/repo/moss/docs/ACP-CLIENT-INTERFACE.md`

---

## 十一、工作量估算

| 模块 | 代码行数 | 工作量 |
|------|----------|--------|
| JSON-RPC Server | ~200 | 0.5 天 |
| AcpAgent 核心 | ~500 | 1 天 |
| 消息转换层 | ~300 | 0.5 天 |
| 工具信息提取 | ~150 | 0.5 天 |
| CLI 参数集成 | ~50 | 0.5 天 |
| 测试 + 调试 | - | 1 天 |
| **总计** | ~1200 | **4 天** |

---

## 十二、已完成实现（2026-04-27）

### 12.1 实现文件

```
src/server/acpServer/
├── index.ts              # ✅ JSON-RPC Server 入口
├── acpAgent.ts           # ✅ ClaudeCodeAcpAgent 实现
├── messageConverter.ts   # ✅ 消息转换层
└── types.ts              # ✅ 类型定义

src/entrypoints/cli.tsx   # ✅ --acp fast-path 已添加
```

### 12.2 已实现的 ACP 方法

#### Client → Agent 请求

| 方法 | 状态 | 说明 |
|------|------|------|
| `initialize` | ✅ | 协议握手，返回 agentCapabilities |
| `session/new` | ✅ | 创建新会话，返回 modes, models, configOptions |
| `session/prompt` | ✅ | 处理用户输入，支持 slash commands |
| `session/cancel` | ✅ | 取消当前操作 |
| `session/set_mode` | ✅ | 设置权限模式 |
| `session/set_model` | ✅ | 设置模型 |
| `session/set_config_option` | ✅ | 设置配置选项 |
| `session/load` | ✅ | 加载会话 |
| `session/list` | ✅ | 列出会话 |
| `session/close` | ✅ | 关闭会话 |
| `session/fork` | ✅ | Fork 会话 |
| `session/resume` | ✅ | 恢复会话 |

#### Agent → Client 请求

| 方法 | 状态 | 说明 |
|------|------|------|
| `session/request_permission` | ✅ | 权限请求，请求用户授权工具调用 |
| `fs/read_text_file` | ✅ | 文件读取请求，请求 Client 读取文件 |
| `fs/write_text_file` | ✅ | 文件写入请求，请求 Client 写入文件 |
| `terminal/create` | ✅ | 终端创建请求，请求 Client 创建终端执行命令 |
| `terminal/output` | ✅ | 终端输出获取，获取终端当前输出 |
| `terminal/kill` | ✅ | 终端终止，终止终端进程 |
| `terminal/release` | ✅ | 终端释放，释放终端资源 |
| `terminal/wait_for_exit` | ✅ | 等待终端退出，等待终端进程结束 |

#### Client → Agent 通知

| 通知 | 状态 | 说明 |
|------|------|------|
| `session/cancel` | ✅ | 取消当前操作 |
| `textDocument/didOpen` | ✅ | 文档打开通知 |
| `textDocument/didChange` | ✅ | 文档变更通知 |
| `textDocument/didClose` | ✅ | 文档关闭通知 |
| `textDocument/didSave` | ✅ | 文档保存通知 |
| `textDocument/didFocus` | ✅ | 文档聚焦通知 |

#### Agent → Client 通知（Session Update）

| sessionUpdate | 状态 | 说明 |
|---------------|------|------|
| `agent_message_chunk` | ✅ | 流式文本输出 |
| `agent_thought_chunk` | ✅ | 思考过程输出 |
| `tool_call` | ✅ | 工具调用开始 |
| `tool_call_update` | ✅ | 工具调用状态更新 |
| `config_option_update` | ✅ | 配置选项更新 |
| `current_mode_update` | ✅ | 当前模式变更 |

### 12.3 测试结果

```bash
# 测试 initialize
$ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node cli-node.js --acp
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"loadSession":true,"sessionCapabilities":{"fork":{},"list":{},"resume":{},"close":{}}},"agentInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.88"},"authMethods":[]}}

# 测试 session/new
$ echo '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/path"}}' | node cli-node.js --acp
{"jsonrpc":"2.0","id":1,"result":{"sessionId":"...","modes":{...},"models":{...},"configOptions":[...]}}

# 测试 session/prompt (slash command)
$ echo '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"sessionId":"test","cwd":"/path"}}
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"test","prompt":{"content":[{"type":"text","text":"/help"}]}}}' | node cli-node.js --acp
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"test","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Available commands: /model, /status, /help"}}}}
{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
```

### 12.4 待完成工作

| 任务 | 优先级 | 说明 |
|------|--------|------|
| 集成 Query 循环 | P0 | 替换模拟响应，实现真实的 LLM 调用 |
| MCP 服务器支持 | P1 | 处理 mcpServers 参数，连接 MCP 工具 |
| 流式响应优化 | P1 | 完善完整的 tool_call/tool_call_update 流程 |
| Session 持久化 | P2 | 会话历史保存和恢复 |
| Permission 回调集成 | P2 | 将 requestPermission 集成到 Query 的 canUseTool 回调 |

### 12.5 启动方式

```bash
# Node.js 目标 (cli-node.js)
node cli-node.js --acp

# 可选参数
node cli-node.js --acp --model claude-opus-4-6
node cli-node.js --acp --permission-mode bypassPermissions
```

---

## 十三、接口详情

### 13.1 Client → Agent 请求

#### initialize

协议握手，交换能力信息。

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "promptCapabilities": { "image": true, "embeddedContext": true },
      "mcpCapabilities": { "http": true, "sse": true },
      "loadSession": true,
      "sessionCapabilities": { "fork": {}, "list": {}, "resume": {}, "close": {} }
    },
    "agentInfo": {
      "name": "claude-code",
      "title": "Claude Code",
      "version": "2.1.88"
    },
    "authMethods": []
  }
}
```

#### session/new

创建新会话。

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "sessionId": "optional-custom-id",
    "cwd": "/absolute/path/to/workspace",
    "mcpServers": []
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "uuid-or-custom-id",
    "modes": {
      "currentModeId": "default",
      "availableModes": [
        { "id": "default", "name": "Default" },
        { "id": "plan", "name": "Plan Mode" },
        { "id": "acceptEdits", "name": "Accept Edits" },
        { "id": "bypassPermissions", "name": "Bypass Permissions" }
      ]
    },
    "models": {
      "currentModelId": "claude-sonnet-4-6",
      "availableModels": [
        { "id": "claude-opus-4-6", "name": "Claude Opus 4.6" },
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
        { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5" }
      ]
    },
    "configOptions": [...]
  }
}
```

#### session/prompt

发送用户消息。

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "session-id",
    "prompt": {
      "content": [
        { "type": "text", "text": "用户消息内容" }
      ]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "stopReason": "end_turn",
    "usage": { "inputTokens": 100, "outputTokens": 50 }
  }
}
```

**Session Updates (notifications sent during prompt):**
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-id",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "响应文本片段" }
    }
  }
}
```

---

### 13.2 Agent → Client 请求

#### session/request_permission

请求用户授权工具调用。

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/request_permission",
  "params": {
    "sessionId": "session-id",
    "toolCall": {
      "toolCallId": "toolu_123",
      "rawInput": { "command": "ls -la" },
      "title": "ls -la",
      "kind": "execute"
    },
    "options": [
      { "kind": "allow_always", "name": "Always Allow", "optionId": "allow_always" },
      { "kind": "allow_once", "name": "Allow", "optionId": "allow_once" },
      { "kind": "reject_once", "name": "Reject", "optionId": "reject_once" }
    ]
  }
}
```

**Response (Client → Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "outcome": { "outcome": "selected", "optionId": "allow_once" }
  }
}
```

#### fs/read_text_file

请求读取文件。

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "fs/read_text_file",
  "params": {
    "uri": "file:///path/to/file.txt"
  }
}
```

**Response (Client → Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": "文件内容..."
  }
}
```

#### fs/write_text_file

请求写入文件。

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "fs/write_text_file",
  "params": {
    "uri": "file:///path/to/file.txt",
    "content": "要写入的内容"
  }
}
```

**Response (Client → Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {}
}
```

#### terminal/create

请求创建终端执行命令。

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "terminal/create",
  "params": {
    "sessionId": "session-id",
    "command": "npm",
    "args": ["test"],
    "cwd": "/path/to/project",
    "env": [{ "name": "NODE_ENV", "value": "test" }],
    "outputByteLimit": 10000
  }
}
```

**Response (Client → Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "terminalId": "terminal-uuid"
  }
}
```

#### terminal/output

获取终端输出。

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "terminal/output",
  "params": {
    "sessionId": "session-id",
    "terminalId": "terminal-uuid"
  }
}
```

**Response (Client → Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "output": "终端输出内容...",
    "exitCode": 0,
    "signal": null
  }
}
```

#### terminal/kill

终止终端进程。

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "terminal/kill",
  "params": {
    "sessionId": "session-id",
    "terminalId": "terminal-uuid"
  }
}
```

**Response (Client → Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {}
}
```

---

### 13.3 Client → Agent 通知

#### textDocument/didOpen

文档打开通知。

```json
{
  "jsonrpc": "2.0",
  "method": "textDocument/didOpen",
  "params": {
    "sessionId": "session-id",
    "uri": "file:///path/to/file.ts",
    "languageId": "typescript",
    "text": "文件完整内容",
    "version": 1
  }
}
```

#### textDocument/didChange

文档变更通知。

```json
{
  "jsonrpc": "2.0",
  "method": "textDocument/didChange",
  "params": {
    "sessionId": "session-id",
    "uri": "file:///path/to/file.ts",
    "version": 2,
    "contentChanges": [
      { "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 5 } }, "text": "新内容" }
    ]
  }
}
```

#### textDocument/didFocus

文档聚焦通知（用于上下文感知）。

```json
{
  "jsonrpc": "2.0",
  "method": "textDocument/didFocus",
  "params": {
    "sessionId": "session-id",
    "uri": "file:///path/to/file.ts",
    "version": 2,
    "position": { "line": 10, "character": 5 },
    "visibleRange": { "start": { "line": 0 }, "end": { "line": 50 } }
  }
}
```

---

### 13.4 Agent → Client 通知 (Session Updates)

#### agent_message_chunk

流式文本输出。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-id",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "文本片段" }
    }
  }
}
```

#### tool_call

工具调用开始。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-id",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "toolu_123",
      "status": "pending",
      "title": "Read file.ts",
      "kind": "read",
      "rawInput": { "file_path": "/path/to/file.ts" }
    }
  }
}
```

#### tool_call_update

工具调用状态更新。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-id",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "toolu_123",
      "status": "completed",
      "rawOutput": { "ok": true },
      "content": [
        { "type": "content", "content": { "type": "text", "text": "工具输出内容" } }
      ]
    }
  }
}
```

---

## 十四、文件结构

```
src/server/acpServer/
├── index.ts              # JSON-RPC Server 入口，双向通信支持
├── acpAgent.ts           # ClaudeCodeAcpAgent 实现
│   ├── Client → Agent 方法
│   ├── Agent → Client 请求方法
│   └── textDocument 通知处理
├── messageConverter.ts   # 消息转换层
│   ├── sendSessionUpdate()
│   ├── convertToolUseToAcpUpdate()
│   ├── convertToolResultToAcpUpdate()
│   └── getToolTitle(), getToolKind()
└── types.ts              # 类型定义
    ├── ClientInterface
    ├── RequestPermissionParams/Response
    ├── ReadTextFileParams/Response
    ├── WriteTextFileParams/Response
    ├── CreateTerminalParams/Response
    ├── TerminalOutputParams/Response
    └── 其他 ACP 类型
```