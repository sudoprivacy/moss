# Sudowork Billing 整合到 Moss 实施计划

> **供自动化开发执行者使用：** 必须逐任务使用 `superpowers:executing-plans` 与 `superpowers:test-driven-development`，每个行为先见到预期失败，再写最小实现并完成局部回归。本文使用复选框跟踪进度。

**目标：** 在 Moss 中建立唯一的统一 Billing 领域，并通过 Sudowork 兼容 Adapter 原样承载旧计费接口，使历史用户和 Moss 新用户共享钱包、流水、授信、充值、支付、退款及对账能力。

**架构：** `src/server/billing/` 拥有唯一财务模型和业务命令；现有 `wallets` 是账户余额快照，`billing_ledger_entries` 是可重建余额的只追加事实。Fuiou 与 Sudorouter 调用只能发生在 SQLite 事务之外，使用持久化操作状态、稳定幂等键和 Outbox/Inbox 完成可恢复编排；`src/server/api/compat/sudowork/` 只负责旧协议解析和序列化。

**技术栈：** TypeScript、Node.js、`node:sqlite` `DatabaseSync`、Hono、Node test runner、Moss `runInTransaction`、Moss `CommandContext`。

**设计依据：** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md`

## 全局约束

- 本阶段不修改 `/Users/yobach/VSCodeProject/sudowork` 和 `/Users/yobach/VSCodeProject/sudowork-server`，两者仅作只读协议依据。
- 不复制旧服务业务实现；Moss 原生接口与 Sudowork 兼容接口必须调用同一个 Billing 服务。
- 不提交、不暂存、不推送任何文件；用户明确要求所有改动留在工作树。
- 所有积分、额度和金额使用整数最小单位存储：积分以百分之一积分、额度以 provider quota unit、人民币以分、美元以微美元保存；Repository/HTTP 边界按旧协议转换为 number。
- `wallets.balance_units` 是余额快照；`billing_ledger_entries` 是唯一可重建余额的只追加事实，已入账流水禁止 UPDATE/DELETE。
- 每个余额命令必须在同一个 SQLite 事务中写入钱包版本、流水、审计和必要的内部 Outbox；事务回调内禁止 `await`、Promise、网络、文件 I/O 和定时器。
- UnitOfWork 只覆盖主 SQLite；Fuiou、Sudorouter、Redis 和其他外部存储通过状态机、Inbox/Outbox、幂等重试与对账保持一致。
- `migration` 和 `replay` 默认抑制外部副作用；迁移仍写账本、审计和 `suppressed` 留痕，不产生可投递的外部 Outbox。
- 旧数字 ID 与订单号是永久外部别名；新 Moss 用户和新订单也必须可立即通过兼容接口访问。
- 兼容范围实际为 28 个计费 endpoint，其中包含此前遗漏的 `POST /api/v1/admin/users/:id/sync-quota`。
- 每项任务完成后先运行该任务局部测试，通过后才能进入下一项；P3 最终门禁要求并发、幂等、验签、对账和 28 路由契约全部通过。

---

## 文件职责

- `src/server/billing/types.ts`：领域类型、状态枚举、端口和错误码，不含 SQL。
- `src/server/billing/billingSchema.ts`：幂等初始化 Billing 表、索引和数据库约束。
- `src/server/billing/billingRepository.ts`：唯一 Billing SQL 入口；提供同步、事务友好的细粒度读写。
- `src/server/billing/walletService.ts`：余额命令、只追加流水、版本并发控制和余额重建。
- `src/server/billing/rechargeService.ts`：套餐、订单、支付状态机、回调入账、取消和列表查询。
- `src/server/billing/creditApplicationService.ts`：授信申请、组织权限、审批、拒绝和重试状态机。
- `src/server/billing/refundService.ts`：退款计算、退款编排、扣回积分和退款记录。
- `src/server/billing/reconciliationService.ts`：钱包/流水、订单/支付、退款和额度差异检测。
- `src/server/billing/fuiouAdapter.ts`：Fuiou 请求签名、响应解密、回调验签及网络端口实现。
- `src/server/billing/sudorouterAdapter.ts`：积分/额度换算及 Sudorouter 网络端口实现。
- `src/server/billing/billingCoordinator.ts`：事务外 Saga 编排；外部调用前后均有持久化状态。
- `src/server/billing/billingOutboxWorker.ts`：领取、执行、重试内部一致性事件，不处理 `suppressed`。
- `src/server/api/compat/sudowork/billingService.ts`：统一结果到旧 DTO 的转换和旧授权规则。
- `src/server/api/compat/sudowork/app.ts`：注册 28 条旧路由，仅解析、调用 Port、序列化。
- `src/server/migration/p3BillingMigrationService.ts`：旧财务数据预检、导入、checkpoint 和零差异报告。
- `scripts/contracts/extract-sudowork-billing-api.ts`：从冻结提交生成 P3 请求/响应契约清单。

---

### 任务 1：冻结 P3 接口与旧状态定义

**文件：**
- 新建：`scripts/contracts/extract-sudowork-billing-api.ts`
- 新建：`scripts/contracts/extract-sudowork-billing-api.test.ts`
- 生成：`contracts/sudowork/billing-api.json`
- 修改：`package.json`

**接口：**
- 输入：`contracts/sudowork/routes.json`、冻结的 sudowork-server 提交和旧 route/service 源码。
- 输出：`extractBillingContract(sourceRoot, commit): BillingContract`，清单固定 method、path、认证、请求字段、查询字段、状态码、响应外层、错误文案和副作用类型。

- [x] **步骤 1：写失败测试**

```ts
test('冻结全部 28 条 Billing 路由并包含 sync-quota', () => {
  const contract = extractBillingContract(sourceRoot, frozenCommit)
  assert.equal(contract.routes.length, 28)
  assert(contract.routes.some(route => route.path === '/api/v1/admin/users/:id/sync-quota'))
})
```

- [x] **步骤 2：运行并确认因提取器不存在而失败**

运行：`bun test scripts/contracts/extract-sudowork-billing-api.test.ts`

- [x] **步骤 3：实现 AST/受控源码提取和 `--check`**

提取器必须拒绝提交漂移、重复路由、缺失响应 envelope 和无法分类的外部副作用；不得仅用路由数量代替契约。

- [x] **步骤 4：生成清单并验证通过**

运行：`bun run contracts:billing -- --source /Users/yobach/VSCodeProject/sudowork-server`

运行：`bun run contracts:billing -- --source /Users/yobach/VSCodeProject/sudowork-server --check`

---

### 任务 2：建立整数财务 Schema 与数据库约束

**文件：**
- 新建：`src/server/billing/types.ts`
- 新建：`src/server/billing/billingSchema.ts`
- 新建：`src/server/billing/billingSchema.node-test.ts`
- 修改：`src/server/db.ts`

**接口：**
- 输出：`ensureBillingSchema(db: DatabaseSync): void`。
- 表：`billing_ledger_entries`、`billing_packages`、`billing_orders`、`billing_payment_attempts`、`billing_provider_events`、`billing_external_accounts`、`billing_quota_operations`、`billing_credit_applications`、`billing_activity_records`、`billing_refunds`、`billing_reconciliations`、`billing_audit_events`、`billing_migration_checkpoints`。`billing_activity_records` 是本地/云端共用的充值活动投影，不是旧服务复制表。

- [x] **步骤 1：写失败测试**

```ts
test('Schema 可重复初始化并强制账本幂等和有效状态', () => {
  ensureBillingSchema(db)
  ensureBillingSchema(db)
  insertLedger({ idempotencyKey: 'same', deltaUnits: 100 })
  assert.throws(() => insertLedger({ idempotencyKey: 'same', deltaUnits: 100 }))
  assert.throws(() => insertOrder({ status: 'NOT_A_STATE' }))
})
```

- [x] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/billing/billingSchema.node-test.ts`

- [x] **步骤 3：实现 Schema**

状态约束至少覆盖订单 `PENDING/PAYING/SUCCESS/FAILED/CANCELLED/REFUNDED/PARTIAL_REFUNDED`、外部操作 `PENDING/PROCESSING/SUCCEEDED/FAILED/UNKNOWN/SUPPRESSED`、申请 `PENDING/PROCESSING/APPROVED/REJECTED/SYNC_FAILED/SYNC_UNKNOWN`；订单号、退款号、Provider event、流水幂等键和来源记录必须唯一。

- [x] **步骤 4：运行局部测试和 DB 初始化回归**

运行：`node --import tsx --test src/server/billing/billingSchema.node-test.ts src/server/identity/identityRepository.node-test.ts`

---

### 任务 3：实现钱包与只追加账本原子命令

**文件：**
- 新建：`src/server/billing/billingRepository.ts`
- 新建：`src/server/billing/walletService.ts`
- 新建：`src/server/billing/walletService.node-test.ts`

**接口：**
- `WalletService.post(input: PostWalletEntryInput, context: CommandContext): WalletPostingResult`
- `WalletService.rebuild(ownerType, ownerId): { stored: number; rebuilt: number; difference: number }`
- `PostWalletEntryInput` 必须包含 owner、正负 `deltaUnits`、类型、稳定幂等键、来源和 actor；可选 `allowNegative` 默认 false。

- [x] **步骤 1：写失败测试**

```ts
test('余额、版本、流水和审计在同一事务提交且重复键只入账一次', () => {
  const first = service.post(command, ONLINE_CONTEXT)
  const replay = service.post(command, ONLINE_CONTEXT)
  assert.deepEqual(replay, first)
  assert.equal(repository.countLedger(command.idempotencyKey), 1)
  assert.equal(service.rebuild('user', userId).difference, 0)
})
```

- [x] **步骤 2：确认测试因服务不存在而失败**

运行：`node --import tsx --test src/server/billing/walletService.node-test.ts`

- [x] **步骤 3：实现同步事务命令**

使用 `runInTransaction`；通过 `wallets.version` 条件更新检测陈旧写入；负余额返回稳定领域错误；重复幂等键返回首次结果，不追加第二条流水。

- [x] **步骤 4：增加并发与回滚测试并运行**

覆盖同连接嵌套 Savepoint、两个 WAL 连接、`SQLITE_BUSY` 整命令重试、流水插入失败时钱包不变。

运行：`node --import tsx --test src/server/storage/sqliteUnitOfWork.node-test.ts src/server/billing/walletService.node-test.ts`

---

### 任务 4：套餐、订单和支付意图状态机

**文件：**
- 新建：`src/server/billing/rechargeService.ts`
- 新建：`src/server/billing/rechargeService.node-test.ts`

**接口：**
- `listPackages(): RechargePackage[]`
- `createOrder(input, context): BillingOrder`
- `preparePayment(orderNo, userId, context): PaymentIntent`
- `recordPaymentRequestResult(input, context): BillingOrder`
- `cancelOrder(orderNo, userId, context): BillingOrder`

- [x] **步骤 1：写失败测试**

```ts
test('同一创建幂等键只产生一个订单且过期订单不能支付', () => {
  const a = service.createOrder(input, online('create-1'))
  const b = service.createOrder(input, online('create-1'))
  assert.equal(a.orderNo, b.orderNo)
  clock.advance(31 * 60_000)
  assert.throws(() => service.preparePayment(a.orderNo, userId, online('pay-1')), /订单已过期/)
})
```

- [x] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/billing/rechargeService.node-test.ts`

- [x] **步骤 3：实现固定套餐和订单状态转换**

保留旧套餐、1 USD = 1000 points、默认汇率 7.3、默认 30 分钟有效期、`ALIPAY/WECHAT`、旧订单号形态；计算只在整数单位完成。

- [x] **步骤 4：运行局部测试**

运行：`node --import tsx --test src/server/billing/rechargeService.node-test.ts src/server/billing/walletService.node-test.ts`

---

### 任务 5：Fuiou Adapter、支付回调 Inbox 与一次入账

**文件：**
- 新建：`src/server/billing/fuiouAdapter.ts`
- 新建：`src/server/billing/fuiouAdapter.node-test.ts`
- 修改：`src/server/billing/rechargeService.ts`
- 修改：`src/server/billing/rechargeService.node-test.ts`

**接口：**
- `FuiouPort.createOrder(request): Promise<FuiouCreateResult>`
- `FuiouPort.verifyCallback(payload): Promise<VerifiedPaymentEvent>`
- `RechargeService.acceptVerifiedCallback(event, context): CallbackResult` 为同步 SQLite 命令。

- [ ] **步骤 1：写回调验签与重复投递失败测试**

```ts
test('非法签名不写 Inbox，合法回调重复十次也只入账一次', async () => {
  await assert.rejects(() => coordinator.handleCallback(invalidPayload), /验签失败/)
  await Promise.all(Array.from({ length: 10 }, () => coordinator.handleCallback(validPayload)))
  assert.equal(repository.countProviderEvent(eventId), 1)
  assert.equal(repository.countLedger(`payment:${orderNo}`), 1)
})
```

- [ ] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/billing/fuiouAdapter.node-test.ts src/server/billing/rechargeService.node-test.ts`

- [ ] **步骤 3：实现 Provider 边界和 Inbox-first 回调**

网络与 RSA 操作在事务外完成；已验证事件使用 `(provider, provider_event_id)` 去重；金额、商户号、订单号不一致拒绝入账；回调成功后钱包、基础积分、赠送积分、订单和审计原子提交。

- [ ] **步骤 4：运行局部测试**

运行：`node --import tsx --test src/server/billing/fuiouAdapter.node-test.ts src/server/billing/rechargeService.node-test.ts src/server/billing/walletService.node-test.ts`

---

### 任务 6：Sudorouter 额度操作与可恢复 Saga

**文件：**
- 新建：`src/server/billing/sudorouterAdapter.ts`
- 新建：`src/server/billing/billingCoordinator.ts`
- 新建：`src/server/billing/billingCoordinator.node-test.ts`
- 新建：`src/server/billing/billingOutboxWorker.ts`

**接口：**
- `SudorouterPort.changeQuota(input): Promise<QuotaResult>`
- `SudorouterPort.getUser(externalUserId): Promise<QuotaSnapshot | null>`
- `BillingCoordinator.adjustPoints(input): Promise<AdjustmentResult>`
- `BillingCoordinator.syncQuota(input): Promise<QuotaSnapshot>`

- [x] **步骤 1：写故障矩阵失败测试**

```ts
test('外部成功后本地提交失败进入 UNKNOWN，重试不重复增加额度', async () => {
  repository.failNextFinalize()
  const result = await coordinator.adjustPoints(command)
  assert.equal(result.status, 'UNKNOWN')
  await coordinator.retry(result.operationId)
  assert.equal(fakeSudorouter.successfulChangesFor(command.idempotencyKey), 1)
})
```

- [x] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/billing/billingCoordinator.node-test.ts`

- [x] **步骤 3：实现事务外三段式编排**

第一事务创建操作意图，事务外调用携带稳定幂等键，第二事务记录成功并入账或记录失败/不确定；`migration/replay` 不调用 Adapter，写 `SUPPRESSED`。外部 API 若不支持原生幂等，重试前必须先查询并对账，禁止盲目重复增减。

- [x] **步骤 4：运行失败矩阵和上下文抑制测试**

运行：`node --import tsx --test src/server/billing/billingCoordinator.node-test.ts src/server/application/commandContext.node-test.ts`

---

### 任务 7：授信申请与组织级审批

**文件：**
- 新建：`src/server/billing/creditApplicationService.ts`
- 新建：`src/server/billing/creditApplicationService.node-test.ts`

**接口：**
- `createApplication(input, actor, context)`
- `approveApplication(input, actor, context): Promise<CreditApplicationResult>`
- `rejectApplication(input, actor, context)`
- `retryApplication(input, actor, context): Promise<CreditApplicationResult>`

- [x] **步骤 1：写失败测试**

```ts
test('企业管理员不能审批其他组织，重复审批不重复发放', async () => {
  assert.throws(() => service.approveApplication(otherOrgInput, orgAdmin, ctx), /无权审批/)
  await service.approveApplication(input, superAdmin, ctx)
  await service.approveApplication(input, superAdmin, ctx)
  assert.equal(repository.countLedger(`credit:${applicationId}`), 1)
})
```

- [x] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/billing/creditApplicationService.node-test.ts`

- [x] **步骤 3：实现校验与状态机**

保留旧最小/最大积分、拒绝原因、禁止重复待处理、企业范围及旧错误文案；发放复用任务 6 的额度 Saga 和任务 3 的钱包命令，不另写余额逻辑。

- [x] **步骤 4：运行局部测试**

运行：`node --import tsx --test src/server/billing/creditApplicationService.node-test.ts src/server/billing/billingCoordinator.node-test.ts`

---

### 任务 8：退款与对账

**文件：**
- 新建：`src/server/billing/refundService.ts`
- 新建：`src/server/billing/refundService.node-test.ts`
- 新建：`src/server/billing/reconciliationService.ts`
- 新建：`src/server/billing/reconciliationService.node-test.ts`

**接口：**
- `RefundService.calculate(orderNo): RefundQuote`
- `RefundService.request(input, actor, context): Promise<RefundResult>`
- `ReconciliationService.run(scope, context): ReconciliationReport`

- [x] **步骤 1：写退款并发和余额对账失败测试**

```ts
test('同一订单并发退款最多成功一次且余额不足不调用支付方', async () => {
  const results = await Promise.allSettled([refund(), refund()])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(fakeFuiou.refundCalls, 1)
  assert.equal(reconciler.run({ ownerId }).walletDifferenceUnits, 0)
})
```

- [x] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/billing/refundService.node-test.ts src/server/billing/reconciliationService.node-test.ts`

- [x] **步骤 3：实现退款 Saga 与只读对账**

退款先冻结唯一操作，确认可扣回积分后才调用 Fuiou；外部成功后原子写负向流水与状态。对账不得悄悄改余额，差异只能记录并由显式修复命令处理。

- [x] **步骤 4：运行局部测试**

运行：`node --import tsx --test src/server/billing/refundService.node-test.ts src/server/billing/reconciliationService.node-test.ts`

实际扩展回归：`node --import tsx --test src/server/billing/*.node-test.ts src/server/storage/sqliteUnitOfWork.node-test.ts`，40 项通过。另覆盖缺少 Sudorouter 绑定时禁止调用支付方，以及 `migration` 上下文完整写入账本但抑制外部调用。

---

### 任务 9：实现 28 条 Sudowork Billing 兼容路由

**文件：**
- 新建：`src/server/api/compat/sudowork/billingService.ts`
- 新建：`src/server/api/compat/sudowork/billingService.node-test.ts`
- 修改：`src/server/api/compat/sudowork/app.ts`
- 修改：`src/server/api/compat/sudowork/app.node-test.ts`
- 修改：`src/server/startStandaloneServer.ts`

**接口：**
- `SudoworkBillingPort` 暴露套餐、订单、回调、管理员调整、额度同步、申请、退款、统计和记录查询。
- Adapter 继续使用 `IdentityActor` 和数字别名，不接触 `DatabaseSync`、Fuiou 或 Sudorouter Port。

- [x] **步骤 1：为 28 路由写参数化失败测试**

```ts
for (const fixture of billingContract.routes) {
  test(`${fixture.method} ${fixture.path} 保持旧 envelope`, async () => {
    const response = await fixture.request(app)
    assert.equal(response.status, fixture.status)
    assert.deepEqual(await response.json(), fixture.response)
  })
}
```

- [x] **步骤 2：运行并确认路由为 404 或 Port 缺失**

运行：`node --import tsx --test src/server/api/compat/sudowork/billingService.node-test.ts src/server/api/compat/sudowork/app.node-test.ts`

- [x] **步骤 3：逐组实现用户充值、管理员充值、申请、退款和同步路由**

每完成一组即运行对应测试。`/callback` 保留无需用户 JWT 的 Provider 验签入口；管理员路由保持 `SUPER_ADMIN/ENTERPRISE_ADMIN` 范围；`simulate-payment` 仅在明确测试配置启用时可用。

- [x] **步骤 4：静态约束和完整路由回归**

运行：`rg -n "DatabaseSync|\.prepare\(|\.exec\(|fuiou|sudorouter" src/server/api/compat/sudowork/app.ts src/server/api/compat/sudowork/billingService.ts`

预期：除 Port/类型名外，没有 SQL 和外部 Adapter 调用。

运行：`node scripts/run-node-tests.mjs src/server/api/compat/sudowork src/server/billing`

实际验证：冻结清单中的 28 条路由全部完成真实请求并逐项比对成功 envelope；兼容 App 与 Billing 聚合回归 60 项通过；`bun run build:node` 通过。支付下单、查单和退款共用同一个 Fuiou Adapter，生产启用由 `SUDOWORK_BILLING_ENABLED=true` 显式控制，缺少必要密钥或 Token 时启动失败。

---

### 任务 10：旧财务数据迁移与零差异校验

**文件：**
- 新建：`src/server/migration/sudoworkP3SourceReader.ts`
- 新建：`src/server/migration/sudoworkP3SourceReader.node-test.ts`
- 新建：`src/server/migration/p3BillingMigrationService.ts`
- 新建：`src/server/migration/p3BillingMigrationService.node-test.ts`

**接口：**
- `plan(source): P3BillingMigrationPlan`
- `execute(plan, migrationContext): P3BillingMigrationReport`
- `verify(source, target): P3BillingVerificationReport`

- [x] **步骤 1：写预检和迁移副作用失败测试**

```ts
test('迁移保持旧 ID/订单号并以 opening 流水重建余额，外部投递为零', () => {
  const report = migration.execute(plan, migration('batch-p3'))
  assert.equal(report.financialDifferenceUnits, 0)
  assert.equal(report.deliverableExternalOutboxCount, 0)
  assert.equal(fakeFuiou.calls + fakeSudorouter.calls, 0)
})
```

- [x] **步骤 2：运行并确认失败**

运行：`node --import tsx --test src/server/migration/p3BillingMigrationService.node-test.ts`

- [x] **步骤 3：实现预检、导入和 checkpoint**

预检接受可无损转换为百分之一积分的余额与流水，拒绝更高小数精度、孤儿用户/组织、重复订单号、重复成功充值、流水与余额不一致、进行中支付/退款/授信。导入必须通过统一 Repository/命令；在旧流水总和严格等于旧余额后，先写带来源 checksum 和快照余额的零值 opening 证明，再按旧顺序导入全部流水。若 P1 已写入同额钱包，只补可重建账本而不二次增加余额；若钱包为空，则在同一事务构建至旧余额；任何矛盾都阻断，禁止覆盖找平。

- [x] **步骤 4：重复执行和零差异验证**

运行：`node --import tsx --test src/server/migration/sudoworkP3SourceReader.node-test.ts src/server/migration/p3BillingMigrationService.node-test.ts`

要求：同一生产副本连续执行两次，映射、计数、checksum 和财务结果一致，第二次新增账本为零。

实际验证：源 SQLite 以 `query_only` 读取并在边界完成整数无损转换；迁移保留订单、授信、退款数字 ID 及订单号，导入客户端/管理员充值活动和 Sudorouter 快照。相同命令重试以及更换 `migrationRunId` 重新规划执行均不新增账本；钱包重建差异、外部调用和可投递 Outbox 均为零。相关局部测试 15 项通过。

---

### 任务 11：P3 综合门禁与云端回归

**文件：**
- 修改：`docs/superpowers/plans/2026-09-07-sudowork-moss-p3-billing.md`（只勾选已有验证证据的步骤）

- [x] **步骤 1：运行 Billing 全量 Node 测试**

运行：`node scripts/run-node-tests.mjs src/server/billing src/server/api/compat/sudowork src/server/migration`

- [x] **步骤 2：运行契约门禁**

运行：`bun run contracts:routes -- --source /Users/yobach/VSCodeProject/sudowork-server --check`

运行：`bun run contracts:billing -- --source /Users/yobach/VSCodeProject/sudowork-server --check`

- [x] **步骤 3：运行构建和 Moss 云端执行回归**

运行：`bun run build:node`

运行：`bun test src/server/__tests__/runtimeScodePaths.test.ts src/server/__tests__/releaseE2eSmoke.test.ts`

- [ ] **步骤 4：生成门禁结论**

必须明确记录：28/28 路由已注册、财务并发无重复入账、合法回调一次入账、非法签名零写入、钱包与账本差异为零、迁移外部调用和可投递 Outbox 均为零。任何一项不成立时 P3 不得标记完成。

当前证据：Billing、兼容接口、迁移及 UnitOfWork 聚合回归 204/204 通过；216/216 总路由和 28/28 Billing 契约检查通过；Node 构建通过；Moss 云端运行路径 7/7 通过。钱包/账本差异、迁移外部调用和可投递 Outbox 均为零。**本步骤仍不勾选**：当前富友回调仅能校验商户号、响应码、密文可解性和业务字段，尚未取得商户私有协议中可证明请求来源的签名规则与验签样例；在该资料补齐并增加验签 Fixture 前，不得将 P3 标记为生产可切换。

---

## 自检结果

- **设计覆盖：** 钱包、只追加流水、授信、套餐、订单、支付、退款、Fuiou、Sudorouter、对账、审计、兼容接口、迁移和副作用抑制均有对应任务。
- **边界校验：** 兼容 Adapter 不含 SQL 和外部调用；统一 Billing 模块不使用 `sudowork_` 表前缀；本地/云端用户共享 P1 的 canonical User 和 `wallets`。
- **一致性校验：** SQLite 原子命令与跨存储 Saga 分开；在线、迁移、回放上下文均有测试；支付和额度操作保留不确定态并提供对账，不宣称全局事务。
- **占位符扫描：** 文档不含 TBD、TODO、“稍后实现”或未定义的后续占位步骤。
- **数量校验：** 机器路由清单中 P3 相关 endpoint 为 28 条，包含 `sync-quota`；实施与验收均以 28 为准。
