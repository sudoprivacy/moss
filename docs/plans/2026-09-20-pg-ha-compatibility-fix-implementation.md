# PostgreSQL 后端启动崩溃与 HA 双活修复 — 实施计划（定稿）

> 方案基线：`docs/plans/2026-09-18-postgres-ha-compatibility-fix.md`（已经三路独立代码核查 + 归档实测确认，见第二节）。其中 3.3.5 的 core/领域 schema 初始化顺序经外部审核 + 本计划独立复核确认存在缺陷（第二节第 5 条），以本计划批次 5 的修正顺序为准。
> 代码事实基准：fix/pg worktree，HEAD = `be38bec`（tag `server-v0.1.36`）。文中行号为该基准下的定位锚点，实施时以符号定位为准。
> 批准后本计划将落盘为 `docs/plans/2026-09-20-pg-ha-compatibility-fix-implementation.md`（新文件；不修改 2026-09-18 文档）。

---

## 一、用户明确需求与强制约束（唯一范围基线，置于最上方）

### 1.1 范围与结果需求 R1–R12（2026-09-18 审核文档第一节原文照录）

- **R1—解决实际故障：**修复 release 0.1.36 和当前 dev 设置 `MOSS_DATABASE_URL` 后 `moss-server` 启动必崩的问题，恢复 PostgreSQL/HA 双活形态。
- **R2—解决完整故障链：**不能只绕过首个 `undefined.exec`；Identity、Catalog、Configuration、Dify 和启用后的 Billing 在 PostgreSQL 下必须能够完成实际运行时读写。
- **R3—保持 SQLite 兼容：**SQLite 单机模式的外部行为、数据升级和事务正确性必须保持，不以 PG 修复换取 SQLite 回归。
- **R4—满足双实例语义：**两个健康实例共享同一 PostgreSQL 时必须能同时启动、共同读写，并正确处理本次 compatibility 路径已经存在的 ID 分配和同幂等键竞争。
- **R5—遵守编码规范：**采用高内聚、低耦合设计，复用已有最小数据库抽象，最小程度修改已有代码；不复制一套 PG 专用业务仓储。
- **R6—严格聚焦需求：**不做任何顺手修改，不修改错误日志格式、QMS 独立 PostgreSQL 存储/schema、旧 Sudowork SQLite 源库读取器、公共 HTTP/API 协议或其他无关功能。为消除 MOSS 主库的同步 SQLite 访问，只允许调整 QMS 组织目录适配接口和旧库迁移中实际访问 MOSS 目标领域仓储的调用链。
- **R7—建立真实回归门禁：**增加真实 PostgreSQL 全链路测试以及最终发布产物的 SQLite、PG 双实例启动测试；本次要求的这些测试必须真实执行，其失败、跳过或证据缺失都必须阻止构建、上传和发布。
- **R8—证据优先：**所有实施内容和验收结论必须来自实际代码、用户提供的原始归档、真实 PostgreSQL 和最终打包产物；禁止猜测性结论，禁止以跳过功能、吞掉异常、伪造类型或放宽门禁图省事。
- **R9—发布依赖保持最小：**不为已经内联进服务端 bundle 的 `pg` 重复增加发布依赖。
- **R10—保持工程约定：**遵守现有 TypeScript、ESLint、测试分层和发布脚本约定；不新增 `any`、非空断言或错误吞噬，不提高 typecheck baseline，不做全局格式化或无关重命名。
- **R11—先审核后实施：**本文档必须先由用户审核；审核通过并收到明确实施指令前，不修改业务代码。
- **R12—范围变更必须复核：**后续任务必须能直接对应 R1–R10；若实施中发现新的生产调用链或必要改动，先补充可复现证据并回到本文档复核，不得自行扩大范围。

HA 外部副作用验收边界：两个健康实例并发处理同一幂等键时只能有一个实例获得执行权；保留并验证现有 `UNKNOWN`/重试契约，不扩大为通用 exactly-once/租约接管/跨系统补偿框架。无生产装配证据的 `MigrationRunStore`、`PostCutoverChangeLog` 及本地迁移控制表不迁入 PG。

### 1.2 用户补充指令（2026-09-20，本次对话明确）

1. **编码规范**：高内聚低耦合；最小程度修改已有代码。
2. **聚焦需求**：不做任何顺手的事情；每项改动必须直接对应 R1–R10。
3. **事实纪律**：一切基于事实；禁止一切幻觉和猜测性输出；所有输出内容必须准确、经过验证；杜绝一切图省事的行为（不吞异常、不伪造类型、不放宽门禁、不静默跳过测试）。
4. **范围决策（2026-09-20）**：`session_attempts.generation` 的 `MAX+1` 预存竞态（`db.ts:2111`，单机/双活共有、非双活阻断、不在本次崩溃链）**不纳入本次范围**，已记录在案，后续独立评估。`db.ts:3779` corp_app_inbound 已有 PG 唯一约束+重试方案，同样不动。
5. 计划文档必须由用户明确指令才开始编写（已获指令，即本文档）。

---

## 二、事实核查结论（本计划的事实底座，全部经独立验证）

三路只读核查（崩溃链与提交历史 / 同步依赖与并发语义 / schema 与测试 CI 发布）+ 归档实测（两 zip 外层 SHA-256、bundle 大小与哈希、node_modules 与 bundle 内容、E2E 报告），对 2026-09-18 文档第 1 节全部声明逐项核对：

- **全部成立**，含：崩溃链三环节（`db.ts:156` 赋 undefined → `auth/service.ts:318` 传 `this.db.db` → `identityRepository.ts:183` `this.db.exec`）；Auth 后无条件构造链 20+ 处 raw `this.db.db`（`auth/service.ts:318-624`）；pg_schema 仅 v1-v4 且 33 项表/列全部缺失；`pgBackend.test.ts` 无 Auth 链覆盖、无 `MOSS_PG_TEST_URL` 整组 skip；CI 不启 PG、build job 无 `needs: test`、release 仅依赖 build；发布 smoke 仅 SQLite；`pg` 已内联 bundle（`scripts/build.js:130-142` external 列表不含 pg）；四类 `MAX(legacy_id)+1`；`runInTransaction`=BEGIN IMMEDIATE+savepoint 与两 driver 事务语义差异；`ensureCompatibilityRecords` fire-and-forget（`auth/service.ts:322`）。
- **方案锚点全部确认**：`DbDriver` 接口含 `get/all/run/exec/transaction/tryRunExclusive`（`db/driver.ts:57-99`）双驱动完整实现；`isUniqueViolation()` 双方言已有（`driver.ts:34-44`）；`AuthCenterDb.bootstrap()/ensureBootstrapAdmin()/isInitialized()` 均为既有 async 方法（`authCenter/db.ts:1802/1850/1929`）；billing 幂等键机制既有（`billingCoordinator.ts:66-69` 等）。
- **保持不动项的事实依据**：旧 Sudowork 源读取器使用私有只读 `DatabaseSync`（`sudoworkIdentitySourceReader.ts:22-33`，`readOnly:true` + `PRAGMA query_only=ON`），与主库隔离，无需改动。
- **2 处字面修正**（实施时按实际符号处理）：bundle 中构造语句实际形态为 `new IdentityRepository(this.db.db, {`；幂等方法名实为 `getOperationAuditByIdempotencyKey`（`identityRepository.ts:859`，迁移校验用）与运行时使用的 `hasOperationAudit`（`adminService.ts:423`）/`getCommandResult`（`configService.ts:287`）。
- **外部审核 4 项发现经独立验证全部成立**（2026-09-20，逐条亲核/实测，非采信报告）：
  1. `config_items.availability` 顺序缺陷：默认 'organization'（`configAvailabilitySchema.ts:7`）+ 启动期 UPDATE 修正（`:11-14`，每次启动执行）；`ensureDefaultConfigItems` 与 `createConfigItem` 的 INSERT 均不写 availability（`db.ts:4193`、`:4245-4276`）；可见性要求 `org_id` 匹配或 `availability='all'` 或显式分配（`configService.ts:243-257`）。PG 跳过 SQLite schema 函数 → fresh PG 的 ShareOne（user-scope、org_id=NULL）得 'organization' → 对所有组织不可见，与 SQLite 行为不等价（违反 R3）。
  2. counter 回填顺序缺陷：`ensureBillingSchema` 升级期**主动生成** legacy_id（`billingSchema.ts:303-334`，从 `MAX(...,1999999999)` 起 ROW_NUMBER 回填 + 唯一索引）；"先 core counter 后领域 schema"的顺序在 fresh 库因来源表不存在而失败、在旧库因升级期生成的 legacy_id 不入 counter 而碰撞。2026-09-18 文档 3.3.5 的该表述被推翻，以本计划批次 5 为准。
  3. 目标迁移链存在 3 处 SQLite 专属 SQL：`sqlite_master` 查询（`identityMigrationService.ts:288`、`p4DifyMigrationService.ts:499`）；`(? IS NOT NULL AND pinyin = ?)` 歧义参数（`p2ConfigurationMigrationService.ts:112-116`）——后者已在运行中的 PostgreSQL 16.15 容器实测复现：`ERROR: could not determine data type of parameter`。
  4. 漏写 await 无发布链门禁：`no-floating-promises: 'error'` 仅由 lint workflow 检查（`eslint.config.js:25`），而 lint 仅在 PR 与 main push 触发（`lint.yml:8-11`）；发布链 test job 只有测试+typecheck（`build-release.yml:49-63`）且 build 无 `needs`——TypeScript 允许丢弃 Promise，大规模异步化后漏写 await 会以绿色构建发布。
- **第三轮审核 7 项发现经独立验证全部成立**（2026-09-20，逐条亲核/实测）：
  1. **[H-1] 原批次划分与 ratchet 门禁矛盾**：仓储方法 Promise 化波及全部同步消费方——亲核证据：`typecheck-ratchet.js:108`（>116 即 exit 1）、`accessMigrationPhase.ts:192-195`（`resolveNumericAliasGlobal(...)!` 值使用必报 TS2339）、`billing/creditApplicationService.ts:77`、`dify/difyConnectionService.ts:77/:85/:186-187`（跨领域消费）、compat 侧大量属性访问点——原批次 1 清单（6 文件）远不覆盖，按原文执行 ratchet 必破。已重划批次（见第四节执行序）。
  2. **[M-1a] 条件上下文静默劣化**：`adminService.ts:448/:462` 的 `if (this.identities.hasOperationAudit(key)) return` 在 Promise 化后恒真（审批静默失效），TS 与 no-floating-promises 均不覆盖。处置：批内 grep 审计 + node-test 行为断言门禁（`adminService.node-test.ts` 有审批幂等断言）。**独立判断：不启用 `no-misused-promises`**——`eslint.config.js:3-10` 注释明确保持 narrow 配置以避免存量误报阻塞门禁，规则存量影响面未实测不可预启；行为断言网（node-test）+ 批内审计已覆盖该风险。
  3. **[M-1b] 124 个 node-test 不在任何 runner**：亲核计数（migration 38/qms 23/compat 23/billing 12/identity 9/dify 9/catalog 5/configuration 4/storage 1）+ 全 workflow/runner grep 零命中 + `test-server.js:119-142` 清单机制硬约束（仅收 SUITES 目录 `.test.ts`，node-test 结构性无法加入）。**现状基线已实测：509 tests/507 pass/0 fail/2 skipped/31.9s 全绿。**处置见批次 8（专用命令）。
  4. **[M-2] availability 修正顺序未锁定**：现状 UPDATE 唯一调用点在 `SudoworkConfigService` 构造函数（`configService.ts:55`，懒构造期）。批次 2 已锁定顺序（领域 schema 加列与 `ensureDefaultConfigItems`（:146）之后、服务构造之前）。
  5. **[L-1]** `driver.ts:376` 为事务级 `tryRunExclusive`、`:393` 为 Session 级变体，原文锚点混同，已修正。
  6. **[L-2]** `qmsRuntime.ts` 目录方法调用零命中（仅装配），await 落点在 `qmsAuthorization/crashService/telemetryService` 方法体，批次 1 已修正指向。
  7. **[L-3/L-4]** 豁免 glob `**/*.test.ts` 不匹配 `*.node-test.ts`（node-test 受 no-floating-promises 约束、现存文件已用 `void it(...)` 模式且 lint 实测绿）；批次 1 时点 PG 无 identity 表导致 `ensureCompatibilityRecords` 预期失败 warn——均已在批次文本注明。
  - 第三轮审核的证伪清单经抽查属实：`configAvailabilityService.ts` 生产零引用（grep 亲核）；v4 `recharge_orders`/`refund_records` 与 v5 新增 `billing_orders`/`billing_refunds` 不同名无冲突；"33 项缺失"、两处类型断言位置与既有一致。
- **第四轮审核 3 项发现经独立验证全部成立**（2026-09-20）：
  1. **[中-1] "全部 124 个 node-test 落在改造波及面"声明不实且与 3.3/基线 3.7.2 矛盾**：五个零波及反例亲核属实（`redisTelemetryQueueBackend`/`postgresStore`/`qmsLeaseStore`/`alertService` 仅测 R6 不动组件、`sudoworkIdentitySourceReader.node-test.ts` 仅测不动源读取器）——先前表述为目录级推断所致（ guessing，违反 1.2.3，已修正为如实表述）；3.3 与批次 8 的文本矛盾已消（全量纳入改为显式范围决策声明，含对基线 3.7.2 字面边界的偏离声明与四点理由）。
  2. **[低-1] 批末门禁缺 lint**：floating 形态实证亲核（`adminService.ts:629` `insertOperationAudit` 语句位置返回值未用）——批末门禁已加入 `bun run lint`。
  3. **[低-2] 专用命令引用指向错误且建立时点晚于首个使用点**：已改为"前置小步（批次 1 开工前建立）"并修正指向。
- **第五轮审核 5 项低危发现经独立验证全部成立**（2026-09-20）：
  1. **[L-A]** ratchet 绿色区间为 [107,116] 非"≤116"（`typecheck-ratchet.js:124-131` 亲核：`allowed - scoped.length >= 10` 即 exit 2）——第四节已注记区间语义与收紧处置。
  2. **[L-B]** 专用命令挂入方式与目录子集能力缺失——前置小步已细化为独立脚本（显式清单 + 目录参数过滤）经 package.json `test` 链式挂入，不触碰 `test-server.js`。
  3. **[L-C]** 批次 1 新增 PG 测试的 runner 归属——已注明新测试一律 `*.node-test.ts` 并即时加入专用命令清单。
  4. **[L-D]** `ensureBillingSchema` 生产零调用（grep 亲核：全部调用点在 node-test fixture）——批次 5 已注明"新增生产初始化入口"的现状背景与验收口径。
  5. **[L-E]** 验收 3 无取证手段——第六节已补静态审计规则（grep 模式 + SQLite-only 白名单分类 + 类型如实化后的编译证据）。

---

## 三、方案重新审核结论（需求覆盖性 × 编码规范 × 聚焦性）

### 3.1 需求覆盖性（机制 → 需求映射，每条均有已验证事实支撑）

| 需求 | 解决机制 | 事实依据 |
|---|---|---|
| R1 启动崩溃 | 仓储构造改注入 `driver`；DDL 从构造函数提取；PG 构造形态不再被触碰 raw `db` | 崩溃链三环节逐一对应拆除；`DbDriver` 接口已存在且双驱动实现 |
| R2 完整故障链 | 五领域仓储方法异步化（`prepare().get/all/run` → `await driver.get/all/run`）+ PG migration v5 补 33 项 schema | 已确认的全部 raw 访问点与 schema 缺口清单即改造清单，无遗漏来源 |
| R3 SQLite 兼容 | SQLite schema 权威不变（显式初始化函数）；`runInTransaction`（BEGIN IMMEDIATE+savepoint）语义差异逐项处理而非盲目替换；SQLite 全量回归 + composition-root 初始化测试 | `sqliteUnitOfWork.ts:39-87` 语义已核实；ratchet/runner 机制已核实 |
| R4 双实例 | `compatibility_id_counters` 原子分配替换四处 `MAX+1`；幂等路径唯一约束+条件状态更新选主；bootstrap 加 advisory lock；`ensureCompatibilityRecords` 改启动 await | `tryRunExclusive`（`driver.ts:376/393`）既有；四处 MAX 已定位；fire-and-forget 现状已定位 |
| R5/R6 规范与聚焦 | 复用 `DbDriver` 单一边界，不建 PG 专用仓储；不改协议/日志格式/QMS 独立库/旧源读取器 | 接口事实见第二节；隔离性事实见第二节 |
| R7 门禁 | CI 启 PG + `MOSS_PG_TEST_URL` 必填 gate；`build` 增加 `needs: test`；发布 PG packaged smoke（双实例） | workflow 现状已核实（build 无 needs、release 仅依赖 build） |
| R9/R10 | 不加 `pg` 依赖（已验证内联）；typecheck ratchet 只许收紧（现值 `serverErrors: 116`） | build.js external 与 baseline 事实 |

### 3.2 编码规范符合性

- **高内聚**：业务 SQL 与映射留在各领域仓储；SQLite DDL 收敛到各领域 schema 函数；PG DDL 只在 `pg_schema.ts` 版本化 migration；composition root 只负责初始化顺序。
- **低耦合**：仓储只依赖 `DbDriver` 最小接口，不依赖 `DirectConnectStore` 整体、不直接依赖 `node:sqlite`（SQLite-only 代码除外）。
- **最小修改**：改动面 = 已确认的 raw `DatabaseSync` 访问点（第二节清单）+ schema 分离 + PG v5 + CI/发布门禁 + 对应测试；每一步由类型检查指出未完成点，不借机重构。

### 3.3 聚焦性核查（禁止事项清单）

不做：日志格式修改、全局格式化/重命名、QMS 独立存储与调度改动、旧源读取器改动、HTTP/API 协议改动、`MigrationRunStore`/`PostCutoverChangeLog` 迁 PG、通用分布式 lease/补偿框架、session_attempts generation 与 corp_app_inbound 的 MAX+1（1.2.4 决策）、向 runtime-deps 加 `pg`。**不收编与本次改造无关的存量测试发现机制**（不改 `scripts/test-server.js` 的 SUITES/清单机制、不做全仓自动发现）；node-test 专用命令对 124 个文件的全量运行是批末门禁可维护性与 R3/R6 双向行为佐证的显式决策（理由与基线偏离声明见批次 8），不属"收编发现机制"。

---

## 四、实施批次（每批末：编译绿 + typecheck ratchet 处于绿色区间 + `bun run lint` 绿 + SQLite 测试绿 + 波及 node-test 绿）

> **ratchet 区间语义（修正 L-A，已亲核 `typecheck-ratchet.js:124-131`）**：绿色区间为 **[107, 116]**，非"≤116"——stale-baseline 保护规定实测值比 baseline 低 ≥10（即 ≤106）时 exit 2 拒绝。若某批改造净消除 ≥10 个存量 src/server 类型错误（如被适配调用点上恰挂存量错误）导致批末意外 exit 2，处置为按 R10 授权执行 `--update-baseline` 向下收紧并在验收记录说明（批次 10 同款规则）。

> **前置小步（批次 1 开工前）**：建立 node-test 专用测试命令——独立脚本 `scripts/run-node-tests.js`（内含 124 个 `*.node-test.ts` 显式路径清单，`npx tsx --test` 执行；**支持可选目录参数过滤**，无参=全量，供批次 1–4 批末只跑各自波及目录——修正 L-B 子集张力）；挂入方式为 package.json `test` 链式串联（`node scripts/test-server.js && node scripts/run-node-tests.js`），**不改动 `scripts/test-server.js`**（规避其 win32 `shell:true`（:148-151）与清单机制耦合）。本计划新增的测试文件一律采用 `*.node-test.ts` 后缀并即时加入该清单（修正 L-C：批次 1 新增 PG 构造测试的 runner 归属即此）。现状基线已实测全绿（509/507/0 fail/2 skipped/31.9s），建立后即为各批门禁载体（修正前轮低-2 的时序倒置）。
>
> 执行序与批次定义（修正第二轮审核 H-1；先前"每批全仓编译保持绿"的领域小清单模式与代码事实不符——仓储方法 Promise 化会立即波及其**全部**同步消费方，远超单批小清单，按原文本执行 ratchet 必破 116）：
> - **每批 = 一个领域仓储 + 该仓储全部同步消费方的完整适配**。翻转仓储方法签名后，`npx tsc --noEmit` 的错误清单即消费方全集（机械圈定，不靠人工枚举、不预限文件清单），批内逐文件适配至错误清单清零。批内允许中间红，批末必须全绿。
> - **批末门禁含 `bun run lint`（修正低-1）**：语句位置丢弃返回值的形态（如 `adminService.ts:629` 的 `this.identities.insertOperationAudit({...})` 返回值未用）在 Promise 化后即 floating——TS 不报错、条件审计不覆盖，恰为 `no-floating-promises` 独有覆盖的盲区；批末跑 lint 可在引入当批发现而非批次 9 返工（当前 `be38bec` 实测全绿，增量成本约几十秒）。
> - **条件/布尔上下文强制审计（修正 M-1a）**：`if (repo.method(...))` 形态（如 `adminService.ts:448/:462` 的 `hasOperationAudit`）在签名 Promise 化后**恒真且 TS 不报错**——每批翻转签名前，grep 该仓储全部调用点并逐个核对条件上下文调用点改为 `if (await ...)`；配套的 node-test 行为断言（如 `adminService.node-test.ts` 的审批幂等断言）进批末门禁，作为该类劣化的行为级检测。不启用 `no-misused-promises`（eslint 配置注释明确保持 narrow 以避免存量误报阻塞，行为断言网已覆盖该风险——独立判断，见第二节）。
> - **跨批消费文件允许多次触及**（如 `adminService.ts` 的 identity 调用点在批次 1 适配、billing 调用点在批次 3 适配）；visibility builder（`auth/service.ts:2460-2483`）与其消费方 `buildVisibility`（`:540`，Dify 构造链）同批（批次 3）。
> - 全部领域完成后做类型如实化收尾（批次 5）。最终形态与 2026-09-18 文档 2.3/3.1 一致。

**批次 1 — Identity 仓储 + 其全部消费方（崩溃点）**
- `identityRepository.ts`：构造改 `DbDriver`；从构造函数提取 SQLite schema 初始化函数（含 PRAGMA 补列逻辑原样搬移）；全部方法异步化（`prepare().get/all/run` → `await driver.get/all/run`；`.changes` → `run()` 受影响行数；`INSERT OR IGNORE` → `INSERT ... ON CONFLICT ... DO NOTHING`）。
- 消费方波及面（已亲核的下限证据，实际以 tsc 清单为准）：migration 目标侧（`accessMigrationPhase.ts:192-195` 的 `resolveNumericAliasGlobal(...)!` 值使用、`governanceMigrationService.ts` 十余处、`identityMigrationService.ts`、`targetIdentitySnapshot.ts`、`planningProjections.ts`）；compat 侧（`identityService`、`casService`、`adminService`（`:448/:462` 条件上下文 + `:329/:678` 属性访问）、`userProjectionService`、`legacyUsageService`、`configService`/`systemConfigService`/`billingService`/`catalogService` 的 identity 调用点）；跨领域（`billing/creditApplicationService.ts:77`、`refundService.ts`、`dify/difyAdministrationService.ts`、`difyConnectionService.ts:77/:85/:186-187`、`identity/legacyToken.ts`）；`unifiedIdentityService.ts`/`organizationIdentityService.ts`（并删除未使用 raw-db 参数，已验证零处 `this.db` 引用）；`auth/service.ts`（构造注入 `this.db.driver`、`nativeActorResolver`（:360-368）、`createQmsOrganizationDirectory`（:381-386）异步化、`ensureCompatibilityRecords` 改 `driver.transaction`）。
- QMS 链（修正 L-2 文件指向）：`qmsAuthorization.ts:15-18` 接口改 `Promise`；await 落点在 `qmsAuthorization.ts`/`crashService.ts`/`telemetryService.ts` 方法体内（消费 `getCode/hasCode` 处）；`qmsRuntime.ts` 仅装配点适配（已验证其自身无目录方法调用）。不改 QMS 独立库。
- 本批后 `createAuthService` 可在真实 PG 完成构造（依据已验证：构造函数直接创建的只有 Identity 链 `:318/:321` 与 fire-and-forget 的 `:322`；其余领域全在工厂方法懒构造）。**预期噪声（修正 L-4）：本批时点 PG 尚无 identity 业务表（v5 在批次 8），构造后 fire-and-forget 的 `ensureCompatibilityRecords` 必然失败并经 `.catch` 输出 warn——测试断言"构造不触碰 undefined"不受影响，warn 为预期行为，非环境错误。**
- 门禁：typecheck ratchet ≤116 + tsc 错误清单清零 + `bun run lint` 绿 + identity/compat/migration 波及 node-test 绿（前置小步建立的专用命令）+ 新增「真实 PG 构造 `createAuthService` 不触碰 undefined」测试。

**批次 2 — Catalog + Configuration 仓储 + 其全部消费方**
- `catalogRepository.ts`（构造调 `ensureCatalogSchema` 处分离）、`catalogSchema.ts`、Catalog/Upload service 及其 tsc 清单消费方（含 `catalogService.ts:103/:118/:146/:160/:173/:197/:225` 等属性访问点）。
- `clientPolicyRepository.ts` / `platformIntegrationSettingsRepository.ts` 构造函数 DDL 提取为独立函数；`configAvailabilitySchema.ts` 维持；Config/SystemConfig service 及消费方适配。
- **availability 启动修正共享化（修正审核问题 1，保 R3 行为等价）**：将 `configAvailabilitySchema.ts:11-14` 的 UPDATE（`scope='user' AND org_id IS NULL AND availability='organization'` → `'all'`）提取为 `DbDriver` 版共享修正函数。**调用顺序显式锁定（修正 M-2）：SQLite 侧在领域 schema 集中初始化（含 availability 加列）与 `ensureDefaultConfigItems()`（`startStandaloneServer.ts:146` 的 ShareOne INSERT）之后、服务构造与 HTTP 就绪之前；PG 侧在 `ensureDefaultConfigItems()` 之后、服务构造之前。现状该 UPDATE 的执行时点是 `SudoworkConfigService` 构造函数（`configService.ts:55`，懒构造期）——修正函数统一前移到锁定位置，效果等价（启动完成前执行），且消除对服务构造顺序的隐式依赖。**`ensureDefaultConfigItems`/`createConfigItem` 的 INSERT 不改（保持现状写入行为，两后端一致）。
- 门禁：同批次 1 模式 + Catalog/Config/billing 交叉消费 node-test 绿 + SQLite availability 修正行为回归（UPDATE 在锁定位置生效）。

**批次 3 — Dify + Billing 仓储 + 其全部消费方**
- `difyRepository.ts`/`difySchema.ts`、Administration/Dataset/Connection service；enterprise alias resolver（`auth/service.ts:539`）与 visibility builder（`:2460-2483`）+ 其消费方 `buildVisibility`（`:540`）同批异步化。
- `billingRepository.ts`/`billingSchema.ts`（含 `command_executions` ALTER 补列逻辑归入 schema 函数）、Wallet/Recharge/Refund/Credit/Sudorouter/Reconciliation/BillingCoordinator 及其消费方（`adminService.ts:465` 等跨领域点本批适配 billing 部分）；`fuiouAdapter` 等既有 provider 幂等键透传保持。
- 门禁：同上 + dify/billing/compat 波及 node-test 绿（含 `adminService.node-test.ts` 审批幂等断言——M-1a 行为级检测）+ Billing append-only/余额恒等式现有测试绿。

**批次 4 — 目标迁移链方言点 + QMS 集成链收尾 + 启动顺序**
- 迁移目标侧在批次 1–3 中已随消费方清单异步化；本批处理**三处已验证的 SQLite 专属 SQL（修正审核问题 3，机械替换规则覆盖不到）**：`sqlite_master` 表存在性查询两处（`identityMigrationService.ts:288`、`p4DifyMigrationService.ts:499`）改为跨方言存在性检查（此处合法检查 `driver.kind`，PG 走 `to_regclass` 等价物）；`(? IS NOT NULL AND pinyin = ?)` 歧义参数（`p2ConfigurationMigrationService.ts:112-116`，已实测 PG 报 `could not determine data type of parameter`）改为 JS 侧按 `source.pinyin` 是否为空分支构造查询。改造后行为与 SQLite 现状一致。旧 `*SourceReader.ts` 不动。
- `startStandaloneServer.ts`（:145-146、:215、:315-426、:480、:620）适配新构造与初始化序列；`ensureCompatibilityRecords` 从 fire-and-forget 改启动门禁内 await。
- Auth bootstrap advisory-lock 化：`DbDriver.tryRunExclusive()`（事务级，`driver.ts:376`；注意 `:393` 是 Session 级变体 `tryRunExclusiveSession`，本处不用——修正 L-1）+ 锁内 `isInitialized()` 重查 + `bootstrap/ensure`，锁后重载 JWT secret/issuer cache（既有 async 方法，见第二节）。
- 门禁：migration 目标侧 plan/execute/verify node-test 行为不变 + typecheck。

**批次 5 — 类型如实化收尾 + SQLite core schema（修正后顺序：先领域，后 counter）**
- `db.ts:140`、`authCenter/db.ts:298` 的 `db` 类型改 `DatabaseSync | undefined`，删除两处 `as unknown as DatabaseSync` 断言；编译暴露的访问点按真实职责逐个处理：SQLite-only 代码局部判空，共享路径禁止非空断言。
- **初始化顺序（修正审核问题 2）**：composition root 与测试 fixture 依次执行——①各领域 SQLite schema（建表 + 旧列升级 + 升级期 legacy ID 回填，如 `billingSchema.ts:303-334` 会在此时产生新 legacy_id）→ ②compatibility core schema（建 `compatibility_id_counters` + 按 key 从**最终**数据取 `MAX(legacy_id)` 回填）。理由（已验证）：counter 回填来源表由领域 schema 创建/升级，且领域升级本身会生成 legacy_id；若 counter 先行，fresh 库因表不存在失败、旧库因漏计升级期 ID 而碰撞（ledger 的 legacy_id 有唯一索引）。重复初始化不降 counter、不重写业务数据。2026-09-18 文档 3.3.5 的"先 core 后领域"表述以此为准修正。
- **现状背景声明（修正 L-D，已亲核）**：`ensureBillingSchema` 当前**生产代码零调用**（全部调用点在 node-test fixture）——即 SQLite 现状下 billing 15 张 compatibility 表无生产创建入口，pay 模式启用后首次写库存在 no-such-table 隐患。将其纳入 composition root 集中初始化是**新增生产初始化入口**：幂等 DDL、无数据改写、消除上述隐患，属 R2 在 SQLite 侧的必要配套；验收第 9 条改动面核对时按此口径认定，不属超范围新增。
- 门禁：typecheck（受影响文件 diagnostic 前后对比，无新增）+ SQLite composition-root 初始化测试（schema 仅一次、两 repository 构造无 DDL）+ 旧库升级后 counter ≥ 各来源表 MAX(legacy_id) 的断言测试。

**批次 6 — 双实例并发语义**
- 四类 legacy ID 分配（`identityRepository.ts:528/:893`、`billingRepository.ts:917/:1040`）替换为 `compatibility_id_counters` 单条 `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` 原子递增（空 counter 从 2,000,000,000 起）；显式导入 legacy ID 同事务内 `CASE` 推进 counter；删除运行时 `MAX+1`。
- numeric alias 分配采用「counter 取号 → `ON CONFLICT DO NOTHING` → 按 `(namespace, resource_id)` 重读」，loser 返回 winner 记录，允许 counter 空洞。
- 幂等路径逐项审核（`getCommandResult`/`hasOperationAudit` → 执行 → 写结果；Dify/Billing/Sudorouter 外呼路径）：纯 DB 事务验证唯一冲突完整回滚 + 胜者结果重读；外呼路径外呼前持久化唯一 operation、条件状态更新原子取得 `PROCESSING` 执行权（受影响行数=1 才外呼）；不把网络调用放进长事务。
- 门禁：新增双 pool 并发测试（counter 不重复、同幂等键单执行者、导入大 ID 后分配严格更大）。

**批次 7 — PG migration v5**
- `pg_schema.ts` 单一 v5：第 1.3 节 33 项表/列/索引/约束/外键 + `compatibility_id_counters`；`tenant_assistants`/`tenant_skills`/`config_items` 幂等 `ADD COLUMN IF NOT EXISTS` + 数据回填，**其中 `config_items.availability` 的存量回填必须包含等价 UPDATE（`scope='user' AND org_id IS NULL` → `'all'`，与批次 2 的启动修正同一语义，覆盖 v5 前存量行；fresh 库空表无行可改，由启动修正函数覆盖后续插入）**；`command_executions` 合并三领域完整列集只建一次；Billing append-only 触发器/余额 CHECK/状态枚举/partial unique、Catalog availability 与 polymorphic parent、各方言约束等价翻译（不复制 `typeof()`/`json_valid()`，不新增 SQLite 没有的约束）；显式命名全部对象；counter 按 key 从存量 legacy 数据回填、只前进；advisory lock 串行、DDL/回填/`_migrations` 同事务。
- 门禁：4.1 schema 测试（空库 v1-v5、v4 升级、幂等重放、双 pool 并发、约束正反例）。

**批次 8 — 测试体系**
- 4.2 Auth/启动回归（含双 pool 并发 bootstrap/compatibility records 收敛）、4.3 五领域代表性 PG 测试（成功/回滚/双 pool 竞争）、4.4 SQLite 回归（fixture 显式包装 `SqliteDriver`）。
- **node-test 纳入门禁（修正 M-1b 与第四轮中-1；机制事实已亲核：`scripts/test-server.js:119-142` 的清单只能收录三个 SUITES 目录内的 `.test.ts`，node-test 文件结构性无法加入现有清单，须走 2026-09-18 文档 3.7.2 的"等价的专用测试命令"）**：专用命令（前置小步建立）运行全部 124 个 `*.node-test.ts`（migration 38 / qms 23 / compat 23 / billing 12 / identity 9 / dify 9 / catalog 5 / configuration 4 / storage 1）。**如实表述波及面（修正第四轮中-1：先前"全部落在改造波及面"为目录级推断、与事实不符）**：多数文件直接波及；已核实的零波及反例包括 QMS 独立存储与服务系列（`redisTelemetryQueueBackend`、`postgresStore`、`qmsLeaseStore`、`alertService` 等，仅测 R6 承诺不改的组件）与旧源读取器测试（`sudoworkIdentitySourceReader.node-test.ts` 等）。**全量纳入是对基线 3.7.2"不收编全部存量测试"字面边界的显式偏离，属范围决策（按 R12 于此声明、随本计划批准一并复核），理由**：(a) 波及子集清单需人工维护、随批次动态增长且易漏判（M-1a 行为断言网恰恰依赖波及文件全覆盖）；(b) 全绿结果同时佐证 R3（波及组件行为不变）与 R6（不动组件行为不变）双向回归；(c) 实测成本 31.9s、现状 0 fail 无存量障碍；(d) 不改动现有 runner 机制（防"借机重整"的意图不受影响）。批次 1–4 的批末门禁以本命令跑各自波及目录。新增测试文件沿用现存 node-test 的 `void it(...)` 模式（豁免 glob `**/*.test.ts` 不匹配 `*.node-test.ts`，node-test 受 `no-floating-promises` 约束，已亲核）。
- **fresh-PG 默认配置可见性测试（修正审核问题 1 的验收）**：空 PG 库完整启动后，组织用户经 `listForUser` 可见 ShareOne（`availability='all'`），与 SQLite 行为一致；v4 存量库升级路径同样验证。
- **PG target-side 迁移测试（修正审核问题 3 的验收）**：三处方言点改写后在真实 PG 上执行 plan/verify（含 outbox_events 表不存在与存在两分支、pinyin 为空与非空的匹配行为），与 SQLite 结果一致。
- **counter 顺序回归测试（修正审核问题 2 的验收）**：模拟旧库（含无 legacy_id 的存量 ledger 行）经领域 schema 升级 + core 初始化后，counter 严格大于全部存量 legacy_id，后续分配不碰撞。
- 所有新 PG 测试进入 runner；环境缺失时 CI 失败而非 skip。
- 门禁：`bun run test`（含 node-test 专用命令）全绿且 PG case 数有输出证据。

**批次 9 — CI 与发布门禁**
- `.github/workflows/build-release.yml`：test job 启 PostgreSQL + 设 `MOSS_PG_TEST_URL`（本地无 PG 仍可跳过，CI 专用必填 gate）；**test job 增加 lint 步骤 `bun run lint`（`package.json:14` 既有正式 script，范围为 src/server+src/channels 全部 .ts——是 test runner 覆盖集合的超集，含 124 个 node-test 与全部生产码；修正审核问题 4——`no-floating-promises` 是本次大规模异步化唯一可靠发现漏写 await 的工具门禁，而 lint workflow 仅在 PR/main 触发、不在 dev push/server tag 上。当前 `be38bec` 已实测 `bun run lint` 全绿，无存量障碍；实施后任何 lint 报错按最小改动修复，不得豁免）**；`build` 增加 `needs: test`（`build-release.yml:65-68` 现状无 needs，已亲核）；build job 在 tarball 生成后新增 PG packaged smoke——归档内 Node + `moss-server.mjs` 双实例（隔离库、独立 runtime 目录、不同主端口/`MOSS_INSTANCE_ID`、`MOSS_AUTH_PROXY_PORT=0`、不同 `MOSS_NEXUS_GRPC_PORT`），从同一空库并发首启（覆盖 migration lock/bootstrap/compatibility records 竞争）→ 双 `/readyz` → 登录 + 一实例写另一实例读 → 停止后再并发重启验证幂等；报告记录双 smoke 状态/后端/实例 ID/关键请求/bundle SHA-256，缺字段视为未执行。
- 保留现有 SQLite packaged smoke 原样。
- 门禁：发布报告双 smoke 通过；任何 skip/缺失阻止构建、上传、发布。

**批次 10 — 全量验收**
- 按第 5 节验收标准逐项取证（见下节）；记录实施前后 `tsc --noEmit` diagnostic 对比；若错误数下降触发 stale-baseline 保护，仅按实测收紧 baseline 并在验收记录说明。

---

## 五、验收标准（全部需实施后证据，不得预宣告）

1. 设置 `MOSS_DATABASE_URL` 后服务稳定启动，无 `undefined.exec/prepare`（对应 R1）。
2. 双实例共享 PG 均就绪、可观察对端写入（R4）。
3. 五领域 + 目标迁移侧 + QMS 目录 + 同步 callback 无 raw `DatabaseSync` PG 运行路径；旧源读取器与 QMS 独立存储保持原实现（R2/R6）。
4. PG v5 空库/v4 库安全升级，幂等、并发执行（R2/R4）。
5. 四类 legacy ID 双实例原子分配不重复；同幂等键竞争无部分提交、无重复外部副作用，保留 `UNKNOWN`/重试契约（R4）。
6. SQLite 全量相关测试通过，外部 API 与配置兼容（R3/R10）；fresh PG 与 SQLite 的默认配置可见性行为一致（ShareOne 对组织用户可见）。
7. 自包含包无需补装 `pg` 完成 PG 启动（R9）。
8. CI PG suite 有实际执行证据；`bun run test` 含 124 个 node-test 专用命令全绿（509+ 用例，较现状基线无新增失败/skip）；test job 含 lint（`no-floating-promises`）；发布报告含通过的 SQLite+PG 双 packaged smoke；任何 skip/缺失阻断发布（R7）。
9. 改动限定在：数据库边界、compatibility 运行时与目标迁移组件、QMS organization-directory 集成边界、SQLite/PG schema、CI/发布 smoke、对应测试；无无关格式化/重命名/功能调整（R5/R6/R10）。

## 六、验证方式（执行命令）

- 每批次：`bun run typecheck`（绿色区间 [107,116]，见第四节注记）+ `bun run lint` + `bun run test`（含 node-test 专用命令）；受影响文件 `npx tsc --noEmit` diagnostic 前后对比。
- 真实 PG：本机 Docker PG 通道（memory 已有可复用通道 `127.0.0.1:54329`，不可用时重建）+ `MOSS_PG_TEST_URL`。
- 发布产物：构建 tarball 后按批次 9 场景运行双实例 smoke（不引用源码 `src/server`）。
- **验收 3 的静态取证规则（修正 L-E，避免验收口径漂移）**：对五领域仓储、compat 适配层、目标迁移侧、QMS 目录链与同步 callback 的生产文件执行模式审计——grep `\.db\.(prepare|exec)\(`、`store\.db`、`runInTransaction\(`，每个命中逐一归类：(a) SQLite-only 白名单（各领域 schema 初始化函数、旧 `*SourceReader.ts`、`AuthCenterDb` 内部实现、SQLite 分支内已局部判空处）= 合规；(b) 其他 = 违规必改。批次 5 类型如实化后，`db: DatabaseSync | undefined` 使 PG 共享路径的 raw 访问成为编译错误——`tsc --noEmit` 清单即机械取证的第二道证据；两项记录进验收报告。

## 七、明确不采用（与 2026-09-18 文档第 6 节一致 + 本次决策）

`if (store.db)` 跳过建表、PG 下禁用 compatibility、本地 SQLite sidecar、PG 专用重复仓储、吞错误继续启动、runtime-deps 加 `pg`、盲换事务保留 `MAX+1`、不处理 BEGIN IMMEDIATE/savepoint 差异、QMS 目录进程内缓存、保留迁移侧同步签名、顺手迁 `MigrationRunStore`/`PostCutoverChangeLog`、通用 exactly-once 框架、session_attempts generation / corp_app_inbound MAX+1 纳入（2026-09-20 决策）。
