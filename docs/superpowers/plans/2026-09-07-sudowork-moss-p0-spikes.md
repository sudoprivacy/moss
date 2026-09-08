# Sudowork 整合 P0 开工门禁实施计划

> **给执行智能体：** 必须使用 `superpowers:executing-plans` 逐任务执行，并使用 `superpowers:test-driven-development` 完成每个代码任务。用户要求不创建 Git commit，因此每个任务以测试结果和工作树检查收尾，不执行提交。

**目标：** 在业务迁移开始前建立可信测试基线、旧接口清单、客户端兼容矩阵，并验证 Hono 单端口接入与 SQLite UnitOfWork 机制。

**架构：** P0 不迁移业务数据，也不实现正式兼容路由。它提供后续领域开发依赖的测试运行器、机器契约和两项可执行 Spike；Spike 代码放在 `spikes/`，不进入生产构建入口。

**技术栈：** Bun Test、Node Test、tsx、TypeScript Compiler API、Hono、`@hono/node-server`、`node:http`、`node:sqlite`。

**Spec：** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md`

## 全局约束

- 工作目录：`/Users/yobach/VSCodeProject/moss-worktrees/sudowork-moss-consolidation`。
- 只读源服务：`/Users/yobach/VSCodeProject/sudowork-server`。
- 只读客户端：`/Users/yobach/VSCodeProject/sudowork`。
- 不提交、不暂存、不推送。
- 每项实现先运行失败测试，再进行最小修改并重新验证。
- P0 允许保留 `spikes/` 中的可执行验证代码，但生产代码不得导入它。

---

### Task 1：修复并统一测试基线

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/server/__tests__/releaseE2eSmoke.test.ts`
- Rename: `src/server/__tests__/claimAttempt.test.ts` → `src/server/__tests__/claimAttempt.node-test.ts`
- Create: `scripts/run-node-tests.mjs`

**Interfaces:**

- Produces: `bun run test:bun`、`bun run test:node`、`bun run test` 三个稳定入口。
- Constraint: Bun 不加载 `node:sqlite` 专用测试；Node 测试仍必须实际运行，不能通过 skip 隐藏。

- [x] **Step 1：保存当前失败证据**

运行：

```bash
bun test src/server/__tests__/releaseE2eSmoke.test.ts
bun test src/server/__tests__/claimAttempt.test.ts
```

预期：前者因截图名称仍断言 `06/07/08` 而失败；后者因 Bun 不支持 `node:sqlite` 而加载失败。

- [x] **Step 2：修正 E2E 静态契约测试**

把断言改为当前浏览器脚本实际生成的名称：

```ts
expect(browser).toContain('capture("12-session-management"')
expect(browser).toContain('capture("13-host-session-chat"')
expect(browser).toContain('capture("14-docker-session-chat"')
```

- [x] **Step 3：增加 Node 专用测试运行器**

`scripts/run-node-tests.mjs` 必须递归查找 `src/**/*.node-test.ts`，排序后通过以下方式一次执行：

```text
node --import tsx --test <sorted test files>
```

没有匹配文件时必须失败，子进程退出码必须原样返回。

- [x] **Step 4：隔离 Node 专用测试并声明脚本**

将 `claimAttempt.test.ts` 改名为 `claimAttempt.node-test.ts`，添加 `tsx` 开发依赖，并在 `package.json` 增加：

```json
{
  "test": "bun run test:bun && bun run test:node",
  "test:bun": "bun test",
  "test:node": "node scripts/run-node-tests.mjs"
}
```

- [x] **Step 5：局部验证**

运行：

```bash
bun test src/server/__tests__/releaseE2eSmoke.test.ts
bun run test:node
```

预期：E2E 静态契约 2 项通过；Node `claimAttempt` 10 项通过。

- [x] **Step 6：完整基线验证**

运行：

```bash
bun run test
```

预期：Bun 与 Node 测试全部通过，无 skip 掩盖 Node 测试。

验证记录（2026-09-07）：Bun 367 项通过，Node 10 项通过；无失败或跳过。Node 测试仍会输出 DirectConnectStore 对全新内存库执行兼容回填时的既有告警，后续身份与数据库阶段单独处理，不影响本任务的测试运行器正确性。

---

### Task 2：建立客户端兼容矩阵

**Files:**

- Create: `contracts/sudowork/supported-clients.schema.json`
- Create: `contracts/sudowork/supported-clients.json`
- Create: `scripts/contracts/validate-supported-clients.ts`
- Create: `scripts/contracts/validate-supported-clients.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `bun run contracts:clients`。
- Schema fields: `schema_version`、`policy_status`、`product_version`、`git_ref`、`commit`、`channel`、`targets[{platform, architecture}]`、`auth_profiles`、`capabilities`、`support_status`。
- Constraint: `candidate` 版本不能满足发布门禁，只有业务确认后的 `supported` 版本进入最终客户端测试矩阵。

- [x] **Step 1：编写失败测试**

测试拒绝缺失版本、空平台、未知认证方式、重复版本/平台组合，以及 `policy_status=confirmed` 但仍含 `candidate` 的矩阵。

- [x] **Step 2：运行失败测试**

运行：

```bash
bun test scripts/contracts/validate-supported-clients.test.ts
```

预期：校验器尚不存在而失败。

- [x] **Step 3：实现 Schema 与校验器**

初始候选只记录代码能够证明的版本：稳定标签 `v0.2.17` 和分析提交 `558668de116e245561f31b6d541aa5474456cab8`。两者保持 `candidate`，不得自行宣称为正式支持范围。

- [x] **Step 4：验证候选矩阵**

运行：

```bash
bun test scripts/contracts/validate-supported-clients.test.ts
bun run contracts:clients
```

预期：Schema 和候选数据合法；命令明确输出 `policy_status=candidate`，P0 最终门禁等待业务确认。

验证记录（2026-09-07）：校验器 6 项单测通过；候选矩阵包含 `v0.2.17` 和设计分析提交对应的私有版 `1.0.1`，`policy_status` 保持 `candidate`。

---

### Task 3：生成机器可读旧路由清单

**Files:**

- Create: `scripts/contracts/extract-sudowork-routes.ts`
- Create: `scripts/contracts/extract-sudowork-routes.test.ts`
- Create: `contracts/sudowork/routes.json`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: 环境变量 `SUDOWORK_SERVER_ROOT`，默认只允许开发机显式传入，不把外部仓库路径写死到生产代码。
- Produces: `{ schema_version, source_commit, generated_at, routes[] }`，每条路由包含 `method`、`path`、`source_file`、`source_line`、`router`、`mount_chain`、`domain`。
- Produces: `bun run contracts:routes -- --source /absolute/path`。

- [x] **Step 1：为 AST 提取器编写失败测试**

使用测试 Fixture 覆盖直接路由、嵌套路由、同一路由双前缀挂载、动态参数和根路径拼接。禁止用正则表达式作为 TypeScript 语义解析器。

- [x] **Step 2：运行失败测试**

运行：

```bash
bun test scripts/contracts/extract-sudowork-routes.test.ts
```

预期：提取器尚不存在而失败。

验证记录（2026-09-07）：测试因 `extract-sudowork-routes.js` 尚不存在而按预期失败，确认测试先于实现生效。

- [x] **Step 3：使用 TypeScript Compiler API 实现提取器**

添加 `typescript` 开发依赖。解析 `new Hono()`、HTTP method 调用、`route(prefix, router)`、命名/默认导出和对象属性导出；检测无法静态解析的路径并失败，禁止静默跳过。

- [x] **Step 4：生成真实清单**

运行：

```bash
bun run contracts:routes -- --source /Users/yobach/VSCodeProject/sudowork-server
```

预期：来源提交为 `311636c7bbfa4fa1c655aa8bd5c7e898f565f263`；对外 API method/path 为 216，Crash 路由分别挂载在 `/api/v1/crash` 和 `/api/v1/qms/crash`。

- [x] **Step 5：重复性验证**

连续生成两次并比较除 `generated_at` 外的规范化 JSON；结果必须完全一致。

验证记录（2026-09-07）：Fixture 单测 3 项通过；从 Sudowork Server 提取 216 条外部 API，来源提交为 `311636c7bbfa4fa1c655aa8bd5c7e898f565f263`。Crash 的 14 条路由分别在 `/api/v1/crash` 与 `/api/v1/qms/crash` 展开；连续生成的规范化 SHA-256 均为 `03bf5baa210b6f2f3391cc0e5368ad4054a81220ac87b50a7676e7b111ac40d7`。

---

### Task 4：验证 Hono 与现有 Node HTTP Server 共存

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `spikes/sudowork-http-adapter/hostDispatch.node-test.ts`
- Create: `docs/superpowers/spikes/2026-09-07-sudowork-http-adapter-result.md`

**Interfaces:**

- Uses: `Hono` 和 `getRequestListener(app.fetch)`。
- Constraint: Spike 不能被 `src/` 或生产构建入口导入。

- [x] **Step 1：添加直接运行时依赖**

添加与当前锁文件兼容的 `hono` 和 `@hono/node-server` 直接依赖，确保不再依赖 MCP SDK 的传递依赖。

验证记录（2026-09-07）：已直接声明 `hono@4.12.9` 与 `@hono/node-server@1.19.12`，版本与既有锁文件兼容。

- [x] **Step 2：编写失败的 Host 分流测试**

构建一个 `node:http` Server：可信 Sudowork Host 交给 Hono，其他 Host 交给原生 handler。相同 `/api/v1/auth/login` 在两个 Host 下必须返回不同且确定的响应。

- [x] **Step 3：扩展传输行为测试**

覆盖 JSON、urlencoded form、multipart、请求体只消费一次、SSE 事件及结束、客户端中断、CORS、302、错误 JSON、原生 `/healthz` 和 WebSocket upgrade 不被 Hono 捕获。

- [x] **Step 4：运行 Node Spike**

运行：

```bash
bun run test:node
```

预期：Host 和全部传输场景通过，无 hanging handle。

- [x] **Step 5：记录结论**

结果文档必须记录依赖版本、挂载 API、Host 信任前提、请求体所有权、SSE/abort 结果和生产 Adapter 的最小接口；不得把 Spike 文件当作生产实现复制。

验证记录（2026-09-07）：先以缺失 `hostDispatch.js` 得到预期失败；实现后统一 Node 入口运行 16 项测试全部通过，其中 Host/传输 Spike 6 项。测试运行器已覆盖 `{src,spikes}/**/*.node-test.ts`，避免 Spike 被统一门禁漏跑。

---

### Task 5：验证 SQLite UnitOfWork 机制

**Files:**

- Create: `spikes/sqlite-unit-of-work/unitOfWork.node-test.ts`
- Create: `docs/superpowers/spikes/2026-09-07-sqlite-unit-of-work-result.md`

**Interfaces:**

- Prototype: `runInTransaction<T>(db: DatabaseSync, callback: (context: TransactionContext) => T): T`。
- Constraint: callback 返回 Promise 时必须立即回滚并抛错。

- [x] **Step 1：编写嵌套事务失败测试**

覆盖最外层 `BEGIN IMMEDIATE`、嵌套唯一 Savepoint、内层失败回滚、外层失败全回滚和连接 `isTransaction` 恢复。

- [x] **Step 2：运行测试确认失败**

运行：

```bash
bun run test:node
```

预期：原型尚不存在而失败。

- [x] **Step 3：实现最小 Spike 事务执行器**

使用显式上下文记录深度和 Savepoint 序号；禁止 Repository 裸事务；检测 PromiseLike 并回滚。

- [x] **Step 4：增加并发与锁测试**

使用临时 WAL 文件和两个 `DatabaseSync` 连接覆盖 `SQLITE_BUSY`、busy timeout、完整命令重试、数字别名唯一约束和钱包无丢失更新。测试不得在事务中间重试。

- [x] **Step 5：运行 Node Spike**

运行：

```bash
bun run test:node
```

预期：事务、并发和异步拒绝场景全部通过。

- [x] **Step 6：记录结论**

结果文档必须给出可用于 P1 正式实现的 API、错误类型、busy 策略和测试结果，并说明 UnitOfWork 只覆盖单个主 SQLite 连接。

验证记录（2026-09-07）：先以缺失 `unitOfWork.js` 得到预期失败；实现后事务 Spike 7 项全部通过。双连接 WAL 测试确认锁冲突会抛错，锁释放后只重试完整命令，钱包最终余额为 2；数字别名唯一约束生效。

---

### Task 6：P0 总门禁

**Files:**

- Modify: `docs/superpowers/plans/2026-09-07-sudowork-moss-p0-spikes.md`（只更新复选框和测试证据）

- [x] **Step 1：运行完整测试**

```bash
bun run test
```

预期：Bun 和 Node 测试全部通过。

- [x] **Step 2：验证生产构建**

```bash
bun run build:node
```

预期：Node 产物构建成功，Spike 文件未进入生产入口。

- [x] **Step 3：验证契约产物**

```bash
bun run contracts:clients
bun run contracts:routes -- --source /Users/yobach/VSCodeProject/sudowork-server --check
```

预期：客户端矩阵格式合法；路由清单与生成结果一致且为 216 个 method/path。

- [x] **Step 4：工作树审计**

确认未修改两个只读仓库、未创建 commit、未暂存文件，并记录 P0 唯一可能未关闭的业务输入：客户端候选版本是否全部属于正式支持范围。

P0 通过后才创建 P1 身份与组织的独立实施计划。

验证记录（2026-09-07）：完整测试为 Bun 377 项、Node 23 项通过，均 0 失败；`build:node` 成功且 Spike 未进入生产入口；客户端矩阵和 216 条路由契约校验通过。当前 HEAD 仍为 `bc3125a126ac9cd4e59beaf195e5cf1d632fca36`，无暂存或新提交；两个只读源仓库未被本任务修改。P0 技术门禁通过，唯一未关闭的业务门禁是客户端矩阵仍为 `candidate`，正式切流前必须确认支持范围。
