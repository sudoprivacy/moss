# Sudowork 与 Moss 企业自动化统一实施计划

> **执行约束：** 使用 `superpowers:executing-plans` 与 `superpowers:test-driven-development` 逐项执行。每项先写失败测试，再做最小实现并运行局部回归。用户明确要求不提交、不暂存、不推送。

**目标：** 保持 Sudowork 本地 Cron/Channel 继续由客户端拥有和执行，同时确保企业 Cron、Event Trigger、Channel 全部使用 Moss 的统一 Organization、User、Catalog、Nexus 与 RuntimeService，并具备组织隔离、单执行和可关闭生命周期。

**架构：** 不为 Sudowork 增建另一套自动化表或兼容路由。Moss 现有 `cron_jobs`、`event_triggers`、Channel 表仍是企业云端自动化唯一数据源；执行统一进入现有 RuntimeService。组织策略进入 `organization_profiles`，全局设置只作为旧数据的兼容默认值。

**技术栈：** TypeScript、Node.js、`node:sqlite`、Croner、Moss RuntimeService、Nexus、Bun/Node 测试。

**规格：** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md` §7.8、§8、§13、§14。

## 全局约束

- 不修改 `/Users/yobach/VSCodeProject/sudowork` 与 `/Users/yobach/VSCodeProject/sudowork-server`。
- 不把客户端本地 Cron/Channel 数据上传或迁入 Moss。
- 企业任务和 Channel 会话必须调用现有 RuntimeService，不建立第二套执行器。
- 所有查询与写入以认证得到的 `orgId`、`userId` 为边界，不信任请求体中的身份字段。
- Channel 敏感凭据仅存在 Nexus，SQLite 只保存非敏感配置与引用信息。
- 后台执行器必须可幂等启动和关闭；关闭后不得继续创建 Session 或写数据库。
- 不执行 Git commit。

## 任务 1：冻结 P6 所有权与现有接口基线

**文件：**
- 新建 `src/server/services/automation/automationOwnership.node-test.ts`
- 只读核对 `src/server/server.ts`、`src/server/api/cron.ts`、`src/server/api/eventTriggers.ts`、`src/server/api/channels.ts`

- [x] 测试证明旧 `sudowork-server` 没有服务端 Cron、Event Trigger、Channel 路由与业务表，P6 不产生新的 Sudowork 兼容接口。
- [x] 固定 Moss 企业自动化入口清单，并验证兼容 Host 分流不截获 Moss 原生自动化接口。
- [x] 记录客户端本地 Cron/Channel 不属于迁移输入，防止后续误加下发或双写。

## 任务 2：将本地 Cron 开关改为组织级策略

**文件：**
- 修改 `src/server/identity/identityRepository.ts`
- 新建 `src/server/identity/organizationAutomationPolicy.node-test.ts`
- 修改 `src/server/api/enterprise.ts`
- 修改 `src/server/api/cron.ts`
- 修改 `src/server/services/cron/CronService.ts`
- 修改 `src/server/server.ts`

- [x] 先用两个 Organization 的测试证明当前全局 `clientCronEnabled` 会串扰。
- [x] 为 `organization_profiles` 增加可幂等升级的 `client_cron_enabled`，旧记录以全局设置作为兼容回填值，新组织默认允许。
- [x] 管理端写入只修改当前认证 Organization；Cron 创建和计划执行均读取对应 Organization 策略。
- [x] 管理员绕过、手工触发与已有任务管理语义保持现状；普通用户只受所在组织策略控制。

## 任务 3：验证 Cron 组织隔离、租约与云端 Session

**文件：**
- 新建 `src/server/services/cron/CronStore.node-test.ts`
- 新建 `src/server/services/cron/CronService.node-test.ts`
- 新建 `src/server/api/cron.node-test.ts`

- [x] 两个数据库连接并发争抢同一到期任务时只允许一个 `acquireLease` 成功。
- [x] 创建、读取、更新、删除、手工执行和历史查询均验证 Organization、owner/co-owner 与管理员边界。
- [x] 计划执行从统一用户获取当前角色/Scopes，以正确 `orgId/userId/assistantName` 创建 Moss 云端 Session。
- [x] 失效用户、禁用组织策略、已有运行、进程重启遗留运行和会话复用均保持确定状态。

## 任务 4：验证 Event Trigger 原子认领与云端执行

**文件：**
- 新建 `src/server/services/eventTrigger/EventTriggerStore.node-test.ts`
- 新建 `src/server/services/eventTrigger/EventTriggerService.node-test.ts`
- 新建 `src/server/api/eventTriggers.node-test.ts`

- [x] 多连接并发认领同一 queued run 时只能成功一次，幂等键重试返回原 run。
- [x] 管理接口固定在认证 Organization；事件入口只接受 trigger secret，不能从载荷覆盖组织或用户。
- [x] 执行统一进入 RuntimeService，并验证新会话、复用会话、失败状态、重启恢复与一次性会话回收。
- [x] 服务停止后不再认领新任务，并等待或安全隔离进程内正在执行的任务。

## 任务 5：收紧 Channel 组织边界与 Nexus 凭据

**文件：**
- 修改 `src/server/db.ts`
- 修改 `src/server/api/channels.ts`
- 修改 `src/channels/core/ChannelManager.ts`
- 修改 `src/channels/gateway/PluginManager.ts`
- 新建 `src/channels/__tests__/organizationIsolation.node-test.ts`
- 新建 `src/channels/__tests__/lifecycle.node-test.ts`

- [x] 旧 `channel_plugins`、`channel_users` 的空 `org_id` 从统一 User 归属幂等回填；无法唯一映射的数据保持禁用并进入校验报告。
- [x] 插件、授权用户、配对和会话的读取、修改、删除均校验认证 Organization 与 owner，跨组织返回不可探测结果。
- [x] API 返回和 SQLite 中均不出现 Telegram/Lark/DingTalk/WeCom 明文秘密；启动时只从 Nexus 注入内存。
- [x] 同一连接仅允许一个服务实例持有执行租约；停止、失联与租约过期后可安全接管，避免双重回复。
- [x] Channel 创建的会话使用统一用户、Organization 与可见 Agent/Skill，并调用同一 RuntimeService。

## 任务 6：统一后台生命周期

**文件：**
- 修改 `src/server/server.ts`
- 修改 `src/server/services/cron/CronService.ts`
- 修改 `src/server/services/eventTrigger/EventTriggerService.ts`
- 修改 `src/channels/core/ChannelManager.ts`
- 新建 `src/server/__tests__/automationLifecycle.node-test.ts`

- [x] 启动失败时按逆序释放已经启动的 Cron、Event Trigger 与 Channel 资源。
- [x] `server.stop()` 幂等停止三个后台模块，并在关闭数据库前停止定时器、插件和新任务认领。
- [x] 测试停止后不再触发 Session 创建、外部 Channel 调用或数据库写入。

## 任务 7：P6 回归门禁

- [x] P6 新增 Node/Bun 测试全部通过。
- [x] Moss Runtime/Session、身份、Catalog、Nexus 与现有 Channel 测试无退化。
- [x] 216 条 Sudowork 路由契约仍通过，且未新增错误的旧兼容路由。
- [x] `bun run build:node` 与全量 Node/Bun 回归通过。
- [ ] 真实多实例与真实 Channel 凭据联调作为部署门禁单独记录；未执行时不得批准生产切换。

## 阶段验收命令

```bash
node --import tsx --test src/server/services/cron/*.node-test.ts
node --import tsx --test src/server/services/eventTrigger/*.node-test.ts
node --import tsx --test src/server/api/cron.node-test.ts src/server/api/eventTriggers.node-test.ts
node --import tsx --test src/channels/__tests__/*.node-test.ts src/server/__tests__/automationLifecycle.node-test.ts
bun run contracts:routes -- --source /Users/yobach/VSCodeProject/sudowork-server --check
bun test src/server/__tests__/runtimeScodePaths.test.ts src/server/__tests__/releaseE2eSmoke.test.ts
node scripts/run-node-tests.mjs
bun test
bun run build:node
```

P6 代码门禁通过不等于生产切换批准。真实多实例、真实 Nexus 和至少一个实际 Channel Provider 的联调证据必须在 P9 汇总。
