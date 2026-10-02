# PostgreSQL/HA 修复实施 — 对抗审核报告

- **审核日期**：2026-09-20
- **修复状态（同日）**：Z-1 / Z-2 / Z-3 已全部修复并验证（见各条目"已修复"标注及第七节修复记录）
- **审核对象**：worktree `dev-parallel`（fix/pg 分支，HEAD=`be38bec`）上的全部未提交实施改动 —— 150 个已跟踪文件（+5138/−3481）+ 6 个新增（`scripts/run-node-tests.js`、`src/server/db/compatibilitySchema.ts`、`src/server/testing/compatibilityRepositories.ts`、`scripts/e2e/packaged-pg-ha-smoke.mjs`、`docs/plans/` 两份计划文档）
- **审核基线**：已批准实施计划 `docs/plans/2026-09-20-pg-ha-compatibility-fix-implementation.md`（含 5 轮计划审核修正）+ `docs/plans/2026-09-18-postgres-ha-compatibility-fix.md`（R1–R12）
- **审核方法**：三路独立对抗性代码审查（①异步化正确性与图省事模式扫描、②schema v5 与双实例并发语义、③测试体系与 CI/发布门禁）+ 审核人本人亲测四大门禁与关键点亲核。代理发现的每项问题均经审核人亲核或交叉确认后收录，未采信未验证结论。

---

## 一、门禁实测结果（审核人本机亲测，2026-09-20）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `bun run typecheck` | ✅ src/server 错误 **112 = baseline 112**（基线由 116 收紧至 112，落在绿色区间，方向合规 R10） | 实测输出 `type errors under src/server/: 112 (baseline 112)` |
| `bun run lint` | ✅ exit 0，零输出 | 实测 |
| `bun run test`（全链） | ✅ exit 0：bun:test 21 文件 + node:test 30 文件（**170/170/0/0**）+ node-test 专用命令 `Running 124/124 explicitly listed node-test files`（**510 tests / 508 pass / 0 fail / 2 skipped**，较实施前基线 509/507/2 净增 1 用例、0 新失败） | 实测完整输出 |
| 真实 PostgreSQL（16.15，`127.0.0.1:54329`） | ✅ `pgBackend.test.ts` **31/31 全绿、0 skipped**（45.9s）——含双 pool bootstrap 收敛、双 pool counter 并发、v5 约束正反例、v1 老库收敛 | 审核人亲设 `MOSS_PG_TEST_URL` 实测 |
| `not run` 排除清单 | ✅ 仅 3 项存量 EXCLUDED（releaseE2eSmoke/runtimeServiceFencing/lbOwnerRoute），与实施前一致，无新增排除 | 实测输出 |
| baseline 完整性 | ✅ `scripts/typecheck-baseline.json` 116→112，只收紧 | git diff 亲核 |

**发布产物级门禁（packaged PG smoke、SQLite+PG 双 smoke 报告）**：workflow 与脚本已实现并通过 `node --check`，但**本地未构建发布 tarball、未实际运行**——运行证据待发布链产生（CI build job）。此为"已实现待取证"，不判缺陷，列入第六节遗留项。

---

## 二、总体结论

**有条件通过。** 核心需求（R1 崩溃链拆除、R2 五领域 PG 读写、R3 SQLite 行为保持、R4 双实例并发语义、R5/R6 规范与聚焦、R8-R10 工程约定）在代码与测试层全部达成且证据充分；未发现高危缺陷。发现 **1 中 + 1 中低 + 6 低 + 4 信息级**问题（第三节），无阻塞项；建议修复两项中/中低问题并清理死 import 后进入提交。

## 三、发现清单

### 中

**Z-1｜test job 缺 PG 必填 gate 与执行证据校验——PG 测试静默 skip 风险**
- 证据：test job 仅以 env 设置 `MOSS_PG_TEST_URL`（`build-release.yml:39-40`），测试侧唯一开关是 `describe(..., { skip: !PG_URL })`（`pgBackend.test.ts:132`）；test job 无 `test -n "$MOSS_PG_TEST_URL"` 兜底步骤，也无"PG suite 实际执行 N case"的证据校验（grep `GITHUB_ACTIONS|process.env.CI` 于测试代码零命中）。build job 有硬 gate（`:253`）、release smoke 有报告存在性检查（`run-server-release-smoke.sh:280`）能拦住发布链，但**若 test job 的 env 未来被误删/改名，整组 PG 测试静默 skip 而 CI 依旧绿**。
- 违反：计划验收 8（"CI PG suite 有实际执行证据"）与批次 8（"PG case 数有输出证据"）。
- 修复建议：test job 增加与 build job `:253` 同款的 `test -n` gate，或在测试内输出 PG case 计数并由 workflow 断言。
- **已修复（2026-09-20）**：test job 在 lint 后、测试前新增步骤 `Require real PostgreSQL for the server suite`（`test -n "$MOSS_PG_TEST_URL"`，含说明注释）；YAML 语法经解析验证通过。

### 中低

**Z-2｜`importConfigItem` 幂等实现不完整**（审核人亲核确认）
- 证据（`src/server/api/compat/sudowork/configService.ts:285-352`）：`previous`（:285）与 `repeated`（:288）是**两次完全相同的查询，中间无任何事务或工作**——`repeated` 双查形同虚设（照搬 `unifiedIdentityService.ts:122-129` 的事务内双查形态但丢失了事务包裹）；执行段（:291-352，create config item → UPDATE → assignments → alias → entries）**无 `db.transaction` 包裹**，中途失败留下部分导入；`:352` `recordCommandResult` 为裸 INSERT，并发重复时撞 `command_executions` 主键抛 500 且不回滚、无胜者结果重读。
- 缓解：`:266-268` 限定该命令仅 `migration`/`replay` 上下文（单运行者），实际并发概率低；`assignNumericAlias` 自身有事务。
- 对照：同文件其它写路径（`associate` :182-190）已在本次改为 `db.transaction`——属实施内不一致，按计划 3.6.4"审核所有 getCommandResult → 执行 → insert result 路径"应覆盖而未完成。
- 修复建议：执行段包入 `this.options.db.transaction`、`repeated` 查询移入事务内或删除、冲突时按既有契约重读胜者结果。
- **已修复（2026-09-20）**：对齐 `unifiedIdentityService.createUser`（`:122-129`）的正确形态——事务外 `previous` 快速返回 + `db.transaction` 内 `repeated` 重查与全部业务写入 + 事务内 `recordCommandResult`（冲突→整事务回滚，对齐既有契约）；新增回归测试「迁移导入中途失败整体回滚，不留部分写入」（不同幂等键导入同一 legacyId 撞 alias 唯一约束 → 断言 config item 零残留 + 幂等记录零写入），`configService.node-test.ts` 7/7 绿；真实 PG `pgBackend.test.ts` 串行复跑 31/31 绿。

### 低

**Z-3｜3 处 `runInTransaction` 死 import（迁移清理遗漏）**
- `src/server/api/compat/sudowork/adminService.ts:8`、`src/server/authCenter/db.ts:10`、`src/server/auth/service.ts:39`——import 无任何使用残留（compat 路径已全部改 `driver.transaction`）。删除即可。
- **已修复（2026-09-20）**：三处 import 已删除（删除前逐文件复核使用计数为零；`auth/service.ts:1801/:1806` 为自有同名方法不受影响）；typecheck 112=112、lint 零错。

**Z-4｜新 PG 测试落点与计划 L-C 承诺偏离（门禁等价）**
- 计划前置小步承诺"新增测试一律 `*.node-test.ts` 进 run-node-tests.js 清单"；实际六类 PG 测试全部扩进既有 `pgBackend.test.ts`（`.test.ts`，走 test-server.js NODE 清单，`scripts/test-server.js:88`）。两段都在 `test` 链上、门禁等价，仅与计划文本不符——记偏离不记缺口。

**Z-5｜`run-server-release-smoke.sh` 不再独立可运行**
- `:280` 起硬性要求 `packaged-pg-ha.json` 预先存在于同目录——本地手跑须先以相同 `--report` 路径执行 `packaged-pg-ha-smoke.mjs`。SQLite smoke 场景保留、入口契约变为"聚合双 smoke"。CI 时序正确（PG smoke 步骤在先）。

**Z-6｜`packaged-pg-ha-smoke.mjs` 三处细节**
- `backend:'postgres'` 为脚本常量而非运行时取证（`:157`）——跨实例读写断言事实上排除 SQLite 回退，影响有限；`freePort()` 申请-释放-绑定存在理论端口竞态（`:34-44`）；`...process.env` 全量透传给被测进程（`:105`，本场景无害）。

**Z-7｜死代码清理之外的文本残留**
- `src/server/identity/organizationIdentityService.ts:118` 附近的 `)!` 断言等为原有断言保留形态（Agent 1 逐对核对新旧行确认**无一处本次新引入**）；`phoneImport.ts:149` 调用的 `authService.runInTransaction` 是自有同名方法（实现已改 driver.transaction，仅名字残留）。

### 信息级（无需修复，供决策知悉）

**Z-8｜`ensureCompatibilityRecords` 失败语义变化**：从构造期 `console.warn` 降级改为启动失败（`auth/service.ts:309` await + 异常阻断启动）。符合计划 2.4"失败必须中止启动"与 R8"禁止吞异常"——**确认为计划要求的有意变化**，发布说明应提及。
**Z-9｜counter 幂等冲突路径烧号形成空洞**（`identityRepository.ts:884` 等）：设计可接受（计划明示"允许 counter 留下空洞"）。
**Z-10｜`ensureCompatibilityRecords` 单事务遍历全部 orgs/users**（`auth/service.ts:645-685`）：大库启动耗时增加，计划接受的启动门禁语义。
**Z-11｜`p5QmsMigrationCli.ts:73` 以只读 `DatabaseSync` 打开 MOSS 库做预检**：预先存在的 SQLite 文件假设（本次仅 hasCode 异步化），PG 部署下该 CLI 预检不可用——范围外既有事实，按 R12 报告。

---

## 四、R1–R10 需求达成核验

| 需求 | 结论 | 关键证据 |
|---|---|---|
| R1 启动崩溃 | ✅ 已拆除 | 六仓储构造全部 `constructor(readonly driver: DbDriver) {}` 且空体（`identityRepository.ts:346` 等）；`AuthService` 全部构造点改 `this.db.driver`（`service.ts:338-584`）；类型如实化 `db: DatabaseSync \| undefined`（`db.ts:140`、`authCenter/db.ts:298`），`as unknown as DatabaseSync` 全仓零残留；真实 PG `createAuthService` 并发收敛测试亲跑通过 |
| R2 完整故障链 | ✅ 代码+测试层达成 | 五领域仓储零 raw `db.prepare/exec` 残留（Agent 1 grep）；compat 全服务零命中；迁移目标侧仅 `migrationRunStore`/`postCutoverChangeLog`（计划明示不动项）；PG v5 含全部 36 类对象（Agent 2 逐一确认，含 `command_executions` 列并集完整性、billing append-only/余额/partial unique 约束、显式命名）；真实 PG 31/31 |
| R3 SQLite 兼容 | ✅ | `repairConfigAvailability` 共享 UPDATE 提取（`configAvailabilitySchema.ts:26-32`）+ 调用时点锁定在领域 schema 与 `ensureDefaultConfigItems` 之后、服务构造之前（`startStandaloneServer.ts:148-155`，两后端同点）；`SqliteDriver.transaction` 升级为 BEGIN IMMEDIATE+嵌套 savepoint（对齐 `runInTransaction` 语义，`beginImmediateWithBoundedWait` 为搬移共享非复制）；针对性测试全绿（`sqliteTransaction.test.ts`、unitOfWork node-test）；510 node-test 全绿佐证行为保持 |
| R4 双实例 | ✅ | 四类 MAX+1 全部替换为 counter 原子 `INSERT..ON CONFLICT..RETURNING`（运行时零残留，仅 schema 回填处允许保留）；回填只前进（`MAX()`/`GREATEST()`）；`advanceCounter` CASE 只前进；auth bootstrap 事务级 advisory lock + 锁内 `isInitialized()` 重查 + 锁后 `loadSecretCache()`（`service.ts:248-307`）；Dify/Billing/Sudorouter 外呼路径均实现"外呼前持久化 + 条件 UPDATE 原子取得 PROCESSING"（`difyRepository.ts:173-180`、`billingRepository.ts:897-910` 等）；双 pool 并发测试亲跑通过 |
| R5/R6 规范聚焦 | ✅ | 复用 `DbDriver` 单一边界、无 PG 专用仓储副本；QMS 独立库/旧源读取器/协议/日志格式未动（Agent 1/2 分别核）；改动面与计划清单吻合 |
| R7 门禁 | ⚠️ 实现完整、产物级证据待发布链 | CI PG service+URL+lint+`needs: test` 全落地；PG packaged smoke 脚本+报告字段断言+release smoke 二次校验齐全；**test job 缺必填 gate（Z-1）；本地未跑产物 smoke** |
| R8 证据优先 | ✅（本报告即对抗证据） | 无吞异常/伪造类型/放宽门禁（Agent 1 扫描零新增）；baseline 收紧 |
| R9 发布依赖 | ✅（静态） | 未向 runtime-deps 加 `pg`（diff 无此文件） |
| R10 工程约定 | ✅ | 无新增 `any`/非空断言/空 catch（Agent 1 逐对核对）；baseline 116→112 收紧；无全局格式化 |

## 五、实施质量正面确认（超出计划的部分）

- `run-node-tests.js` 具备**反漂移双向校验**（清单 vs 磁盘双向 diff，缺一即 exit 1）——防止未来新增 node-test 静默漏跑，超出计划要求。
- PG smoke 报告字段在 workflow（`build-release.yml:260-268`）与 release smoke 脚本（`:289-296`）**双处独立校验**。
- `billingSchema.node-test.ts` 净新增 counter 顺序回归与 PROCESSING 抢占测试；五领域代表性测试 diff 均为纯异步适配，断言零削弱（全局扫描 `.skip`/`.todo` 零变更，assert 行净增 293→332）。
- `pgBackend.test.ts` 六类承诺（Auth 构造/五领域/双 pool counter/ShareOne 可见性/target-side 方言分支/跨 pool 幂等）全部落地且为实值断言。

## 六、遗留与建议

1. ~~修复 Z-1/Z-2/Z-3~~ **已完成（见第七节）**。
2. 发布链首次运行时留存 packaged PG smoke 报告作为 R7/R9 的产物级证据（bundle SHA-256、双实例 ID、跨实例读写）。
3. Z-8 的启动语义变化写入发布说明。
4. 建议提交拆分：按批次语义分组（边界+异步化 / schema+并发 / 测试+CI），便于 review。

---

## 七、修复验证记录（2026-09-20，Z-1/Z-2/Z-3 修复后全套复验）

| 验证项 | 结果 |
|---|---|
| `bun run typecheck` | ✅ 112 = baseline 112 |
| `bun run lint` | ✅ 零错误 |
| `bun run test` 全链 | ✅ exit 0（bun:test + node:test "both runners passed" + node-test 专用命令） |
| `configService.node-test.ts`（含新增回滚回归） | ✅ 7/7（新增「迁移导入中途失败整体回滚，不留部分写入」） |
| `adminService.node-test.ts` + `p2ConfigurationMigrationService.node-test.ts` | ✅ 合计 22/22（含 configService 共跑） |
| 真实 PG `pgBackend.test.ts`（串行单进程） | ✅ 31/31、0 skip |
| workflow YAML | ✅ 解析通过 |

插曲如实记录：一次验证中 PG 套件出现 1 例失败（30/31），系审核人**同时运行**全量测试链与 PG 套件、两个进程打同一 PG 实例造成的环境性竞争；随后串行复跑两次均 31/31。CI 形态（单进程顺序执行）不存在此并发条件。

---

*审核人声明：本报告全部结论基于上述可复现命令与 file:line 证据；三路子审查的每项发现均经审核人亲核或交叉确认；未经检验的推测均未收录。*
