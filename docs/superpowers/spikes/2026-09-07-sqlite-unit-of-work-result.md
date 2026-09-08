# SQLite UnitOfWork Spike 结论

## 结论

`node:sqlite` 的 `DatabaseSync` 可以为 Moss 主 SQLite 提供同步 UnitOfWork。最外层边界使用 `BEGIN IMMEDIATE`，嵌套边界及接入既有事务时使用唯一 `SAVEPOINT`，避免 `cannot start a transaction within a transaction`。

UnitOfWork 只覆盖传入的单个 SQLite 连接。Redis refresh token、QMS PostgreSQL 和外部系统不在同一事务内，它们的一致性必须由 Outbox、幂等键、迁移校验和补偿流程保证。

## 建议正式接口

```ts
interface TransactionContext {
  depth: number
  savepoint?: string
}

function runInTransaction<T>(
  db: DatabaseSync,
  callback: (context: TransactionContext) => T,
): T
```

正式实现应提供专用 `AsyncTransactionCallbackError`。回调返回 PromiseLike 时，当前边界必须立即回滚并抛错。类型签名和代码评审仍应明确禁止 `async` 回调，因为运行时检测无法撤销 Promise 在首次 `await` 之后自行产生的外部副作用。

## 嵌套机制

- 连接不在事务中：执行 `BEGIN IMMEDIATE`，成功后 `COMMIT`，失败后 `ROLLBACK`。
- 同一 UnitOfWork 嵌套：创建单调递增且不重复的 `SAVEPOINT moss_uow_N`。
- 连接已由旧代码打开事务：UnitOfWork 从 SAVEPOINT 开始，不提交或回滚调用方拥有的外层事务。
- 内层失败：`ROLLBACK TO SAVEPOINT` 后 `RELEASE SAVEPOINT`；调用方捕获异常后可继续外层事务。

## SQLITE_BUSY 策略

锁冲突只允许在事务边界之外重试完整业务命令，禁止在事务中间重试单条 SQL。建议配置较短 `busy_timeout`，使用有上限的退避和可观测重试计数；耗尽后向上抛出明确的可重试错误。

双连接 WAL 测试中，一个 Worker 持有写锁，第二连接先收到锁错误；持锁连接提交后，第二连接重试完整 `runInTransaction` 成功。两次钱包增量均保留，最终余额为 2。

## 已验证行为

- 外层提交和失败全回滚。
- 两层嵌套 SAVEPOINT 唯一，内层失败只回滚内层。
- 已有事务复用 SAVEPOINT，UnitOfWork 不越权提交。
- PromiseLike 回调被拒绝，同步阶段写入回滚。
- WAL 双连接 `SQLITE_BUSY`、锁释放后的完整命令重试。
- 数字别名 `(entity_type, legacy_id)` 唯一约束。

Spike 代码不能被生产模块导入。P1 应在主数据库模块中按上述接口重新实现，并让 Repository 禁止自行执行裸 `BEGIN`、`COMMIT` 或 `ROLLBACK`。
