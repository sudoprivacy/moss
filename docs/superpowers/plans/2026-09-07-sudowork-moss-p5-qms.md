# Sudowork QMS 能力整合到 Moss 实施计划

> **执行约束：** 逐任务采用测试驱动开发；每一小步先出现预期失败，再实现并执行局部回归。用户明确要求不提交、不暂存、不推送，所有文档使用中文。

**目标：** 将 sudowork-server 的质量与遥测能力实现为 Moss 原生 QMS 模块，统一使用 Moss Organization、用户和权限模型，继续使用独立 PostgreSQL/TimescaleDB 与 Redis，并保持未修改 Sudowork 客户端及旧管理端依赖的 72 条 HTTP 接口、鉴权、加密和响应契约。

**架构：** `src/server/qms/` 是 Moss 唯一 QMS 领域实现；`src/server/api/compat/sudowork/qmsRoutes.ts` 只负责旧协议适配。QMS 时序、聚合、Crash、告警和审计数据留在独立 PostgreSQL/TimescaleDB，不进入 Moss 主 SQLite。旧 `tenant_id` 通过 P1 的永久企业 code 映射到统一 Organization；新组织直接使用同一 code。API Key、数据库密码、Redis 密码、RSA 私钥和通知凭据只从环境或 Nexus 读取。

**兼容规模：** 冻结 72 条 QMS 路由：Telemetry 5 条、Crash 28 条（14 条同时保留两个前缀）、Dashboard 8 条、User Stats 6 条、Alerts 8 条、System 17 条。

## 正确性红线

- 不修改 Sudowork 客户端和旧 sudowork-server；旧仓库仅作冻结契约、数据结构和差异测试依据。
- 不把 QMS 表、时序事件或聚合结果写入 Moss 主 SQLite，也不建立第二套 Organization/User 主数据。
- 保持 API Key Header、旧 JWT 角色映射、RSA-OAEP SHA-256 + AES-256-GCM、状态码、Header、成功/错误外层和字段默认值。
- API Key 必须常量时间校验；密钥、私钥、SMTP 密码和 Webhook 不得进入 SQLite、日志、错误响应或迁移报告。
- 旧 QMS 的“先 RPOP、后写库”存在数据库失败丢数据风险，不能照搬。新队列必须具备处理中队列、确认、失败恢复、稳定事件 ID 和幂等落库。
- 聚合、告警、清理和队列消费必须使用跨实例租约；同一任务同一时刻只允许一个 Moss 实例执行，手工触发同样受互斥保护。
- 遥测接收成功只表示事件已可靠进入队列，不伪装为已写入 PostgreSQL。Redis 不可用时不得返回成功。
- 管理查询必须按 Organization 限定 tenant。超级管理员可跨组织，企业管理员只读本组织；禁止通过 query 参数越权。
- 迁移模式允许 PostgreSQL 数据导入，但不得发送历史告警、测试通知或其他外部副作用；恢复/replay 同样抑制或按稳定幂等键去重。
- Source Map 虽无旧公开路由，表和历史数据仍必须迁移、校验并由 Crash 符号化服务统一使用。
- `/api/v1/qms/system/health` 在旧实际路由中受 JWT 中间件保护；兼容以实际行为为准，不按错误注释改成公开接口。

## 任务 1：冻结 72 条 QMS 契约

**文件：**
- 新建 `scripts/contracts/extract-sudowork-qms-api.ts`
- 新建 `scripts/contracts/extract-sudowork-qms-api.test.ts`
- 生成 `contracts/sudowork/qms-api.json`
- 修改 `package.json`

- [x] 测试只提取 `domain=qms` 的 72 条路由，并固定旧仓库提交。
- [x] 为每条路由显式记录认证方式、请求类型、响应外层、tenant 范围、加密要求和副作用。
- [x] 明确冻结 Crash 双前缀、Telemetry API Key、管理 JWT 和 System Health 实际鉴权。
- [x] 任何新增、缺失、重复或未分类路由均使 `--check` 失败。

## 任务 2：建立 QMS 配置、生命周期与独立存储端口

**文件：**
- 新建 `src/server/qms/types.ts`
- 新建 `src/server/qms/config.ts`
- 新建 `src/server/qms/postgresStore.ts`
- 新建 `src/server/qms/redisQueue.ts`
- 新建 `src/server/qms/qmsSchema.ts`
- 修改 `src/server/types.ts`、`src/server/config.ts`、`package.json`

- [x] 配置覆盖启用开关、PostgreSQL、Redis、队列、保留期、加密和通知；拒绝旧默认密码和默认 API Key。
- [x] 数据库与 Redis 在 QMS 启用时启动，在关闭时释放；连接失败使 QMS 启动失败，不静默降级。
- [x] Schema 幂等创建旧表、索引、hypertable、连续聚合和保留策略，并兼容无 TimescaleDB 的普通 PostgreSQL 模式。
- [x] 单元测试使用 Fake Port；真实 PostgreSQL/Redis 集成测试通过显式环境门禁运行，不依赖开发机隐式服务。

## 任务 3：统一租户、JWT、API Key 与混合加密

**文件：**
- 新建 `src/server/qms/qmsAuthorization.ts`
- 新建 `src/server/qms/hybridDecryption.ts`
- 新建对应 Node 测试

- [x] 旧 JWT 复用 P1 Identity，`SUPER_ADMIN` 映射 QMS admin，`ENTERPRISE_ADMIN` 映射本组织 viewer。
- [x] `tenant_id` 只接受已映射 Organization code；企业管理员请求中的其他 tenant 被服务端覆盖或拒绝。
- [x] API Key 常量时间校验并兼容可配置 Header 名；缺失、未配置、错误分别保持旧状态码与错误结构。
- [x] 用固定密码学向量验证 PKCS8 RSA-OAEP SHA-256、AES-256-GCM、标准/URL-safe Base64、错误码和明文禁用策略。

## 任务 4：可靠遥测接收与队列消费

**文件：**
- 新建 `src/server/qms/telemetryService.ts`
- 新建 `src/server/qms/reliableTelemetryQueue.ts`
- 新建对应 Node 测试

- [x] 支持 batch、perf、conversation、install，以及 batch 内 turns/steps 和新旧 events 两种载荷。
- [x] 合并公共字段并验证 tenant、时间戳、必填字段和批量上限，保持旧计数响应。
- [x] Redis 队列使用 pending/processing/ack/recover 模型；数据库失败可恢复，重复消费按稳定事件 ID 幂等。
- [x] PostgreSQL 批量写入五类原始表，所有 tenant/user/org 字段保持旧含义并能映射统一实体。

## 任务 5：Crash、Issue 与 Source Map

**文件：**
- 新建 `src/server/qms/crashService.ts`
- 新建 `src/server/qms/sourceMapService.ts`
- 新建对应 Node 测试

- [x] 支持单条/批量 Crash、fingerprint、Issue 聚合、列表、详情、resolve、ignore 和统计。
- [x] 两组 Crash 前缀调用同一服务，不产生两份状态或不同权限。
- [x] fingerprint 与旧算法保持兼容；重复事件不会重复创建 Issue，tenant 间不合并。
- [x] Source Map 按版本、平台和 tenant 解析；缺失时保留原始堆栈，历史 Source Map 可迁移和校验；企业专属映射优先，旧全局映射作为兜底。

## 任务 6：Dashboard 与 User Stats 查询

**文件：**
- 新建 `src/server/qms/qmsQueryService.ts`
- 新建对应 Node 测试与 Fixture

- [x] 实现 overview、perf/conversation/install 趋势与维度查询。
- [x] 实现 conversation/turn/step 用户统计、排行榜、用户详情和 realtime。
- [x] 历史聚合与当日原始数据合并时不重复计数，UTC 边界、分页、排序和空数据结构保持旧行为。
- [x] 企业管理员无法读取其他 tenant，超级管理员显式传 tenant 或查询全局。

## 任务 7：告警、通知、审计与系统管理

**文件：**
- 新建 `src/server/qms/alertService.ts`
- 新建 `src/server/qms/notificationAdapters.ts`
- 新建 `src/server/qms/qmsSystemService.ts`
- 新建对应 Node 测试

- [x] 实现告警配置 CRUD、历史、确认、冷却窗口和测试通知。
- [x] 通知经 Lark/SMTP Port 执行，凭据只从 Nexus/环境解析；迁移、replay、影子模式调用数必须为零。
- [x] QMS 审计仍写独立 PostgreSQL，并记录统一 Moss 用户 ID、Organization 与旧 tenant code。
- [x] 实现 17 条 System 路由的配置、通知、统计、Schema、聚合、任务和错误码契约；敏感配置响应必须保持脱敏。

## 任务 8：单实例调度、聚合与保留

**文件：**
- 新建 `src/server/qms/qmsScheduler.ts`
- 新建 `src/server/qms/qmsLeaseStore.ts`
- 新建对应 Node 测试

- [x] 实现 queue、aggregation、cleanup、alert、crash aggregation、crash cleanup 六类任务。
- [x] PostgreSQL advisory lock 或租约表保证多实例互斥，租约过期可接管，运行中进程退出可恢复。
- [x] TimescaleDB 模式使用连续聚合和 retention policy；普通 PostgreSQL 模式使用幂等手工聚合与删除。
- [x] 手工执行与后台调度共享同一租约、状态和审计，不允许并发重复通知。

## 任务 9：72 条兼容路由与生产接线

**文件：**
- 新建 `src/server/api/compat/sudowork/qmsRoutes.ts`
- 修改 `src/server/api/compat/sudowork/app.ts`
- 修改 `src/server/auth/service.ts`
- 修改 `src/server/startStandaloneServer.ts`
- 修改管理端凭据配置页面

- [x] 逐条注册 72 条路由并保持旧 CORS、错误处理、请求日志、JSON 外层和状态码。
- [x] Compatibility Adapter 不写数据库、不包含业务判断，只做解析、授权上下文和 DTO 转换。
- [x] QMS 启用时创建唯一服务图和调度器；关闭时路由行为符合旧 `QMS_ENABLED=false` 的不可用表现。
- [x] Moss 原生管理能力复用同一 QMS 服务，不复制旧 QMS 管理业务。

## 任务 10：P5 PostgreSQL/TimescaleDB 数据迁移与校验

**文件：**
- 新建 `src/server/migration/sudoworkP5QmsSourceReader.ts`
- 新建 `src/server/migration/p5QmsMigrationService.ts`
- 新建对应 Node 测试和迁移命令入口

- [x] 只读提取旧 QMS Schema 版本、tenant 范围、原始事件、聚合、Crash、Source Map、告警、系统配置和审计。
- [x] 预检 Organization code、时间范围、主键冲突、孤立 Issue/Event、重复聚合和不安全明文配置，阻塞时零写入。
- [x] 分表 checkpoint、稳定批次、checksum 和幂等写入支持断点续传；迁移期间调度器与外部通知关闭。
- [x] 校验 tenant 数量、逐表行数、时间边界、全量内容 checksum、聚合窗口和 Source Map 完整性。

## 任务 11：阶段门禁与真实环境验证

- [x] 72 条 QMS 契约和所有 P5 Node 测试通过。
- [x] 216 条 Sudowork 全量路由 `--check` 通过，P1-P4 回归与 Moss Runtime/Session 冒烟无退化。
- [x] `bun run build:node` 通过；配置生命周期测试确认失败回收和幂等关闭。
- [ ] 在真实 PostgreSQL/TimescaleDB、Redis、Nexus 上验证故障恢复、队列不丢数据、多实例租约和迁移重跑。
- [ ] 使用脱敏 Fixture 对旧服务与 Moss 做差异测试；所有未批准差异均阻止 P5 完成。

## 阶段验收命令

```bash
bun test scripts/contracts/extract-sudowork-qms-api.test.ts
bun run contracts:qms -- --source /Users/yobach/VSCodeProject/sudowork-server --check
node scripts/run-node-tests.mjs src/server/qms src/server/api/compat/sudowork src/server/migration
bun test src/server/__tests__/runtimeScodePaths.test.ts src/server/__tests__/releaseE2eSmoke.test.ts
bun run contracts:routes -- --source /Users/yobach/VSCodeProject/sudowork-server --check
bun run build:node
```

只有 72 条契约无未批准差异、可靠队列故障测试不丢数据、跨实例任务不重复、迁移对账通过且 Moss 云端 Runtime 无退化，P5 才可标记完成。真实环境联调未完成时只能声明代码阶段通过，不能批准生产切换。

## 2026-09-07 代码阶段验证记录

- QMS 契约：72 条通过；Sudowork 全量契约：216 条通过；Dify：45 条通过；Billing：28 条通过；候选客户端矩阵：2 个客户端通过。
- P5 迁移专项：11/11 通过；QMS Runtime Source Map 专项：4/4 通过；Moss Runtime/Session 冒烟：8/8 通过。
- Node 全量回归：393 项，391 通过、0 失败、2 项跳过；跳过项仅为需 `QMS_INTEGRATION_POSTGRES_URL` 和 `QMS_INTEGRATION_REDIS_URL` 的真实基础设施门禁。
- Bun 全量回归：392/392 通过；`bun run build:node` 通过。
- 全库 `tsc --noEmit` 仍存在 `dev` 基线历史错误；本次 P5/QMS/迁移文件的过滤结果为 0 条新增错误，不能据此宣称全库 TypeScript 门禁通过。
- 尚未完成：真实 PostgreSQL/TimescaleDB、Redis、Nexus 联调，脱敏生产副本迁移与旧服务差异测试。完成这些门禁前不得批准生产切换。
