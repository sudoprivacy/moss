# Dify / Moss / SudoWork 第二轮复审修复说明

日期：2026-10-13。对应评审：`dify-moss-sudowork-pr-merge-decision-2026-10-13(1).md`。
状态：修复与复验记录，供再次评审；不构成合并、发布或生产准入授权。

## 1. 范围与结论

针对复审第 5.1–5.10 项完成跨仓修复，保留管理员在 Moss「专属智能体 → 外部托管」发布、SudoWork 用户从智能体库进入统一对话的产品流程。本轮升级为 `external-provider.sudo.dev/v1alpha3`，没有把实验 TaskStore 宣称为标准 HA。

## 2. 逐项响应

| 评审项 | 实际修改 | 验证与说明 |
| --- | --- | --- |
| 5.1 Windows clean-build | virtual entry resolver 先将反斜杠归一化，再匹配入口；main/renderer 均保留禁止读取 contracts/moss-client dist 的构建探针。 | 本地两个源码构建探针通过；Windows 实机证据以本轮远端 Windows 全量/构建矩阵为准。 |
| 5.2 Key 幂等遗漏 | 对通过校验的 API key 计算组织及 request_id 作用域的 SHA-256 指纹，将指纹纳入请求摘要；数据库不存 key 明文。相同 ID、不同 key 返回 409 IDEMPOTENCY_CONFLICT；空 key 在查幂等记录前拒绝。 | 同 key 重试只写一次；换 key 冲突；跨组织、PostgreSQL 跨实例回归。旧无指纹请求无法证明凭据相同，返回冲突；不得默认为新 key 已生效。 |
| 5.3 清理生命周期 | 增加写入确认、cleanup_complete 终态和 cleanup_guard。确认写调用已返回的清理进入终态，30 天后分批删除紧凑清理记录；审计独立保留。无法确认远端写结束的记录保留紧凑 guard，每日检查；Secret 不存在时不调用 DELETE。删除失败指数退避，上限一天。 | 已确认清理不再访问 vault；到期回收；迟到写入、检查不存在与写入确认竞争、原有 SIGKILL 测试通过。**不对不确定写入设置任意 TTL**：当前 Secret 端口没有远端写入 fencing，丢弃 guard 会重新引入孤儿 Secret 风险。 |
| 5.4 raw_answer 恢复 | alpha3 增加独立 raw_delta；原文等于展示文本时用 from_answer 引用，避免双份存储。raw-only 增长也触发 checkpoint。原始和展示结果在读取、重启、替换、unknown/failed 终态均可恢复。 | 多次 delta、checkpoint 前读取、重启、JSON 部分结果、替换和 unknown 回归。旧 alpha2 已丢失的原文不能补回，返回 legacy_checkpoint 标记。 |
| 5.5 Attempt 核对 | 新增 external_pilot_reconciliations，与 Task、Attempt 更新时间和审计在同事务记录；升级导入旧核对记录。Attempt 保留 unknown 执行结果，独立核对记录表示本地已关闭。 | 复审中的“正常路径仍 running”不成立：原有 mutate 已将 Attempt 变为 unknown。本轮补的是明确的核对状态；可按 task_id JOIN 查询。关闭幂等且保持会话锁，不伪造成功/取消。 |
| 5.6 流式写入 | 使用 500ms 时间窗的异步合并器：最多一个进行中的持久化和一个待写最新快照；解析不逐帧等待数据库。成功、EOF 或错误退出前排空缓冲，再持久化终态。 | 阻塞写入期间 100 次更新只保留最新值；flush 与数据库错误传播回归。中间未刷数据仍可能因进程崩溃损失，但不重发 Provider 请求。此改动不等于生产并发压测通过。 |
| 5.7 N+1 查询 | 完整 checkpoint 直接返回；待恢复任务用一次按 task_id/sequence 范围的批量事件查询。核对记录在 LIMIT 之前排除，避免最近 100 个已关闭任务遮蔽更早待核对任务。 | 六个已完成任务读取历史为 0 次事件查询，包含进行中任务为 1 次。30 秒全局刷新实际调用 sessions，并非每次重建 transcript；更正原评审描述。 |
| 5.8 固定轮询 | 有更新时 750ms，连续无更新退避为 1.5/3/6 秒；隐藏页面 15 秒，回前台立即刷新；防止重叠请求。积压在前台立即拉取。 | DOM 假时钟覆盖空闲、隐藏、前台、终态停止和不重复创建。原版终态已停止，本轮保留并验证。 |
| 5.9 事件版本 | Event/Page 都要求 api_version 和 kind；消费者解析边界严格拒绝未知/缺失版本。改变 raw delta 语义采用 alpha3。 | 新消费者拒绝不匹配页/事件；存储旧事件触发快照恢复；三仓精确提交与摘要验证。旧客户端须升级，不能声称未实现 envelope 校验的 alpha2 客户端会自动安全识别所有新流。 |
| 5.10 文档旧引用 | stack README 更新 alpha3 及兼容规则；原 Pilot、开发总结和上一轮修复说明明确标记历史，并链接本文。 | 历史 SHA 和历史测试数保留用于溯源，不再作为当前生成/验收步骤。 |

## 3. 契约与升级规则

- Moss 语义源：`3d12c355c52d6017df73efb6d99b0910ad2d4902`，`contracts/external-provider/v1/contract.ts`。
- Source digest：`sha256:cd3102357a54f54ddfdcc902605475654445afe4dc0cea8fc84cfc9b57f11cab`。
- SudoStack 固定读取上述 Git blob 生成产物；SudoWork 固定其 artifact revision、digest 和 source lock，禁止手改生成物。
- `delta` 更新展示结果；`raw_delta.offset/text` 更新原文，`raw_delta.from_answer=true` 表示复制同一事件应用展示增量后的 answer。offset 均为 JavaScript UTF-16 code units。
- checkpoint 条件：64 个事件、展示或原文距上个 checkpoint 增长/缩短达到 8192 字符，或终态。保留 sequence 连续性检查和快照恢复。
- 新任务 `raw_answer_freshness=current`。旧 alpha2 数据标记 `legacy_checkpoint`，不声称历史丢失原文已恢复。
- 先停止旧客户端的进行中读取，协调升级 Moss 与 SudoWork，再恢复会话。alpha3 客户端拒绝旧/未知 envelope；不得用重发创建任务修复版本或读取错误。
- 旧 onboarding request_id 的摘要没有凭据证据时返回冲突。应先检查已存在的智能体；已有智能体改 key 走“更换凭据”，确实新接入才使用新 request_id，避免创建重复目录项。

## 4. 本轮验证

本地专项：Moss 44 项通过（含 4 种凭据 SIGKILL 场景）；SudoWork 23 项通过。Moss 全量服务测试通过，Node 主套件 923 passed / 3 skipped；SudoWork 全量 3152 passed / 29 skipped。PostgreSQL 隔离双实例测试通过，覆盖幂等、换钥竞争、非阻塞读取、原文恢复及核对事务。SudoStack 139 项原有契约测试及 2 项实验生成器测试通过。

Moss 类型基线仍为 104/104，仓库其他既有类型问题未宣称清零。SudoWork desktop 类型检查通过。最终构建、WebUI、远端 CI 与真实 Dify 证据在交付前补入本节。

## 5. 再次评审重点与限制

1. 审查不确定写入 guard 的长期保留是否符合 Pilot 运维要求；若要求全部有限 TTL，先扩展 Secret 服务的过期写入拒绝/fencing，不能只删本地记录。
2. 核对 unknown 执行结果和本地核对关闭的语义，不允许解锁或自动重放原会话。
3. 检查 alpha3 生产构建、Windows 全量、三仓来源检查的最终 head；CI 网络故障与代码失败分别处理。
4. 标准 HA、生产级 Provider 出口、客户数据准入、Dify immutable version pin、cancel/resume 仍未完成。本轮仍为合成数据 Pilot。

PR：[Moss #369](https://github.com/sudoprivacy/moss/pull/369)、[SudoStack #43](https://github.com/sudoprivacy/sudostack/pull/43)、[SudoWork #1234](https://github.com/sudoprivacy/sudowork/pull/1234)。再次评审通过且检查满足要求后，仍按 Moss → SudoStack → SudoWork 顺序评估合并；本次不执行 merge。
