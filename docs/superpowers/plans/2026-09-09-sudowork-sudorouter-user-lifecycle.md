# Sudowork 用户与 Sudorouter 生命周期闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让历史用户和所有新建用户在 Moss 中拥有可恢复的 Sudorouter 账号、额度和 Token，并让旧 Sudowork 登录、模型、用量和积分接口继续完整工作。

**Architecture:** 新增统一 `SudorouterAccountService` 作为唯一开户接口，隐藏外部查找、创建、额度初始化、Token 生成、Nexus 存储和 Saga 恢复。身份入口只负责创建统一用户并调用该模块；登录投影从 Billing 外部账户、Nexus、Wallet、Usage 和统一模型配置构造旧响应。网络调用始终位于 SQLite 事务之外。

**Tech Stack:** TypeScript、Node.js、node:sqlite、Nexus、Redis、Hono、Bun/Node test。

**Spec:** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md`

## Global Constraints

- 不修改 Sudowork 客户端和旧 sudowork-server。
- 旧接口字段、状态码、错误文案和 Token 行为保持不变。
- 每项先写失败测试并确认红灯，再实现和运行相关回归。
- Token 只保存到 Nexus；SQLite、日志、迁移报告和接口审计不得出现明文。
- SQLite 事务回调内禁止网络、Nexus、文件 I/O 和 Promise。
- 迁移和 replay 默认抑制外部开户、额度和 Token 创建。
- 不提交或推送，除非用户另行要求。

---

### Task 1: Sudorouter 协议 Adapter

**Files:**
- Modify: `src/server/billing/sudorouterAdapter.ts`
- Modify: `src/server/billing/sudorouterAdapter.node-test.ts`

**Interfaces:**
- Produces: `findUser(username)`、`createUser(input)`、`createToken(input)`。
- Preserves: `getUser(externalUserId)`、`changeQuota(input)`。

- [x] 写失败测试冻结精确 URL、Header、请求体、响应校验和超时。
- [x] 实现精确用户名查找、创建用户、创建无限额度 Token。
- [x] 验证 Provider 错误不泄漏管理 Token。

### Task 2: 外部账户 Schema 与可恢复开户模块

**Files:**
- Modify: `src/server/billing/billingSchema.ts`
- Modify: `src/server/billing/billingRepository.ts`
- Create: `src/server/billing/sudorouterAccountService.ts`
- Create: `src/server/billing/sudorouterAccountService.node-test.ts`

**Interfaces:**
- Produces: `ensureAccount(input, context): Promise<SudorouterAccountResult>`。
- Stores: `token_secret_ref` 和持久化 Provisioning Saga 状态。

- [x] 写失败测试覆盖新建、已存在复用、失败恢复、并发幂等和 Token 不落 SQLite。
- [x] 幂等升级外部账户表并新增 Provisioning Operation 表。
- [x] 实现 `PENDING -> ACCOUNT_READY -> QUOTA_READY -> TOKEN_READY -> COMPLETED`。
- [x] 外部结果不确定时持久化失败状态，重试先按账号和操作记录查询恢复，不重复开户或加额度。

### Task 3: 所有用户创建入口统一接入

**Files:**
- Modify: `src/server/api/compat/sudowork/identityService.ts`
- Modify: `src/server/api/compat/sudowork/casService.ts`
- Modify: `src/server/api/compat/sudowork/adminService.ts`
- Modify: `src/server/auth/service.ts`
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `SudorouterAccountService.ensureAccount`。
- Produces: 密码、短信、CAS、旧后台和 Moss 原生后台一致的创建结果。

- [x] 分入口写失败测试，证明当前创建后没有 external account/token。
- [x] 本地用户先以不可登录状态创建，开户成功后原子激活。
- [x] 失败重试复用同一个本地用户、邀请码和 Provisioning Operation。
- [x] 旧后台响应恢复真实 `sudorouter_user_id` 和 `initial_points`。

### Task 4: 初始额度与模型配置

**Files:**
- Modify: `src/server/api/compat/sudowork/systemConfigService.ts`
- Modify: `admin/src/pages/sudowork-settings-page.tsx`
- Modify: `src/server/modelListCache.ts`
- Modify: `src/server/startStandaloneServer.ts`

**Interfaces:**
- Adds: `initialQuota`、`modelServiceUrl`、`modelsApiUrl`。
- Produces: 所有注册入口共用的额度和模型配置。

- [x] 写失败测试覆盖配置校验、旧默认、URL 去尾斜杠和动态模型源。
- [x] 管理端增加三个字段并标记重启要求。
- [x] 邀请显式 USD 额度优先；为空时使用统一 `initialQuota`。

### Task 5: 旧登录用户投影与用量查询

**Files:**
- Create: `src/server/api/compat/sudowork/userProjectionService.ts`
- Create: `src/server/api/compat/sudowork/userProjectionService.node-test.ts`
- Modify: `src/server/startStandaloneServer.ts`
- Modify: `src/server/api/compat/sudowork/legacyUsageService.ts`

**Interfaces:**
- Produces: `project(user): Promise<SudoworkUserProjection>`。
- Reads: external account、Nexus Token、Wallet/Ledger、Usage、模型配置。

- [x] 写失败测试冻结 `sudorouter_key/model_service_url/models/points`。
- [x] 接入兼容 App 的 `getUserProjection`，移除生产空投影。
- [x] 用量、模型统计、积分余额和额度快照优先读取 Sudorouter 实时数据并保留本地回退。
- [x] Token 引用缺失时返回明确兼容错误，不静默返回 null。

### Task 6: 历史 Token 数据迁移

**Files:**
- Modify: `src/server/migration/sudoworkP3SourceReader.ts`
- Modify: `src/server/migration/p3BillingMigrationService.ts`
- Modify: `src/server/migration/migrationVerifier.ts`

**Interfaces:**
- Migrates: `users.sudorouter_key -> Nexus + token_secret_ref`。

- [x] 源读取器只在内存保留 Token，报告和指纹只写摘要。
- [x] 迁移按用户映射写 Nexus，再写 SQLite 引用；失败不得留下可用半状态。
- [x] verify 检查每个历史 external account 都有可读取 Token 引用。
- [x] migration/replay 不调用 Sudorouter 创建账号或 Token。

### Task 7: 完整回归与切流门禁

- [x] 运行 Sudorouter、身份、CAS、Billing、Projection 和迁移聚焦测试。
- [x] 运行 216 路由、Billing、Dify、QMS 契约。
- [x] 运行完整 Bun/Node 测试、Admin TypeScript 和 Node 构建。
- [x] 使用假 Sudorouter HTTP Server 验证注册、重复注册恢复、登录、模型、用量和余额闭环。
- [x] 验证过程未调用生产支付或批量创建用户。
