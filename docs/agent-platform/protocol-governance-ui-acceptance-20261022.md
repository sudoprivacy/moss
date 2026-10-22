# 统一 Agent 协议治理：UI 补齐与操作验收

日期：2026-10-22。对应领导提供的《统一 Agent 接入标准：协议接入批次实施、验证与 UI 说明》v0.1。

本轮补齐前次遗漏的目录字段和筛选、版本元数据、状态一致性及真实 Electron 操作验证。Moss 负责管理，SudoWork 负责选择与对话，SudoStack 按精确来源分发契约。这里的完成结论仅适用于该方案限定的实验性协议接入；不等于 Enterprise 1.1 所有生产场景已验收。

## 1. 对应领导方案的完成项

| 方案位置 | 本轮补齐内容 | 验证证据 |
|---|---|---|
| §9.2、§9.4 智能体目录 | 增加智能体目录视图，展示 Provider、协议、外部标识、来源绑定/修订/摘要、适配器、负责人、组织/Zone、审批、已发布版本、执行模式、可观测性、七项能力、最近运行及警告/漂移 | `01-catalog-overview.png`；Catalog SQLite/PG 用例 |
| §9.4 筛选 | Provider、协议、审批状态、目录状态、来源状态、负责人、Zone、执行模式、可观测性、能力、警告、漂移及搜索；组织范围跟随已鉴权的当前组织 | 浏览器逐项筛选与重置；服务端查询/分页/组织隔离测试 |
| §9.4 状态 | 后端统一计算 draft、pending_approval、approved、published、active、deprecated、revoked、archived、unavailable；原接入卡片不再用 `binding.approved` 推断“已发布” | 审核→发布→canary→stable→撤销状态回归；`11-revocation-refresh.png` |
| §9.5 候选 | 展示外部标识与拟登记目录身份，明确来源身份未验证；已发布候选的频道按钮也读取后端版本准入结果 | `04-candidate-identity.png`；候选批准/发布实际操作 |
| §9.6 版本 | 来源修订、来源摘要、适配器版本、审批状态、当前频道、撤销原因、回滚目标、证据级别和不可切换原因；历史元数据缺失明确显示未记录 | `02-version-metadata.png`、`10-channel-rollback.png` |
| §9.7、§9.8 执行记录 | 增加按 Task 分页的规范化事件，展示序号、时间、事件类型、状态、错误码；压缩或缺失历史有说明 | `03-normalized-events.png`；事件权限、游标与脱敏回归 |
| §11、§12、§16 客户端操作 | WebUI 与真实 Electron 都从专属智能体进入统一对话，返回合成 A2A 结果及版本证据；Electron 断网 unknown 后重载不重发 | `05-webui-result.png` 至 `09-electron-reload.png`；调用计数 3→3 |

## 2. 状态逻辑与边界

批准只表明候选通过审核；发布生成固定的 Sudo 版本；启用 stable 后才成为默认选择。仅设置 canary 不会被目录误标成默认可选。管理员本人无需被授权对话即可管理和查看，但成员执行仍保留个人授权检查。

目录读模型通过现有 RegistryReleases 路由读取版本和决定，同时检查当前组织、来源启用、资产状态、接入策略、绑定/凭据连接和版本生命周期。Registry 不可达或不能确认时按不可用处理。GET 不会自动发布 legacy binding、批准版本或推动 Channel。

页面可用性是读取时的结果；任务准入和派发前仍会再次检查权限、版本、元数据与连接。不能把目录显示理解为对未来远端调用的保证。目录在无成员授权时不会标为成员可选。

一个 Agent 可有多个历史版本：当前 stable 被撤销后，若另有未启用的已发布版本，目录显示“已发布且当前不可供成员选择”，版本详情保留各自的撤销状态和原因。不能因为存在另一个已批准版本就让被撤销版本重新执行。

来源快照只能证明当时登记的内容，不代表远端不可变执行、完整 Trace 或来源身份已经可信。历史版本没有记录的 adapter/source revision 不会从当前配置反向填造。A2A 参考服务没有提供 source revision，界面按未记录展示。

## 3. 筛选、分页与事件安全

目录由服务端逐页扫描来源并计算发布状态；动态过滤后的当前页可能为空，但仍有下一页游标。页面明确提示继续加载，避免把当前页无匹配误报为全库无数据。每页最多扫描 50 个来源，并限制对 Registry 的并发。单 Agent 超过 1000 个历史版本时保守返回不可用及明确错误码；大规模历史目录优化不在本轮实验验收范围。

组织不是可任意传入的查询参数，使用服务端鉴权后的 actor.orgId。组织切换或过滤变化会取消旧请求，晚到响应不能覆盖当前页。撤销、频道切换和来源修改后刷新目录及原卡片，避免依赖不变的 binding revision。

事件接口先校验组织、Agent、Task 关联，再检查任务保留状态。每页最多 100 条，仅返回 `sequence/at/type/status/error_code`；不会返回用户 query、answer、delta、原始 Provider payload、credential secret。它不是完整远端 Trace，也不支持凭此重放执行。跨组织/不属于该 Agent 的 Task 均拒绝。

## 4. 验证结果

| 检查 | 结果 | 日志 |
|---|---|---|
| Catalog SQLite（包括四种协议治理、读模型、状态、过滤、事件） | 20 通过 | catalog-ui-server-tests.log |
| Catalog 独立 PostgreSQL schema | 20 通过 | catalog-ui-pg-tests.log |
| Catalog/Registry/发布/协议适配回归 | 53 通过 | catalog-ui-regression.log |
| External Provider 回归 | 64 通过 | catalog-ui-external-regression.log |
| Admin API | 10 通过 | catalog-ui-admin-tests-final.log |
| Admin 类型与生产前端构建 | 通过 | catalog-ui-admin-check-final.log / catalog-ui-admin-build-final.log |
| 服务端增量类型门禁 | 104，对照基线 104；无新增 | catalog-ui-types-final.log |
| 本轮后端 ESLint | 通过 | catalog-ui-lint-final.log |
| Stack 两类生成器 | 5 通过，精确来源校验通过 | catalog-ui-stack-tests.log |
| 浏览器管理端 | 筛选、版本限制、候选身份、事件、来源停用/启用、历史版本回滚、撤销即时刷新通过 | admin-ui / rollback 日志及截图 |
| WebUI | 普通成员选择外部 Agent → 提交 `6 * 7` → 返回 `42` | work-run 日志与截图 |
| 原生 Electron | 实际进程、IPC、Moss、A2A 链路执行及版本证据通过；unknown 重载调用次数 3→3 | desktop-run / desktop-unknown 日志与截图 |

53 项回归包含 Catalog 20，表格不累加成互不重叠的总用例数。Moss 全仓历史类型问题没有在本轮清零，门禁外仍有既有问题；本轮也没有宣称运行所有仓库的所有测试。

SudoWork 本次未新增业务代码，继续使用原分支 HEAD `64e2f1ac728fe2113e5b3b0a3b6ca3959e28554b`。该精确 HEAD 的前次完整测试为 3362 通过、30 跳过，本轮补的是真实 Electron 操作证据，不能把前次日志日期改成本轮重跑。浏览器与桌面均由自动化工具操作，不冒称用户本人已验收。

### 本轮发现与处理

- 原卡片将批准当成已发布：改为后端读模型，撤销/禁用即时刷新。
- 过滤后空页仍可能有后续结果：保留游标和继续加载提示，并增加回归。
- 候选详情里频道按钮原先只看“已发布”：改为读取版本准入结果，状态不明时禁用。
- 原生 Electron 从空隔离目录启动时尝试安装本地引擎，外网下载超时；通过界面“跳过”进入并完成外部托管链路。本地引擎安装不属于本轮验收。
- 完整桌面构建在本机触及 Node 堆上限；未以此冒充打包通过。本轮改用已构建 main/preload 与开发 renderer 启动真实 Electron，没有生成安装包或做签名。
- 初次浏览器脚本等待 networkidle 受到轮询影响；改为等待明确页面状态。一次跨面板切换定位超时后，单独重开页面完成回滚/撤销流程，相关失败没有被当成业务通过证据。

## 5. 提交、契约与评审入口

均继续原分支 `codex/agent-platform-foundation-20261016`，没有创建替代业务分支。

- Moss：Catalog 契约源 `5a3aa94d015468a1d58228b8142e877b5ae992cd`；UI/服务端实现 `2b2ff0d0`。
- SudoStack：`4012e7c`，Catalog 按上述 Moss 完整 commit 和逐文件 SHA-256 分发。
- SudoWork：`64e2f1ac728fe2113e5b3b0a3b6ca3959e28554b`。原分支此前 rebase 的等价提交已核对；仅测试期望随 dev 的历史合并逻辑调整，使用明确旧 SHA 的 force-with-lease 推送。
- [Moss #424](https://github.com/sudoprivacy/moss/pull/424) → dev。
- [SudoStack #88](https://github.com/sudoprivacy/sudostack/pull/88) → main。
- [SudoWork #1287](https://github.com/sudoprivacy/sudowork/pull/1287) → dev。

三个 PR 为草稿，尚未合并。CI 是动态结果，交付包 `revisions.json` 与 `evidence/ci/` 记录最终检查时的精确 HEAD、时间和结论；不能拿较早提交的绿色状态证明新 HEAD 通过。

Catalog 管理读模型与客户端 External Provider 契约分别锁源。本轮只改 Catalog 管理契约，不人为更新 Work 未消费的 Catalog pin，也不把所有契约强行改成一个 Moss revision。

## 6. 范围与数据保留

本地参考实现用于协议一致性测试，不等于通过官方 Dify/MCP/A2A/OpenAI 服务认证。真实商业 Provider 配置、IM→Dify 实例（用户已暂缓）、生产 HA/容量/部署、统一 callback/webhook、完整 replay/resume、多模态、跨 Provider 组合、安装包/签名，以及 Skill/知识图谱/RSI 均不在这次补齐结论内。

旧交付文档与截图保留原始归属；本文件纠正其“UI 已全部完成”的过宽表述，并补上本轮新增证据。无需丢弃旧完整证据包，评审时先看本轮补充包，再按旧包精确提交追溯其他协议与治理能力。

测试沿用隔离实验数据；用户此前要求保留的数据与原有 PostgreSQL 容器不删除。交付包不包含账号密码、token、cookie、凭据种子、数据库、node_modules 或桌面安装产物。临时服务、备份与停止状态在交付包最终说明中记录。
