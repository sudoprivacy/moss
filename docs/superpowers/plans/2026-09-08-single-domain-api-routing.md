# Sudowork 单域名切换与 Moss 管理 API 隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**目标：** 保持 Sudowork 客户端域名和旧接口不变，同时让同一域名下的 Moss Admin 使用独立原生 API，并使运营中心不依赖旧接口开关。

**架构：** 原 Sudowork `method + /api/v1/*` 继续由 Legacy Adapter 处理；Moss Admin 的全部请求统一改为 `/api/moss/v1/*`。Server 将普通 `/api/moss/v1/*` 映射到现有 Moss 原生 handler，将 `/api/moss/v1/operations/*` 映射到始终创建的统一运营服务；`sudoworkCompatibility.enabled` 仅控制旧客户端协议是否公开。

**技术栈：** Node.js HTTP、Hono、React、TypeScript、Bun/Node test。

**规格：** 本对话中确认的“原 Sudowork 域名不变、停旧服务后切换上游到 Moss”方案。

## 全局约束

- 不修改 Sudowork 客户端代码、域名、旧 method/path、状态码和响应外壳。
- Moss Admin 不得调用旧 `/api/v1/admin/*` 或旧 `/api/v1/qms/*`。
- 本地任务继续由 Sudowork 客户端执行，企业模式会话继续由 Moss RuntimeService 执行。
- 用户、组织、钱包、Agent、Skill、配置和审计只使用 Moss 统一模型。
- 未启用 Billing、Dify 或 QMS 时返回明确的功能不可用响应，不能因路由未注册而返回 404。

---

### Task 1: Moss Admin 原生 API 命名空间

**文件：**
- 创建：`src/server/api/mossAdminNamespace.ts`
- 创建：`src/server/api/mossAdminNamespace.node-test.ts`
- 修改：`src/server/server.ts`

**接口：**
- `normalizeMossAdminApiPath(pathname: string): string`
- `/api/moss/v1/<tail>` 映射到现有 `/api/v1/<tail>` 原生 handler。

- [x] 先写映射、边界和非匹配路径测试并确认失败。
- [x] 实现纯路径映射并在 `mossRequestHandler` 解析后使用。
- [x] 运行 Node 定向测试，确认新旧原生路径都可用。

### Task 2: 统一运营路由独立于兼容开关

**文件：**
- 修改：`src/server/api/compat/sudowork/hostDispatch.ts`
- 修改：`src/server/api/compat/sudowork/hostDispatch.node-test.ts`
- 修改：`src/server/api/compat/sudowork/sharedOperationalRoutes.ts`
- 修改：`src/server/startStandaloneServer.ts`
- 修改：`src/server/server.ts`

**接口：**
- `/api/moss/v1/operations/<tail>` 映射到 `/api/v1/admin/<tail>`。
- `/api/moss/v1/operations/qms/<tail>` 映射到 `/api/v1/qms/<tail>`。
- Legacy Host 只有在 `sudoworkCompatibility.enabled=true` 时公开旧接口。

- [x] 先写单域名下 Admin、旧客户端和未命中路径的分流测试。
- [x] 始终创建统一运营依赖；仅在兼容开启时连接旧 Redis、创建 CAS/SMS 并公开 Legacy Host。
- [x] QMS 生命周期从 Legacy Host 开关解耦。
- [x] 为未启用的可选模块注册明确的 503 响应。
- [x] 运行 Host dispatch、Compatibility App 和启动生命周期测试。

### Task 3: Admin 前端只调用 `/api/moss/v1/*`

**文件：**
- 修改：`admin/lib/api/client.ts`
- 修改：`admin/lib/api/auth.ts`
- 修改：`admin/lib/api/operations-core.ts`
- 修改：相关 Admin API 单测。

**接口：**
- `toMossAdminApiPath(path: string): string`
- 现有 Admin API 模块无需逐个维护 Host 判断。

- [x] 先写认证、普通管理、运营和 QMS URL 测试并确认失败。
- [x] 为通用 Admin Client 添加原生命名空间转换。
- [x] 将运营 API 改为 `/api/moss/v1/operations/*`。
- [x] 修正直接 `fetch` 的刷新、退出和上传请求。
- [x] 运行 Admin Node 测试和 TypeScript 检查。

### Task 4: 配置收敛与端到端验证

**文件：**
- 修改：`admin/components/app-sidebar.tsx`
- 修改：`deploy/README.md`
- 修改：迁移路线图和配置说明。
- 测试：Server 启动 smoke、Admin 浏览器 smoke、完整 Node/Bun 套件。

- [x] 将“Sudowork 策略”恢复为容易识别的“Sudowork 系统设置”。
- [x] 文档明确 `hosts` 只保留原生产域名，删除 `127.0.0.1/localhost` 生产配置。
- [x] 标记可移除配置：Admin Host 分流、本地测试 Host、Admin 对旧 JWT/Redis 的依赖。
- [x] 标记仍需保留配置：Legacy 开关、原域名 allowlist、publicBaseUrl、旧 JWT、旧 Refresh Token Redis、外部集成凭据。
- [x] 在同一 Host 下验证 Moss Admin 登录、运营中心和旧接口分流。
- [x] 运行完整构建、测试和 `git diff --check`。
