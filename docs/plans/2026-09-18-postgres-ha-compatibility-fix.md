# PostgreSQL 后端启动崩溃与 HA 双活修复实施计划

## 用户明确需求与强制约束（唯一范围基线）

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

其中，HA 外部副作用的验收边界是“两个健康实例并发处理同一幂等键时只能有一个实例获得执行权”；保留并验证现有 `UNKNOWN`/重试契约，但不把本次修复扩大为任意进程崩溃窗口下的通用 exactly-once、租约接管或跨系统补偿框架。当前没有生产装配证据的 `MigrationRunStore`、`PostCutoverChangeLog` 及其本地迁移控制表不因本次修复自动迁入 PostgreSQL。

## 0. 审核证据与结论边界

- 源码事实以当前 `server-v0.1.36`/`be38bec` 工作树及其本地 Git 历史为准；`653ad295` 是 `b9a217b` 的祖先，当前版本包含 `b9a217b`。
- 发布物事实来自用户提供的两个原始归档，并已只读核验外层哈希、内层 server tarball、服务端 bundle 和随包 E2E 报告：
  - `moss-server-release-amd64-20260918.zip`，SHA-256 `E34A251944E52C17053CA0EC1572D3BC1341295B9934F0878A3C61AF2713EA1B`，内含 `moss-server-0.1.36-linux-amd64.tar.gz`。
  - `moss-server-release-amd64-lbha.zip`，SHA-256 `5D11048B6E68103BB3B59F45CCF58D0058D6E31E509A1F90D9EB306BB989971A`，内含 `moss-server-dev-653ad295-linux-amd64.tar.gz`。
- 用户已提供运行事实：相同 PG 使用场景下，0.1.36 包报错，`dev-653ad295` 包不报该错。本次只读审核没有重新启动这两个服务，因此文档将用户观察与本次静态/归档核验明确区分。
- 本文档中的“已确认”只表示已有上述证据支持；修复是否成功只能在实施后由真实 PostgreSQL、双实例和最终发布产物测试得出，不能在实施前预先宣告。

## 1. 已验证事实

### 1.1 直接崩溃链

1. PG 模式由 `openStoreAsync()` 创建 `PgDriver`，随后构造 `DirectConnectStore(':postgresql:', driver)`。
2. 该构造形态有意不创建 SQLite 句柄，当前实现将 `DirectConnectStore.db` 赋为 `undefined`。
3. `AuthCenterDb` 的 shared-store 构造已经具备双形态保护：共享 `store.driver`，且只有 `store.db` 存在时才执行 SQLite 建表。
4. `AuthService` 构造函数没有沿用该边界，而是把 `this.db.db` 传给 `IdentityRepository`。
5. `IdentityRepository` 构造后立即执行 `this.db.exec(...)`，因此 PG 模式稳定触发：

   ```text
   TypeError: Cannot read properties of undefined (reading 'exec')
     at IdentityRepository.initTables (.../identityRepository.ts:183)
     at new IdentityRepository (.../identityRepository.ts:179)
     at new AuthService (.../auth/service.ts:318)
   ```

6. `serverCli.ts` 顶层错误处理只输出 `error.message`，因此正式日志只有一行而没有堆栈。这解释了现场日志表现，但日志格式不属于本次修复范围。
7. 该回归由提交 `b9a217b` 将 Sudowork compatibility 组件接入公共启动链引入；正常包对应的 `653ad295` 不包含该提交，问题包对应版本包含该提交。

### 1.2 修复不能只处理首个 `exec`

- `IdentityRepository` 不只是建表依赖 SQLite，它的全部业务读写均使用同步 `DatabaseSync.prepare/exec`。
- `UnifiedIdentityService` 虽然暴露异步方法，但事务内仍调用上述同步仓储接口；只增加 `if (store.db)` 无法让其在 PG 上工作。
- 启动流程在 Auth 之后还会无条件创建 Catalog、Configuration、System Configuration 和 Dify 服务。它们当前继续接收 `this.db.db`；对这些构造函数传入 PG 形态的 `undefined` 已分别复现 `prepare/exec` 异常。
- Billing 仓储由兼容接口和可选支付路径使用，同样直接依赖同步 SQLite。若不纳入统一数据访问边界，PG 服务即使能够启动，对应接口仍会在请求时失败。
- 因而仅修 `IdentityRepository` 会把故障从第一处移动到下一处，不能满足“PG/HA 可用”。

### 1.3 PG schema 缺口

当前 `src/server/db/pg_schema.ts` 只有 migration v1-v4，没有 `b9a217b` 新增兼容层所需的完整表、列和索引。已确认的缺口按领域为：

- Identity：`organization_profiles`、`user_auth_identities`、`resource_numeric_aliases`、`invitations`、`wallets`、`outbox_events`、`command_executions`、`operation_audit_events`、`integration_connections`。
- Catalog：`catalog_resource_org_assignments`、`resource_external_aliases`，以及 `tenant_assistants`、`tenant_skills` 的 compatibility 列、约束和索引。
- Configuration：`client_delivery_policies`、`config_item_org_assignments`、`platform_integration_settings`，以及 `config_items.availability`。
- Dify：`dify_provider_resources`、`dify_provider_operations`、`dify_migration_checkpoints`。
- Billing：`billing_ledger_entries`、`billing_usage_records`、`billing_packages`、`billing_orders`、`billing_payment_attempts`、`billing_provider_events`、`billing_external_accounts`、`billing_sudorouter_provisioning`、`billing_quota_operations`、`billing_credit_applications`、`billing_activity_records`、`billing_refunds`、`billing_reconciliations`、`billing_audit_events`、`billing_migration_checkpoints`。

`command_executions` 被多个 SQLite schema 初始化器共同使用，PG migration 中只能维护一份包含现有全部列的定义。

### 1.4 测试与发布包事实

- `pgBackend.test.ts` 覆盖 PG driver、schema 和 store 行为，但没有构造 `createAuthService`、`AuthService`、`IdentityRepository` 或完整服务。
- 全仓库不存在同时覆盖真实 PG 与 Auth/Identity compatibility 构造链的测试。
- 现有发布 smoke 使用 SQLite，没有设置 `MOSS_DATABASE_URL`，所以未覆盖本次回归。
- 已只读检查以下两个发布归档：
  - `moss-server-release-amd64-20260918.zip`，SHA-256：`E34A251944E52C17053CA0EC1572D3BC1341295B9934F0878A3C61AF2713EA1B`。
  - `moss-server-release-amd64-lbha.zip`，SHA-256：`5D11048B6E68103BB3B59F45CCF58D0058D6E31E509A1F90D9EB306BB989971A`。
- 0.1.36 与旧包的 `moss-server.mjs` 分别为 26,957,154 和 23,980,762 字节，SHA-256 分别为 `1B6D3749972C61E3CA346CEFFFC406DDA5E7D222583D90C847FE3B4EBB95F5FC` 和 `02DD6180B7425AFEA8BCBBB76009AD34A12B4FE6B090AFD8EB38F2AF3286F0B8`。
- 两个包的应用 `node_modules` 均没有独立 `pg` 目录，但两个 `moss-server.mjs` 均包含 `node_modules/pg-pool/index.js` 和 bundle 内部 `init_esm()` PG 初始化调用；因此归档本身不依赖外置 `pg` 目录。
- 两个 bundle 的 PG store 都将 `DirectConnectStore.db` 设为 `undefined`。只有 0.1.36 bundle 包含 `IdentityRepository`、`organization_profiles`/`catalog_resource_org_assignments` 等 compatibility 代码，以及 `new IdentityRepository(this.db.db)`；旧包的 `AuthService` 不包含该构造链。这与用户观察到的新包报错、旧包不报该错一致。
- 两个包内的发布 E2E 报告均为成功，但报告全部条目中都没有 `MOSS_DATABASE_URL` 或 `postgres`，因此这些成功报告只证明 SQLite 发布路径，不能证明 PG 启动可用。
- 因此本次不能通过向 `runtime-deps.package.json` 添加 `pg` 处理；真正缺陷是发布流程未运行打包产物的 PG 启动测试。

### 1.5 异步边界与 HA 并发缺口

- `IdentityRepository`、`CatalogRepository`、`DifyRepository` 和 `BillingRepository` 不只被在线 compatibility service 使用；`src/server/migration` 下的 identity、catalog、configuration、billing、Dify 目标迁移、验证和 planning projection 也直接调用其同步方法。旧 Sudowork SQLite 源读取器可以保持不变，但目标侧调用链必须随仓储异步化。
- `QmsOrganizationDirectory.getCode/hasCode` 当前是同步接口，`AuthService.createQmsOrganizationDirectory()` 通过 `IdentityRepository` 查询 MOSS 主库，并被 QMS authorization、telemetry 和 crash service 使用。在 PG 下不能继续保留同步数据库读取，也不能以跨实例易过期缓存规避；必须把该目录接口及其异步调用方纳入修改范围，但不修改 QMS 独立数据库/schema。
- `SudoworkIdentityService.nativeActorResolver`、Dify route 的 enterprise alias resolver、Catalog visibility builder 等回调也存在“同步签名内读取 MOSS 主库”的同类问题，必须逐项改为异步并由已有 async handler/service 等待。
- SQLite compatibility 事务使用 `BEGIN IMMEDIATE`，会在写事务开始时串行化；`PgDriver.transaction()` 使用 PostgreSQL 默认 `BEGIN`，即 READ COMMITTED。直接替换事务 API 不会自动保留相同的并发语义。
- 已确认存在四类 `MAX(legacy_id) + 1` 分配：resource numeric alias、operation audit、billing ledger、billing activity。在双实例 READ COMMITTED 下，两个事务可读到相同最大值，必须改为数据库原子分配，不能只依赖普通事务或失败后人工重试。
- compatibility command 的“先查幂等记录、执行业务、最后写幂等结果”依赖唯一约束兜底。PG 双实例下必须验证冲突事务会完整回滚，并在既有契约要求幂等返回时正确读取胜者结果；涉及外部网络调用的流程必须在调用前持久化唯一 operation，并原子选出唯一执行者，防止两个健康实例并发产生重复外部副作用。
- Configuration schema 当前不是完整的集中函数：`client_delivery_policies` 和 `platform_integration_settings` 的 DDL 分别位于两个 repository 构造函数；它们也必须从构造期副作用中提取。

## 2. 设计决策

### 2.1 复用现有 `DbDriver`，不增加第二套数据库抽象

`DbDriver` 已提供两种后端共用的异步 `get/all/run/exec/transaction` 接口，`SqliteDriver` 和 `PgDriver` 已实现相同的调用边界、事务内连接绑定和占位符转换；两者的锁与隔离语义并不相同，差异按第 2.4 节显式处理。此次修复直接复用该边界：

- 运行时仓储只依赖 `DbDriver`，不依赖 `DirectConnectStore` 整体，也不直接依赖 `DatabaseSync`。
- SQLite schema 初始化函数继续接收 `DatabaseSync`，只负责 SQLite DDL 和升级。
- PG schema 只由 `pg_schema.ts` 的版本化 migration 管理。
- 不创建 PG 专用重复仓储，避免两套业务 SQL 和映射逻辑长期分叉。

该设计把“业务读写”“SQLite DDL”“PG DDL”分离在现有职责边界内，既避免额外耦合，也能最小化无关代码变化。

### 2.2 内部接口异步化，外部协议保持不变

- Identity、Catalog、Configuration、Dify、Billing 仓储中访问数据库的方法改为返回 `Promise`。
- 调用这些仓储的 service、compatibility adapter、HTTP handler、MOSS 目标迁移/验证服务和 planning projection 在现有异步调用链中显式 `await`。旧 Sudowork SQLite 源读取器继续使用其私有同步连接，不纳入改造。
- `UnifiedIdentityService`、`OrganizationIdentityService` 删除实际未使用的 `DatabaseSync` 构造参数。
- `QmsOrganizationDirectory`、`nativeActorResolver`、enterprise alias resolver、visibility builder 等当前同步但会读取 MOSS 主库的接口改为返回 `Promise`，由现有 async route/service 等待。QMS 仅调整组织目录集成边界，不修改其独立存储、schema 和调度逻辑。
- 仍需保持同步的内部回调不得读取数据库；不得为了保留同步签名建立可能过期的跨实例内存缓存。
- 对外 HTTP 路径、请求字段、响应字段、状态码、配置文件和环境变量保持不变。

### 2.3 让类型系统暴露非法 SQLite 访问

- 将 `DirectConnectStore.db` 与 `AuthCenterDb.db` 的类型修正为 `DatabaseSync | undefined`，移除把 `undefined` 强制伪装成 `DatabaseSync` 的断言。
- PG/SQLite 共用运行时路径不得使用非空断言访问该字段。
- 明确只支持 SQLite 的代码必须在本地完成 `db` 存在性校验后再使用。

这项调整直接封堵本次回归模式；编译期暴露的使用点仅按其真实职责处理，不借机重构其他逻辑。

### 2.4 保持事务与跨实例一致性

- 把 compatibility 路径中的 `runInTransaction(DatabaseSync, ...)` 替换为现有 `DbDriver.transaction(async () => ...)`。
- 上述替换前必须逐项记录受影响调用链实际使用的 SQLite 事务边界。当前 `runInTransaction()` 提供外层 `BEGIN IMMEDIATE` 和嵌套 savepoint，而 `SqliteDriver.transaction()` 使用普通 `BEGIN TRANSACTION` 且嵌套调用直接加入外层事务，二者不能未经验证就视为等价。仅对已确认依赖这些语义的 compatibility 调用补足既有 `DbDriver` 边界及针对性测试；不得为了图省事全局改变无关调用链的事务策略，也不得在没有实际嵌套路径证据时扩大改造。
- 事务体内所有查询必须通过同一个 driver 发出，以继续使用 `PgDriver` 的 AsyncLocalStorage 专用连接。
- 外部网络调用不放入长事务；继续保持“本地状态准备—外部调用—本地结果落库”的既有阶段划分，只替换各阶段内部的数据库事务实现。
- 增加主库共享表 `compatibility_id_counters(counter_key, current_value)`，替换四类已确认的 `MAX(legacy_id) + 1`。分配使用 SQLite 与 PG 都支持的单条 `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` 原子递增语句；空 counter 从 `2_000_000_000` 开始。显式导入 legacy ID 时，在同一事务内以 `CASE` 表达式把 counter 推进到现值与导入值的较大者，避免后续碰撞；不得使用进程内锁或仅 PG 有效的本地序列替代共享状态。
- 对 command/operation 幂等路径逐项检查双实例竞争：本地纯数据库事务依赖唯一约束、完整回滚和冲突后的胜者结果读取；包含外部调用的流程必须先以唯一 idempotency key 原子建立 operation，并通过带状态前置条件的更新原子取得 `PROCESSING` 执行权，只有受影响行数为 1 的实例可以外呼，其他实例按既有契约重读或等待结果。已有 provider idempotency key 必须继续透传。不得把网络调用放入数据库长事务，也不得在唯一冲突时返回未完成的局部结果；本项只承诺双实例并发去重，不宣称覆盖外呼成功但本地结果落库前进程崩溃的严格 exactly-once。
- `ensureCompatibilityRecords()` 从 fire-and-forget 改为启动阶段显式 `await`，所有 upsert/alias/wallet 操作在同一 driver 事务中完成并能承受两个实例同时执行；失败必须中止启动，禁止留下部分初始化后继续提供服务。

### 2.5 Schema 权威与约束等价

- SQLite 的 schema 权威继续是显式的 SQLite 初始化函数；repository/service 构造函数不得执行 DDL、`PRAGMA` 或旧库列升级。
- PG 的 schema 权威只允许是版本化 migration。v5 不复制 SQLite 专属的 `typeof()`/`json_valid()` 表达式，而以 PG 列类型、`CHECK` 或可验证的等价表达式保留相同业务约束。
- 必须保留 Billing ledger 的 append-only 约束、余额恒等式、状态枚举和部分唯一索引；必须保留 Catalog availability、polymorphic assignment parent 校验和 source resource ID 行为；必须分别保留 Identity、Dify、Configuration 当前实际存在的状态、唯一性、JSON 有效性和引用约束，不向某个领域凭空增加 SQLite 原本没有的约束。
- 所有新 PG constraint、index、trigger function 和 trigger 使用稳定显式名称，供迁移测试和跨方言错误映射验证；不依赖 PostgreSQL 自动生成名称作为业务判断的唯一依据。

### 2.6 测试必须实际执行而不是静默跳过

- 当前 `pgBackend.test.ts` 在未设置 `MOSS_PG_TEST_URL` 时整组 skip，现有 CI 没有提供该变量。实施时必须在 CI 显式启动受支持版本的 PostgreSQL、设置测试 URL，并增加门禁证明 PG suite 实际运行。
- 发布 PG smoke 必须启动最终归档中的 bundle，禁止用源码进程代替；其结果与现有 SQLite packaged smoke 分开记录，任何一项失败都阻止发布物上传。
- 现有 typecheck 是按错误总数 ratchet，而不是零错误门禁；实施前后除运行 `bun run typecheck` 外，还必须比较受影响文件的 TypeScript diagnostic，保证没有用“修掉一个旧错误、增加一个新错误”的总数抵消掩盖问题，也不得提高 `scripts/typecheck-baseline.json`。

## 3. 实施步骤

### 3.1 修正共享数据库边界

1. 修正 `DirectConnectStore.db`、`AuthCenterDb.db` 的可选类型，保留 `driver` 为所有后端必有字段。
2. 将 `AuthService` 创建的 compatibility 仓储改为注入 `this.db.driver`。
3. 将 AuthService 和 Sudowork admin/identity adapter 中直接使用 `authDb.db.prepare(...)` 的运行时查询改用已有 `AuthCenterDb` 方法；确无现成方法时，只增加覆盖该查询的最小 driver-backed 方法。
4. 删除 Unified/Organization Identity 两个 service 未使用的 raw-db 参数。
5. 将 QMS organization directory、identity native actor resolver、Dify enterprise alias resolver 和 Catalog visibility builder 改为异步接口；逐个修改实际调用点并保持 HTTP 返回契约不变。
6. SQLite-only DDL/升级代码在获得已局部判空的 `DatabaseSync` 后执行；共享运行时路径不得以类型断言或非空断言恢复旧的非法访问。

### 3.2 迁移运行时仓储与服务

按依赖顺序处理，保证每一步都可由类型检查指出未等待的调用：

1. Identity Repository → Unified Identity → Organization Identity → Auth compatibility adapter。
2. Catalog Repository → Catalog Service/Upload Service → compatibility catalog/Dify 调用方。
3. Configuration repositories → Config/System Config services →启动配置读取和对应路由。
4. Dify Repository → Administration/Dataset services。
5. Billing Repository → Wallet/Recharge/Refund/Credit/Sudorouter/Reconciliation services → compatibility billing、legacy usage 和 user projection。
6. 目标迁移链：planning projections/target snapshot → Identity/Catalog/Configuration/Billing/Dify migration services → migration coordinator/HTTP 入口。只迁移访问 MOSS 目标领域仓储的调用；旧 Sudowork SQLite source reader 保持同步和原样。`MigrationRunStore`、`PostCutoverChangeLog` 及迁移控制表在当前无生产装配证据的边界下保持不变，不纳入 PG migration v5。
7. QMS 集成链：organization directory → authorization、telemetry、crash service → QMS async routes/runtime wiring；QMS 自身 PostgreSQL store、schema、队列和 scheduler 不变。

具体规则：

- `prepare().get/all/run` 分别替换为 `await driver.get/all/run`。
- `.run(...).changes` 替换为 `await driver.run(...)` 返回的受影响行数。
- `INSERT OR IGNORE` 改为 SQLite 和 PG 均支持的 `INSERT ... ON CONFLICT ... DO NOTHING`。
- 只在确有 SQL 方言差异且无法写成公共语句时检查 `driver.kind`；不得为整个仓储复制 PG 分支。
- JSON、布尔值、时间戳和整数继续沿用当前 store 已采用的跨方言存储约定，不改变 API 数据模型。
- PostgreSQL 未加引号的 camelCase alias 会折叠为小写；运行时查询继续选择 snake_case 并通过既有 mapper 转换，或显式引用稳定 alias，不把 SQLite 结果列大小写行为带入公共 SQL。
- 唯一约束错误统一使用已有 `isUniqueViolation()`/明确 constraint 名处理，不继续新增只识别 SQLite `UNIQUE constraint failed` 文本的分支。

### 3.3 分离 schema 初始化

1. 从 `IdentityRepository` 构造函数提取 SQLite schema 初始化函数，使仓储构造不再产生 DDL 副作用。
2. 保留并复用现有 Catalog、Config Availability、Dify、Billing SQLite schema 函数；从 `ClientPolicyRepository` 和 `PlatformIntegrationSettingsRepository` 构造函数提取其 DDL。所有函数集中在服务 composition root 的 SQLite 初始化阶段调用一次。
3. PG 路径跳过全部 SQLite schema 函数，只依赖 `applyPgSchema()`。
4. 在创建 AuthService 之前完成对应 schema 初始化；完成 compatibility records 后才继续构造后续服务。
5. 增加独立的 SQLite compatibility core schema 初始化函数，负责 `compatibility_id_counters` 及其从现有 alias/audit/billing 数据的回填；composition root 和需要独立构造仓储的测试 fixture 先初始化 core schema，再初始化各领域 schema。重复初始化不得降低 counter 或重写业务数据。

### 3.4 增加 PG migration v5

1. 在 `src/server/db/pg_schema.ts` 增加单一 migration v5，包含第 1.3 节已确认的表、列、索引、外键、唯一约束和 `compatibility_id_counters`。
2. 将 SQLite `INTEGER` 标志位保持为当前 PG 主 schema 已采用的数值约定，避免额外转换分支。
3. Catalog 的 SQLite trigger 在 PG 中使用等价 CHECK、外键、默认/运行时赋值或 PG trigger，覆盖 availability、polymorphic assignment parent 和 source resource ID 行为；只保留现有业务约束，不新增规则。
4. 对 v1-v4 已存在的 `tenant_assistants`、`tenant_skills`、`config_items` 使用幂等 `ADD COLUMN IF NOT EXISTS`、数据回填和索引创建。
5. `command_executions` 合并 Identity/Catalog/Billing 需要的完整列集合，不重复建表。
6. 将 Billing ledger 的禁止 UPDATE/DELETE 触发器、余额 CHECK、状态 CHECK、JSON 有效性、partial unique index，以及 Identity/Configuration/Dify 的对应约束翻译为 PG 等价实现；测试按显式对象名验证。
7. migration 在创建 counter 后按 counter key 从已有 legacy ID 数据取最大值回填；`ON CONFLICT` 更新只能前进不能后退。
8. migration 继续由既有 advisory lock 串行执行，DDL、counter 回填与 `_migrations` 记录保持同一事务。

### 3.5 修正启动顺序

1. `openStoreAsync()` 先完成现有主 store schema；PG 在该函数内完成 v1-v5，SQLite 返回后由 composition root 依次运行 compatibility core 与各领域 SQLite schema。保留现有 `ensureDefaultConfigItems()` 行为，并保证 `config_items` 主表存在后再执行 availability 升级。
2. 创建 `AuthCenterDb`。使用既有 `DbDriver.tryRunExclusive()` 加有界重试取得固定的 Auth bootstrap advisory-lock key；在锁内重新检查 `isInitialized()` 后执行 bootstrap/ensure，并在锁后重新加载 JWT secret/issuer cache。SQLite 单实例路径由同一接口直通。
3. 在同一启动门禁内等待 compatibility records 初始化完成；初始化使用幂等 upsert/`ON CONFLICT DO NOTHING` 与冲突后重读，不使用 check-then-plain-insert。并发 loser 返回既有记录，不能因预期唯一冲突退出。
4. 再依次创建 Catalog、Configuration、System Configuration、Identity、Dify、可选 Billing、QMS runtime 和 HTTP server。Auth Proxy 的既有启动位置不因本修复调整。
5. 任一必要数据库初始化失败均按现有启动错误路径退出；不降级为部分功能可用状态。

### 3.6 修复双实例竞争语义

1. 将 resource alias、operation audit、billing ledger、billing activity 的 legacy ID 生成统一改为 `compatibility_id_counters` 原子分配；删除运行时 `MAX(...) + 1`。
2. numeric alias 分配使用“counter 取号 → `INSERT ... ON CONFLICT DO NOTHING` → 按 `(namespace, resource_id)` 重读”的同一事务流程；两个实例为同一资源并发取到不同号码时，loser 返回 winner 已建立的 alias，允许 counter 留下空洞但不得报错或创建第二映射。
3. 对显式 legacy ID 导入路径同步推进 counter，并测试导入大 ID 后的下一次自动分配。
4. 审核所有 `getCommandResult/getOperationByIdempotencyKey → 执行 → insert result` 路径；对纯数据库事务验证唯一冲突会回滚 loser 的全部写入，并按既有幂等契约返回 winner 结果或确定性冲突。
5. 审核 Dify、Billing、Sudorouter 等外部调用路径；本地 preparation operation 必须在外呼前提交，并以唯一 idempotency key 加条件状态更新原子选出唯一执行者，其他实例只读取/等待既有 operation，不重复外呼。Sudorouter 等已有 provider 幂等键继续透传；对没有 provider 幂等能力的 Dify 路径，本次只验证两个健康实例的并发去重并保留既有 `UNKNOWN` 处理，不引入通用崩溃接管协议。
6. 两实例同时首次启动同一空 PG 时，Auth bootstrap、compatibility records、schema migration 都必须收敛；不得因 check-then-insert 竞争导致任一健康实例退出。只有取得 bootstrap lock 的实例可以返回一次性明文 bootstrap credential，其他实例返回 `created: false`。

### 3.7 接入真实 PG 与发布产物门禁

1. 在 server test CI job 启动 PostgreSQL，设置 `MOSS_PG_TEST_URL`，并让测试输出/断言记录真实执行的 PG case 数；环境缺失时 CI 失败而不是 skip。
2. 保留本地开发时无 PG 可跳过的便利，但 CI 通过专用必填环境变量或显式 gate 禁止误跳过。将本次新增测试以及因仓储异步化、schema 初始化迁移而直接受影响的现有测试明确加入 `scripts/test-server.js` 或等价的专用测试命令；不借机重整、收编全部未纳入现有 runner 的测试。
3. 在当前 workflow 的 `build` job（显示名 `build-amd64`）增加 `needs: test`（`test` 的显示名为 `server-tests`），成功后才构建和上传产物；不能继续让两个 job 并行且让 `release` 只依赖 `build`，否则 PG suite 失败仍可能产生并发布归档。
4. 发布 build job 在最终 server tarball 生成后启动独立 PostgreSQL，使用归档内 Node 和 `moss-server.mjs` 运行两个实例；不得引用源码 `src/server`。
5. PG smoke 使用隔离数据库、两个独立 runtime 目录、不同主服务端口与 `MOSS_INSTANCE_ID`。同一 CI 主机上的两个进程还必须避免辅助监听冲突：分别设置 `MOSS_AUTH_PROXY_PORT=0`，并为 embedded Nexus 设置不同的 `MOSS_NEXUS_GRPC_PORT`，或显式连接同一个测试专用 external Nexus。完成后保留诊断并清理测试数据库/进程；现有 SQLite packaged smoke 原样保留。
6. 记录实施前后的 `tsc --noEmit` diagnostic，并逐项检查所有受影响文件没有新增错误；同时运行现有 typecheck ratchet。不得提高或放宽 baseline；若实际错误数下降并触发 stale-baseline 保护，只允许按实测结果向下收紧 baseline，并在验收记录中说明。

## 4. 测试方案

### 4.1 Schema 测试

- PostgreSQL 空库执行 migration v1-v5，逐项验证第 1.3 节及 counter 表的表、关键列、显式命名索引、CHECK、外键、唯一约束和 trigger。
- 在已标记 v1-v4 的数据库上执行升级，放入覆盖 tenant/config compatibility 列及 legacy ID 的代表数据，验证数据回填、counter 起点和原数据保留。
- 重复执行 `applyPgSchema()`，确认 migration 记录保持 `[1, 2, 3, 4, 5]` 且结构不重复。
- 两个 PG pool 并发执行 migration，确认 advisory lock 下只有一次有效升级，两端最终结构一致。
- 对 Catalog polymorphic parent、Billing ledger append-only/余额恒等式、Dify/Identity/Configuration 状态与 JSON 约束分别执行正反例；不能只查询对象是否存在。

### 4.2 Auth 与启动回归测试

- 使用真实 PG 创建 `DirectConnectStore`，调用 `createAuthService({ db: store, ... })`，确认不访问 `undefined.exec/prepare`。
- 验证 bootstrap admin、默认 organization profile、numeric aliases、wallet 和 password identity 均创建完成。
- 重复启动同一数据库，确认 compatibility records 初始化幂等。
- 用两个独立 PG pool 并发调用完整 Auth bootstrap/compatibility 初始化，确认两端均成功且 profile、alias、wallet、identity 没有重复或缺失。
- 构造完整 standalone service，确认 Catalog、Configuration、System Configuration、Dify 和未启用 Billing 的默认启动链全部完成。
- QMS 启用时，通过异步 organization directory 验证已知/未知 tenant 的 authorization、telemetry 和 crash 路径；测试使用 QMS 自身测试库，不改变其 schema。

### 4.3 各领域代表性 PG 测试

- Identity：组织/用户创建、身份解析、邀请、钱包、命令幂等、审计查询。
- Catalog：agent/skill 创建、可见范围分配、外部 alias 和冲突约束。
- Configuration：availability、组织分配、client policy、platform integration settings。
- Dify：resource、operation、checkpoint 的创建、更新和幂等查询。
- Billing：钱包乐观锁、订单、支付事件、退款、额度申请、对账记录；仅覆盖已有行为，不新增业务场景。
- 每个领域至少包含成功提交、异常回滚和两个 pool 的同幂等键竞争；PG 测试必须验证事务内写入不会部分提交、winner 结果确定且 loser 不留下业务写入。
- 对四类 legacy ID counter 分别进行两个 pool 并发分配，验证不重复；再导入高 legacy ID，验证后续自动分配严格更大。
- 对包含外部 provider 的 Dify/Billing/Sudorouter 流程使用可计数 fake provider，两个健康实例并发同一 idempotency key 时必须只有一个实例取得 `PROCESSING` 执行权，外部调用次数符合现有幂等契约且不得重复扣款、加额或建资源；同时回归既有 `UNKNOWN`/重试行为。本次不新增“外呼成功后执行进程立即崩溃”的通用 exactly-once 验收。
- 运行旧库迁移的 target-side plan/execute/verify 测试，确认异步仓储改造后行为不变；旧 SQLite source reader 使用原连接读取，不迁移到 `DbDriver`。

### 4.4 SQLite 回归测试

- 运行现有 Identity、Catalog、Configuration、Dify、Billing 和 AuthCenter SQLite 测试。
- 确认上述本次直接受影响的测试由 CI 实际收集和执行；测试文件存在但不在 `scripts/test-server.js` 或专用命令中，不计为覆盖。只补入受影响集合，不扩大为全仓测试发现机制改造。
- 将现有 repository/service 测试 fixture 显式包装为 `SqliteDriver`，不得为测试保留生产 raw-DB 仓储重载。
- 补充 SQLite composition-root 初始化测试，确认 schema 只初始化一次、Configuration 两个构造函数不再执行 DDL、旧库列升级与 counter 回填仍有效。
- 验证现有 SQLite 服务启动、登录和 compatibility 代表接口返回不变。
- 运行 migration、QMS organization directory 和所有受异步签名影响的现有测试，确认旧源读取及 QMS 独立存储行为不变。

### 4.5 发布产物与 HA 验收

- 在发布 CI 提供真实 PostgreSQL，使用最终自包含包而不是源码启动服务。
- 不向产物补装 `pg`；若出现模块加载错误，测试直接失败。
- 启动两个共享同一 PG、使用不同 `MOSS_INSTANCE_ID`、不同主服务端口和独立本地运行目录的实例；同机运行时使用独立/临时 Auth Proxy 端口，并为 embedded Nexus 分配不同端口或使用同一个测试专用 external Nexus。
- 两个实例均须通过 `/readyz`，并完成登录、一次 Identity 查询及一次 compatibility 写入后由另一实例读取。
- 两个实例必须从同一空库并发首次启动，以同时覆盖 migration lock、Auth bootstrap 与 compatibility records 竞争；随后停止并再次并发启动，验证升级后的幂等路径。
- 发布报告分别记录 SQLite smoke 与 PG smoke 状态、实际数据库后端、两个实例 ID、关键请求结果和 bundle SHA-256；PG 报告缺少上述字段视为测试未执行。
- 保留现有 SQLite packaged smoke；PG smoke 是新增后端覆盖，不替代 SQLite 覆盖。

## 5. 验收标准

- 问题版本相同配置下，设置 `MOSS_DATABASE_URL` 后服务稳定启动，不再出现 `undefined.exec/prepare`。
- 两个实例共享 PG 时均能就绪并观察到对端写入，满足 HA 共享数据要求。
- Identity、Catalog、Configuration、Dify 和启用后的 Billing 不存在 raw `DatabaseSync` PG 运行路径。
- 旧库迁移的 MOSS 目标侧、QMS organization directory 和所有同步 callback 中不存在 raw `DatabaseSync` PG 运行路径；旧 SQLite source reader 与 QMS 独立存储保持原实现。
- PG schema migration 可从空库和 v1-v4 数据库安全升级，并能幂等、并发执行。
- 四类 legacy ID 在双实例并发下原子分配且不重复；两个健康实例的同幂等键竞争不会产生部分提交或重复外部副作用，并保持既有 `UNKNOWN`/重试契约。
- SQLite 全量相关测试通过，既有外部 API 和配置兼容。
- 自包含包无需额外安装 `pg` 即可完成 PG 启动。
- CI 中 PG suite 有明确的实际执行证据，受影响的 SQLite 回归测试确实被 runner 收集，且发布构建显式依赖这些测试成功；最终发布报告同时包含通过的 SQLite 与 PG packaged smoke，任何 skip 或缺失均阻止构建、上传和发布。
- 代码改动限定在数据库边界、上述 compatibility 运行时与目标迁移组件、QMS organization-directory 集成边界、SQLite/PG schema、CI/发布 smoke 和对应测试；无无关格式化、重命名或功能调整。

## 6. 明确不采用的方案

- 仅以 `if (store.db)` 跳过 Identity 建表：只能消除首个异常，不能执行 PG 业务读写。
- PG 下禁用 compatibility 接口：不满足功能完整性和 HA 可用要求。
- 为 compatibility 维护本地 SQLite sidecar：多实例数据不共享，破坏 HA 一致性。
- 新建一套 PG 专用仓储：重复业务逻辑，增加长期分叉和维护成本。
- 吞掉初始化错误继续启动：会产生部分初始化状态，无法作为可靠服务节点。
- 向 runtime dependencies 重复添加 `pg`：两个实际产物均已验证内联，不能解决本次崩溃。
- 直接把 `runInTransaction` 替换为 PG READ COMMITTED 事务而保留 `MAX(id)+1`：不能保留 SQLite `BEGIN IMMEDIATE` 下的分配串行性，双实例会竞争。
- 直接把 `runInTransaction` 替换为当前 `DbDriver.transaction()` 而不处理 SQLite `BEGIN IMMEDIATE` 与嵌套 savepoint 差异：会违反 SQLite 行为保持要求。
- 为 QMS organization directory 建立进程内长期缓存以保留同步接口：跨实例写入不会及时可见，不符合 HA 共享数据要求。
- 只迁移在线 HTTP 调用而保留 target migration/planning projection 的同步仓储签名：同一 repository 无法同时保持真实 PG 异步访问和旧同步调用契约。
- 在没有生产装配证据时顺手把 `MigrationRunStore`、`PostCutoverChangeLog` 和全部迁移控制表迁入 PG：超出本次 MOSS 目标仓储兼容范围。
- 为覆盖任意外呼崩溃窗口而新建通用分布式 lease/fencing/补偿框架：超出本次“双健康实例同幂等键并发去重”的验收边界。

## 7. 实施前复核结论

- **覆盖结论：**本方案覆盖当前代码与两个发布归档中已确认的崩溃链、后续 raw SQLite 访问、PG schema 缺口、同步 callback、target migration 波及范围和双实例并发差异。是否真正解决只能以第 4、5 节实施后证据为准。
- **高内聚：**业务仓储统一负责查询和映射；SQLite/PG DDL分别留在各自 schema 层；composition root 只负责初始化顺序。
- **低耦合：**仓储依赖既有最小 `DbDriver` 接口，不依赖整个 store，也不引入 PG 专用重复实现；共享 counter 使用普通跨方言 SQL 和主库表，不引入进程本地协调器。
- **最小修改：**只异步化实际访问 MOSS 主数据库的 compatibility、目标迁移和 QMS 组织目录调用链；旧 SQLite 源读取器、QMS 独立库/schema、日志格式和外部协议不动。
- **聚焦需求：**所有任务均直接对应 PG 启动、compatibility 完整可用、HA 并发一致性或防止发布回归，没有附带功能开发。
