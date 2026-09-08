# Sudowork 管理端能力在 Moss 完整收口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Moss Admin 完整承接旧 Sudowork 管理后台的业务操作，同时继续复用 Moss 统一领域模型并保持全部旧接口不变。

**Architecture:** 无冲突运营接口通过既有 Hono 兼容应用同时服务 Moss Host 与旧 Host；与 Moss 原生用户/组织路径冲突的能力增加显式、组织隔离的原生管理 API。前端在现有用户、运营、设置、文档/Agent 和看板页面内补齐操作，不复制旧管理端或旧业务表。

**Tech Stack:** TypeScript、React、Vite、Hono、Node.js、Bun、node:test、Moss UI 组件。

**Spec:** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md`

## Global Constraints

- 不修改 `/Users/yobach/VSCodeProject/sudowork` 与 `/Users/yobach/VSCodeProject/sudowork-server`。
- 旧 Sudowork 216 条接口 method、path、状态码、响应和权限语义不得改变。
- Moss Admin 使用 Moss Access Token；所有查询和写入按当前 Organization 隔离。
- 财务操作复用统一 Billing Command、账本、审计、幂等和 Sudorouter Saga。
- 密钥只进入 Nexus，不写前端状态、日志或 SQLite 明文。
- 每个任务先写失败测试并确认红灯，再实现、运行局部测试和相关回归。
- 不改写提交 `6273bae`；本轮完成后另建提交，除非用户另有要求。

---

### Task 1: 运营 API 能力清单与 Host 接线

**Files:**
- Modify: `admin/lib/api/operations-core.ts`
- Modify: `admin/lib/api/operations-core.node-test.ts`
- Modify: `src/server/api/compat/sudowork/sharedOperationalRoutes.ts`
- Modify: `src/server/api/compat/sudowork/hostDispatch.node-test.ts`

**Interfaces:**
- Produces: `operationsApi` 的用户审批/财务、订单、授信、系统配置、Dify Dataset、QMS 完整方法。
- Produces: Moss Host 可调用且无路径冲突的共享运营路由白名单。

- [x] 为所有缺失 API 方法和共享路由写失败测试。
- [x] 运行聚焦测试，确认因方法/路由缺失失败。
- [x] 实现 API client 与共享路由清单；Moss 原生 `/api/v1/users` 与兼容 `/api/v1/admin/users` 不冲突，后者按明确白名单共享。
- [x] 运行 API 与 Host 分流测试至通过。

### Task 2: 用户审批与财务工作台

**Files:**
- Modify: `admin/src/pages/users-page.tsx`
- Create: `admin/src/user-operations.node-test.ts`
- Modify: `admin/lib/api/types.ts`
- Modify: `src/server/server.ts`
- Create or modify: `src/server/api/enterprise.node-test.ts`

**Interfaces:**
- Produces: Moss 原生 `/api/v1/users/:id/operations/*` 端点，内部委托统一身份和 Billing 服务。
- Produces: 用户列表完整状态、审批/拒绝、充值、积分调整、额度同步、账本/充值记录入口。

- [x] 写失败测试固定 `pending/locked` 状态映射、组织隔离和财务命令委托。
- [x] 运行测试确认红灯。
- [x] 原生用户 DTO 返回稳定 legacy alias 与钱包摘要，前端财务命令调用统一兼容服务。
- [x] 在用户表操作菜单和详情侧栏加入审批与财务操作；积分使用明确整数单位和确认框。
- [x] 运行用户、身份、Billing 和前端辅助测试至通过。

### Task 3: 账务运营完整工作流

**Files:**
- Modify: `admin/src/pages/operations-billing-page.tsx`
- Modify: `admin/lib/api/operations-core.ts`
- Modify: `admin/lib/api/operations-core.node-test.ts`
- Create: `admin/src/operations-billing.node-test.ts`

**Interfaces:**
- Consumes: Task 1 的订单、退款、重试、批量同步和授信 API。
- Produces: 统计、筛选、详情、重试、退款、同步及合法状态操作模型。

- [x] 写失败测试固定订单/授信状态允许的操作以及整数积分校验。
- [x] 运行测试确认红灯。
- [x] 实现统计、筛选、详情、重试、批量同步和退款对话框。
- [x] 补齐充值记录字段、筛选和授信详情/同步失败重试。
- [x] 运行账务前端测试、Billing 路由和服务回归。

### Task 4: Sudowork 客户端策略与系统配置

**Files:**
- Create: `admin/src/pages/sudowork-settings-page.tsx`
- Modify: `admin/src/app.tsx`
- Modify: `admin/components/app-sidebar.tsx`
- Modify: `admin/src/operations-navigation.ts`
- Modify: `admin/lib/api/operations-core.ts`
- Modify: `src/server/api/compat/sudowork/sharedOperationalRoutes.ts`
- Test: `admin/src/operations-navigation.node-test.ts`
- Test: `admin/lib/api/operations-core.node-test.ts`

**Interfaces:**
- Produces: `/operations/sudowork-settings`，管理登录/CAS、上报、版本、产品改进、自动模型、充值和授信策略。

- [x] 写失败测试固定路由、菜单、读取和更新 API。
- [x] 运行测试确认红灯。
- [x] 实现页面和共享路由；敏感值仅允许写入，不回显明文。
- [x] 运行系统配置、导航和构建回归，并修复登录方式 `0=短信/1=密码/2=CAS` 标签映射。

### Task 5: 配置项跨组织授权

**Files:**
- Modify: `admin/lib/api/secrets.ts`
- Modify: `admin/src/pages/secrets/config-items-page.tsx`
- Create: `admin/lib/api/config-availability.node-test.ts`
- Modify: `src/server/server.ts`

**Interfaces:**
- Produces: 配置项 `organization | all | assigned` 可见范围读取和更新 API。
- Produces: 超级管理员的指定组织选择界面。

- [x] 写失败测试固定权限、全局/指定组织切换和原子替换分配。
- [x] 运行测试确认红灯。
- [x] 实现统一 API 与页面选择器。
- [x] 运行配置服务、组织隔离和前端 API 测试。

### Task 6: Dify Dataset 管理视图

**Files:**
- Create: `admin/lib/api/dify-datasets.ts`
- Create: `admin/lib/api/dify-datasets.node-test.ts`
- Create: `admin/src/pages/dify-datasets-page.tsx`
- Modify: `admin/src/app.tsx`
- Modify: `admin/components/app-sidebar.tsx`
- Modify: `src/server/api/compat/sudowork/sharedOperationalRoutes.ts`

**Interfaces:**
- Produces: Dataset CRUD、文档文本/文件上传、删除、检索测试与 Studio 链接页面。
- Consumes: 既有统一 Dify Administration/Dataset 服务和旧兼容 DTO。

- [x] 写失败测试固定 Dataset 方法、multipart 字段和路由可达性。
- [x] 运行测试确认红灯。
- [x] 实现 API client、页面和无冲突共享路由；当前 Organization alias 由 `/me` 返回，企业管理员不依赖全局组织列表。
- [x] 运行 Dify 管理、Dataset、multipart 和构建回归。

### Task 7: QMS 完整运维页面

**Files:**
- Modify: `admin/lib/api/operations-core.ts`
- Modify: `admin/lib/api/operations-core.node-test.ts`
- Rewrite: `admin/src/pages/operations-quality-page.tsx`
- Create: `admin/src/qms-operations.node-test.ts`

**Interfaces:**
- Produces: 总览、会话、安装、性能、用户详情、Crash 详情/指派、告警配置 CRUD、系统/通知/任务/表统计。

- [x] 写失败测试固定 QMS 查询、变更方法和状态动作。
- [x] 运行测试确认红灯。
- [x] 分标签实现完整运维视图，查询并行化且只在活动标签加载。
- [x] 运行 QMS 72 路由、服务和前端测试。

### Task 8: 运营看板、矩阵修订与最终验证

**Files:**
- Modify: `admin/src/pages/dashboard-page.tsx`
- Modify: `docs/superpowers/spikes/2026-09-08-sudowork-admin-capability-matrix.md`
- Modify: `docs/superpowers/plans/2026-09-07-sudowork-moss-p7-compat-admin.md`
- Modify: `docs/superpowers/plans/2026-09-07-sudowork-moss-consolidation-roadmap.md`

**Interfaces:**
- Produces: 统一运营摘要和基于实际代码重新核对的能力矩阵。

- [x] 为摘要数据聚合写失败测试并实现组织/用户/待审批/财务/质量摘要。
- [x] 修订能力矩阵，逐项标记真实完成状态和生产门禁。
- [x] 运行全部 Node、Bun、216 路由与细分契约测试。
- [x] 运行 Admin 构建和桌面/移动浏览器验证；7 页 × 2 视口无白屏、横向溢出或控制台错误。
- [x] 记录仍只能由真实基础设施和正式客户端关闭的门禁。

验证记录（2026-09-08）：Node 545 项中 543 通过、2 个真实 PostgreSQL/Redis 门禁跳过、0 失败；Bun 392/392；Admin 全量 TypeScript 检查通过；正式构建通过；216/216 旧接口、Hub 8、Billing 28、Dify 45、QMS 72 契约检查通过；浏览器 fixture 检查 7 个关键页面在 1440×900 与 390×844 两种视口均无白屏、横向溢出或控制台错误。反向扫描旧管理端实际 `adminApi` 调用后，所有可达业务操作均由 Moss 原生页面或本轮运营页面承接；旧页面未调用的模拟支付死代码不在新管理端暴露，兼容接口仍保留。生产副本、真实基础设施、正式客户端和 Fuiou 门禁不由本轮关闭。

## Self-Review

- 所有已确认的管理端缺口都有独立任务；旧兼容接口保持不变。
- 用户冲突路径采用 Moss 原生端点，其他运营路径显式加入共享白名单。
- 财务、身份、配置、Dify、QMS 均复用统一领域服务，不新增旧业务表。
- 计划不包含生产凭据、真实支付执行或源仓库修改。
