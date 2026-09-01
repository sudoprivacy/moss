# Moss Server API

本文档描述统一后的 `moss-server` HTTP / WebSocket 接口。

## Overview

统一后的 server 只有一个进程、一个端口、一个 base URL、一个 SQLite 数据库连接。

它同时提供：

- session runtime API
- auth API
- users / api keys 管理 API
- `/admin` 静态 SPA

默认启动入口：

- `node moss-server.mjs`
- 兼容入口：`node direct-connect-server.mjs`

默认配置文件：

- `~/.moss/server/server.json`
- 可通过 `MOSS_SERVER_CONFIG=/path/to/server.json` 覆盖

**首次启动**：如果配置文件不存在，server 会自动创建一个默认配置文件，包含：

- 监听 `0.0.0.0:43127`
- 本地认证模式 (`auth.mode: local`)
- 默认管理员用户名 `admin`（密码需手动设置）
- 数据存储在 `~/.moss/server/` 目录下

启动后会提示编辑配置文件设置 `bootstrapAdmin.password`。

### 远程访问配置

如果 server 需要被远程客户端访问（非本地），需要配置 `advertisedHost`：

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 43127,
    "advertisedHost": "10.0.1.179"
  }
}
```

说明：

- `host`: 监听地址，`0.0.0.0` 表示监听所有接口
- `advertisedHost`: 对外广播的地址，用于 WebSocket URL
- 如果不设置 `advertisedHost`，当 `host` 为 `0.0.0.0` 或 `::` 时，WebSocket URL 会使用 `127.0.0.1`，导致远程客户端无法连接

首次初始化 admin 可直接从配置文件读取：

```json
{
  "bootstrapAdmin": {
    "username": "admin",
    "password": "ChangeMe123!",
    "email": "admin@example.com"
  }
}
```

说明：

- `username` 用于 `/admin` 登录
- `password` 仅在数据库首次初始化时生效
- `email` 可选；不填时会自动生成一个本地占位邮箱

## Base URL

示例：

```text
http://127.0.0.1:43127
```

`cc://` 连接串也收敛成单地址模式：

```text
cc://127.0.0.1:43127
```

## Auth

除以下路径外，其他接口都要求：

```text
Authorization: Bearer <access_token>
```

无需鉴权的路径：

- `GET /healthz`
- `GET /readyz`
- `GET /admin`
- `GET /admin/*`
- `POST /api/v1/auth/token`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/introspect`

失败格式统一为：

```json
{ "error": "..." }
```

## Health

### GET `/healthz`

存活检查。

示例响应：

```json
{
  "ok": true,
  "ready": true,
  "sessions": 2,
  "auth_mode": "local"
}
```

### GET `/readyz`

就绪检查。

示例响应：

```json
{
  "ok": true,
  "ready": true
}
```

## Admin UI

### GET `/admin`

返回 `admin/dist/index.html`。

### GET `/admin/*`

静态资源直接返回；非文件路径会做 SPA fallback，统一回到 `index.html`。

## Auth API

### POST `/api/v1/auth/token`

密码或 API key 登录，返回 access token。

密码登录：

```json
{
  "grant_type": "password",
  "username": "admin",
  "password": "secret"
}
```

兼容旧客户端，`email` 登录仍然可用。

API key 登录：

```json
{
  "grant_type": "api_key",
  "api_key": "moss_sk_xxx.yyy"
}
```

示例响应：

```json
{
  "access_token": "jwt",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": {
    "id": "user-id",
    "orgId": "org-id",
    "email": "admin@example.com",
    "name": "Admin",
    "role": "admin",
    "status": "active",
    "createdAt": 0,
    "passwordUpdatedAt": 0,
    "lastLoginAt": 0
  },
  "organization": {
    "id": "org-id",
    "name": "Default Organization",
    "createdAt": 0
  },
  "scopes": ["*"]
}
```

### POST `/api/v1/auth/login`

`/api/v1/auth/token` 的等价别名。

### GET `/api/v1/auth/me`

返回当前 token 对应用户信息。

### POST `/api/v1/auth/introspect`

可选外部接口，内部不再通过 HTTP 调它。

请求：

```json
{ "token": "jwt" }
```

示例响应：

```json
{
  "active": true,
  "sub": "user-id",
  "org_id": "org-id",
  "role": "admin",
  "scopes": ["*"],
  "key_id": "password-login"
}
```

## Users API

### GET `/api/v1/roles`

需要 scope：`admin:users`

返回固定角色定义：`admin / dept_admin / user`。

## Departments API

### GET `/api/v1/departments`

需要 scope：`admin:users`

返回当前组织下的部门列表，前端可据此构建层级树。

### POST `/api/v1/departments`

需要 scope：`admin:users`

请求：

```json
{
  "name": "研发中心",
  "parent_id": null
}
```

### PATCH `/api/v1/departments/:departmentId`

需要 scope：`admin:users`

支持字段：

```json
{
  "name": "平台研发部",
  "parent_id": "parent-department-id"
}
```

### DELETE `/api/v1/departments/:departmentId`

需要 scope：`admin:users`

仅允许删除没有子部门且没有用户归属的部门。

### GET `/api/v1/users`

需要 scope：`admin:users`

### POST `/api/v1/users`

需要 scope：`admin:users`

请求：

```json
{
  "name": "Member",
  "department_id": "department-id",
  "role": "user",
  "password": "Passw0rd!"
}
```

`email` 现在是可选字段。

### PATCH `/api/v1/users/:userId`

需要 scope：`admin:users`

支持字段：

```json
{
  "name": "Updated Name",
  "department_id": "department-id",
  "role": "dept_admin",
  "status": "active"
}
```

### POST `/api/v1/users/:userId/password`

需要 scope：`admin:users`

请求：

```json
{
  "password": "NewPassw0rd!"
}
```

### GET `/api/v1/users/:userId/sessions`

需要 scope：`admin:users`

返回该用户在当前 org 下的 session 列表。

## API Keys API

### GET `/api/v1/api-keys`

需要 scope：`admin:api_keys`

### POST `/api/v1/api-keys`

需要 scope：`admin:api_keys`

请求：

```json
{
  "user_id": "user-id",
  "name": "service-key",
  "scopes": ["sessions:create", "sessions:list"]
}
```

示例响应：

```json
{
  "api_key": {
    "id": "key-id",
    "orgId": "org-id",
    "userId": "user-id",
    "name": "service-key",
    "prefix": "moss_sk_xxx",
    "scopes": ["sessions:create", "sessions:list"],
    "status": "active",
    "createdAt": 0,
    "lastUsedAt": null
  },
  "plain_text_key": "moss_sk_xxx.yyy"
}
```

### DELETE `/api/v1/api-keys/:keyId`

需要 scope：`admin:api_keys`

逻辑上是 revoke，不会物理删除行。

## Sessions API

### Session shape

```json
{
  "sessionId": "uuid",
  "transcriptSessionId": "uuid",
  "workDir": "/abs/path/project",
  "userId": "user-id",
  "orgId": "org-id",
  "role": "user",
  "scopes": ["sessions:create", "sessions:attach", "sessions:list"],
  "runtime": {
    "type": "host",
    "dockerImage": "optional",
    "dockerMode": "session",
    "containerName": "optional",
    "configDir": "/abs/path/config"
  },
  "status": "creating|active|detached|ended|terminated|failed|lost",
  "desiredState": "active|ended|terminated",
  "createdAt": 0,
  "lastActiveAt": 0,
  "endedAt": null
}
```

### POST `/api/v1/sessions`

需要 scope：`sessions:create`

请求：

```json
{
  "cwd": "/abs/path/project",
  "dangerously_skip_permissions": true,
  "runtime": {
    "type": "host",
    "hostMode": "user"
  }
}
```

兼容旧字段：

```json
{
  "runtime_type": "docker",
  "docker_image": "my-image:tag",
  "docker_mode": "session"
}
```

示例响应：

```json
{
  "session_id": "uuid",
  "ws_url": "ws://127.0.0.1:43127/ws/sessions/uuid",
  "work_dir": "/abs/path/project",
  "runtime": {
    "type": "host",
    "hostMode": "user",
    "configDir": "/abs/path/config"
  }
}
```

### GET `/api/v1/sessions`

需要 scope：

- `sessions:list`
- 或 `sessions:list:any`

查询参数：

- `active_only=true`

有 `sessions:list:any` 时可看当前 org 的全部 session；否则只看自己的。

### GET `/api/v1/dashboard/stats`

需要 scope：

- `sessions:list`
- 或 `sessions:list:any`

可选查询参数：

- `from=<unix_ms>`
- `to=<unix_ms>`

按 session 的 `createdAt` 时间范围聚合看板统计。

示例响应：

```json
{
  "sessions": {
    "total": 12,
    "active": 3
  },
  "agents": {
    "total": 4,
    "active": 2
  },
  "usage": {
    "inputTokens": 12345,
    "outputTokens": 6789,
    "cacheReadInputTokens": 111,
    "cacheCreationInputTokens": 222,
    "totalTokens": 19467
  }
}
```

### GET `/api/v1/sessions/:sessionId`

返回单个 session；当 `desiredState=active` 时会确保 runtime attempt 可 attach。

### GET `/api/v1/sessions/:sessionId/context`

返回 transcript 派生的 usage / messages 上下文。

当 transcript 还没有内容时返回 `404`。

### POST `/api/v1/sessions/:sessionId/resume`

确保 session 当前 runtime 可恢复，并返回新的 `ws_url`。

### POST `/api/v1/sessions/:sessionId/terminate`

终止 session。

这是状态变更，不是删除。

### WS `/ws/sessions/:sessionId`

会话 WebSocket attach 路径。

需要 `Authorization: Bearer <token>` header。

## Cron Job Workspace Files

给定时任务上传它每次执行都能读到的文件（对照表、模板等）。

**为什么挂在 job 上而不是 session 上**：`conversationMode='new'` 时每次执行都是新
session，传给其中一个，下次执行就没了；`conversationMode='reuse'` 时 session 要到
第一次执行才存在，之前无处可传。**job 的工作目录是两种模式都共享的唯一位置**，
也正是 `createCronSession` 解析出的那个目录（两处共用同一个解析函数，不会漂移）。

权限：`canManageJob`（创建者 / 共同所有者 / `admin:cron` 等）—— 往工作目录写文件会
改变任务下次执行的行为，属于编辑而非读取。

### POST `/api/v1/cron/jobs/:jobId/workspace/file`

```json
{ "path": "对照表.xlsx", "content_base64": "<base64>" }
```

- `path` 必须是相对路径；绝对路径与 `..` 穿越一律拒绝（400 / 403）。
- **同名覆盖**：重传修正后的文件是常见操作，留着旧文件会让任务继续按旧数据跑。
- 大小上限取 `workspaceUploadLimitBytes`（settings.json，默认 20MB），超出返回 413。

返回：`{ "success": true, "relativePath": "对照表.xlsx", "size": 10558 }`

### DELETE `/api/v1/cron/jobs/:jobId/workspace/file?path=<相对路径>`

返回：`{ "success": true, "relativePath": "..." }`

### GET `/api/v1/cron/jobs/:jobId/workspace/tree?path=<相对路径>`

返回 `{ "success": true, "workspace": "<绝对路径>", "tree": { ... } }`，
`tree` 是 `MossWorkspaceNode`（`name` / `relativePath` / `isFile` / `isDir` /
`size` / `mtime` / `children`）。

目录不存在时会先创建再返回空列表，**不返回 404** —— 「先上传、等排期执行」是正常
流程，空列表必须能被读成「还没传」而不是「任务没了」。

> docker user-container 模式下，job 的 workspace 必须位于 `runtimeDir` 或
> `MOSS_HOME` 之下，否则上传即被拒并在消息里给出允许的根路径 —— 而不是收下文件、
> 等到执行时才失败。

## Event Triggers API

外部系统通过 HTTP POST 通知 moss，触发 agent 近实时执行分析任务。

典型场景：客户系统提交了数据 → POST 事件到 moss → agent 拉取数据、分析 → agent 自行回报
（调用客户 API 或通过 corpapp 发送）。**报告的投递由 agent 的 prompt/skills 决定，moss
本身不负责回调投递。**

与 cron 的区别：cron 由时间驱动（最快 60s 轮询），event trigger 由外部推送驱动
（2s 排空间隔），并携带每次事件独有的 payload。

### 认证模型

- **管理接口**（创建/查询/修改/删除）：普通 `Authorization: Bearer <access_token>`，需要 `admin:triggers` scope。
- **事件投递接口**：使用每个 trigger 独立的 secret，不需要 JWT。
  secret 仅在创建/轮换时返回一次，服务端只保存 sha256，不可恢复。

### POST `/api/v1/triggers`

创建 trigger。需要 scope `admin:triggers`。

请求：

```json
{
  "name": "订单风险审核",
  "prompt_template": "有新订单提交。请分析该订单并判断是否需要人工复核。",
  "assistant_name": "risk-analyst",
  "conversation_mode": "new",
  "workspace": null,
  "timeout_ms": 900000,
  "rate_limit_per_min": 120
}
```

响应 `201`：

```json
{
  "success": true,
  "trigger": { "id": "...", "events_url": "/api/v1/triggers/<id>/events", "secret_prefix": "moss_evt_xYHU5xt", "...": "..." },
  "secret": "moss_evt_xYHU5xtRPAggvXR8AN-vtLLUqDyLNmMT"
}
```

`secret` **只返回这一次**，请立即保存。丢失后只能通过 rotate-secret 重新生成。

字段说明：

- `prompt_template`：agent 指令，保存在服务端。事件 payload 会以 ```json 代码块追加在其后。
  指令留在服务端，意味着调用方只能提供数据，不能注入 agent 指令。
- `conversation_mode`：`new`（默认，每次事件独立 session，结束后自动回收）或 `reuse`（复用上次 session）。
- `timeout_ms`：单次运行上限，默认 15 分钟。
- `rate_limit_per_min`：该 trigger 的每分钟投递上限，默认 120。

### POST `/api/v1/triggers/:id/events`

**事件投递接口**（供客户系统调用）。不需要 JWT。

```bash
curl -X POST https://<moss>/api/v1/triggers/<id>/events \
  -H "Authorization: Bearer moss_evt_xxxxx" \
  -H "Content-Type: application/json" \
  -H "X-Moss-Idempotency-Key: order-SO-8812" \
  -d '{"order_id":"SO-8812","amount":240000,"customer":"ACME"}'
```

- secret 也可通过 `X-Moss-Trigger-Secret` 头传递。
- body 必须是 JSON 对象，上限 **1 MiB**（超出返回 `413`）。
- `X-Moss-Idempotency-Key` 可选；同一 trigger 下重复的 key 不会产生第二次运行。

响应 `202`（立即返回，不等待 agent 执行完）：

```json
{
  "run_id": "...",
  "status": "queued",
  "trigger_id": "...",
  "status_url": "/api/v1/triggers/<id>/runs/<run_id>"
}
```

重复的 idempotency key 返回 `200` 且带 `"duplicate": true`，`run_id` 为首次的运行。

错误码：

| 状态码 | 含义 |
| --- | --- |
| `401` | secret 缺失或错误（trigger 不存在时同样返回 401，避免探测 id 是否存在） |
| `403` | trigger 已停用 |
| `400` | body 不是合法 JSON |
| `413` | body 超过 1 MiB |
| `429` | 超过该 trigger 的每分钟上限 |

### GET `/api/v1/triggers/:id/runs/:runId`

查询单次运行状态。需要 scope `admin:triggers`。

状态流转：`queued` → `running` → `ok` / `error` / `skipped`。

响应包含 `session_id`（可据此查看完整 transcript）、原始 `payload`、`error`、`summary`
及时间戳。

### 其他管理接口

- `GET /api/v1/triggers` — 列出本 org 的 trigger
- `GET /api/v1/triggers/:id` — 查询单个
- `PATCH /api/v1/triggers/:id` — 修改（含 `enabled` 启停）
- `DELETE /api/v1/triggers/:id` — 软删除
- `POST /api/v1/triggers/:id/rotate-secret` — 轮换 secret（旧 secret 立即失效）
- `GET /api/v1/triggers/:id/runs?limit=50` — 运行历史

所有接口均按 org 隔离：跨 org 访问一律返回 `404`（而非 `403`），避免泄露资源是否存在。

### 并发与容量

- 全局并发上限默认 **3**（`MOSS_EVENT_MAX_CONCURRENT`）。突发事件排队，不丢弃。
- 排空间隔默认 **2s**（`MOSS_EVENT_TICK_MS`）。
- `new` 模式的 session 在运行结束后自动回收，避免耗尽 runtime 的 `maxSessionsPerUser` 配额。
- 服务重启时，处于 `running` 的孤儿运行会被标记为 `error`，不会永久占用并发槽位。

### 安全提示

事件 payload 是**不可信输入**，最终会进入 agent 的上下文。请为 trigger 绑定权限收敛的
agent，并在 `prompt_template` 中明确要求 agent 将 payload 视为数据而非指令。
另外该接口应始终经由 HTTPS 暴露——bearer secret 模式不提供载荷完整性校验。

## Notes

- `AuthService.verifyAccessToken()` 已经是进程内调用，server 不再反向 fetch 外部 auth-center。
- `admin/dist` 由同一个进程直接挂在 `/admin`。
- 单库模式下，auth / users / api_keys / sessions / runtime events 共用同一个 SQLite 文件。
