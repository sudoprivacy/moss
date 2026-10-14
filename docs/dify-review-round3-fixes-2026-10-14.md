# Dify Pilot 第三轮评审修复与升级说明

日期：2026-10-14。评审依据：`dify-moss-sudowork-pr-merge-decision-2026-10-14.md` 第 4 章。
范围：现有 Moss #369、SudoStack #43、SudoWork #1234 的 Pilot 修复。本文不是生产准入或合并授权；第 5 章的平台建设另按阶段实施。

## 修复对应关系

| 评审项 | 本次处理 | 验证方式／限制 |
|---|---|---|
| P0-1 已归档／恢复凭据仍能测试 | testSaved 和执行路径共用凭据状态门禁，检查归档、换钥、恢复及 Connection 的组织、启用状态、引用和端点；异步读 Secret 后重新锁定并核对 Binding | 草稿测试可用；归档、换钥、恢复、禁用连接在读取 Secret 前拒绝；读取期间归档则不调用 Provider |
| P0-2 SSE 累计输入无限制 | 原始 UTF-8 字节在解码前累计，最多 2 MiB；超过时取消 reader 并记录 PROVIDER_RESPONSE_LIMIT | 大量中文 metadata、不增长 answer 的流也触发限制；派发后无法确认远端结果仍为 unknown，不伪装取消 |
| P0-3 定义隐藏能力 | 新的 query-only profile v1 检查完整 workflow.features、节点及连接、LLM 模型参数、prompt、context、vision、memory；拒绝未知执行字段、工具、知识库、HTTP、附件、变量、Jinja 和 YAML alias | 只允许唯一 Start → LLM → Answer；graph-only 不再接受；无法证明远端实际执行版本，管理员必须核对发布内容 |
| P1-1 兼容引用注册幂等 | 强制 request_id 和 source_definition；持久唯一约束与目录、Connection、Binding、审计同事务；同请求返回原 ID、内容冲突返回 409 | SQLite 重开服务、字段重排重试；PostgreSQL 两实例 12 路并发；提交前故障的完整回滚 |
| P1-4 请求生命周期不一致 | 桌面、浏览器和 WebUI 代理共用 15 秒总期限，涵盖 token 获取／刷新与响应读取；代理透传剩余预算；迟到刷新不能发起任务 | 身份变更拒绝、401 最多一次且保留原任务幂等 key；超时不自动重发 |
| P1-2 / P1-3 / P2 | 保留 Pilot 持久层、人工核对、非生产压测、非完整 envelope 的边界 | 不将本次修复宣称为标准 HA、生产治理或正式通用契约 |

## alpha4 协调升级

实验契约升级为 `external-provider.sudo.dev/v1alpha4`。原因是兼容引用注册新增必填字段和定义准入条件，不能继续沿用旧版本说明。

- Moss 仍是实验语义所有者；SudoStack 固定 Moss commit 和文件摘要生成；SudoWork 固定 SudoStack commit、来源锁及产物摘要消费。正式 `agent.sudo.dev/v1` / `task.sudo.dev/v1` 尚未因此完成。
- Event/Page 的 alpha3 增量与 checkpoint 结构保持，旧事件在读取时返回当前版本快照。alpha3 完整 raw_answer 保持 current；旧 alpha2 缺失原文仍标记 legacy_checkpoint，不能补造历史。
- 先暂停旧客户端读取，协调升级 Moss 和 SudoWork，再恢复会话。版本错误不通过重新创建任务处理。
- 未带 definitionProfileVersion=1 的旧 Binding 不再可执行或发布。管理员从 Moss「专属智能体 → 外部托管」编辑，上传完整已发布定义并保存，再审核发布；原目录 ID、凭据和历史保留。
- 旧 reference 注册调用方需要持久化 request_id，同时提交 source_definition 与匹配摘要；丢失响应时重用同一请求。不要用随机新 key 规避冲突。
- 输入定义和明文 App Key 不写入业务数据库。摘要是提交内容的证据，绝不是 Dify 不可变执行版本凭证。

## 本地验证

当前已完成：Moss 全量服务端测试（Bun 279 项和边界检查 50 项通过；Node 924 项，921 通过、3 按配置跳过）；Moss 类型门槛维持 104，无新增错误；管理员 API 4 项；PostgreSQL 16 跨实例专项；WebUI 超时与身份专项 9 项。Moss lint、服务端构建、管理端类型检查及构建已通过。SudoWork 全量结果、固定提交及 CI 以本轮最终交接证据为准。

真实 Dify 联调等待用户启动服务器。截至本次本地验证，不能复用上一轮运行记录冒充 alpha4 已真实通过，也不能据此宣布当前三个 PR 已可合并。

## 后续阶段

1. 当前 PR 修复、三仓来源更新、真实联调及 CI 收尾。
2. 通用契约基线、Custom Manifest、独立第二 Provider 与共用一致性测试。
3. Agent Principal / Version / Channel、候选版本、审核、发布和回滚。
4. 标准持久层归属、迁移、fencing、恢复及可证明的取消／回调。
5. 确定业务与数据范围，完成凭据、Provider 下游出口、DLP、压测和运维验收。
6. 选定原生智能体迁移，以及 Cloud / Private / Edge 交付验收。

第二 Provider、生产业务和原生迁移对象需要具体选型与真实验收环境；仅添加接口或 mock 不能算这些阶段完成。
