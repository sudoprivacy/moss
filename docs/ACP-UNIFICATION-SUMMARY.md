# ACP Protocol Unification Summary

## Overview

**Date**: 2026-04-27

**Goal**: Unify Moss server to always use ACP (Agent Client Protocol) for all sessions, removing dual-protocol (CLI/ACP) support.

## Changes Made

### 1. Core Backend Changes

#### backendUtils.ts
- **Changed**: `spawnLocalCliProcess()` now spawns cli-node.js with `--acp` flag instead of stream-json format
- **Removed**: `--print`, `--verbose`, `--input-format stream-json`, `--output-format stream-json`, `--permission-prompt-tool stdio` flags
- **Added**: `--acp` flag (cli-node.js runs as ACP Agent Server, JSON-RPC 2.0 over stdin/stdout)

#### runtimeBackend.ts
- **Removed**: `AcpBackend` import and member
- **Removed**: Protocol routing logic (`if (options.protocol === 'acp')`)
- **Result**: All sessions now use host/docker backend with cli-node.js running in ACP mode

#### acpBackend.ts
- **Deleted**: File removed entirely (no longer needed)

### 2. Daemon Changes

#### sessionRunnerDaemon.ts
- **Removed**: Protocol check (`if (this.manifest.session.protocol === 'acp')`)
- **Changed**: Always parse stdout as ACP JSON-RPC notification
- **Updated**: Hello message now always sends `protocol: 'acp'`
- **Removed**: ACP-specific spawn parameters from `BackendSpawnOptions`
- **Removed**: `acp_request` and `acp_notification` message handling

### 3. Server Changes

#### server.ts
- **Removed**: `isAcp` variable and all related checks
- **Changed**: WebSocket handler always uses ACP message format
- **Removed**: Unused imports (`getEnabledAcpBackends`, `isValidAcpBackend`)
- **Changed**: Session creation now always returns `protocol: 'acp'`
- **Removed**: Protocol validation (no need for `acp_backend` requirement)
- **Removed**: `protocol !== 'acp'` checks in model/mode/config endpoints
- **Updated**: `formatSessionResponse()` now always returns `protocol: 'acp'`

### 4. Client Changes

#### directConnectManager.ts
- **Removed**: `protocol` and `acpBackend` fields from `DirectConnectConfig`
- **Changed**: `sendMessage()` always uses ACP `user_message` format
- **Changed**: `handleIncomingText()` always handles ACP messages
- **Changed**: `respondToPermissionRequest()` always uses ACP `permission_response` format
- **Changed**: `sendInterrupt()` always uses ACP `cancel` message
- **Removed**: `handleCliMessage()` method
- **Removed**: `isStdoutMessage()` function and `StdoutMessage` import

#### createDirectConnectSession.ts
- **Removed**: `protocol` and `acpBackend` from returned config

### 5. Type Changes

#### types.ts
- **Updated**: `connectResponseSchema` now uses `protocol: z.literal('acp')`
- **Removed**: `acp_backend` field from schema
- **Updated**: `attachSessionResponseSchema` now uses `protocol: z.literal('acp')`
- **Removed**: `acpBackend` field from session schema
- **Updated**: `SessionRecord` - removed `protocol`, `acpBackend`, `acpSessionId` fields
- **Updated**: `SessionCreateInput` - removed all ACP parameters
- **Updated**: `RunnerManifest` - removed all ACP protocol fields from session
- **Updated**: `SessionSummary` - removed `protocol`, `acpBackend` fields

#### sessionManager.ts
- **Removed**: ACP protocol options from `BackendSpawnOptions`

#### runnerProtocol.ts
- **Removed**: `acp_request` and `acp_notification` client message types
- **Updated**: Hello message now uses `protocol: 'acp'` (literal, not optional)

### 6. Database Changes

#### db.ts
- **Updated**: `mapSession()` - removed `protocol`, `acpBackend`, `acpSessionId` fields
- **Updated**: `createSession()` - removed protocol-related parameters and fixed SQL INSERT column mismatch
- **Updated**: `toSessionSummary()` - removed `protocol`, `acpBackend` fields
- **Fixed**: SQL INSERT statement had extra columns (`protocol, acp_backend, acp_session_id`) without corresponding values - removed these unused columns

### 7. Runtime Service Changes

#### runtimeService.ts
- **Removed**: ACP parameters from `createSession()` call
- **Removed**: ACP options from `spawnAttempt()` call
- **Removed**: ACP fields from `RunnerManifest` construction
- **Updated**: `resumeSession()` - removed ACP fields

---

## Protocol Flow After Unification

### Session Creation
```
Client → POST /api/v1/sessions { cwd: "..." }
Server → Returns { session_id, ws_url, protocol: 'acp' }
Server → Spawns cli-node.js --acp (ACP Agent Server)
```

### WebSocket Communication
```
Client → WebSocket sends { type: 'user_message', content: '...' }
Server → Converts to JSON-RPC: { jsonrpc: '2.0', method: 'session/prompt', params: { prompt: { content: '...' } } }
Agent  → Sends JSON-RPC notifications: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', ... } } }
Server → Converts to client format: { type: 'content', msg_id: '...', data: '...' }
Client → Receives ACP-formatted messages
```

### Permission Handling
```
Agent  → Sends permission_request notification
Server → Converts to: { type: 'permission_request', data: { tool_name, ... } }
Client → User selects option
Client → Sends: { type: 'permission_response', request_id: '...', option_id: 'allow' }
Server → Converts to JSON-RPC response: { jsonrpc: '2.0', id: '...', result: { outcome: 'selected', optionId: 'allow' } }
```

---

## Benefits

1. **Simplified Code**: No more dual-protocol branching throughout codebase
2. **Consistent Messages**: All clients receive same ACP-formatted messages
3. **Reduced Maintenance**: Single protocol path to maintain and test
4. **Future-Ready**: ACP protocol supports rich features (thoughts, plans, tool calls)

---

## Testing

Build verification: `bun run build` - **SUCCESS**

Final verification completed:
- All `protocol`, `acpBackend`, `acpSessionId` references removed from runtime code
- `mapSession()` and `toSessionSummary()` correctly exclude deprecated fields
- `createSession()` SQL INSERT columns match run() parameters
- `RunnerManifest` in runtimeService.ts matches types.ts definition
- `sessionRunnerDaemon.ts` always parses stdout as ACP JSON-RPC
- `server.ts` WebSocket always uses ACP message format
- `directConnectManager.ts` always uses ACP client messages
- `runnerProtocol.ts` hello message sends `protocol: 'acp'` (literal)

Manual testing steps:
1. Create session: `POST /api/v1/sessions { "cwd": "/path/to/project" }`
2. Connect WebSocket to ws_url
3. Send: `{ "type": "user_message", "content": "hello" }`
4. Verify ACP responses: `{ "type": "content", ... }`, `{ "type": "finish", ... }`

---

## Files Modified

| File | Changes |
|------|---------|
| `src/server/backends/backendUtils.ts` | Added --acp flag |
| `src/server/backends/runtimeBackend.ts` | Removed AcpBackend routing |
| `src/server/backends/acpBackend.ts` | **DELETED** |
| `src/server/sessionRunnerDaemon.ts` | Removed protocol checks and ACP message handling |
| `src/server/server.ts` | Removed isAcp checks |
| `src/server/directConnectManager.ts` | Removed CLI handling |
| `src/server/createDirectConnectSession.ts` | Removed protocol fields |
| `src/server/types.ts` | Updated all type definitions |
| `src/server/sessionManager.ts` | Removed ACP options from BackendSpawnOptions |
| `src/server/runnerProtocol.ts` | Updated protocol types |
| `src/server/db.ts` | Removed protocol fields from DB mapping |
| `src/server/runtimeService.ts` | Removed ACP parameters |

---

## Notes

- cli-node.js must support `--acp` flag (ACP Agent Server mode)
- `acpMode` and `acpModelId` fields retained in SessionRecord for future model/mode switching support
- `/api/v1/acp/backends` endpoint returns empty array (deprecated, no external backends)
- `types/acpTypes.ts` kept for ACP message format definitions used in WebSocket handling

---

## Known Issues / TODO

### ACP Server Implementation Status

The current ACP server implementation (`src/server/acpServer/acpAgent.ts`) is a **stub/simulation**:
- `prompt()` method returns simulated data, not integrated with `runAgent()`
- Does not execute actual Claude Code agent loop
- Needs full integration with `runAgent()` for real agent execution

### Missing Environment Variable Handling

Session context passed via environment variables but not read by ACP server:
- `MOSS_SESSION_USER_ID` - user identity
- `MOSS_SESSION_ORG_ID` - organization identity
- `MOSS_SESSION_ROLE` - user role
- `MOSS_SESSION_SCOPES` - permission scopes
- `MOSS_ASSISTANT_NAME` - assistant name override

These should be read in `acpAgent.ts` `newSession()` to set session context.

### Required Integration Work

To fully implement ACP server:
1. Import and integrate `runAgent()` from `src/tools/AgentTool/runAgent.ts`
2. Create proper `ToolUseContext` and `AgentDefinition`
3. Handle permission mode from `--permission-mode` and `--dangerously-skip-permissions`
4. Convert `runAgent()` output messages to ACP `session/update` notifications
5. Read environment variables for session context
6. Implement proper session/cancel handling with AbortController