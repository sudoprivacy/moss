# Sudowork 整合 P1 身份与组织实施计划

> **执行约束：** 按 TDD 小步实施，每项先获得失败证据，再实现并运行局部与相关回归。不得提交、暂存或推送。

**目标：** 让 Moss 的唯一 Organization/User 模型同时承载 Moss 原生用户和 Sudowork 历史/新增用户，并为旧客户端提供原路径、原 Token profile、原数字 ID 和原响应契约。

**非目标：** 本阶段不迁移 Agent、Skill、Dify、QMS 和完整 Billing 业务；但创建用户所需的空钱包及 Outbox/别名基础表必须原子落库。

## Task 1：正式 SQLite UnitOfWork

- [x] 在 `src/server/storage/sqliteUnitOfWork.ts` 编写生产实现，API 不依赖 Spike。
- [x] Node 测试覆盖外层事务、嵌套 SAVEPOINT、已有事务、回滚、PromiseLike 拒绝和连接状态恢复。
- [x] 将 AuthCenterDb 的 bootstrap、ensureBootstrapAdmin、JSON 迁移改用 UnitOfWork，消除裸事务。
- [x] 验证 AuthCenter 方法嵌套在外层 UnitOfWork 时不会触发嵌套 BEGIN。

验证记录（2026-09-07）：生产 UnitOfWork Node 测试 4 项通过；AuthCenterDb 已无裸 `BEGIN/COMMIT/ROLLBACK`，bootstrap 和 JSON 迁移可安全嵌套在调用方事务内。

## Task 2：统一身份基础表

- [x] 扩展用户状态为 `pending | active | locked | disabled`，对旧数据库做保数据重建迁移。
- [x] 新增 `organization_profiles`、`user_auth_identities`、`resource_numeric_aliases`、`invitations`、`wallets`、`outbox_events`。
- [x] 为 provider identity、旧数字 ID、企业 code、邀请码和 Outbox 幂等键建立数据库唯一约束。
- [x] 增加 Repository 映射与跨组织隔离测试。

验证记录（2026-09-07）：身份 Repository Node 测试 5 项通过；旧二态 users 表数据与 api_keys 外键无损保留，四种状态、企业 code、身份唯一约束和数字别名组织隔离均通过。

## Task 3：统一命令上下文与创建用户

- [x] 定义仅由可信入口构造的 `online | migration | replay` 上下文及 `enqueue | suppress_external` 策略。
- [x] 实现统一创建用户命令：User、认证身份、数字别名、钱包、邀请码消费、审计/Outbox 同事务。
- [x] migration/replay 对外副作用写为不可投递 `suppressed`；在线模式写 `pending`。
- [x] 任一步失败均无部分数据，并覆盖幂等重试。

验证记录（2026-09-07）：统一命令与可信上下文测试 4 项通过；Moss 原生 `AuthService.createUser` 接入测试 1 项通过。新建用户自动获得密码身份、Sudowork 数字 ID 和钱包；固定旧 ID 冲突时所有写入回滚。

## Task 4：密码与 Token 双兼容

- [x] 支持读取旧 bcrypt 摘要；登录成功后同一 SQLite 事务升级为 Moss scrypt。
- [x] Moss 原生 JWT 保持现有 claim；Sudowork profile 签发旧 `id/phone/role/enterprise_id` claim。
- [x] 接受迁移前未过期旧 JWT 和 Refresh Token，按旧设备语义滚动刷新；迁移 TTL 不得人为缩短。
- [x] 覆盖 active 登录，以及 pending/locked/disabled 的旧错误语义。

验证记录（2026-09-07）：旧 Token、Refresh Token、设备隔离、bcrypt 升级和四态登录测试均通过；Moss 原生 Token 代码路径保持不变。

## Task 5：组织、邀请和身份领域服务

- [x] Organization Profile 替代 `enterprises.id='default'` 单例语义。
- [x] 实现组织 code、品牌、登录策略、本地/云端能力开关。
- [x] 实现邀请生成、查询、消费、审批、锁定和角色映射；旧 `ADMIN` 只报告冲突，不自动提权。
- [x] 手机号、CAS 等身份通过 `user_auth_identities` 解析到同一 User。

验证记录（2026-09-07）：组织/用户跨组织隔离、邀请码生命周期、用户状态与角色、CAS 自动开户和一次性 handoff 均有 Node 集成测试；OAuth 组织变更会同步认证身份和数字别名。

## Task 6：Sudowork 身份兼容 Adapter

- [x] 在 `src/server/api/compat/sudowork/` 建立 Hono 组合根和错误序列化层。
- [x] 实现旧认证、用户、企业、邀请码和管理员身份接口；Adapter 只调用统一服务。
- [x] 在 P1 已实现路由范围内保持旧状态码、字段、错误文案、分页/排序和 302 行为。
- [x] 将 Host 分流正式接入现有 `http.Server`，保持 Moss 原生 `/api/v1/auth/login`、WebSocket 与 `/healthz` 不变。

验证记录（2026-09-07）：P1 兼容 Adapter 注册 29 条身份与组织相关路由；HTTP Fixture 覆盖密码、短信、CAS、管理员、企业、邀请和用户管理协议。CAS HTTP 校验已改为 DOM 解析并覆盖命名空间、实体解码、参数编码和失败响应。

## Task 7：P1 契约与回归门禁

- [x] 逐接口 Fixture/差异测试覆盖 P1 已实现路由。
- [ ] 历史用户和 Moss 新建用户均可通过未修改客户端协议登录。
- [x] `bun run test:bun`、`bun run test:node`、`bun run build:node` 和路由契约检查通过。
- [x] 工作树无提交、无暂存，只读源仓库未新增本任务改动。

验证记录（2026-09-07）：Node 88 项、Bun 378 项通过；216 条 Sudowork 路由契约与固定源提交一致；支持客户端矩阵结构校验通过但状态仍为 `candidate`。第二项只能由历史数据迁移演练和未修改真实客户端验收关闭，不能由服务端单元测试代替。

## 业务门禁

正式切流前必须把 `contracts/sudowork/supported-clients.json` 的候选范围评审为 `confirmed`。在确认前可开发与测试，但不能声称旧客户端兼容验收完成。
