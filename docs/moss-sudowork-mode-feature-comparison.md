# Sudowork 普通模式 vs 企业模式功能缺口梳理

本文以 Sudowork 普通用户模式为参考，检查企业模式和 Moss 当前实现的缺口。结论基于当前仓库代码，重点覆盖 MCP 配置、图片模型设置、会话能力、系统设置和定时任务。

## 总结结论

| 模块 | 普通模式状态 | 企业模式 / Moss 当前状态 | 结论 |
| --- | --- | --- | --- |
| MCP 配置 | 已完整实现本地配置、导入、编辑、测试、OAuth、同步到 Agent | 企业客户端隐藏入口；Moss runner 有读取 MCP 配置的底层能力，但没有 AdminHub/API/企业配置闭环 | 企业模式缺完整 MCP 配置实现 |
| 图片模型设置 | 已实现本地图片模型选择，并接入图片生成 bridge | Moss AdminHub 可以保存图片模型字段，但未看到运行时或工具消费该配置 | 配置保存成功，功能未闭环 |
| 会话能力 | 本地会话、文件复制、Agent 运行、Slash 命令、MCP、图片生成、定时任务联动较完整 | 企业远程会话主链路可用，但文件、MCP、图片生成、模型切换等能力不等价 | 企业会话是可用但不完整 |
| 系统设置 | 设置页覆盖模型、Agent、工具、技能、安全、运行时、定时任务等 | 企业客户端只开放 profile、enterprise、display、webui、system、about；Moss AdminHub 只有少量服务端设置 | 企业系统设置缺普通模式的大部分高级配置 |
| 定时任务 | Sudowork 本地 CronService 和 UI 已实现 | 企业客户端底层 CronService 会初始化，但 `/settings/cron` 被企业路由拦截；Moss 无集中式企业定时任务 API/UI | 企业模式只算局部可运行，不算完整实现 |

## 1. 设置入口差异

普通用户模式的设置入口较完整，包含 Agent、Tools、Skill、Security、Runtime、System、About 等页面，且路由中还存在 Model、Cron 等页面。

企业模式客户端被显式限制，只允许：

- `/settings/profile`
- `/settings/enterprise`
- `/settings/display`
- `/settings/webui`
- `/settings/system`
- `/settings/about`

因此普通模式里的这些关键设置页在企业模式下被隐藏或路由拦截：

- `/settings/model`
- `/settings/agent`
- `/settings/tools`
- `/settings/skill`
- `/settings/security`
- `/settings/runtime`
- `/settings/cron`

代码依据：

- `sudowork/src/renderer/router.tsx`
- `sudowork/src/renderer/pages/settings/SettingsSider.tsx`

## 2. MCP 配置缺口

### 普通模式已有能力

普通模式的 MCP 管理在 Sudowork 客户端里是完整功能，不只是一个配置字段。已有能力包括：

| MCP 能力 | 普通模式 |
| --- | --- |
| MCP Server 列表 | 已实现 |
| JSON 导入配置 | 已实现 |
| 从已安装 Agent 一键导入 | 已实现 |
| 新增、编辑、删除 MCP Server | 已实现 |
| 启用、禁用 MCP Server | 已实现 |
| 测试 MCP 连接 | 已实现 |
| 同步 MCP 到 Claude、Gemini、Qwen、Codex 等 Agent | 已实现 |
| HTTP/SSE OAuth 登录、登出、状态检查 | 已实现 |
| Agent MCP 配置读取 | 已实现 |

相关代码：

- `sudowork/src/renderer/pages/settings/McpManagement/index.tsx`
- `sudowork/src/renderer/components/SettingsModal/contents/ToolsModalContent.tsx`
- `sudowork/src/process/bridge/mcpBridge.ts`
- `sudowork/src/process/services/mcpServices/McpService.ts`
- `sudowork/src/process/services/mcpServices/McpOAuthService.ts`

### 企业模式 / Moss 当前状态

企业客户端隐藏了 `/settings/tools`，所以用户不能在企业模式 UI 里进入 MCP 管理。

Moss 当前只看到底层 runner 侧会读取或预取 MCP 配置：

- `moss/src/bootstrap/headless.ts` 中有 `getAllMcpConfigs()` 和 `prefetchAllMcpResources()`
- `moss/src/utils/settings/types.ts` 中有 `enableAllProjectMcpServers`、`enabledMcpjsonServers`、`disabledMcpjsonServers`、`allowedMcpServers` 等配置 schema

但没有看到完整的企业 MCP 管理闭环：

- 没有 AdminHub MCP 管理页
- 没有 `/api/v1/mcp` 这类服务端管理 API
- 没有企业级新增、编辑、删除、启停、测试 MCP Server 的入口
- 没有 OAuth 登录、登出、状态检查的企业实现
- 没有用户、部门、组织级 MCP 可见性和权限配置
- 没有把 Sudowork 普通模式的 MCP 同步能力迁移到 Moss 管理端

结论：Moss 不是完全没有 MCP 底层读取能力，但企业模式缺的是“完整配置和管理实现”。这块应标为未实现。

## 3. 图片模型设置是否成功

### 普通模式已有能力

普通模式的图片模型设置已经接到图片生成链路：

| 能力 | 普通模式 |
| --- | --- |
| 图片生成开关 | 已实现 |
| 图片模型选择 | 已实现 |
| 默认图片模型 | 已实现 |
| 保存用户选择 | 已实现 |
| 同步给 openclaw / scode | 已实现 |
| 调用 `/images/generations` | 已实现 |
| 图片编辑和头像生成 bridge | 已实现 |

相关代码：

- `sudowork/src/renderer/components/SettingsModal/contents/ToolsModalContent.tsx`
- `sudowork/src/process/bridge/imageGenerationBridge.ts`

普通模式中可选模型包含：

- `gpt-image-1.5`
- `gpt-image-1`
- `doubao-seedream-4-0-250828`

### Moss 当前实现

Moss AdminHub 的系统设置页有“图片模型”配置区，字段包括：

- `provider`
- `url`
- `apiKey`
- `model`

这些字段通过 `/api/v1/settings/system` 保存到系统设置中。默认配置在 `moss/src/server/systemSettings.ts`：

```ts
image: {
  provider: 'minimax',
  url: 'https://api.minimaxi.com/v1/image_generation',
  apiKey: '',
  model: '',
}
```

也就是说，图片模型设置的“保存”是成功的。

但从当前代码看，图片模型设置没有完成运行闭环：

- `moss/src/server/runtimeService.ts` 只把文本模型相关配置注入 runner：
  - `MOSS_DEFAULT_MODEL`
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_AUTH_TOKEN`
  - `ANTHROPIC_MODEL`
- 未看到 `systemSettings.image` 被注入 runner env
- 未看到 Moss 服务端存在等价的 `generateImage` 工具或 API
- 未看到企业会话调用 AdminHub 图片模型配置
- `moss/src/utils/settings/types.ts` 虽然有 `imageGeneration` schema，但它和 AdminHub 的 `systemSettings.image` 没有形成闭环

结论：图片模型设置“能保存”，但不能判定为图片生成功能已经成功。按产品能力口径，应标为未完整实现。

## 4. 企业模式会话缺失项

### 普通模式会话能力

普通模式以本地 Agent 和本地数据库为核心，已有能力包括：

- 本地创建、删除、更新会话
- 本地保存和读取消息
- 发送消息到本地 Agent
- 文件复制到 workspace 后发送给 Agent
- 支持百度网盘文件解析后转成本地文件
- 支持 preset context、skills、assistant resources
- 支持 MCP 工具配置进入 Agent
- 支持 Slash 命令
- 支持 `/image` 图片生成命令
- 支持权限确认、打断、继续
- 支持 CronService 创建或复用会话执行定时任务

### 企业远程会话已有能力

企业模式使用 `RemoteConversationProvider` 和 `RemoteAgent` 连接 Moss 远程会话，当前已具备：

| 能力 | 企业模式状态 |
| --- | --- |
| 首次发送时创建 Moss session | 已实现 |
| WebSocket 发送消息 | 已实现 |
| 接收 assistant 消息流 | 已实现 |
| 权限请求和响应 | 已实现 |
| 打断会话 | 已实现 |
| 终止 Moss session | 已实现 |
| 拉取 Moss session context | 已实现 |
| 本地缓存远程会话元数据 | 已实现 |

相关代码：

- `sudowork/src/renderer/services/conversation/RemoteConversationProvider.ts`
- `sudowork/src/process/task/RemoteAgent.ts`
- `sudowork/src/process/services/moss/MossWsConnection.ts`
- `sudowork/src/process/services/moss/MossSessionApi.ts`

### 与普通模式相比缺失或不完整

| 会话能力 | 普通模式 | 企业模式 / Moss | 缺口判断 |
| --- | --- | --- | --- |
| 附件和本地文件 | 文件会复制到 workspace，Agent 可直接读 | `RemoteAgent` 会把文件路径拼进文本，`MossWsConnection.sendMessage()` 没有真正上传 files | 缺完整文件上传和远程可访问映射 |
| 百度网盘文件 | 会先解析和复制 | 远程链路没有看到等价处理 | 缺失 |
| MCP 工具 | 可在 Tools 设置里完整配置并同步 | Moss runner 可读取已有配置，但企业无配置 UI/API | 缺完整 MCP 配置 |
| 图片生成 | 普通模式 bridge 已实现 | Moss 图片设置只保存，未接入企业会话 | 缺失 |
| Slash 命令 | 支持 ACP 命令和 `/image` | 远程 Agent 侧能力不等价，图片命令没有 Moss 运行闭环 | 不完整 |
| 动态切换模型 | 本地 Agent 有自己的模型配置链路 | 企业客户端存在 `set_model` 调用，但 Moss server 未看到完整 `set_model` 处理闭环，client 侧 `canSwitch` 也为 false | 不完整 |
| 会话列表来源 | 本地 DB 完整维护 | 企业客户端主要依赖本地缓存和远程 session id，Moss session 不是完整替代本地列表 | 不完整 |
| 历史消息 | 本地 DB 可完整读写 | 企业模式依赖 Moss context 和本地缓存 | 可用但不等价 |
| workspace | 本地 workspace 和本地文件一致 | Moss 运行在远程或容器时，本地路径未必存在 | 不完整 |
| 定时任务联动 | CronService 可以创建或复用本地会话 | 企业下 CronService 可初始化，但 UI 被隐藏，且不是 Moss 集中式能力 | 不完整 |

关键文件链路：

- `sudowork/src/process/task/RemoteAgent.ts` 会把附件路径拼到 content
- `sudowork/src/process/services/moss/MossWsConnection.ts` 的 `sendMessage()` 只发送文本内容，没有上传 `payload.files`
- `moss/src/server/runtimeService.ts` 负责启动 runner，但没有图片模型配置注入

## 5. 企业模式系统设置缺失项

### 普通模式系统和设置能力

普通模式设置项按产品能力看包括：

- 模型平台配置
- Agent 配置
- Tools 配置
- MCP 管理
- 图片模型设置
- Skill 管理
- Security 设置
- Runtime 设置
- Cron 定时任务设置
- Display 设置
- WebUI 设置
- System 本地偏好
- About

### 企业客户端当前开放的设置

企业客户端只开放：

- Profile
- Enterprise
- Display
- WebUI
- System
- About

其中 System 页主要是本地桌面偏好，例如语言、主题、关闭到托盘、头像、超时、工作目录等。它不是 Moss 服务端能力配置中心。

### Moss AdminHub 当前系统设置

Moss AdminHub 目前有服务端系统设置页，主要字段包括：

- 默认文本模型
- API URL
- API Key
- 图片模型 provider / url / apiKey / model
- Skill Store tenantId
- bypass permissions
- max turns
- thinking mode
- thinking budget tokens

相关代码：

- `moss/admin/src/pages/system-settings-page.tsx`
- `moss/src/server/systemSettings.ts`
- `moss/src/server/runtimeService.ts`

### 与普通模式相比缺失

| 设置能力 | 普通模式 | 企业模式 / Moss | 判断 |
| --- | --- | --- | --- |
| 多模型平台管理 | 有独立模型配置链路 | AdminHub 只有默认文本模型和基础 URL/API Key | 不完整 |
| Agent 配置 | 有 `/settings/agent` | 企业隐藏 | 缺失 |
| Tools 配置 | 有 `/settings/tools` | 企业隐藏 | 缺失 |
| MCP 管理 | Tools 内完整实现 | Moss 无完整管理页/API | 缺失 |
| 图片模型功能 | 普通模式可选择并调用 | Moss 只保存字段，未接运行时 | 不完整 |
| Skill 管理 | 有 `/settings/skill` | 企业隐藏；Moss 只有 skillStore tenantId 配置 | 不完整 |
| Security 设置 | 有 `/settings/security` | 企业隐藏 | 缺失 |
| Runtime 设置 | 有 `/settings/runtime` | 企业隐藏；Moss session runtime 由服务端内部决定 | 不完整 |
| Cron 设置 | 有 `/settings/cron` | 企业隐藏；Moss 无集中式任务设置 | 缺失 |
| Prompt/Idle timeout 对远程会话生效 | 普通模式本地可控 | 企业 System 页有本地字段，但未看到传入 Moss runner 的闭环 | 不确定，按不完整处理 |

## 6. 定时任务是否实现

### 普通模式

普通模式定时任务已实现，主要由 Sudowork 本地 CronService 负责：

- 使用本地 SQLite `cron_jobs` 表
- 支持 `at`、`every`、`cron` 等计划类型
- 支持新增、更新、删除、暂停、恢复、立即运行
- 支持创建新会话或复用会话
- 支持 workspace
- 支持 preset assistant
- 支持系统唤醒后检查错过的任务
- 支持 powerSaveBlocker 防止任务执行时休眠

相关代码：

- `sudowork/src/process/services/cron/CronService.ts`
- `sudowork/src/process/services/cron/CronStore.ts`
- `sudowork/src/process/bridge/cronBridge.ts`
- `sudowork/src/process/database/migrations.ts`

### 企业模式

企业客户端启动时仍会初始化 CronService：

- `sudowork/src/process/initBridge.ts` 中注释为 `Initialize cron service in all modes`
- 注释明确写着 `now available in enterprise mode too`

但企业模式下 `/settings/cron` 被路由限制挡掉，所以用户没有完整可见的定时任务设置入口。

因此企业客户端当前只能算“底层本地 CronService 可能可用”，不能算“企业模式定时任务完整实现”。

### Moss 服务端

Moss 中存在 `.claude/scheduled_tasks.json` 相关的 agent/CLI 级调度代码：

- `moss/src/utils/cronScheduler.ts`
- `moss/src/utils/cronTasks.ts`

但没有看到企业 AdminHub 或服务端 API 层面的定时任务管理能力：

- 没有企业定时任务列表页
- 没有 `/api/v1/cron` 或等价 API
- 没有企业任务表、权限、审计、部门可见性
- 没有集中式任务执行和状态管理

结论：如果按企业产品能力定义，Moss 定时任务未实现；如果按本地客户端能力定义，Sudowork 企业客户端只有局部底层能力，UI 和服务端闭环缺失。

## 7. 按优先级的缺口清单

### P0：企业模式应先补齐

1. MCP 企业配置中心
   - AdminHub MCP Server 管理页
   - 服务端 MCP CRUD API
   - 连接测试
   - OAuth 登录和状态管理
   - 用户、部门、组织级可见性
   - 会话启动时注入可见 MCP 配置

2. 企业会话文件上传
   - 上传本地附件到 Moss
   - 将文件映射到 runner 可读路径
   - 支持百度网盘文件转换后的远程可读文件
   - 会话消息中保存附件元数据

3. 图片模型运行闭环
   - 明确图片模型协议，MiniMax 还是 OpenAI-compatible
   - 将 AdminHub 图片设置注入 runner 或服务端工具
   - 增加企业 `generateImage` 工具/API
   - 让 `/image` 在远程会话中真正可用

4. 企业定时任务
   - Moss 服务端任务表和 API
   - AdminHub 任务管理页
   - 任务执行状态、日志、暂停、恢复、立即运行
   - 用户和部门权限

### P1：影响体验和可维护性

1. 企业会话模型切换闭环
   - Moss server 处理 `set_model`
   - client `canSwitch` 和 `availableModels` 返回真实状态
   - 会话运行时使用切换后的模型

2. 企业系统设置补齐
   - 多模型平台管理
   - Agent 默认配置
   - Runtime 配置
   - Skill 管理和可见性
   - Security 策略

3. 远程会话列表和历史统一
   - 客户端不只依赖本地缓存
   - Moss session list、message history、context 统一查询
   - 删除、归档、恢复语义统一

### P2：后续增强

1. 企业设置项与普通设置项的差异提示
2. 从普通模式迁移 MCP、Skill、Agent 配置到企业模式
3. AdminHub 中增加配置健康检查
4. 图片模型、MCP、Cron 增加审计日志

## 8. 最终实现状态列表

| 功能 | 普通模式已实现 | 企业客户端已实现 | Moss 已实现 | 企业模式缺口 |
| --- | --- | --- | --- | --- |
| MCP 配置 UI | 是 | 否 | 否 | 缺 |
| MCP 服务端 CRUD API | 本地 bridge 是 | 否 | 否 | 缺 |
| MCP 连接测试 | 是 | 否 | 否 | 缺 |
| MCP OAuth | 是 | 否 | 否 | 缺 |
| MCP runner 读取 | 是 | 部分 | 部分 | 缺管理闭环 |
| 图片模型保存 | 是 | 部分 | 是 | Moss 仅保存 |
| 图片生成调用 | 是 | 否 | 否 | 缺 |
| `/image` 远程可用 | 是 | 不完整 | 否 | 缺 |
| 本地文件附件 | 是 | 不完整 | 不完整 | 缺上传和路径映射 |
| 百度网盘文件进入会话 | 是 | 不完整 | 不完整 | 缺远程处理 |
| 远程会话创建 | 不适用 | 是 | 是 | 已有 |
| 权限确认 | 是 | 是 | 是 | 基本已有 |
| 打断会话 | 是 | 是 | 是 | 基本已有 |
| 动态切模型 | 是 | 不完整 | 不完整 | 缺 server 闭环 |
| Agent 设置 | 是 | 否 | 否 | 缺 |
| Tools 设置 | 是 | 否 | 否 | 缺 |
| Skill 设置 | 是 | 否 | 部分 | 缺完整管理 |
| Security 设置 | 是 | 否 | 部分 | 缺企业设置页 |
| Runtime 设置 | 是 | 否 | 部分 | 缺可配置入口 |
| Cron UI | 是 | 否 | 否 | 缺 |
| Cron 本地服务 | 是 | 部分 | 不适用 | 企业只局部可用 |
| 企业集中式 Cron | 否 | 否 | 否 | 缺 |

