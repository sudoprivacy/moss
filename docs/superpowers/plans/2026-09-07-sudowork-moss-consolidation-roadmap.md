# Sudowork Server 整合到 Moss 实施路线图

> **给执行智能体：** 每个阶段开始前必须编写独立的细粒度实施计划，并使用 `superpowers:test-driven-development` 按红、绿、重构循环执行。用户明确要求不创建 Git commit，因此所有计划中的验收点只记录工作树状态和测试证据，不执行提交。

**目标：** 在不修改 Sudowork 客户端的前提下，将 sudowork-server 的全部生产能力统一整合到 Moss，并保持旧接口、历史数据和 Moss 云端会话能力。

**架构：** Moss 保留一套领域模型和业务实现。Moss 原生 HTTP 与 Sudowork Hono 兼容 Adapter 共享领域服务和 Repository；本地任务仍由客户端执行，企业任务由 Moss 执行。迁移使用维护窗口，不建立长期双写。

**技术栈：** TypeScript、Node.js、Bun 构建与单元测试、`node:http`、Hono、`@hono/node-server`、`node:sqlite`、PostgreSQL/TimescaleDB、Redis、Nexus、React 管理端。

**Spec：** `docs/superpowers/specs/2026-09-07-sudowork-server-moss-consolidation-design.md`

## 全局约束

- 开发分支固定为 `codex/sudowork-moss-consolidation`，基线为 `origin/dev` 的 `bc3125a126ac9cd4e59beaf195e5cf1d632fca36`。
- 不修改 `/Users/yobach/VSCodeProject/sudowork` 客户端仓库和 `/Users/yobach/VSCodeProject/sudowork-server` 旧服务仓库；二者只读。
- 不创建 Git commit，不暂存文件，不推送远端。
- 每个小任务先运行能证明缺口的失败测试，再实现最小改动，并运行局部测试与相关回归。
- 任一阶段门禁失败时留在当前阶段修复，不继续推进依赖它的后续阶段。
- 兼容 Adapter 不拥有业务数据、不直接执行 SQL、不直接调用外部服务。
- 旧接口 method、path、状态码、Header、响应结构、错误文案、SSE、上传、重定向和副作用语义必须通过差异测试。
- Moss 云端 Session、WebSocket、RuntimeService、重连、恢复、权限、文件和模型能力不得回退。
- UnitOfWork 事务回调必须同步；迁移和 replay 默认抑制外部副作用。
- 所有生产迁移命令使用 Node.js，不使用 Bun 作为迁移运行时。

---

## 阶段与门禁

### P0：开工前验证与契约基线

独立计划：`docs/superpowers/plans/2026-09-07-sudowork-moss-p0-spikes.md`

交付物：

- 可重复运行的 Bun 与 Node 测试基线；
- 受支持客户端版本矩阵格式及候选版本；
- 机器可读的 Sudowork 路由清单；
- Hono 接入同一 `node:http` Server 的验证结果；
- `DatabaseSync` 嵌套事务、同步边界与并发写验证结果；
- 后续领域计划使用的契约测试骨架。

门禁：Hono 与事务 Spike 全部通过，基线测试没有未解释红灯，路由清单可以稳定重复生成。

### P1：身份、组织与兼容认证

前置：P0 通过。

范围：Organization Profile、用户状态、认证身份、邀请审批、旧数字别名、双 Token Profile、密码兼容、Refresh Token 迁移、统一用户创建命令。

门禁：历史用户与 Moss 新建用户均可通过未修改客户端登录；用户、数字别名和钱包初始化原子提交；身份领域旧接口差异测试通过。

### P2：Agent、Skill、配置与 Nexus

前置：P1 的统一 Principal、Organization 和数字别名接口稳定。

范围：统一 Agent/Skill 目录、Provider metadata、模式能力、制品和 checksum、可见性、审批、Organization 配置、密钥迁入 Nexus、上传文件。

门禁：本地与云端读取同一资源；旧下载和上传契约通过；任何响应不泄漏真实密钥。

### P3：Billing

前置：P1、UnitOfWork 和 Outbox 基础能力稳定。

范围：钱包、只追加流水、授信、充值套餐、订单、支付、退款、对账、Fuiou、幂等回调和审计。

门禁：财务并发测试、幂等测试、回调验签测试和余额对账全部通过，差异为零。

### P4：Dify Provider

前置：P1、P2。

范围：Connection、Agent binding、Dataset、ACL、SSE 对话、历史、反馈、文件、音频和 SSO。

门禁：旧 Dify 接口字节级/结构级契约通过，影子测试不执行真实写入，Moss RuntimeService 不受影响。

### P5：QMS

前置：P1 Organization 映射稳定。

范围：TimescaleDB 生命周期、API Key、RSA-OAEP/AES-256-GCM、遥测、Crash、Source Map、统计、告警、聚合、保留和审计。

门禁：双 Crash 前缀、加密载荷、时序数据和权限差异测试通过；QMS 数据不写入主 SQLite。

### P6：企业自动化

前置：P1、P2。

范围：企业 Cron、Event Trigger、Channel、lease、run、Session、历史、统一用户与资源解析。

门禁：集群单执行、失败恢复和云端 Session 回归通过；本地 Cron/Channel 所有权不改变。

### P7：兼容接口与管理端收口

前置：P1 至 P6 各领域兼容路由已随领域交付。

范围：补齐全部 216 个 method/path、静态资源、上传访问、旧管理能力在 Moss Admin 的对应页面和全量契约差异。

门禁：机器清单中不存在未实现或未批准例外的接口，受支持客户端版本矩阵全部通过。

进度（2026-09-08）：本地实现与回归已完成，216/216 路由及 Dify、QMS、Billing、Hub 细分契约通过，Bun/Node 全量测试和正式构建通过。生产门禁尚未关闭：客户端矩阵仍为 `candidate`，且真实基础设施、Fuiou 验签样本与在线差异验证未执行。因此可继续开发 P8 工具，但不得进入生产迁移或切流。

### P8：迁移、演练、切换与回滚

前置：P1 至 P7 全部通过。

范围：Node 迁移 CLI、checkpoint、resume、冲突报告、Import Command、副作用抑制、全量校验、生产演练、切换和回滚工具。

门禁：代表性生产副本至少两次迁移结果一致，财务差异为零，迁移来源外部 Outbox 待处理数为零，回滚演练通过。

进度（2026-09-08）：本地开发与 fixture 门禁已完成。Node 迁移 CLI 已接入固定十阶段统一领域 Import Command、只读源指纹、checkpoint/resume、十项最终校验、不可变中英文报告、migration/replay 副作用抑制和受审批 redelivery；多组织中断恢复与重复执行测试通过。中文切换手册位于 `docs/superpowers/runbooks/2026-09-08-sudowork-moss-migration-cutover.md`。生产门禁仍未关闭：需要两次代表性生产副本迁移、真实基础设施、正式客户端矩阵、Fuiou 样本和两类回滚演练。

### P9：最终全量验证

运行所有 Bun 测试、Node 专用测试、构建、契约差异、客户端矩阵、云端 Runtime 回归、迁移演练和安全检查。只有全部通过且不存在一级、二级问题时，才允许生产切换。

本地验证记录（2026-09-08）：Node 538 通过、2 个真实基础设施用例跳过；Bun 392/392；正式构建通过；216/216 兼容路由及 Hub、Billing、Dify、QMS 冻结契约检查通过；云端 Session 和企业自动化回归通过。客户端矩阵状态仍为 `candidate`，因此 P9 生产门禁未完成，当前结论仅为代码可进入生产副本演练。

## 进度记录规则

每完成一个任务，在对应阶段计划中记录：

1. 失败测试命令与预期失败原因；
2. 修改文件；
3. 通过的局部测试及数量；
4. 通过的相关回归及数量；
5. 尚未解决的风险或经批准的基线豁免。

任何“已完成”结论都必须引用当次最新测试输出，不能依赖历史运行结果。
