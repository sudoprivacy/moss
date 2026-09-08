# Sudowork 到 Moss P8 数据迁移、切换与回滚实施计划

> **供执行代理使用：** 必须逐任务使用 `superpowers:test-driven-development`；在当前隔离工作树内使用 `superpowers:executing-plans` 顺序执行。本文使用复选框记录进度。用户明确禁止提交、暂存和推送，因此不包含 Git 提交步骤。

**目标：** 提供可随 Moss 发布的 Node.js 迁移程序，安全、可恢复地把冻结 Sudowork Server 数据导入 Moss 统一领域模型，并生成可审核的迁移、校验、切换和回滚证据。

**架构：** CLI 只负责模式选择、依赖装配和退出码；`MigrationRunStore` 持久化批次、阶段、映射、冲突和报告；`SudoworkMigrationCoordinator` 按固定依赖顺序调用统一领域 Import Command。源端只读，目标写入均使用 `migrationCommandContext`，外部副作用一律抑制并进入报告；跨 SQLite、Redis、Nexus、文件和 PostgreSQL/TimescaleDB 的一致性依靠源指纹、checkpoint 和对账，不伪装成全局事务。

**技术栈：** TypeScript、Node.js 24、`node:sqlite`、PostgreSQL/TimescaleDB、Redis、Nexus、Bun 构建、Node test runner。

**规格：** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md` §11-§15

## 全局约束

- 不修改 `/Users/yobach/VSCodeProject/sudowork` 和 `/Users/yobach/VSCodeProject/sudowork-server`；源仓库和源数据均只读。
- 迁移生产入口固定为 `node bin/migrate-sudowork.mjs`，Bun 仅用于构建和测试。
- `--dry-run`、`--verify` 不写目标业务数据；`--execute` 创建唯一持久化批次；`--resume` 必须显式复用已有批次。
- CLI 内部创建 `origin=migration`、`effect_policy=suppress_external` 上下文，外部输入不能覆盖。
- 所有目标业务写入复用 Moss Repository 和 Import Command；禁止复制旧 SQL 到目标库或从兼容路由写库。
- SQLite UnitOfWork 回调内禁止 `await`；跨存储一致性通过 checkpoint、补偿状态和校验报告保证。
- 未解决身份、组织、财务或源指纹冲突必须阻断 execute/resume，禁止静默跳过。
- 客户端本地 Session、本地 Cron 和本地 Channel 不属于服务端迁移输入。
- 真实发布客户端、Fuiou 验签样本和真实 PostgreSQL/Redis/Nexus/TimescaleDB 尚未验证，始终保留为生产切流硬门禁。

---

### Task 1：迁移批次、阶段和审计存储

**文件：**
- 新建：`src/server/migration/migrationRunStore.ts`
- 新建：`src/server/migration/migrationRunStore.node-test.ts`

**接口：**

```ts
type MigrationMode = 'execute' | 'resume'
type MigrationRunStatus = 'planned' | 'running' | 'blocked' | 'failed' | 'verified'
type MigrationPhaseStatus = 'pending' | 'running' | 'complete' | 'failed'

class MigrationRunStore {
  createRun(input: { sourceFingerprint: string; sourceMetadata: object }): MigrationRun
  requireResumableRun(runId: string, sourceFingerprint: string): MigrationRun
  beginPhase(runId: string, phase: MigrationPhaseName): MigrationPhaseCheckpoint
  completePhase(runId: string, phase: MigrationPhaseName, result: object): void
  failPhase(runId: string, phase: MigrationPhaseName, error: MigrationIssue): void
  putMapping(input: StableMigrationMapping): void
  recordIssue(runId: string, issue: MigrationIssue): void
  recordSuppressedEffect(runId: string, effect: SuppressedMigrationEffect): void
  saveReport(runId: string, kind: 'migration' | 'verification', sha256: string, json: string, markdown: string): void
}
```

- [x] 写失败测试：批次 ID 唯一、状态转换合法、阶段顺序稳定、同源同键映射幂等、不同目标冲突、报告不可覆盖。
- [x] 写失败测试：resume 的批次不存在、已 verified、源指纹变化时拒绝；failed/running 批次可从未完成阶段恢复。
- [x] 实现 SQLite schema 和同步 Repository；所有多表状态变化使用现有 `runInTransaction`，事务回调内不执行异步操作。
- [x] 运行 `node --test --import tsx src/server/migration/migrationRunStore.node-test.ts`，要求全部通过。

验证记录（2026-09-08）：先确认模块缺失红灯；实现后聚焦 6/6，通过与 `sqliteUnitOfWork.node-test.ts` 联跑 11/11。

### Task 2：冻结源快照与统一指纹

**文件：**
- 新建：`src/server/migration/sudoworkSourceSnapshot.ts`
- 新建：`src/server/migration/sudoworkSourceSnapshot.node-test.ts`
- 修改：`src/server/migration/sudoworkP2SourceReader.ts`
- 修改：`src/server/migration/sudoworkP3SourceReader.ts`
- 修改：`src/server/migration/sudoworkP4SourceReader.ts`
- 修改：`src/server/migration/sudoworkP5QmsSourceReader.ts`

**接口：**

```ts
interface SudoworkSourceSnapshot {
  fingerprint: string
  capturedAt: string
  sqlite: SourceComponentSnapshot
  redis: SourceComponentSnapshot
  qms: SourceComponentSnapshot
  files: SourceComponentSnapshot
  includedDomains: MigrationPhaseName[]
  excludedLocalData: ['sessions', 'client_cron', 'client_channels']
}

interface SudoworkSourceSnapshotReader {
  capture(): Promise<SudoworkSourceSnapshot>
  assertUnchanged(expectedFingerprint: string): Promise<void>
}
```

- [x] 写失败测试：相同内容不同遍历顺序产生相同 SHA-256；任一 SQLite 行、Redis Token、QMS 表或文件 checksum 改变都会改变总指纹。
- [x] 写失败测试：只读连接、缺失必需组件和非法符号链接均阻断预检；文件读取前后状态不一致时实现会以 `SOURCE_MUTATED_DURING_READ` 阻断。
- [x] 提供统一组件 checksum 协议和文件/配置显式白名单读取器；固定排除客户端本地 Session、Cron 和 Channel。真实 Redis/QMS 连接装配归入 Task 6，不能视为已完成生产验证。
- [x] 运行聚焦 Node 测试及既有 P2-P5 SourceReader 回归。

验证记录（2026-09-08）：先确认模块缺失红灯；实现后聚焦 5/5，与 P2-P5 既有 SourceReader 联跑 13/13。

### Task 3：Organization 与 User 确定性合并

**文件：**
- 新建：`src/server/migration/identityMergePlanner.ts`
- 新建：`src/server/migration/identityMergePlanner.node-test.ts`
- 新建：`src/server/migration/identityMigrationService.ts`
- 新建：`src/server/migration/identityMigrationService.node-test.ts`

**接口：**

```ts
class IdentityMergePlanner {
  plan(snapshot: LegacyIdentitySnapshot, resolutions: ManualResolution[]): IdentityMergePlan
}

class IdentityMigrationService {
  plan(): IdentityMergePlan
  execute(plan: IdentityMergePlan, context: CommandContext): IdentityMigrationReport
  verify(plan: IdentityMergePlan): IdentityMigrationVerification
}
```

- [x] 写失败测试：Organization 只按显式映射、唯一已验证 code 匹配；User 只按显式 Provider 映射、唯一已验证手机号、唯一已验证邮箱顺序匹配。
- [x] 写失败测试：名称/昵称不得参与匹配；重复手机/邮箱、跨组织 Provider、占用的数字别名、人工映射目标变化均生成阻断冲突。
- [x] 通过统一 Identity Service 创建或复用 Organization/User/Profile/Auth/Role/Wallet 和永久数字别名；保留 bcrypt 摘要，不触发欢迎通知。
- [x] 验证重复 execute 不新增实体，且 suppressed Outbox 记录与报告逐项一致、pending 数为零。

验证记录（2026-09-08）：规划器先以模块缺失红灯，随后 6/6 通过；统一身份导入服务 3/3 通过；与现有统一身份/组织服务联跑 20/20。已有不同数字别名的 Moss 实体在 dry-run 阶段阻断，不自动换号。

### Task 4：固定顺序阶段协调、checkpoint 与 resume

**文件：**
- 新建：`src/server/migration/sudoworkMigrationCoordinator.ts`
- 新建：`src/server/migration/sudoworkMigrationCoordinator.node-test.ts`
- 新建：`src/server/migration/migrationPhaseRegistry.ts`
- 修改：`src/server/migration/p2MigrationCoordinator.ts`
- 修改：`src/server/migration/p3BillingMigrationService.ts`
- 修改：`src/server/migration/p4DifyMigrationService.ts`
- 修改：`src/server/migration/p5QmsMigrationService.ts`

**接口：**

```ts
interface MigrationPhase {
  readonly name: MigrationPhaseName
  plan(context: MigrationPlanningContext): Promise<MigrationPhasePlan>
  execute(context: MigrationExecutionContext): Promise<MigrationPhaseResult>
  verify(context: MigrationVerificationContext): Promise<MigrationPhaseVerification>
}

class SudoworkMigrationCoordinator {
  dryRun(): Promise<MigrationPlanReport>
  execute(): Promise<MigrationExecutionReport>
  resume(runId: string): Promise<MigrationExecutionReport>
  verify(runId: string): Promise<MigrationVerificationReport>
}
```

- [x] 写失败测试：十个阶段严格按规格顺序；任一 plan blocked 时 execute 零写入；失败阶段之后不得开始。
- [x] 写失败测试：完成阶段 resume 跳过，失败阶段重试；每阶段前后检查源指纹；同一 run 的幂等键稳定。
- [x] 用 Registry 包装身份、邀请/审计、P2 Catalog/配置/文件、P4 Dify、P3 Billing、企业自动化、P5 QMS、JWT/Redis/handoff 的 Import Service；缺失领域必须返回阻断项，不能伪装为空成功。
- [x] 验证每阶段使用 `migrationCommandContext(runId, stableKey)`，外部 Adapter 调用为零，迁移来源 pending Outbox 增量为零。

阶段记录（2026-09-08）：固定十阶段 Registry 已接入真实统一领域服务；多组织端到端夹具覆盖全量预检、失败停止、checkpoint/resume、源指纹复查、重复执行和 `migration` Outbox `pending=0`。恢复测试额外发现并修复了仅邮箱用户在重跑时的确定性 ID 冲突，永久数字别名现在作为恢复标识优先复用。

### Task 5：统一校验与中英文不可变报告

**文件：**
- 新建：`src/server/migration/migrationVerifier.ts`
- 新建：`src/server/migration/migrationVerifier.node-test.ts`
- 新建：`src/server/migration/migrationReportWriter.ts`
- 新建：`src/server/migration/migrationReportWriter.node-test.ts`

**接口：**

```ts
class MigrationVerifier {
  verify(runId: string, snapshot: SudoworkSourceSnapshot): Promise<MigrationVerificationReport>
}

class MigrationReportWriter {
  write(report: MigrationReport, outputDir: string): Promise<{ jsonPath: string; markdownPath: string; sha256: string }>
}
```

- [x] 建立强制完整的领域校验清单，覆盖组织/用户映射、数字别名、引用、财务、Catalog、配置/Nexus、文件、QMS 和登录抽样；缺项或乱序直接拒绝启动。
- [x] 写失败测试：任何 mismatch 使 verify 非零；迁移来源可投递副作用大于零时阻断。
- [x] 报告同时生成规范 JSON 与中文 Markdown；内容含批次、源指纹、计数、冲突、副作用抑制和生产门禁。
- [x] 以内容 SHA-256 命名报告并在 `MigrationRunStore` 中只追加登记，已有报告不得覆盖。

验证记录（2026-09-08）：先确认两个实现模块缺失红灯；校验器与报告写入器聚焦测试通过。十项最终门禁已通过 `createPhaseBackedMigrationChecks` 连接真实阶段查询，协调器只有在阶段校验和最终门禁同时匹配时才标记批次 `verified`；JSON/中文报告保留阶段与最终门禁问题。真实环境结果不得由 fixture 代替。

### Task 6：Node CLI、构建产物与退出码

**文件：**
- 新建：`src/server/migrationCli.ts`
- 新建：`src/server/migrationCli.node-test.ts`
- 修改：`scripts/build.js`
- 修改：`package.json`

**接口：**

```text
node bin/migrate-sudowork.mjs --config <absolute-path> --dry-run
node bin/migrate-sudowork.mjs --config <absolute-path> --execute
node bin/migrate-sudowork.mjs --config <absolute-path> --resume <migration_run_id>
node bin/migrate-sudowork.mjs --config <absolute-path> --verify <migration_run_id>
```

- [x] 写失败测试：四种模式互斥；生产配置路径必须绝对；resume/verify 必须有批次；未知参数、缺密钥、可写源目录和开发默认秘密使用明确非零退出码。
- [x] 依赖装配只从配置/环境读取连接信息，日志必须脱敏；CLI 不接受 source/effect policy 覆盖参数。
- [x] 修改构建脚本生成 `bin/migrate-sudowork.mjs`；用 `node` 对产物执行 help 冒烟，四种模式、blocked、resume 和 verify 由 CLI 注入式测试与全链路 fixture 覆盖。
- [x] 运行 CLI 聚焦测试及 `bun run build`，确认产物不包含构建机绝对路径。

验证记录（2026-09-08）：配置会在建立网络连接前拒绝源/目标同库、JWT 密钥不一致、目标路径落入冻结源目录、非法人工映射和开发默认秘密；正式构建与产物 help 通过，构建机绝对路径扫描为空。真实 Redis/QMS/Nexus 组合的二进制四模式演练仍属于生产副本门禁。

### Task 7：切换后变更日志、replay 与受控 redelivery

**文件：**
- 新建：`src/server/migration/postCutoverChangeLog.ts`
- 新建：`src/server/migration/postCutoverChangeLog.node-test.ts`
- 新建：`src/server/migration/replayService.ts`
- 新建：`src/server/migration/replayService.node-test.ts`

**接口：**

```ts
class ReplayService {
  replay(change: PostCutoverChange, approval: ReplayApproval): Promise<ReplayResult>
  redeliver(effect: SuppressedMigrationEffect, approval: RedeliveryApproval): Promise<RedeliveryResult>
}
```

- [x] 写失败测试：replay 使用稳定 original event ID 和 `suppress_external`，重复执行不改变内部状态、不调用 Adapter。
- [x] 写失败测试：redelivery 缺审批、目标不在白名单、幂等键变化或已成功投递时拒绝；同一外部动作最多成功一次。
- [x] 实现切换后命令只追加记录及敏感字段拒绝策略；生产命令总线接入该记录器归入切流部署配置。
- [x] 实现 replay/redelivery 审批、审计与状态机，代码边界禁止普通 replay 访问外部 Adapter。

验证记录（2026-09-08）：先确认实现模块缺失红灯；变更日志和 replay/redelivery 聚焦测试 5/5 通过。

### Task 8：全链路 fixture、演练手册与 P8 门禁

**文件：**
- 新建：`src/server/migration/sudoworkMigrationE2e.node-test.ts`
- 新建：`docs/superpowers/runbooks/2026-09-08-sudowork-moss-migration-cutover.md`
- 修改：`docs/superpowers/plans/2026-09-07-sudowork-moss-consolidation-roadmap.md`

- [x] 构造脱敏多组织 fixture，完整执行 dry-run → execute 中断 → resume → verify → 重复 execute 安全性，并验证统一身份、邀请、钱包和报告构造。
- [x] 验证本地 Session/Cron/Channel 未读取，Moss 企业 Cron/Trigger/Channel、云端 Session 和兼容登录在迁移后正常。
- [x] 编写中文运行手册：七天前演练、TTL、备份恢复、维护模式、停任务、财务静默、迁移、校验、切流、单实例后台任务、观察指标和回滚决策点。
- [x] 明确 Moss 开放写入前后的两种回滚流程，以及 replay 默认抑制、redelivery 审批白名单要求。
- [x] 运行 P8 聚焦测试、全部 Node/Bun 测试、正式构建和 `git diff --check`。
- [x] 仅将本地 fixture 门禁标记完成；两次代表性生产副本迁移、真实基础设施、客户端二进制矩阵、Fuiou 与回滚演练保持未完成，禁止据此生产切流。

验证记录（2026-09-08）：迁移聚焦测试 112/112；完整 Node 测试 540 项中 538 通过、2 项真实基础设施门禁跳过；完整 Bun 测试 392/392；正式构建、CLI 产物 help、构建机绝对路径扫描、216 路由实现检查、Hub 8/Billing 28/Dify 45/QMS 72 契约检查和 `git diff --check` 均通过。客户端策略仍为 `candidate`。

## 自检结论

- 规格 §11 的四种命令、只读源、Import Command、批次/checkpoint/resume、冲突、双格式报告和副作用抑制分别由 Task 1-6 覆盖。
- §11.2 的身份匹配优先级和禁止名称匹配由 Task 3 覆盖；§11.3 十阶段顺序由 Task 4 固化。
- §11.4 的数据校验由 Task 5 覆盖；§13 的 migration/replay/redelivery 保护由 Task 3、4、7 覆盖。
- §14 的维护窗口、开放写入前后回滚和观察期由 Task 7-8 覆盖。
- 真实生产副本、真实基础设施和正式客户端矩阵不能由本地代码替代，明确保留为外部门禁，不存在将模拟结果冒充生产验收的步骤。
