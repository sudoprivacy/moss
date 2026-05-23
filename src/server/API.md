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
    "type": "host"
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
    "dockerMode": "session",
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

## Notes

- `AuthService.verifyAccessToken()` 已经是进程内调用，server 不再反向 fetch 外部 auth-center。
- `admin/dist` 由同一个进程直接挂在 `/admin`。
- 单库模式下，auth / users / api_keys / sessions / runtime events 共用同一个 SQLite 文件。
