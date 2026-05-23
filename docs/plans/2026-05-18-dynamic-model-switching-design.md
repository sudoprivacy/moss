# 动态切换会话模型设计文档

## 概述

实现用户在 sudowork 客户端企业模式下远程连接 moss 对话时,可以在对话中动态切换可用模型的功能。切换后下一轮对话生效,用户偏好持久化存储。

## 背景

### 当前模型配置机制

Moss 在启动会话时动态生成 `sudocode.json`,配置模型使用 `proxy/` 前缀:

```json
{
  "auth_modes": {
    "proxy": {
      "moss-proxy": {
        "baseUrl": "https://hk.sudorouter.ai/v1",
        "apiKey": "..."
      }
    }
  },
  "models": {
    "proxy/gemini-3-flash-preview": {
      "alias": "proxy/gemini-3-flash-preview",
      "providers": {
        "proxy": {
          "provider": "moss-proxy",
          "model": "gemini-3-flash-preview",
          "api": "openai-completions"
        }
      }
    }
  }
}
```

### scode 模型处理限制

scode 的 `resolve_provider_from_config` 函数要求模型必须在 `sudocode.json` 中定义,否则报错:

```rust
let model_config = resolve_model(config, &alias_lower).ok_or_else(|| {
    ApiError::Configuration(format!(
        "model alias '{model_alias}' not found in sudocode.json"
    ))
})?;
```

### 优化方案: 预置所有可用模型

**核心优化**: 在会话启动时,从 sudorouter API 获取所有可用模型并预置到 `sudocode.json` 中。这样后续切换模型时无需再次修改配置文件,只需通过 ACP 协议发送切换请求即可。

**优势**:
1. 简化模型切换流程,无需文件操作
2. 减少切换延迟
3. 避免文件写入失败的风险
4. 用户可以即时切换到任意可用模型

## 需求确认

| 需求项 | 确认内容 |
|--------|----------|
| 触发时机 | 用户在会话界面内切换模型,下一轮对话生效 |
| 模型列表 | 从 `https://hk.sudorouter.ai/api/specific_pricing` 动态获取 |
| 持久化级别 | 用户级持久,影响该用户所有新会话 |
| UI 位置 | 会话界面内的下拉选择框 |
| 切换时机 | 等待当前回复完成后再应用新模型 |

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        sudowork 客户端 (Electron)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  MossSessionPage.tsx                                                        │
│  ├── ModelSelector 组件 (新增)                                              │
│  └── IPC Bridge                                                             │
│      ├── moss.getAvailableModels                                            │
│      ├── moss.getUserModel / moss.setUserModel                              │
│      └── moss.setModel                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP / WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          moss Server (Node.js)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  API 端点:                                                                  │
│  ├── GET /api/v1/models/available                                           │
│  ├── GET/PUT /api/v1/users/:userId/model                                     │
│  │                                                                          │
│  会话启动 (关键优化):                                                        │
│  ├── scodeBackend.ts / dockerBackend.ts                                     │
│  │   ├── 1. 获取所有可用模型列表                                             │
│  │   ├── 2. 预置所有模型到 sudocode.json                                     │
│  │   └── 3. 使用用户偏好模型启动                                             │
│  │                                                                          │
│  WebSocket 模型切换 (简化):                                                  │
│  ├── control_request (subtype: set_model)                                   │
│  │   └── 直接发送 ACP SetSessionModelRequest (无需修改文件)                  │
│  │   └── 返回 model_changed 事件                                            │
│  │                                                                          │
│  会话创建:                                                                   │
│  └── buildSessionEnv → 应用用户模型偏好                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ ACP Protocol
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          scode (Rust)                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  SetSessionModelRequest                                                     │
│  └── set_model() → handle_acp_model_switch()                                │
│      ├── load_sudocode_config_for_cwd (读取预置的配置)                       │
│      ├── resolve_provider_from_config (模型已存在,直接匹配)                  │
│      └── build_runtime_for_cwd                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ OpenAI API
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      sudorouter (https://hk.sudorouter.ai)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 数据流

| 操作 | 数据流 |
|------|--------|
| 获取模型列表 | sudowork → moss `/api/v1/models/available` → sudorouter API |
| 会话启动 | moss backend → sudorouter API → 预置所有模型到 sudocode.json |
| 用户选择模型 | 前端 ModelSelector → IPC `setUserModel` → moss 存储 |
| 切换会话模型 | IPC `setModel` → WebSocket → ACP `SetSessionModelRequest` → scode (无需修改文件) |
| 新会话创建 | moss `buildSessionEnv` → 读取用户偏好 → 设置环境变量 |

## 模块设计

### 1. Moss Server API

#### 1.1 获取可用模型列表

**端点**: `GET /api/v1/models/available`

**实现位置**: `src/server/server.ts`

**逻辑**:
1. 代理请求 `https://hk.sudorouter.ai/api/specific_pricing`
2. 使用 24 小时缓存,避免频繁请求
3. 转换响应格式,返回模型列表

**缓存机制**:
- 缓存时长: 24 小时
- 缓存存储: 内存 Map
- 缓存键: `sudorouter_models`
- 刷新策略: 过期后自动重新获取

**响应格式**:
```json
{
  "success": true,
  "data": [
    { "id": "gemini-3-flash-preview", "name": "gemini-3-flash-preview", "ratio": 3.5 },
    { "id": "claude-sonnet-4-6", "name": "claude-sonnet-4-6", "ratio": 20 }
  ]
}
```

#### 1.2 用户模型偏好存储

**端点**: `GET/PUT /api/v1/users/:userId/model`

**实现位置**: `src/server/server.ts`

**存储方式**: 内存 Map 或 SQLite

**请求/响应格式**:
```json
// GET 响应
{
  "success": true,
  "data": { "modelId": "claude-sonnet-4-6", "updatedAt": 1716012345678 }
}

// PUT 请求
{ "modelId": "claude-sonnet-4-6" }
```

### 2. 会话启动预置所有模型 (关键优化)

#### 2.1 创建模型配置生成函数 (带缓存)

**实现位置**: `src/server/backends/backendUtils.ts`

**新增函数**:

```typescript
// 模型列表缓存 (24 小时)
const MODEL_CACHE_DURATION = 24 * 60 * 60 * 1000 // 24 hours in milliseconds
let modelCache: {
  data: Record<string, any>
  fetchedAt: number
} | null = null

/**
 * 从 sudorouter API 获取所有可用模型并生成 sudocode.json 的 models 配置
 * 使用 24 小时缓存,避免频繁请求
 */
export async function buildAllModelsConfig(baseUrl: string): Promise<Record<string, any>> {
  // 检查缓存是否有效
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_DURATION) {
    process.stderr.write(`[Backend] Using cached model list (age: ${Math.round((Date.now() - modelCache.fetchedAt) / 1000)}s)\n`)
    return modelCache.data
  }
  
  try {
    process.stderr.write(`[Backend] Fetching fresh model list from sudorouter...\n`)
    const response = await fetch('https://hk.sudorouter.ai/api/specific_pricing', {
      signal: AbortSignal.timeout(10000)
    })
    
    if (!response.ok) {
      throw new Error(`sudorouter API returned ${response.status}`)
    }
    
    const data = await response.json()
    
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Invalid response from sudorouter API')
    }
    
    const models: Record<string, any> = {}
    
    for (const item of data.data) {
      const modelId = item.model_id
      const scodeModelName = `proxy/${modelId}`
      
      models[scodeModelName] = {
        alias: scodeModelName,
        name: `Moss Dynamic: ${scodeModelName}`,
        input: ["text"],
        providers: {
          proxy: {
            provider: "moss-proxy",
            model: modelId,
            api: "openai-completions"
          }
        }
      }
    }
    
    // 更新缓存
    modelCache = {
      data: models,
      fetchedAt: Date.now()
    }
    
    process.stderr.write(`[Backend] Model list cached: ${Object.keys(models).length} models\n`)
    
    return models
  } catch (error) {
    process.stderr.write(`[Backend] Failed to fetch available models: ${error}\n`)
    // 如果有过期缓存,仍然使用
    if (modelCache) {
      process.stderr.write(`[Backend] Falling back to expired cache\n`)
      return modelCache.data
    }
    return {}
  }
}
```

#### 2.2 修改 scodeBackend.ts

**实现位置**: `src/server/backends/scodeBackend.ts`

**修改 sudocode.json 生成逻辑**:

```typescript
// 原代码 (只配置单个模型):
const scodeConfig = {
  auth_modes: { ... },
  models: {
    [scodeModelName]: { ... }
  }
}

// 新代码 (预置所有可用模型):
const allModels = await buildAllModelsConfig(baseUrl)

const scodeConfig = {
  auth_modes: {
    proxy: {
      "moss-proxy": {
        baseUrl,
        apiKey
      }
    }
  },
  models: allModels  // 预置所有可用模型
}

writeFileSync(dummySudocodePath, JSON.stringify(scodeConfig, null, 2), 'utf8')
```

#### 2.3 修改 dockerBackend.ts

**实现位置**: `src/server/backends/dockerBackend.ts`

**同 scodeBackend.ts 的修改逻辑**:

```typescript
const allModels = await buildAllModelsConfig(baseUrl)

const scodeConfig = {
  auth_modes: {
    proxy: {
      "moss-proxy": {
        baseUrl,
        apiKey
      }
    }
  },
  models: allModels  // 预置所有可用模型
}

writeFileSync(dummySudocodePath, JSON.stringify(scodeConfig, null, 2), 'utf8')
```

### 3. WebSocket 模型切换 (简化)

#### 3.1 消息格式

**客户端 → Moss**:
```json
{
  "type": "control_request",
  "request_id": "req-xxx",
  "request": {
    "subtype": "set_model",
    "model_id": "claude-sonnet-4-6"
  }
}
```

**Moss → scode (ACP)**:
```json
{
  "jsonrpc": "2.0",
  "id": "m-set-model",
  "method": "session/setModel",
  "params": {
    "session_id": "sess-xxx",
    "model_id": "proxy/claude-sonnet-4-6"
  }
}
```

**Moss → 客户端 (成功)**:
```json
{
  "type": "system",
  "subtype": "model_changed",
  "session_id": "sess-xxx",
  "model": "proxy/claude-sonnet-4-6"
}
```

#### 3.2 acpBridge.ts 扩展 (简化版)

**实现位置**: `src/server/backends/acpBridge.ts`

**关键逻辑 (无需修改文件)**:
1. 接收 `control_request` (subtype: `set_model`)
2. 直接发送 ACP `SetSessionModelRequest` (模型已在 sudocode.json 中)
3. 处理响应,通知前端

```typescript
// 处理 control_request (set_model) - 简化版
if (parsed.type === 'control_request' && parsed.request?.subtype === 'set_model') {
  const modelId = parsed.request.model_id
  
  // 构建 scode 模型名称
  const scodeModelName = modelId.includes('/') ? modelId : `proxy/${modelId}`
  
  // 直接发送 ACP 请求 (无需修改 sudocode.json)
  sendRpc('session/setModel', {
    session_id: acpSessionId,
    model_id: scodeModelName
  }, 'm-set-model')
  
  continue
}
```

### 4. 会话创建应用用户偏好

**实现位置**: `src/server/backends/backendUtils.ts`

**修改 `buildSessionEnv` 函数**:
```typescript
// 获取用户模型偏好
const userModelPref = getUserModelPreference(options.userId)

// 模型优先级: 用户偏好 > 系统设置 > 默认值
const model = userModelPref?.modelId || settings.model || 'gemini-3-flash-preview'

return {
  ...process.env,
  MOSS_DEFAULT_MODEL: model,
}
```

### 5. sudowork 客户端

#### 5.1 IPC Bridge 扩展

**实现位置**: `src/common/ipcBridge.ts` + `src/process/bridge/mossBridge.ts`

**新增 IPC 定义**:
- `moss.getAvailableModels`
- `moss.getUserModel`
- `moss.setUserModel`
- `moss.setModel`
- `moss.modelChanged` (事件流)

#### 5.2 MossSessionApi 扩展

**实现位置**: `src/process/remote/MossSessionApi.ts`

**新增消息处理**:
- 处理 `system` (subtype: `model_changed`) 消息
- 触发 `ipcBridge.moss.modelChanged` 事件

#### 5.3 前端组件

**实现位置**: `src/renderer/pages/moss-session/MossSessionPage.tsx`

**ModelSelector 组件功能**:
1. 加载可用模型列表
2. 加载用户当前偏好
3. 监听模型切换事件
4. 用户选择后:
   - 调用 `setUserModel` 持久化
   - 调用 `setModel` 切换当前会话

## 关键设计决策

| 决策 | 理由 |
|------|------|
| 用户偏好存储在 moss | 用户级持久化,跨设备同步 |
| **会话启动时预置所有模型** | 简化切换流程,无需文件操作,减少延迟 |
| 使用 `proxy/` 前缀 | 保持与现有模型命名一致 |
| 等待当前回复完成 | 用户已确认此行为,实现简单 |

## 实现优先级

1. **P0 - Moss Server API**
   - `/api/v1/models/available` 端点
   - `/api/v1/users/:userId/model` 端点
   - 用户偏好存储

2. **P0 - 会话启动预置模型 (关键优化)**
   - `buildAllModelsConfig` 函数
   - scodeBackend.ts 修改
   - dockerBackend.ts 修改

3. **P1 - WebSocket 模型切换 (简化)**
   - acpBridge.ts 扩展 (无需文件操作)

4. **P1 - sudowork 客户端**
   - IPC Bridge 扩展
   - MossSessionApi 扩展
   - ModelSelector 组件

5. **P2 - 会话创建优化**
   - buildSessionEnv 应用用户偏好

## 测试计划

1. **API 测试**
   - 模型列表获取成功
   - 用户偏好读写正确

2. **会话启动测试**
   - sudocode.json 包含所有可用模型
   - 验证模型配置格式正确

3. **WebSocket 测试**
   - 模型切换请求处理
   - ACP 协议交互
   - 无需文件修改验证

4. **集成测试**
   - Host 模式模型切换
   - Docker 模式模型切换
   - 新会话应用用户偏好

5. **E2E 测试**
   - 用户选择模型 → 持久化 → 新会话使用该模型
   - 会话中切换模型 → 下一轮生效