# 统一 Agent 协议治理：完整实施与验证说明

日期：2026-10-22。依据：领导提供的《统一 Agent 接入标准：协议接入批次实施、验证与 UI 说明》v0.1，以及本仓 P0–P4 实施计划。

**更正：本文记录前次交付，当时 §9.4/§9.6 的部分 UI 及本轮 Electron 操作验收尚未补齐。新增完成项请以 [UI 补齐与操作验收](protocol-governance-ui-acceptance-20261022.md) 为准。** 交付的是实验性外部 Agent 接入与治理闭环，不代表 Enterprise 1.1 全部发版，也不代表商业 Provider、生产部署或全部协议能力已验收。代码保留在三仓原分支 `codex/agent-platform-foundation-20261016`；本轮新提交尚未 push、创建 PR 或合并。

## 1. 做成了什么

组织管理员现在可以在 Moss 的“智能体管理 → 专属智能体 → 外部托管”中，配置来源连接、同步服务描述、查看候选差异、提交和批准审核、发布固定版本，再明确切换 stable / canary。普通获授权成员在 SudoWork 的“智能体库 → 专属智能体”选择智能体，通过原有对话界面执行，查看结果和版本依据。

完整链路：

```text
配置受控连接与凭据 → 创建 Source → 测试/同步元数据
  → 固定 Candidate 快照及 ValidationReport
  → 提交审核 → 批准 → 发布 Version → 切换 Channel
  → 授权用户选用 → Task 解析/准入 → 固定派发证据 → Provider 调用
  → 结果或 unknown → 用户版本依据 + 管理员运行记录与审计
```

几个对象各有职责：

| 对象 | 用途 | 不代表什么 |
|---|---|---|
| Source | 管理服务地址、凭据引用、源定义、成员授权和同步状态 | 不自动获得发布/执行权限 |
| Candidate | 固定一次导入内容、差异、能力、权限申请及校验依据 | 未批准候选不可执行 |
| Version | 对已批准内容建立固定的本地版本 | 来源快照不保证远端模型/提示词不可变 |
| Channel | stable / canary 指向明确版本，可受控回退 | 发布版本不会自动移动频道 |
| Task / Attempt / Session | 记录 Sudo 请求、执行尝试及对话 | 不与 A2A Message / Task ID 混用 |
| Provenance / Audit | 保存派发时事实及管理操作关联 | 不倒填历史、不伪造完整 Trace、身份认证或可信成本 |

台账继续负责企业资产登记/治理；Source/Candidate 负责具体外部接入的导入、审查和发布。两者不是同一个状态机。本轮没有迁移台账，也没有把管理员管理操作搬进普通用户对话。

## 2. 对应领导方案的实现

| 方案章节 | 本轮落实 | 代码入口 |
|---|---|---|
| §2 基线与证据 | 原分支、精确源提交、生成摘要、分层测试、真实浏览器证据 | 本文、交付包 revisions.json / checksums.sha256 |
| §3–5 协议与 Contract | 保留 Dify、HTTP、OpenAI Chat Completions、MCP、A2A 的限定子集；真实协议取自校验后的 Manifest | agentFederation/catalogAdapter.ts、standardHttpAdapter.ts、contracts/agent-catalog/v1alpha1 |
| §6–8 来源/候选/治理与执行 | Catalog SPI、同步、去重、修订冲突、校验绑定、审核/发布分离、频道和准入 | catalogGovernance.ts、catalogStore.ts、catalogRoutes.ts、externalProviders/service.ts |
| §9.3 来源连接 | 创建、编辑受控地址/定义/成员、测试、启停、同步、错误与能力 | admin/components/external-agent-catalog.tsx |
| §9.4–9.6 目录/候选/详情 | 协议、状态、负责人、能力、可观测性、警告与搜索筛选；快照/差异/权限/审批；独立版本频道面板 | external-agent-catalog.tsx、external-agent-versions.tsx |
| §9.7、§10 用户执行与证据 | 统一对话、单轮限制、七项能力、派发时快照、未知和历史缺项的真实展示 | Work ExternalTaskEvidence.tsx、ExternalAgentUsageDetails.tsx、MossExternalProviderClient.ts |
| §9.8 审计 | Source → Candidate → Version → Channel → Task 关联，Provider IDs、组织/操作者/时间、分页、脱敏 | catalogStore.ts、catalogGovernance.ts |
| §11–12 客户端和验证 | Desktop/WebUI 共用 renderer；WebUI 转发新证据 profile；浏览器完成管理/消费/撤销/断网流程 | WebUI externalProviderRoutes.ts、测试及截图 |
| §13 单仓交付 | Moss 拥有语义与管理，Stack 生成分发，Work 消费与对话；未建立新契约仓库 | 三仓原 worktree |
| §14–17 范围与检查 | C01–C15 及 §16 清单逐项对应，生产/真实平台状态单列 | 下文 |

UI 分工说明：领导稿 §13 的部分工作项与 §1、§9 的管理员归属不一致。本轮沿用已经确定的“Moss 管理、SudoWork 使用”，采用现有专属智能体入口及面板，没有再建第二个管理员状态机。

本轮是 external-hosted 专项，执行模式固定为外部托管；组织范围使用全局组织切换器强制隔离；没有来源的 Zone 明确显示“未记录”，没有提供一个前端可自行授予的 Zone。Provider 兼容存储类别不作为真实协议展示。版本、运行、审批及审计通过关联面板进入，不要求用户在一个巨型列表里阅读所有字段。

## 3. 协议能力和真实边界

| 来源 | 本轮实现/验证 | 限制 |
|---|---|---|
| Dify | 既有执行适配；新增候选治理；合成 HTTP Dify 服务验证 | 本轮未重新验收真实 10.0.1.158 环境；受支持 DSL 限制约束，远端提示词不能由公开元数据完整核对 |
| HTTP v1alpha1 | Manifest 读取、归一化、单轮 /invoke、文本结果与治理测试 | 不保证远端幂等、恢复或完整 trace |
| HTTP v1alpha2 | 复用既有持久化调用/查询恢复路径，并跑相关回归 | 不是任意 HTTP 服务都兼容 |
| OpenAI compatible | Chat Completions 单轮文本、stream:false、n:1 | 不支持 Responses、工具、多模态或流式 |
| MCP 2025-06-18 | Streamable HTTP；initialize、tools/list、已批准 query:string 工具 | 不支持 stdio、任意工具编排、sampling、资源及 elicitation |
| A2A 0.3.0 | 单 skill 文本、message/send、tasks/get；本轮完整 WebUI 验收 | 不支持 push、流式、多模态、人工等待后继续 |
| LangChain / LangGraph | 可作为服务暴露以上约定协议 | 框架工程不能直接导入；框架名不是协议 |

Catalog SPI 的发现范围是 **configured_agent**：管理员提供连接和 Agent 标识/Manifest 后读取该服务描述。它不扫描任意企业网络，也不枚举任意 Dify 工作区里的全部应用。发现/同步只读元数据，不发业务任务。

七项能力为 streaming、cancel、resume、idempotency、trace_export、version_pin、human_approval。能力来自适配器事实；不支持的能力不允许管理员手工勾选为支持。human_approval 指 Provider 运行中的人工介入，与管理员审批发布不同。

## 4. 关键行为与本轮修复

- 同一快照重复同步返回同一候选；来源内容变化生成新候选，旧版本及历史保留。同一个 provider revision 对应不同内容时报冲突。
- 来源、授权、策略、凭据版本、私有绑定或适配规则变化后，旧校验不能直接用于发布。Source 编辑不直接覆盖正在运行的 binding。
- 未批准候选不可发布/执行。新版本发布、频道切换、任务执行是独立操作；并发修改使用 revision 和事务约束。
- 来源停用、版本撤销/弃用/归档阻止新任务。已派发远端工作保留真实状态，不声称已被取消。
- 发布响应丢失可以核对原固定版本，不能盲目再发布；显式封存仅隔离本地未知发布，不声称远端已经取消。重新审核创建新的审核轮次，不复活原版本。
- 调用已派发但无法确认结果时保持 unknown；重载、恢复观察不自动重发。能够证明未派发的准入拒绝保留 rejected/failed。
- 每次派发在授权事务内保存 Source/Candidate、真实协议、适配器版本、能力及摘要；展示历史时不读取当前配置冒充原事实。
- 旧严格 evidence 客户端保持原形状；新版通过 `?profile=catalog-v1` 获取扩展。真实浏览器发现 WebUI 代理丢失该参数，已经修正并补路由回归测试。
- 修复跨分页打开版本/候选详情和批量查询 managed 状态，避免当前列表页决定是否能管理某个来源。
- 审计未知结果显示“核对原操作，不要重发”，避免泛化“重试”文案误导管理员。
- provenance 保留清理按仍存在的记录分批推进，修复首批墓碑阻塞后续清理；两次维护批次测试证明旧记录逐批清理，未退休记录保留。

## 5. 契约归属与精确锁

Moss 为语义源，Stack 从精确 Git blob 读取并校验来源与 SHA-256，Work 消费 Stack 精确产物。本轮仍为实验契约，不宣称已发布稳定的六份产品契约。

| 项目 | 值 |
|---|---|
| Moss 契约源提交 | c356ce319087e5926104bb3f8c0aba40d609420e |
| Catalog 类型摘要 | sha256:5b08205c99f4360e8be529e2ce427c7adf0e45bfe38674ced79799753a4b1530 |
| Catalog schema 摘要 | sha256:8c421e486b9c0eff0333330746cc587ed69b0622f6c10228aa1a1fe702ecf5d2 |
| Stack 分发提交 | a172557（完整 SHA 见交付包 revisions.json） |
| Work 消费提交 | 64e2f1ac（完整 SHA 见交付包 revisions.json） |
| 管理 API | agent-catalog.sudo.dev/v1alpha1 |
| 用户 evidence | 外部契约 v1alpha5 的可选扩展 + 显式 catalog-v1 profile |

契约源提交早于 Moss 后续业务提交是有意分层，生成器只取该提交的契约文件；最终 HEAD 与契约源无需相同，但字节必须一致。精确锁与字节检查已通过。新提交未推送，因此本轮不提供远端 CI 已绿或 PR 可合并的结论。

## 6. 验收矩阵 C01–C15

| ID | 结论与证据 |
|---|---|
| C01 相同来源重复同步 | 4 种协议治理测试确认同一快照只产生同一候选、每次同步保留记录 |
| C02 来源更新 | 协议治理测试确认新候选/差异，旧发布保持；浏览器重新审核创建第二个版本 |
| C03 revision 复用 | `reusing a provider revision...` 拒绝不同内容复用同一修订 |
| C04 未批准与组织权限 | 未批准不可发布；跨组织拒绝；真实登录普通成员读管理 API 返回 403，其他组织看不到来源 |
| C05 校验依据失效 | 连接、密钥版本、策略、私有快照修改分别使批准失效 |
| C06 并发 | 并发决定/发布/频道测试确认不重复创建版本、频道 revision 防覆盖 |
| C07 发布结果未知 | 丢失发布响应可核对同一版本；部分发布可封存，无二次 publish |
| C08 不可达/启停 | 协议故障与来源启停测试；历史保留，重新启用不恢复被撤销权限 |
| C09 撤销与回退 | 发布测试/既有版本回归；浏览器撤销后旧会话新请求返回 rejected，attempt_id=null，提供方调用计数为 0 |
| C10 执行证据 | 来源编辑不改变已有 provenance；历史缺项不倒填；浏览器实际显示七项能力与 Source/Candidate/Adapter |
| C11 审计脱敏 | 组织过滤、时间游标、能力上下文及 secret 排除；浏览器按 Task 搜索关联运行/派发记录 |
| C12 协议 | Dify 合成 HTTP + HTTP/OpenAI/MCP/A2A 自动化矩阵；A2A 独立参考进程完整 UI 流程 |
| C13 升级和兼容 | 显式纳管、GET 只读、旧 evidence 兼容；SQLite 和独立 PostgreSQL 路径通过 |
| C14 Desktop/WebUI | 共用 renderer，客户端/DOM/类型回归；真实 WebUI 验证重载不重发。未启动 Electron 做本轮原生人工验收 |
| C15 十步实际操作 | 浏览器操作完成配置、Manifest、测试、授权、批准发布、用户目录、对话42、证据、撤销拒绝、响应丢失unknown；截图01–13 |

浏览器证据由 Playwright 操作真实页面、真实鉴权、真实本地存储、独立 A2A HTTP 进程产生；不是 mock 页面或仅接口脚本。它属于本地合成环境操作验证，最终人工体验复核仍交给评审方。浏览器脚本曾因文案/异步筛选定位错误失败，修正定位后验证；不能把这些脚本失败写成业务故障。真正发现的 WebUI 转发缺陷已修复并有回归测试。

## 7. 测试结果与复现

| 检查 | 结果 | 证据文件 |
|---|---|---|
| 新增 Catalog，SQLite | 16 通过 | protocol-governance-catalog-final.log |
| Moss 9 文件相关回归（含上项，不可重复相加） | 139 通过、1 跳过、0 失败 | protocol-governance-moss-regression-final.log |
| 独立 PostgreSQL，Catalog + 现有跨实例测试 | 18 通过、0 跳过 | protocol-governance-pg.log |
| Moss 管理 API | 8 通过 | protocol-governance-admin-api.log |
| Moss admin 类型/构建 | 通过；构建仍有既有大 chunk 提示 | admin-current / admin-build 日志 |
| Moss 服务端 type ratchet | 104 个错误，等于既有基线；其他范围1336个未门禁错误 | protocol-governance-ratchet-final.log |
| Moss 定向 lint | 通过 | moss-lint / retention-lint 日志 |
| Stack 生成/身份/摘要/schema | 5 通过，生成 --check 通过 | stack-final / stack-check / stack-external-check 日志 |
| Work 客户端+DOM+locale | 59 通过；包含在下面全量中 | protocol-governance-work-targeted.log |
| Work 全量（root 转发 Desktop Vitest） | 3362 通过、30 跳过；365文件通过、7文件跳过 | protocol-governance-work-full-final.log |
| WebUI 转发专测 | 10 通过（含新 profile 回归） | protocol-governance-webui-proxy.log |
| Work 类型 | client、renderer、desktop、WebUI client/server 检查通过 | 对应 type / webui-ts 日志 |
| Work 精确产物核对 | 通过 | protocol-governance-work-contract.log |
| 真实浏览器 | 管理、消费、撤销、续审、断网、重载、运行审计通过 | browser 日志、截图01–13 |

早期 Work 全量中一个既有 ontology 测试在并行构建时超时；该文件单独53项通过，随后低并发完整重跑通过。PG 既有测试修复了仅等待本实例 promise 的测试假设，改为等待共享持久状态；独立跨实例验证现已通过。Moss 全仓类型错误并未清零，也未宣称运行了所有 Moss/WebUI 测试。

主要复现命令（在对应 worktree 执行）：

```sh
# Moss
node --import tsx --test --test-force-exit src/server/agentFederation/catalogGovernance.node-test.ts
node scripts/typecheck-ratchet.js
# Moss/admin
bun run check
bun test tests/agent-catalog-api.test.ts tests/external-agents-api.test.ts
bun run build
# PostgreSQL：MOSS_PG_TEST_URL 指向一次性独立测试库，禁止使用原业务库
node --import tsx --test --test-force-exit src/server/agentFederation/catalogGovernance.node-test.ts src/server/externalProviders/externalProviders.pg-test.ts
# Stack：<Moss checkout> 为准确来源仓库
node contracts/experimental/agent-catalog/generate.mjs --owner '<Moss checkout>' --check
node --test contracts/experimental/agent-catalog/generate.test.mjs contracts/experimental/external-provider/generate.test.mjs
# Work
bun run test --maxWorkers=2
node scripts/check-external-contract.mjs --stack '<Stack checkout>'
# Work/apps/webui
bun run test tests/unit/server/externalProviderRoutes.test.ts
bun run typecheck
```

隔离 UI 启动入口为 `src/server/testing/catalogGovernance.fixture.ts`，必须显式设置 MOSS_CATALOG_FIXTURE=1；其 Secret 后端是测试内存/私有种子，不能拿来当生产 Nexus Vault。交付包脚本读取外部私有配置，包内不附账号密码、cookie、token、数据库或 Vault 内容。

## 8. 管理员和用户如何复核

1. 管理员选择组织，进入“智能体管理 → 专属智能体 → 外部托管”。
2. 配置接入范围；接入外部智能体，选择已批准 API 地址或按原审批流程提交新地址。
3. 上传受支持的 Manifest / Dify 定义，填入测试凭据；测试连接，选择测试成员并保存。
4. 在来源连接点击“测试连接”“同步 / 重新导入”，查看候选快照、能力、警告、权限和差异。
5. 填写审核说明，依次“提交审核 → 批准候选 → 发布固定版本 → 设为 stable”。
6. 普通获授权成员登录 Work，“智能体库 → 专属智能体 → 开始对话”，输入合成问题；查看结果及“版本依据”。
7. 管理员从 Source 打开“版本与频道”，填写原因撤销；原对话的新请求应显示“未执行”，历史结果仍可看。
8. 重新发起审核会生成独立候选，新版本获批发布后才可使用；不能恢复原撤销版本。
9. 测试 Provider 在收到业务请求后断开响应。Work 应显示“结果待核对”并锁定提交；刷新页面，调用计数仍为1。
10. 管理员查看“执行记录”和“审计记录”，按 Task 查 Source/Candidate/Version/Attempt/Provider ID 关联；不应看到密钥或原始业务输入输出。

## 9. 数据、升级和服务状态

新增治理表和索引是增量创建。常规启动不自动破坏性迁移旧 external-Pilot 任务，不删除旧 ID、频道或历史；旧接入通过管理员显式纳管。旧客户端的 evidence 默认读模型保持兼容。

上线时先备份并完成同一版本 Moss 服务端的整体升级，再启用新的候选治理流程。**本轮不支持新旧 Moss writer 混跑后共同管理新 Source**，旧服务不了解新增准入规则；旧客户端兼容不等于旧服务端 writer 兼容。生产 HA/滚动升级需要另做部署验收。

本轮临时端口43148、26808、26809、22174已停止；两个新建测试PG容器已移除。原有实验数据保留。新增隔离验收数据库另以SQLite备份和已检查目录的PostgreSQL归档保存在 `~/.local/share/sudo-agent-labs/protocol-governance-20261022`，该目录私有，未放进评审包。

原 `agent-v11-pg-20261021` 数据在 tmpfs，故保留容器运行以避免丢数据。早期测试曾耗尽其128MB空间；已经在线扩至256MB，并仅删除本轮新建的11个临时 catalog 测试 schema，原业务数据未删除。之后所有新增PG验证均使用独立512MB测试容器。

## 10. 给评审方的结论和边界

方案 §16 的代码、契约锁、协议语义、能力、未批准/撤销准入、unknown不重发、脱敏、ID区分和本地操作检查已有证据。交付包提供三仓精确SHA、分层测试日志、13张页面截图、可复核变更和文件摘要。

以下仍保持未验收，不纳入本轮完成结论：

- 真实商业 Provider / 真实模型调用、生产部署、HA/TLS/故障切换、成本账本和完整数据出境治理。
- 任意网络自动扫描、任意平台工作区应用枚举、框架工程直接导入，以及协议矩阵明确不支持的能力。
- 全新稳定产品六契约、可信远端不可变执行、完整分布式Trace和来源身份可信证明。
- 本轮 Electron 原生人工体验、人工复核、远端CI/PR合并；桌面安装包/签名仍按用户要求后置。
- 对话转Skill、问题转知识图谱、RSI及其他Enterprise范围。

评审重点建议放在：并发发布的状态迁移、校验失效条件、旧数据纳管、组织和版本准入、未知结果封存/不重放，以及来源快照与真实执行证明的区别。不要把本地参考服务返回42视为商业平台互通或生产上线证明。
