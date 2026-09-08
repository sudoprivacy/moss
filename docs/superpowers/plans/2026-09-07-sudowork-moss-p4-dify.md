# Sudowork Dify 能力整合到 Moss 实施计划

> **供自动化开发执行者使用：** 逐任务使用 `superpowers:executing-plans` 和 `superpowers:test-driven-development`。每个行为必须先看到预期失败，再实现最小改动并执行局部回归。用户明确要求不提交、不暂存、不推送。

**目标：** 将 sudowork-server 的 Dify 连接、Agent 执行、知识库、增强、文件、音频、历史、反馈和 SSO 能力整合进 Moss 的统一 Catalog 与 Organization 模型，同时保持未修改 Sudowork 客户端使用的旧 HTTP、SSE、二进制和 302 契约。

**架构：** Dify 是统一 Agent Catalog 的一种 Provider，不拥有第二套 Agent 主数据。Organization 的 Dify tenant 连接复用 `integration_connections`，非敏感连接信息保存在 SQLite，Service API Key、System Token、Provision Secret 与每个 App Key 只保存 Nexus 引用。兼容路由只做旧协议适配，所有 Dify HTTP 调用由 `src/server/dify/` 的 Provider Port 执行。

**兼容规模：** Dify 领域共 45 条旧接口：18 条用户 Agent 路由、18 条管理 Dify 路由、9 条管理 Dataset 路由。其中 2 条可见列表路由已由 P2 Catalog 实现，本阶段新增 43 条，但最终门禁覆盖全部 45 条。

## 正确性红线

- 不修改 Sudowork 客户端和旧 sudowork-server；旧仓库仅作冻结契约依据。
- 不创建 `sudowork_dify_agents` 或复制旧 `dify_app_binding` 主模型；Agent 主数据只能在统一 Catalog。
- Dify 终端用户 ID 必须使用永久数字别名生成 `sudowork:{legacyEnterpriseId}:{legacyUserId}`，保证历史会话归属不变；不得使用 Moss UUID。
- SQLite 的 `provider_binding`、`integration_connections.config_json`、日志、错误响应和迁移报告不得包含真实密钥。
- 外部 Dify 调用不得发生在 SQLite 事务内。创建、删除、绑定等跨存储写操作使用状态机、Outbox 和稳定幂等键；迁移、replay、影子测试默认抑制外部写入。
- SSE 必须逐字节转发，不解析后重组；客户端断开必须中止上游请求。音频保留原始字节、Content-Type 与相关 Header。
- Moss 云端 `RuntimeService` 与 WebSocket Session 路径保持不变；`POST /api/v1/agents/:assistantId/chat` 仍表示 Dify SSE，不得重定向到 Moss Runtime。
- 管理员组织解析、Agent 可见性、Dataset 归属和 Connection 查询必须始终带 `org_id`，禁止跨组织回退查询。
- 自动 provision 属于真实外部写入。GET 接口不得在影子测试或迁移中隐式 provision；在线兼容行为通过显式副作用策略控制并留下审计。

## 任务 1：冻结 45 条 Dify 契约

**文件：**
- 新建 `scripts/contracts/extract-sudowork-dify-api.ts`
- 新建 `scripts/contracts/extract-sudowork-dify-api.test.ts`
- 生成 `contracts/sudowork/dify-api.json`
- 修改 `package.json`

- [x] 测试提取结果恰好包含 45 条路由、冻结提交、认证类型、请求字段、响应类型和副作用分类。
- [x] 检查 SSE、multipart、audio、302/HTML 路由均被显式标记，未知路由或未分类副作用必须失败。
- [x] 运行生成与 `--check`，证明清单可重复。

## 任务 2：建立统一 Dify Provider 端口与 HTTP Adapter

**文件：** `src/server/dify/types.ts`、`difyHttpAdapter.ts` 及 Node 测试。

- [x] 先用 Fake fetch 验证 Service API、System API、Provision HMAC、Dataset API 的 URL、method、Header、body 和错误映射。
- [x] 验证 SSE/音频返回原始 `Response`，不读取或改写 body。
- [x] 验证上游超时与客户端 AbortSignal 合并，敏感 Header 不进入错误对象。

## 任务 3：连接、密钥引用与运行时上下文

**文件：** `src/server/dify/difyConnectionService.ts`、`difyRuntimeService.ts` 及 Node 测试。

- [x] 使用 `integration_connections` 保存 tenant/system account/base URL 等非敏感配置和 Nexus `secretRef`。
- [x] 只通过注入的 Secret Port 解析密钥；缺失、禁用和跨组织引用返回稳定错误。
- [x] 使用 P1 永久数字别名构建 Dify EndUser ID；历史用户与新 Moss 用户均有测试。
- [x] 使用统一 Catalog 的 Dify Agent 和 `VisibleTo` 校验运行权限。

## 任务 4：运行时对话、历史、反馈、文件和音频

**文件：** `src/server/dify/difyRuntimeService.ts`、`src/server/api/compat/sudowork/difyRoutes.ts` 及测试。

- [x] 实现 chat/stop、conversation list/delete/rename、messages、feedback、suggested、parameters、meta。
- [x] 实现文件上传、speech-to-text、text-to-audio，服务端覆盖客户端传入的 `user` 字段。
- [x] 验证旧成功 envelope、错误状态/字段、SSE Header、媒体 Header 和断连中止。

## 任务 5：统一增强与 Dataset binding

**文件：** `src/server/dify/difySchema.ts`、`difyRepository.ts`、`difyEnhancementService.ts` 及测试。

- [x] Dataset 是 Organization 下的 Provider Resource；只保存 provider ID 与元数据，不复制 Agent。
- [x] Agent 的 Dify app/mode/connection/dataset 引用写入统一 Catalog provider binding；真实 App Key 写 Nexus。
- [x] 实现 blocking/streaming enhancement，保持 app/workflow/dataset 三类旧行为与流式事件结构。
- [x] 禁止创建后改变 enhancement 方法，保持旧错误文案。

## 任务 6：管理端 Dify 与 SSO

**文件：** `src/server/dify/difyAdministrationService.ts`、兼容路由及测试。

- [x] 实现 binding 查询/provision、App 创建/删除/列表、企业 Assistant CRUD、ACL、共享组织和 Dataset 绑定。
- [x] 实现 SSO 的 302/HTML 契约，确保一次性 Token、目标地址和组织边界正确。
- [x] 所有真实外部写入具备幂等命令与可恢复状态；Fake Adapter 验证迁移、replay 和影子模式调用数为零。

## 任务 7：管理 Dataset 代理

**文件：** `src/server/dify/difyDatasetService.ts`、兼容路由及测试。

- [x] 实现 Dataset CRUD、Document list/create file/create text/delete 和 retrieve。
- [x] 严格保持分页默认值、multipart 字段、错误结构和企业管理员范围。
- [x] Dataset GET 的旧自动 provision 行为仅允许在线上下文；影子/迁移模式返回被抑制的稳定结果，不执行外呼。

## 任务 8：P4 数据迁移与校验

**文件：** `src/server/migration/sudoworkP4SourceReader.ts`、`p4DifyMigrationService.ts` 及测试。

- [x] 只读读取旧 tenant/app/dataset/ACL/enhancement 数据并生成 canonical checksum。
- [x] 复用 P1 Organization/User 别名和 P2 Catalog；孤立组织、用户、Agent、Dataset 或冲突绑定必须阻断。
- [x] 真实密钥写入 Nexus，SQLite 仅写引用；迁移重跑可恢复且不调用 Dify、不产生可投递外部 Outbox。
- [x] 校验 connection、app、dataset、ACL、metadata binding 数量及引用完全一致。

## 任务 9：接入兼容 App 与全阶段门禁

- [x] 将 43 条新增路由注册到现有 Sudowork Hono App，复用统一 Identity/Catalog/Dify 服务。
- [x] 运行 45 条 Dify 契约测试、全部 P1/P2 相关回归、Moss Runtime/Session 回归和 Node build。
- [x] 运行路由全量 `--check`，确认没有因 P4 产生接口漂移。
- [x] 记录仍需真实 Dify 私有部署验证的生产阻塞项，不以 Fake Adapter 通过替代生产凭据与真实联调。

## 阶段验收命令

```bash
bun test scripts/contracts/extract-sudowork-dify-api.test.ts
bun run contracts:dify -- --source /Users/yobach/VSCodeProject/sudowork-server --check
node scripts/run-node-tests.mjs src/server/dify src/server/api/compat/sudowork src/server/migration
bun test src/server/__tests__/runtimeScodePaths.test.ts src/server/__tests__/releaseE2eSmoke.test.ts
bun run contracts:routes -- --source /Users/yobach/VSCodeProject/sudowork-server --check
bun run build:node
```

只有上述验证通过、45 条契约无未批准差异、迁移副作用为零且 Moss 云端 Runtime 回归无退化，P4 才可标记完成。

## 2026-09-07 阶段验证记录

- Dify 契约提取测试：3/3 通过；冻结清单保持 45 条路由。
- Dify、Sudowork 兼容层及 P1-P4 迁移 Node 回归：282/282 通过。
- Moss Runtime 与发布冒烟：7/7 通过。
- Sudowork 全量路由合同：216 条通过 `--check`，未发生接口漂移。
- `bun run build:node` 通过，包含管理端、Moss Server、Session Runner、Wiki 与 CorpApp 构建。
- 测试期间最小 SQLite 测试夹具会输出 `department_secret_policies` 回填告警，但测试均通过；该告警不作为生产迁移可忽略项，P9 需在完整生产结构上再次确认启动日志为零异常。

## P4 生产门禁

P4 代码阶段已完成，但尚不能据此批准生产切换。必须在具备真实私有 Dify、Nexus 和回调域名的预发布环境完成 provision、App 创建/删除、Dataset 文件写入、SSE 断连、音频、SSO、密钥轮换及迁移后历史会话验证；任何一项失败都阻止切流量。
