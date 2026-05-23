# sudowork Channels 管理页面 - 个人模式 vs 企业模式 对比

> 本文档详细对比 sudowork 个人模式（Consumer Mode）和企业模式（Enterprise Mode）在 Channels 管理页面的功能差异和交互逻辑。

---

## 一、页面元素对比

| 页面区域 | 个人模式 | 企业模式 |
|---------|------------------------|------------------------|
| **Channel 卡片列表** | ✅ 支持 | ✅ 支持 |
| **启用/禁用开关** | ✅ Switch 开关 | ✅ 禁用按钮（无开关） |
| **折叠/展开配置** | ✅ 支持 | ✅ Dialog 弹窗 |
| **Bot Token 输入** | ✅ 密码框 | ✅ 密码框 |
| **测试连接按钮** | ✅ "Test" 按钮 | ✅ "测试连接" 按钮 |
| **测试并连接按钮** | ✅ "Test & Connect"（Lark专用） | ✅ "保存并启用" |
| **Agent 选择器** | ✅ Dropdown 下拉选择 | ❌ 无 |
| **默认模型选择器** | ✅ GeminiModelSelector | ❌ 无 |
| **待处理配对列表** | ✅ 实时监听 + 手动刷新 | ✅ 手动刷新 |
| **批准/拒绝配对按钮** | ✅ 两个按钮 | ✅ 仅批准按钮 |
| **已授权用户列表** | ✅ 实时监听 + 手动刷新 | ✅ 手动刷新 |
| **撤销用户按钮** | ✅ 删除按钮 | ✅ 删除按钮 |
| **下一步引导** | ✅ 显示操作步骤 | ❌ 无 |
| **连接状态显示** | ✅ 详细状态 + 错误信息 | ✅ 简单状态 |
| **可选配置项** | ✅ 可展开（Encrypt Key、Verification Token） | ✅ 直接显示 |
| **WeChat 二维码登录** | ✅ 支持 | ❌ 无 |
| **扩展插件支持** | ✅ 动态加载 | ❌ 无 |

---

## 二、按钮交互逻辑全链路对比

### 1. 测试连接（Test Connection）

#### 个人模式流程

```
用户点击 "Test" 按钮
    ↓
前端调用 channel.testPlugin.invoke({ pluginId, token, extraConfig })
    ↓
IPC Bridge → Main Process → ChannelManager.testPlugin()
    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ if (isEnterpriseMode()) {                                            │
│   // 企业模式：调用 RemoteChannelProvider.testConnection()           │
│   → POST /api/v1/channels/plugins/{pluginId}/test                   │
│   → Moss Server → ChannelManager.testPlugin()                       │
│   → LarkPlugin.testConnection(appId, appSecret)                     │
│ } else {                                                             │
│   // 个人模式：本地调用                                               │
│   → TelegramPlugin.testConnection(token)                            │
│   → LarkPlugin.testConnection(appId, appSecret)                     │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘
    ↓
返回 { success, botUsername, error }
    ↓
前端显示成功/失败消息
    ↓
成功后自动调用 handleAutoEnable() 启用插件
```

#### 企业模式流程

```
用户点击 "测试连接" 按钮
    ↓
前端调用 testPlugin(pluginId, credentials)
    ↓
authClient.post('/api/v1/channels/plugins/{pluginId}/test', credentials)
    ↓
Moss Server → channelsApi.testPlugin()
    ↓
ChannelManager.testPlugin(pluginId, credentials)
    ↓
LocalChannelProvider.testConnection(pluginId, credentials)
    ↓
LarkPlugin.testConnection(appId, appSecret)
    ↓
返回 { ok, message }
    ↓
前端显示成功/失败消息
    ↓
注意：不会自动启用插件，需要用户点击"保存并启用"
```

#### 差异对比

| 步骤 | 个人模式 | 企业模式 |
|-----|---------|---------|
| 调用方式 | IPC Bridge | REST API |
| 测试成功后 | **自动启用插件** | 需手动点击"保存并启用" |
| 返回格式 | `{ success, botUsername, error }` | `{ ok, message }` |

---

### 2. 启用插件（Enable Plugin）

#### 个人模式流程

```
用户切换 Switch 开关 或 测试成功后自动启用
    ↓
前端调用 channel.enablePlugin.invoke({ pluginId, config })
    ↓
IPC Bridge → Main Process → ChannelManager.enablePlugin()
    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ if (isEnterpriseMode()) {                                            │
│   // 企业模式：调用 RemoteChannelProvider.upsertPlugin()            │
│   → POST /api/v1/channels/plugins/{pluginId}/enable                 │
│   → Moss Server 启动插件                                             │
│   → 返回成功（插件在服务端运行）                                      │
│ } else {                                                             │
│   // 个人模式：本地启用                                               │
│   → provider.upsertPlugin(config) // 保存到本地 SQLite              │
│   → pluginManager.startPlugin(config) // 本地启动插件               │
│   → LarkPlugin.onStart() → 创建 WebSocket 连接                      │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘
    ↓
插件开始运行，监听消息
```

#### 企业模式流程

```
用户点击 "保存并启用" 按钮
    ↓
前端调用 enablePlugin(pluginId, credentials)
    ↓
authClient.post('/api/v1/channels/plugins/{pluginId}/enable', credentials)
    ↓
Moss Server → channelsApi.enablePlugin()
    ↓
ChannelManager.enablePlugin(pluginId, credentials)
    ↓
保存到数据库 + 启动插件
    ↓
PluginManager.startPlugin(config)
    ↓
LarkPlugin.onStart() → 创建 WebSocket 连接
    ↓
返回 { ok: true }
```

#### 差异对比

| 步骤 | 个人模式 | 企业模式 |
|-----|---------|---------|
| 触发方式 | Switch 开关 或 自动启用 | "保存并启用" 按钮 |
| 数据存储 | 本地 SQLite | Moss Server 数据库 |
| 插件运行位置 | 本地进程 | Moss Server 进程 |

---

### 3. 禁用插件（Disable Plugin）

#### 个人模式流程

```
用户切换 Switch 开关
    ↓
channel.disablePlugin.invoke({ pluginId })
    ↓
ChannelManager.disablePlugin()
    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ if (isEnterpriseMode()) {                                            │
│   → POST /api/v1/channels/plugins/{pluginId}/disable                │
│ } else {                                                             │
│   → pluginManager.stopPlugin(pluginId)                              │
│   → provider.updatePluginEnabled(pluginId, false)                   │
│   → 对于 WeChat/WeCom：清除所有用户和会话                            │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

#### 企业模式流程

```
用户点击 "禁用" 按钮
    ↓
disablePlugin(pluginId)
    ↓
POST /api/v1/channels/plugins/{pluginId}/disable
    ↓
Moss Server → ChannelManager.disablePlugin()
    ↓
PluginManager.stopPlugin() + 更新数据库
```

---

### 4. 配对流程（Pairing Flow）

#### 个人模式流程

```
1. 用户在 IM 发送消息给 Bot
    ↓
2. Bot 收到消息 → PairingService 生成配对码
    ↓
3. 通过 IPC 事件 channel.pairingRequested 推送到前端
    ↓
4. 前端实时显示配对请求（无需刷新）
    ↓
5. 用户点击 "Approve" 或 "Reject"
    ↓
6. channel.approvePairing.invoke({ code })
    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ if (isEnterpriseMode()) {                                            │
│   → POST /api/v1/channels/pairings/{code}/approve                   │
│   → Moss Server 更新数据库                                           │
│ } else {                                                             │
│   → PairingService.approvePairing(code)                             │
│   → 保存用户到本地 SQLite                                            │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘
    ↓
7. 通过 IPC 事件 channel.userAuthorized 推送新用户到前端
    ↓
8. 用户可以开始与 Agent 对话
```

#### 企业模式流程

```
1. 用户在 IM 发送消息给 Bot
    ↓
2. Moss Server Bot 收到消息 → 生成配对码
    ↓
3. 前端需要手动刷新获取配对列表（无实时推送）
    ↓
4. 用户点击 "批准"
    ↓
5. approvePairing(code)
    ↓
6. POST /api/v1/channels/pairings/{code}/approve
    ↓
7. Moss Server 更新数据库
    ↓
8. 用户可以开始与 Agent 对话
```

#### 差异对比

| 步骤 | 个人模式 | 企业模式 |
|-----|---------|---------|
| 配对请求推送 | ✅ IPC 实时推送 | ❌ 需手动刷新 |
| 拒绝配对按钮 | ✅ 有 | ❌ 无 |
| 用户授权推送 | ✅ IPC 实时推送 | ❌ 需手动刷新 |

---

### 5. Agent 选择（Agent Selection）

#### 个人模式流程

```
用户选择 Agent
    ↓
Dropdown onChange → persistSelectedAgent(agent)
    ↓
ConfigStorage.set('assistant.{platform}.agent', agent)
    ↓
channel.syncChannelSettings.invoke({ platform, agent, model })
    ↓
ChannelManager.syncChannelSettings() → 清除所有 Session
    ↓
下次消息到来时使用新的 Agent
```

#### 企业模式流程

```
❌ 不支持 Agent 选择

原因：企业模式的 Agent 配置应该在 Moss Server 端统一管理
```

---

### 6. 模型选择（Model Selection）

#### 个人模式流程

```
用户选择模型
    ↓
GeminiModelSelector → onSelectModel(provider, modelName)
    ↓
ConfigStorage.set('assistant.{platform}.defaultModel', { id, useModel })
    ↓
channel.syncChannelSettings.invoke({ platform, agent, model })
    ↓
ChannelManager.syncChannelSettings() → 清除所有 Session
```

#### 企业模式流程

```
❌ 不支持模型选择

原因：企业模式的模型配置应该在 Moss Server 端统一管理
```

---

### 7. 撤销用户（Revoke User）

#### 个人模式流程

```
用户点击删除按钮
    ↓
channel.revokeUser.invoke({ userId })
    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ if (isEnterpriseMode()) {                                            │
│   → DELETE /api/v1/channels/users/{userId}                          │
│ } else {                                                             │
│   → provider.deleteUser(userId)                                     │
│   → 从本地 SQLite 删除用户                                          │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘
    ↓
刷新用户列表
```

#### 企业模式流程

```
用户点击删除按钮
    ↓
确认对话框
    ↓
deleteUser(userId)
    ↓
DELETE /api/v1/channels/users/{userId}
    ↓
Moss Server 删除用户
    ↓
刷新用户列表
```

---

## 三、架构设计对比

### 个人模式架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        sudowork 客户端 (Electron)                    │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │  Renderer 进程   │    │   Main 进程     │    │  本地 SQLite    │  │
│  │  (React UI)     │◄──►│ ChannelManager  │◄──►│    数据库       │  │
│  │                 │    │                 │    │                 │  │
│  │  - 配置表单      │    │ - PluginManager │    │ - plugins 表    │  │
│  │  - 状态显示      │    │ - SessionManager│    │ - users 表      │  │
│  │  - 用户操作      │    │ - PairingService│    │ - sessions 表   │  │
│  └─────────────────┘    └────────┬────────┘    └─────────────────┘  │
│                                  │                                   │
│                                  ▼                                   │
│                         ┌─────────────────┐                         │
│                         │  Plugin 实例    │                         │
│                         │  (本地运行)     │                         │
│                         │                 │                         │
│                         │ - TelegramPlugin│                         │
│                         │ - LarkPlugin    │                         │
│                         │ - DingTalkPlugin│                         │
│                         └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 企业模式架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     sudowork 客户端 (企业模式)                        │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐                                                │
│  │  Renderer 进程   │                                                │
│  │  (React UI)     │                                                │
│  │                 │                                                │
│  │  - 配置表单      │                                                │
│  │  - 状态显示      │                                                │
│  │  - 用户操作      │                                                │
│  └────────┬────────┘                                                │
│           │                                                          │
│           │ RemoteChannelProvider                                   │
│           │ (REST API 调用)                                          │
│           ▼                                                          │
└─────────────────────────────────────────────────────────────────────┘
            │
            │ HTTP/HTTPS
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Moss Server                                 │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │  REST API       │    │ ChannelManager  │    │  数据库         │  │
│  │  /api/v1/       │◄──►│                 │◄──►│  (PostgreSQL/   │  │
│  │  channels/*     │    │ - PluginManager │    │   SQLite)       │  │
│  │                 │    │ - SessionManager│    │                 │  │
│  └─────────────────┘    │ - PairingService│    │ - plugins 表    │  │
│                         └────────┬────────┘    │ - users 表      │  │
│                                  │              │ - sessions 表   │  │
│                                  ▼              └─────────────────┘  │
│                         ┌─────────────────┐                         │
│                         │  Plugin 实例    │                         │
│                         │  (服务端运行)   │                         │
│                         │                 │                         │
│                         │ - TelegramPlugin│                         │
│                         │ - LarkPlugin    │                         │
│                         │ - DingTalkPlugin│                         │
│                         └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、关键差异总结

| 差异点 | 个人模式 | 企业模式 | 说明 |
|-------|---------|---------|------|
| **数据存储** | 本地 SQLite | Moss Server 数据库 | 通过 IChannelProvider 抽象 |
| **插件运行位置** | 本地进程 | Moss Server 进程 | 企业模式客户端不运行插件 |
| **实时事件推送** | ✅ IPC 事件 | ❌ 无 | 企业模式需轮询或 WebSocket |
| **Agent 选择** | ✅ 支持 | ❌ 无 | 企业模式应在服务端配置 |
| **模型选择** | ✅ 支持 | ❌ 无 | 企业模式应在服务端配置 |
| **WeChat 二维码** | ✅ 支持 | ❌ 无 | 需要本地 GUI |
| **扩展插件** | ✅ 动态加载 | ❌ 无 | 需要在 Moss Server 注册 |
| **测试后自动启用** | ✅ 是 | ❌ 否 | 企业模式需手动保存 |
| **拒绝配对按钮** | ✅ 有 | ❌ 无 | 企业模式只有批准 |
| **下一步引导** | ✅ 详细步骤 | ❌ 无 | 企业模式缺少引导 |

---

## 五、建议改进

企业模式需要补充以下功能以与个人模式对齐：

### 5.1 高优先级

1. **实时事件推送**
   - 使用 WebSocket 或 SSE 推送配对请求和用户授权事件
   - 减少用户手动刷新的频率
   - 提升用户体验

2. **拒绝配对功能**
   - 添加"拒绝"按钮
   - 实现 `POST /api/v1/channels/pairings/{code}/reject` API

3. **下一步引导**
   - 添加操作步骤提示
   - 帮助用户理解配对流程

### 5.2 中优先级

4. **Agent 选择器**
   - 在 Moss Server 端实现 Agent 配置 API
   - 前端添加 Agent 下拉选择

5. **模型选择器**
   - 在 Moss Server 端实现模型配置 API
   - 前端添加模型选择组件

### 5.3 低优先级

6. **扩展插件支持**
   - 支持动态注册和加载扩展插件
   - 需要在 Moss Server 端实现插件注册机制

7. **WeChat 二维码登录**
   - 需要评估企业模式是否需要此功能
   - 可能需要通过其他方式实现

---

## 六、API 对应关系

| 功能 | 个人模式 IPC | 企业模式 REST API |
|-----|-------------|------------------|
| 获取插件状态 | `channel.getPluginStatus` | `GET /api/v1/channels/plugins` |
| 获取插件凭据 | `channel.getPluginCredentials` | `GET /api/v1/channels/plugins/:id` |
| 启用插件 | `channel.enablePlugin` | `POST /api/v1/channels/plugins/:id/enable` |
| 禁用插件 | `channel.disablePlugin` | `POST /api/v1/channels/plugins/:id/disable` |
| 测试插件 | `channel.testPlugin` | `POST /api/v1/channels/plugins/:id/test` |
| 获取待配对列表 | `channel.getPendingPairings` | `GET /api/v1/channels/pairings/pending` |
| 批准配对 | `channel.approvePairing` | `POST /api/v1/channels/pairings/:code/approve` |
| 拒绝配对 | `channel.rejectPairing` | `POST /api/v1/channels/pairings/:code/reject` |
| 获取授权用户 | `channel.getAuthorizedUsers` | `GET /api/v1/channels/users` |
| 撤销用户 | `channel.revokeUser` | `DELETE /api/v1/channels/users/:id` |
| 同步设置 | `channel.syncChannelSettings` | ❌ 无对应 API |
| 配对请求事件 | `channel.pairingRequested` | ❌ 无实时推送 |
| 用户授权事件 | `channel.userAuthorized` | ❌ 无实时推送 |
| 插件状态变更事件 | `channel.pluginStatusChanged` | ❌ 无实时推送 |

---

## 七、代码文件索引

### 个人模式

| 文件 | 说明 |
|-----|------|
| `src/renderer/components/SettingsModal/contents/ChannelModalContent.tsx` | Channels 设置主页面 |
| `src/renderer/components/SettingsModal/contents/TelegramConfigForm.tsx` | Telegram 配置表单 |
| `src/renderer/components/SettingsModal/contents/LarkConfigForm.tsx` | Lark 配置表单 |
| `src/renderer/components/SettingsModal/contents/DingTalkConfigForm.tsx` | DingTalk 配置表单 |
| `src/renderer/components/SettingsModal/contents/WeChatConfigForm.tsx` | WeChat 配置表单 |
| `src/renderer/components/SettingsModal/contents/WeComConfigForm.tsx` | WeCom 配置表单 |
| `src/channels/core/ChannelManager.ts` | Channel 管理器 |
| `src/channels/core/LocalChannelProvider.ts` | 本地数据提供者 |
| `src/channels/core/RemoteChannelProvider.ts` | 远程数据提供者 |
| `src/common/ipcBridge.ts` | IPC 桥接定义 |

### 企业模式

| 文件 | 说明 |
|-----|------|
| `admin/src/pages/channels-page.tsx` | Channels 管理页面 |
| `admin/lib/api/channels.ts` | Channels API 客户端 |
| `admin/lib/api/types.ts` | 类型定义 |
| `src/server/api/channels.ts` | Channels 服务端 API |
| `src/channels/core/ChannelManager.ts` | Channel 管理器 |
| `src/channels/core/LocalChannelProvider.ts` | 本地数据提供者 |

---

*文档生成时间: 2025-05-07*
