# Sudowork 到 Moss P7 兼容接口与管理端收口实施计划

> **供执行代理使用：** 必须逐任务使用 `superpowers:test-driven-development`；可使用 `superpowers:executing-plans` 按检查点执行。本文使用复选框记录进度。

**目标：** 在不复制 Sudowork Server 业务模型的前提下，让 Moss 实装冻结清单中的全部 216 个旧 method/path，并让原 Sudowork 域名同时提供 Moss 管理端与 Moss 原生接口。

**架构：** Sudowork 兼容 Hono 应用只处理冻结清单中的旧协议及经批准的 Hub/上传路径；同一 Host 上的其他请求交给 Moss 原生处理器。缺失接口通过统一身份、组织、账本、外部额度和配置服务实现，兼容层仅完成参数与响应转换。管理端使用 Moss 现有页面和统一 API，缺失的运营/QMS 页面直接接统一服务，不继续维护旧 React 管理端。

**技术栈：** TypeScript、Node.js 24、Bun、Hono、node:http、node:sqlite、React、Vite、Node test runner。

**规格：** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md`

## 全局约束

- 不修改 `sudowork` 客户端和 `sudowork-server` 源仓库。
- 不提交、不暂存、不推送任何 Git 变更。
- 每个生产代码改动前必须先加入会失败的测试并确认失败原因正确。
- 兼容 Adapter 不得直接 SQL、持有独立业务状态或直接调用外部供应商。
- 旧接口状态码、响应字段、错误文案、分页、SSE、文件、302 和 HTML 行为保持兼容。
- 本地任务仍由 Sudowork 客户端执行；企业模式继续使用 Moss 云端 Session。
- 真实 PostgreSQL、Redis、Nexus、支付和受支持客户端矩阵属于部署门禁，未具备环境时不得宣称通过。

---

### Task 1：兼容路由实装清单与旧域名精确分流

**文件：**
- 新建：`src/server/api/compat/sudowork/routeInventory.ts`
- 新建：`src/server/api/compat/sudowork/routeInventory.node-test.ts`
- 修改：`src/server/api/compat/sudowork/hostDispatch.ts`
- 修改：`src/server/api/compat/sudowork/hostDispatch.node-test.ts`
- 修改：`src/server/server.ts`
- 修改：`package.json`

**接口：**
- 产出 `createCompatibilityRouteMatcher(routes): (method, pathname) => boolean`，支持 Hono 的 `:param` 与尾部通配符。
- 产出 `collectSudoworkRouteInventory(app)`，将 `app.routes` 归一化为唯一的 `METHOD path`。
- `createHostDispatch` 仅在 Host 可信且 matcher 命中时调用 Hono；`GET /`、管理端静态资源和 Moss 原生 API 走 `mossHandler`。

- [x] 写路由清单失败测试：冻结 216 项均必须出现在应用路由中，额外路由只能来自显式批准列表。
- [x] 运行该测试，确认因当前缺失接口失败，并记录准确缺失集合。
- [x] 写 Host 分流失败测试：旧 Host 的旧登录走 Hono，`GET /`、`/assets/*`、Moss 原生 API 走 Moss；伪造 Host 仍走 Moss。
- [x] 运行 Host 测试，确认当前 `GET /` 被 Hono 接管导致失败。
- [x] 实现清单归一化、动态路径匹配及精确分流，并把 matcher 注入生产 Server。
- [x] 运行两个聚焦测试，要求全部通过。

### Task 2：旧用户统计、流水、用量与模型接口

**文件：**
- 新建：`src/server/api/compat/sudowork/legacyUsageService.ts`
- 新建：`src/server/api/compat/sudowork/legacyUsageService.node-test.ts`
- 新建：`src/server/api/compat/sudowork/legacyUsageRoutes.ts`
- 新建：`src/server/api/compat/sudowork/legacyUsageRoutes.node-test.ts`
- 修改：`src/server/api/compat/sudowork/app.ts`
- 修改：`src/server/billing/billingRepository.ts`

**接口：**
- `SudoworkLegacyUsagePort` 提供 `listModels`、`reportUsage`、`getDashboard`、`getStats`、`listLedger`、`getModelUsageStats`、`listAdminUserLedger`。
- 写操作通过统一 `WalletService` 与命令上下文落账；查询通过统一 Repository 和模型配置投影旧 DTO。
- 实装 7 个用户/用量接口和 `GET /api/v1/router/models`，不得在路由层计算余额或写 SQL。

- [x] 为模型列表、用量扣减幂等、余额不足、用户统计、流水分页和组织隔离编写失败服务测试。
- [x] 运行服务测试，确认因端口或方法缺失失败。
- [x] 最小实现统一服务与必要 Repository 查询，运行服务测试至通过。
- [x] 为 8 个 HTTP 接口编写旧 envelope、状态码、校验文案和授权失败测试并确认失败。
- [x] 注册路由并只做协议转换，运行路由测试和 Billing/Identity 回归至通过。

### Task 3：旧管理审批、成员、日志、特性与统计接口

**文件：**
- 修改：`src/server/api/compat/sudowork/adminService.ts`
- 修改：`src/server/api/compat/sudowork/adminService.node-test.ts`
- 新建：`src/server/api/compat/sudowork/legacyAdminRoutes.ts`
- 新建：`src/server/api/compat/sudowork/legacyAdminRoutes.node-test.ts`
- 修改：`src/server/api/compat/sudowork/app.ts`
- 视需要修改：`src/server/identity/identityRepository.ts`

**接口：**
- `SudoworkAdministrationPort` 增加 `listMembers`、`approveUser`、`rejectUser`、`deletePendingUser`、`listOperationLogs`、`getFeatureFlags`、`getAdminStats`。
- `sync-quota` 和管理员用户流水委托 Task 2/现有 Billing 服务，不在管理服务复制额度规则。
- 实装剩余 7 个管理接口，并保持 super admin 与企业 admin 的组织边界。

- [x] 为审批、拒绝、删除、成员组织隔离、日志筛选、特性和统计编写失败服务测试。
- [x] 运行服务测试并确认正确红灯。
- [x] 通过统一身份、组织、审计和账本服务实现最小行为，运行服务测试至通过。
- [x] 为旧接口响应、分页、错误文案和跨组织不可探测性编写失败路由测试。
- [x] 注册路由并运行管理、Identity、Billing 回归至通过。

### Task 4：216 路由闭环与传输契约

**文件：**
- 修改：`src/server/api/compat/sudowork/routeInventory.node-test.ts`
- 修改：`src/server/api/compat/sudowork/app.node-test.ts`
- 新建：`src/server/api/compat/sudowork/transportContract.node-test.ts`
- 修改：`scripts/contracts/*` 中与实装覆盖检查直接相关的脚本
- 修改：`package.json`

**接口：**
- `contracts:implementation` 必须校验冻结 216 路由全部注册，未批准额外路由直接失败。
- 传输测试覆盖 JSON/form/multipart 单次读取、CORS/限流 Header、SSE、音频/文件、302、HTML 和上传清理。

- [x] 运行清单测试，确认 Task 2/3 完成后缺失集合为空。
- [x] 为尚未覆盖的传输类型加入失败测试，并使用 Fake Adapter 捕获副作用。
- [x] 最小修复传输差异，逐类运行测试至通过。
- [x] 运行 `contracts:routes`、`contracts:implementation` 及全部兼容 Node 测试。

### Task 5：Moss Admin 能力矩阵与缺失页面

**文件：**
- 新建：`docs/superpowers/spikes/2026-09-08-sudowork-admin-capability-matrix.md`
- 修改：`admin/src/app.tsx`
- 修改：`admin/components/app-sidebar.tsx`
- 新建或修改：`admin/lib/api/*`
- 新建或修改：`admin/src/pages/*`
- 新建：对应的 `*.test.tsx` 或 API 单元测试文件

**接口：**
- 能力矩阵逐项映射旧后台菜单到 Moss 页面/统一 API；同义能力复用现有页面。
- 仅为无等价入口的 QMS、邀请码、充值/授信运营、统一业务日志新增页面，不复制旧服务数据模型。
- 所有新页面使用 Moss 鉴权、组织范围和现有 UI 组件。

- [x] 完成中文能力矩阵并标记“已有、需增强、需新增、仅兼容接口保留”。
- [x] 为侧栏角色可见性、路由可达性和每个新增 API client 编写失败测试。
- [x] 按矩阵逐页实现邀请码、账务、业务审计与 QMS 工作流，每页均运行聚焦 API/导航测试和正式构建。
- [x] 运行 Admin 构建；使用隔离的本地 API Fixture 与系统 Chrome/Playwright Core 检查四页桌面 1440×900、移动 390×844 视口，确认无溢出、404 或控制台错误。移动端首次检查发现固定侧栏将主内容压缩至 134px，改为抽屉后复测主内容宽度为 390px。

说明：独立 `tsc -p admin/tsconfig.json` 仍被本阶段之前已存在的 MCP 页面和 `system-settings-page.tsx` 类型错误阻断；本阶段新增文件均已进入 `bun run build` 的 Vite 正式产物，该基线问题继续列入 P9，不得表述为全量类型检查通过。

### Task 6：P7 回归门禁与诚实结论

**文件：**
- 修改：本计划中的任务复选框
- 修改：`docs/superpowers/plans/2026-09-07-sudowork-moss-consolidation-roadmap.md`

- [x] 运行全部 Node 测试并记录通过、跳过和失败数。
- [x] 运行全部 Bun 测试、`bun run build`、`git diff --check`。
- [x] 运行 216 路由实装检查及兼容契约 fixture。
- [x] 运行运行时 Smoke、云端 Session 和企业自动化回归。
- [x] 对照能力矩阵确认旧管理功能都有 Moss 对应入口。
- [x] 仅将本机可验证项标记完成；受支持客户端二进制矩阵、真实基础设施和新旧在线差异测试保留为生产部署门禁。

验证记录（2026-09-08）：

- `bun run test:node`：466 项，464 通过、0 失败、2 跳过；云端 Session、组织隔离、Cron/Event Trigger、SQLite SAVEPOINT 与同步事务边界均在本轮通过。
- `bun run test:bun`：392 项全部通过；首次两轮全量运行暴露 `tenantAssistantRoutes.test.ts` 的真实 Node fixture 冷启动会超过 Bun 默认 5 秒，单文件连续 3 轮 30 项业务断言全部通过。将该进程型集成测试文件的超时显式设为 15 秒后，单文件 10/10 和全量 392/392 均通过，未放宽业务断言。
- `bun run build` 与 `git diff --check` 通过。独立 Admin `tsc` 的既有基线错误仍按 Task 5 说明保留，不得表述为通过。
- 固定旧服务提交 `311636c7bbfa4fa1c655aa8bd5c7e898f565f263`：路由源清单 216/216、Moss 实装 216/216、Dify 45、QMS 72、Billing 28、Hub 客户端调用 8 条契约均通过。
- `contracts:clients` 只证明矩阵结构有效，状态仍为 `candidate`；真实发布客户端二进制矩阵、真实 PostgreSQL/Redis/Nexus/TimescaleDB、Fuiou 验签样本和新旧在线差异测试仍是生产部署硬门禁。
