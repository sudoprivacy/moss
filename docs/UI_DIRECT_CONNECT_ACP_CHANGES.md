# UI Remote Mode (Direct Connect) ACP Support Analysis

## Overview

当前 Moss 客户端有两套 remote 模式:
1. **CCR Remote** - 连接云端 api.anthropic.com (RemoteSessionManager)
2. **Direct Connect** - 连接本地 Moss server (--server 模式)

本文档分析 **Direct Connect** 模式支持 ACP 协议需要的改动。

---

## Implementation Status: ✅ COMPLETED

所有改动已完成并通过编译验证。

### Completed Changes

| File | Changes | Status |
|------|---------|--------|
| `src/server/createDirectConnectSession.ts` | 添加 ACP 参数 | ✅ |
| `src/server/directConnectManager.ts` | DirectConnectConfig 类型扩展 | ✅ |
| `src/server/directConnectManager.ts` | sendMessage 双协议 | ✅ |
| `src/server/directConnectManager.ts` | handleIncomingText 双协议 | ✅ |
| `src/server/directConnectManager.ts` | handleAcpMessage 新方法 | ✅ |
| `src/server/directConnectManager.ts` | sendInterrupt 双协议 | ✅ |
| `src/server/directConnectManager.ts` | respondToPermissionRequest 双协议 | ✅ |
| `src/remote/acpMessageAdapter.ts` | 新建消息转换 | ✅ |

### Client Files

| File | Purpose | Protocol |
|------|---------|----------|
| `src/server/createDirectConnectSession.ts` | HTTP POST 创建 session | CLI only |
| `src/server/directConnectManager.ts` | WebSocket 连接管理 | CLI only |
| `src/hooks/useDirectConnect.ts` | React hook | CLI only |
| `src/remote/sdkMessageAdapter.ts` | 消息格式转换 | CLI only |

### Message Formats (Current CLI Protocol)

**HTTP POST /api/v1/sessions**
```json
{
  "cwd": "/path/to/project",
  "dangerously_skip_permissions": true,
  "runtime": { ... },
  "assistant_name": "Claude"
}
```

**WebSocket 发送**
```json
// 用户消息
{ "type": "user", "message": { "role": "user", "content": "..." }, "uuid": "...", "session_id": "", "parent_tool_use_id": null }

// 中断
{ "type": "control_request", "request_id": "...", "request": { "subtype": "interrupt" } }

// 权限响应
{ "type": "control_response", "response": { "subtype": "success", "request_id": "...", "response": { "behavior": "allow", "updatedInput": {} } } }
```

**WebSocket 接收 (SDKMessage)**
```typescript
type SDKMessage =
  | { type: 'assistant', message: ..., uuid: ... }
  | { type: 'user', message: ..., uuid: ... }
  | { type: 'result', subtype: 'success'|'error', ... }
  | { type: 'system', subtype: 'init'|'status'|..., ... }
  | { type: 'stream_event', event: ... }
  | { type: 'tool_progress', ... }
```

---

## Required Changes

### 1. createDirectConnectSession.ts - HTTP Session Creation

**改动**: 添加 ACP 参数

```typescript
// 当前
export async function createDirectConnectSession({
  serverUrl,
  cwd,
  dangerouslySkipPermissions,
  runtime,
  assistantName,
}): Promise<{ config: DirectConnectConfig, workDir?: string }>

// 改动后 - 增加 ACP 参数
export async function createDirectConnectSession({
  serverUrl,
  cwd,
  dangerouslySkipPermissions,
  runtime,
  assistantName,
  // 新增 ACP 参数
  protocol,           // 'cli' | 'acp'
  acpBackend,         // 'scode' | 'gemini' | ...
  acpArgs,            // ['--model', 'gemini-3-flash', '--auth', 'proxy']
  acpEnv,             // { "CUSTOM_VAR": "value" }
  acpMode,            // 'default' | 'yolo' | 'bypassPermissions'
}): Promise<{ config: DirectConnectConfig, workDir?: string }>
```

**Request Body 改动**
```typescript
body: jsonStringify({
  cwd,
  ...(dangerouslySkipPermissions && { dangerously_skip_permissions: true }),
  ...(runtime ? { runtime } : {}),
  ...(assistantName && { assistant_name: assistantName }),
  // 新增
  ...(protocol && { protocol }),
  ...(acpBackend && { acp_backend: acpBackend }),
  ...(acpArgs && { acp_args: acpArgs }),
  ...(acpEnv && { acp_env: acpEnv }),
  ...(acpMode && { acp_mode: acpMode }),
})
```

**Response 改动** (server.ts 已返回)
```json
{
  "session_id": "...",
  "ws_url": "...",
  "work_dir": "...",
  "protocol": "acp",        // 新增
  "acp_backend": "scode"    // 新增
}
```

### 2. DirectConnectConfig 类型

**文件**: `src/server/directConnectManager.ts`

```typescript
// 当前
export type DirectConnectConfig = {
  serverUrl: string
  sessionId: string
  wsUrl: string
  authToken?: string
}

// 改动后
export type DirectConnectConfig = {
  serverUrl: string
  sessionId: string
  wsUrl: string
  authToken?: string
  // 新增
  protocol?: 'cli' | 'acp'
  acpBackend?: string
}
```

### 3. DirectConnectSessionManager.ts - WebSocket 消息处理

这是核心改动，需要根据 protocol 处理不同消息格式。

#### sendMessage 改动

```typescript
// 当前 (CLI only)
sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): boolean {
  const line = jsonStringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
    uuid,
  })
  ...
}

// 改动后 (双协议)
sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): boolean {
  const protocol = this.config.protocol ?? 'cli'

  if (protocol === 'acp') {
    // ACP 格式: user_message
    const images = extractImagesFromContent(content)
    const textContent = extractTextFromContent(content)
    const line = jsonStringify({
      type: 'user_message',
      content: textContent,
      images: images.length > 0 ? images : undefined,
    })
  } else {
    // CLI 格式 (保持不变)
    const line = jsonStringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
      uuid,
    })
  }
  ...
}
```

#### handleIncomingText 改动

```typescript
// 当前 (CLI only)
private handleIncomingText(data: string): void {
  const lines = data.split('\n').filter(line => line.trim())
  for (const line of lines) {
    const parsed = jsonParse(line)
    if (!isStdoutMessage(parsed)) continue

    // 处理 CLI 的 SDKMessage
    if (parsed.type === 'control_request') { ... }
    else if (parsed.type !== 'control_response' && ...) {
      this.callbacks.onMessage(parsed)  // SDKMessage
    }
  }
}

// 改动后 (双协议)
private handleIncomingText(data: string): void {
  const protocol = this.config.protocol ?? 'cli'
  const lines = data.split('\n').filter(line => line.trim())

  for (const line of lines) {
    const parsed = jsonParse(line)

    if (protocol === 'acp') {
      this.handleAcpMessage(parsed)
    } else {
      this.handleCliMessage(parsed)  // 保持现有逻辑
    }
  }
}

// 新增 ACP 消息处理
private handleAcpMessage(msg: unknown): void {
  if (!isAcpClientMessage(msg)) return

  // ACP 消息类型 (server.ts 已转换)
  switch (msg.type) {
    case 'start':
    case 'content':
    case 'thought':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
      // 转换为 SDKMessage 格式供上层使用
      const converted = convertAcpToSdk(msg)
      this.callbacks.onMessage(converted)
      break

    case 'permission_request':
      // ACP 权限请求格式不同
      this.callbacks.onPermissionRequest(
        {
          tool_name: msg.data.tool_name,
          tool_use_id: msg.data.tool_use_id,
          description: msg.data.description,
          input: msg.data.input,
          permission_suggestions: msg.data.options?.map(o => o.name),
        },
        msg.request_id,  // ACP 用 request_id
      )
      break

    case 'finish':
      // 转换为 result 消息
      this.callbacks.onMessage({
        type: 'result',
        subtype: 'success',
        uuid: msg.msg_id,
      })
      break

    case 'error':
      this.callbacks.onMessage({
        type: 'result',
        subtype: 'error',
        errors: [msg.data.message],
        uuid: randomUUID(),
      })
      break

    case 'model_info':
    case 'context_usage':
      // 状态信息，可忽略或显示
      break
  }
}
```

#### sendInterrupt 改动

```typescript
// 当前 (CLI only)
sendInterrupt(): void {
  const line = jsonStringify({
    type: 'control_request',
    request_id: randomUUID(),
    request: { subtype: 'interrupt' },
  })
  this.sendLine(line)
}

// 改动后 (双协议)
sendInterrupt(): void {
  const protocol = this.config.protocol ?? 'cli'

  if (protocol === 'acp') {
    // ACP: 发送 cancel 消息
    const line = jsonStringify({ type: 'cancel' })
    this.sendLine(line)
  } else {
    // CLI: 保持不变
    const line = jsonStringify({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    })
    this.sendLine(line)
  }
}
```

#### respondToPermissionRequest 改动

```typescript
// 当前 (CLI only)
respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void {
  const line = jsonStringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: result.behavior,
        ...(result.behavior === 'allow'
          ? { updatedInput: result.updatedInput }
          : { message: result.message }),
      },
    },
  })
  this.sendLine(line)
}

// 改动后 (双协议)
respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void {
  const protocol = this.config.protocol ?? 'cli'

  if (protocol === 'acp') {
    // ACP: permission_response 格式
    const line = jsonStringify({
      type: 'permission_response',
      request_id: requestId,
      option_id: result.behavior === 'allow' ? 'allow' : 'deny',
      // 如果 ACP 需要 updatedInput，需要调整格式
    })
    this.sendLine(line)
  } else {
    // CLI: 保持不变
    const line = jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput }
            : { message: result.message }),
        },
      },
    })
    this.sendLine(line)
  }
}
```

### 4. acpMessageAdapter.ts (NEW) - ACP 消息转换

新建文件处理 ACP 客户端消息转换。

```typescript
// src/remote/acpMessageAdapter.ts

import type { Message, StreamEvent } from '../types/message.js'

// ACP 客户端消息类型 (server.ts 转换后的格式)
export type AcpClientMessage =
  | { type: 'start'; msg_id: string }
  | { type: 'content'; msg_id: string; data: string }
  | { type: 'thought'; msg_id: string; data: string }
  | { type: 'tool_call'; msg_id: string; data: { tool_name: string; tool_use_id: string; input: unknown } }
  | { type: 'tool_call_update'; msg_id: string; data: { status: string; output?: string } }
  | { type: 'plan'; msg_id: string; data: { steps: string[] } }
  | { type: 'permission_request'; request_id: string; data: PermissionRequestData }
  | { type: 'finish'; msg_id: string }
  | { type: 'error'; data: { message: string; code?: string } }
  | { type: 'model_info'; data: { model_id: string; model_name: string } }
  | { type: 'context_usage'; data: { used: number; limit: number } }

export function isAcpClientMessage(msg: unknown): msg is AcpClientMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && typeof msg.type === 'string'
}

export function convertAcpToSdk(msg: AcpClientMessage): SDKMessage {
  switch (msg.type) {
    case 'start':
      return { type: 'assistant', uuid: msg.msg_id, message: { role: 'assistant', content: [] } }

    case 'content':
      return {
        type: 'stream_event',
        uuid: msg.msg_id,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: msg.data } },
      }

    case 'thought':
      return {
        type: 'stream_event',
        uuid: msg.msg_id,
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: msg.data } },
      }

    case 'tool_call':
      return {
        type: 'assistant',
        uuid: msg.msg_id,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: msg.data.tool_use_id,
            name: msg.data.tool_name,
            input: msg.data.input,
          }],
        },
      }

    case 'finish':
      return { type: 'result', subtype: 'success', uuid: msg.msg_id, result: null, cost_usd: 0 }

    case 'error':
      return { type: 'result', subtype: 'error', uuid: randomUUID(), errors: [msg.data.message], cost_usd: 0 }

    // ... 其他类型
  }
}
```

### 5. useDirectConnect.ts - Hook 更新

需要在回调中处理 ACP 权限请求的不同格式。

```typescript
// 当前
onPermissionRequest: (request, requestId) => {
  // request 是 SDKControlPermissionRequest 格式
  const toolUseConfirm: ToolUseConfirm = {
    ...
    onAllow(updatedInput) {
      manager.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput })
    }
  }
}

// 改动后 - ACP 权限响应需要 option_id
onPermissionRequest: (request, requestId) => {
  const config = manager.getConfig()  // 需要新增方法
  const isAcp = config?.protocol === 'acp'

  const toolUseConfirm: ToolUseConfirm = {
    ...
    onAllow(updatedInput) {
      if (isAcp) {
        // ACP: 选择第一个允许选项
        const allowOptionId = request.permission_suggestions?.[0] ?? 'allow'
        manager.respondToPermissionRequest(requestId, { behavior: 'allow', optionId: allowOptionId })
      } else {
        // CLI
        manager.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput })
      }
    }
  }
}
```

---

## Additional HTTP Calls (ACP Only)

ACP 协议需要额外的 HTTP 端点调用:

### Model Switch

```typescript
// 新增方法
async switchModel(modelId: string): Promise<void> {
  const resp = await fetch(`${this.config.serverUrl}/api/v1/sessions/${this.config.sessionId}/model`, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({ model_id: modelId }),
  })
  if (!resp.ok) throw new Error(...)
}
```

### Mode Switch

```typescript
// 新增方法
async switchMode(mode: string): Promise<void> {
  const resp = await fetch(`${this.config.serverUrl}/api/v1/sessions/${this.config.sessionId}/mode`, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({ mode }),
  })
  if (!resp.ok) throw new Error(...)
}
```

### Get Available Backends

```typescript
// 新增方法
static async getBackends(serverUrl: string): Promise<AcpBackendConfig[]> {
  const resp = await fetch(`${serverUrl}/api/v1/acp/backends`)
  const data = await resp.json()
  return data.backends
}
```

---

## Implementation Priority

| Priority | File | Changes | Complexity |
|----------|------|---------|------------|
| P0-1 | `createDirectConnectSession.ts` | 添加 ACP 参数 | Low |
| P0-2 | `directConnectManager.ts` | DirectConnectConfig 类型 | Low |
| P0-3 | `acpMessageAdapter.ts` | 新建消息转换 | Medium |
| P0-4 | `directConnectManager.ts` | sendMessage 双协议 | Medium |
| P0-5 | `directConnectManager.ts` | handleIncomingText 双协议 | High |
| P0-6 | `directConnectManager.ts` | sendInterrupt 双协议 | Low |
| P0-7 | `directConnectManager.ts` | respondToPermissionRequest 双协议 | Medium |
| P1-1 | `directConnectManager.ts` | HTTP model/mode switch | Low |
| P1-2 | `useDirectConnect.ts` | 权限响应处理 | Low |

---

## Testing Plan

### CLI Protocol (Backward Compatibility)

1. 创建 CLI session: `{ cwd: "...", runtime: { type: "host" } }`
2. WebSocket 发送用户消息
3. WebSocket 接收 assistant 消息
4. 权限请求/响应
5. 中断请求

### ACP Protocol

1. 获取 backends: `GET /api/v1/acp/backends`
2. 创建 ACP session: `{ cwd: "...", protocol: "acp", acp_backend: "scode", acp_args: [...] }`
3. WebSocket 发送 `{ type: 'user_message', content: "..." }`
4. WebSocket 接收 10 种消息类型
5. 权限请求: `{ type: 'permission_request', request_id: "...", data: {...} }`
6. 权限响应: `{ type: 'permission_response', request_id: "...", option_id: "..." }`
7. 取消: `{ type: 'cancel' }`
8. Model switch: `POST /api/v1/sessions/:id/model`
9. Mode switch: `POST /api/v1/sessions/:id/mode`

---

## Key Design Decisions

### 1. 协议检测策略

使用 `DirectConnectConfig.protocol` 字段判断协议类型，默认 `'cli'`。

```typescript
const protocol = this.config.protocol ?? 'cli'
```

### 2. 消息转换策略

ACP 消息在 client 端转换为 SDKMessage 格式，使上层代码 (useDirectConnect, REPL) 无需改动。

```typescript
// ACP → SDKMessage 转换
const converted = convertAcpToSdk(acpMsg)
this.callbacks.onMessage(converted)  // 上层仍接收 SDKMessage
```

### 3. 权限响应差异

- **CLI**: 发送 `behavior: 'allow'` + `updatedInput`
- **ACP**: 发送 `option_id` (从 permission_request 的 options 中选择)

需要上层 (useDirectConnect) 适配，根据协议类型发送不同响应。

---

## Summary

UI Direct Connect 模式支持 ACP 需要:

1. **HTTP**: 添加 ACP 参数到 session 创建
2. **WebSocket**: 双协议消息格式处理
3. **消息转换**: ACP → SDKMessage 格式转换
4. **权限**: 双协议权限请求/响应
5. **额外功能**: HTTP model/mode switch

核心改动在 `directConnectManager.ts`，其他文件改动较小。