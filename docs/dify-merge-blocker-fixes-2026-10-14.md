# 合并阻断修复说明

本轮沿用原三个 PR，Moss/Work rebase 到 dev，Stack rebase 到 main。评审结论及最终提交证据以交接包为准；本文不代表允许合并或生产准入。

## 行为变更

- HTTP 只接受 SubmitTask。旧 CreateExternalTask 返回 409 TASK_CLIENT_UPGRADE_REQUIRED，不读取凭据、不创建任务/会话/Attempt、不占用幂等键。历史仍可读取。
- external-provider.sudo.dev/v1alpha5 协调升级；alpha3/alpha4 旧事件通过当前快照返回，保留完整 raw_answer，不重放任务。客户端不能因版本错误自动重提任务。
- 目录、连接检查、新任务及新 Resolution 显式记录 source_identity_evidence=unverified。Dify App/Workspace ID 均为管理员声明，不能视为已被服务凭据验证。强来源审计任务使用 required_capabilities=["verified_source_identity"]，准入持久拒绝 SOURCE_IDENTITY_UNVERIFIED，且不调用凭据服务或 Provider。HTTP Manifest 匹配也不被冒充为跨平台强身份认证。
- 新任务持久化会话内 session_sequence，在持有会话行锁时分配。历史按创建序号排序；旧记录按既有 created_at、ID 确定性排序并放在新记录前，不伪造旧序号。
- 归档不可恢复接入，保留历史。Moss 创建的专用凭据排队清理；引用的已有凭据由其所有者管理。界面和文档与清理策略一致。
- PostgreSQL migration 12 的两处旧断言同步；验证包含通用 PG backend、全新库、旧库收敛、重跑与外部任务双实例专项。
- 增加目录绑定的 (org_id,id) 索引；已存在的凭据门禁、2MiB SSE累计上限、严格 query-only profile、注册持久幂等和15秒请求生命周期继续保留。

## 操作与升级

协调升级 Moss 和 SudoWork，先使新版任务入口可用，再启用新版客户端；期间不要重放失败或 unknown 的旧请求。任务中声明 synthetic 不意味着已经具备 DLP。管理员在接入和审核时核对真实应用来源，仅用于合成数据试点；需要强来源审计的业务暂不可接入。

## 本轮验证方法

真实 PostgreSQL 环境执行 pgBackend.test.ts 与 externalProviders.pg-test.ts；完整 Moss 测试也设置 MOSS_PG_TEST_URL，避免通用 PG 基线被条件跳过。新增测试覆盖旧 HTTP 入口零写入、强来源拒绝零 Provider I/O、源身份展示与留存、同毫秒/不同期限/时钟回拨后的顺序、归档凭据所有权、alpha3/4快照升级。Work 校验身份字段与创建序号保留、精确来源及完整测试。最终结果、CI和真实联调见本轮交接包。

## 未宣称完成

标准 Moss/Nexus Task持久层与HA、生产并发长流压测、retention/compaction、统一隐藏页面请求治理、不可变远端版本、第二真实平台、客户数据/DLP/下游出口、cancel/resume/callback、原生包和多形态部署仍按后续阶段验收。本轮不删除未知结果、不自动重试、不以本地HTTP夹具冒充真实第二平台。
