# Dify / Moss / SudoWork 评审问题修复说明

日期：2026-10-13  
对应评审：`dify-moss-sudowork-pr-merge-decision-2026-10-13.md`  
执行依据：`dify-moss-sudowork-merge-review-response-2026-10-13.md`

## 1. 本轮结论与范围

本轮已按复核意见修改 Moss、sudostack 和 SudoWork，覆盖执行快照、审核版本、凭据恢复、旧管理隔离、事件增量、契约 CI，以及桌面/WebUI 的消费、登录恢复、上下文门控和六语言文案。管理员继续在 Moss「专属智能体 → 外部托管」管理发布，用户在 SudoWork「专属智能体 → 外部托管」选择并进入统一对话。

这些修复仍属于 **Dify 合成数据 Pilot**，不构成生产上线或完整 HA 能力验收。三个 PR 本轮不执行合并。真实 Dify 地址 `http://10.0.1.158:8089` 首次检查曾超时，网络恢复后已完成本次真实 Provider 与管理/WebUI 界面联调；两轮返回 `42 → 50`，没有复用旧验证结果。Electron 实际应用另验证 `7 × 8 → 56` 及刷新后的历史恢复。

## 2. 十项主要评审问题

| 评审项 | 修复内容 | 本轮验证 / 边界 |
| --- | --- | --- |
| 3.1 最终检查与实际派发配置不一致 | Task 记录 `configuration_revision`；审核绑定 Secret version；轮换写入独立 Secret ref。预检后锁定 Binding 与组织策略，比较完整执行快照、复核身份与目录/连接准入，记录 `dispatch_authorized_at`；实际派发和解码使用同一快照。 | 换钥并重新审核、endpoint、decoder、ACL、停用、策略禁用的预检竞争回归；PostgreSQL 双实例换钥竞争。授权时点之前的变更拒绝旧快照；不承诺追回已授权或已经送达 Provider 的请求。 |
| 3.2 旧 Dify 管理路径隔离不完整 | 统一 `isExternalHosted`；旧管理列表/详情、ACL、dataset、enhancement、默认连接和删除拒绝外部记录；删除在登记旧操作前拒绝外部记录；原生按名称查重排除外部记录。 | 真实旧服务调用回归、原生同名创建隔离；保留原生删除幂等重试语义。未扩大为整个 Catalog 写入模型重构。 |
| 3.3 Pilot 未接标准 HA | 启动即启动维护；accepted 超时拒绝，dispatching/running 超时记 unknown。增加组织管理员待核对任务页、核对说明与审计接口。 | 核对关闭后依然保留 unknown、历史和会话锁；禁止重放原任务。真实 kill 测试针对凭据操作，任务生命周期另由持久化/超时和 PostgreSQL 并发验证。尚未迁入 `session_attempts/server_instances/generation` 标准 HA。 |
| 3.4 未限制上传能力 | `/parameters` 校验拒绝 `file_upload.enabled=true` 和旧式 `file_upload.image.enabled=true`，审核与派发预检共同使用。 | 现代/旧上传开关负向测试；原有输入表单限制和 Start/LLM/Answer DSL 节点限制继续生效。 |
| 3.5 审核 revision 可选 | HTTP 与服务边界均要求正的安全整数 revision；缺失/非法 400，旧版本 409。管理员对当前详情版本确认审核。 | 缺失、0、负数、小数、字符串、旧版本、准确版本的双边界测试。 |
| 3.6 换钥进程中断后卡死 | 新增持久 `external_pilot_operations`：组织作用域幂等键、60 秒租约、目标 Secret ref、操作状态和恢复记录。已写 Secret 恢复为未审核草稿；未写则安全放弃并要求重新换钥。保留清理 tombstone 并重试，阻止迟到写入发布。归档禁用连接并登记所属 Secret 清理。 | onboarding/rotation × 写入前/写入后，四种真实子进程 SIGKILL；过期操作、迟到写入、Secret 清理、旧 finally-only 中断升级测试。恢复绝不自动批准。外部已有引用的 Secret 不视为本功能所有，不自动删除。 |
| 3.7 契约来源 / CI 未闭环 | Moss 语义源固定 SHA → sudostack 精确读取 Git blob 并生成 → SudoWork 固定 sudostack SHA、artifact digest 和 source lock。两仓新增真实工作流闸门及负向漂移测试；sudostack 使用独立工作流，保留已审核稳定工作流字节。 | 本地精确来源检查、原有 sudostack 冻结包面测试、新增生成器/消费器负向测试。实验契约保持 experimental 导出边界，不修改已冻结稳定包面。远端 CI 状态见第 5 节。 |
| 3.8 累计 answer 事件放大 | 升级到 `external-provider.sudo.dev/v1alpha2`；事件使用 `delta.offset/text` 和有限状态。每 8192 answer 字符变化或 64 个事件保存 checkpoint，终态保存完整结果。客户端按连续 sequence 消费；首次、游标异常、旧事件或终态提供快照恢复。 | 128000 字符长回答、分页、替换、快照、重复/缺失序号与 offset 校验。实测事件文档从 8273812 降至 166445 字符，减少约 98.0%，约为最终答案的 1.30 倍（原 64.6 倍）。不把 JS/数据库字符统计称为磁盘字节。 |
| 3.9 每次请求重复过期扫描 / 读取写锁 | 移除路由和创建请求中的重复 expire，后台合并维护；保留派发前 deadline 检查。事件读取只使用 SELECT，以读到的已提交 sequence 为查询上界，不再执行 no-op UPDATE。目录批量读取 Catalog/Connection。 | 驱动调用测试确认事件读取无写 SQL；PostgreSQL 在另一事务持有任务行写锁期间仍可读取一致事件页；两个实例竞争过期处理保持终态与会话锁。 |
| 3.10 六语言缺失 / 名称不一致 | en-US、zh-CN、zh-TW、ja-JP、ko-KR、tr-TR 补齐 45 条实际使用的 `external.*` flat keys，统一目录及外部/内部托管名称，Dify 显示使用 i18n。删除已退役客户端管理入口的无引用文案。 | 六种语言分别用真实 i18next、关闭语言 fallback 检查所有 key、占位符集合和插值结果；不是只比较 JSON 条数。 |

## 3. 七项补充问题

| 补充项 | 修复与验收 |
| --- | --- |
| 401 refresh | 保留已有预刷新；桌面和 WebUI 在上游意外 401 后强制刷新并最多重试一次。POST 复用相同 body / 幂等身份；桌面检查当前身份，WebUI 使用当前会话并验证 Moss 地址未变化。测试覆盖一次恢复、连续 401 不循环及身份切换拒绝。 |
| 无 Moss 上下文仍轮询 | 新增宿主 `externalProviders.context`。WebUI 通过本地会话信息提供 readiness，桌面通过本地服务器/身份/令牌信息提供；目录和历史依 readiness 请求，不以 enterprise_code 是否非空推断。 |
| 目录逐项查询 | 可执行目录批量载入 Catalog 与 Connection，再逐 Binding 检查；没有把不存在的 history 逐 Binding 查询列为修复成果。 |
| 跨组织 onboarding UUID | 按 `(org_id, kind, request_id)` 唯一；agent ID 独立随机生成。两个组织使用同一 UUID 可各自完成且各自幂等。迁移旧操作记录，保留旧幂等 hash 兼容。 |
| hosted 名称阻止 native 创建 | 合并到 3.2，原生名称查询排除 `external_hosted`，有原生兼容数据库回归。 |
| 共享 Markdown | 共享 Markdown 增加 `isExternalContent` 模式：禁用 HTML、自动图片、本地/工作区文件访问和非 http(s) 链接，保留代码高亮和数学渲染；链接隔离 opener。实际共享渲染器安全回归通过。 |
| reference_compat 证据 | API/管理页区分 `registration_mode` 和 `definition_evidence`；兼容引用显示 digest-only 提示，完整接入显示经过 DSL 验证。标记不会补齐缺失定义，也不提供 Dify 版本固定或运行中定义不可变保证。 |

## 4. 升级与操作说明

1. 本轮 alpha2 改变事件页结构，Moss 与 SudoWork 应协调升级，不能将新客户端与旧事件 API 混用。已有任务可按 alpha2 投影，旧流事件通过快照恢复，不自动重新执行。
2. 旧已审核 Binding 若缺少 Secret version，启动迁移后改为未审核。管理员需在 Moss 外部托管页核对定义与权限、测试连接、重新审核发布。
3. 旧版本遗留 `credentialUpdating` 且无持久操作 ID 时，管理锁会解除，但显示需重新换钥；完成换钥并审核之前不可执行。
4. unknown 任务：管理员在「待核对的外部任务」查看远端引用，检查 Dify 运行记录，填写至少 10 字符依据，记录核对并关闭会话。该操作不会取消远端任务、伪造成功或解锁原会话；用户需要新建对话，不能将原业务动作自动重试。
5. 凭据恢复每批最多 25 条，凭据维护约每分钟运行；清理 tombstone 成功后仍按小时复查以处理迟到写入。试点数据量与单功能状态恢复不能推导为完整 HA 或无限规模保障。
6. 本轮已重新完成管理员接入/连接测试/审核授权/换钥/停用/归档、普通用户目录/连续两轮对话/历史恢复。全过程仅用合成输入，不修改上游实际应用定义或轮换上游 App key。临时验收智能体已归档；原验收助手在核对真实定义后重新审核发布 1 天。

## 5. 验证记录与 PR

- Moss `bun run test`：server 测试 201 通过、5 跳过；runtime 测试 138 通过；Node 测试 914 通过、3 跳过；0 失败。跳过项为原有测试的环境限制。
- Moss PostgreSQL 专项：独立 PostgreSQL 16、独立随机 schema、两个实例、12 个并发同幂等请求、预检竞争、行锁下事件读取、unknown 核对：1 项通过；未使用现有试点 PostgreSQL 数据库。
- Moss typecheck ratchet：`104 / baseline 104`，没有提高基线；该结果不表示整个历史代码库零类型错误。Moss lint 通过。
- Moss 管理端：4 项 API 测试通过，覆盖审核版本、接入幂等、scope 取消、错误脱敏、unknown 核对 API 路径回归通过；类型检查通过。
- sudostack：139 项原有测试、2 项新增生成器测试、experimental TypeScript 检查通过。
- SudoWork：降低构建并发后的完整复跑 **3150 通过、29 跳过、0 失败**（含两个源码构建入口；WebUI 构建产物已存在，因此 favicon 检查不再跳过）。首次全量的 4 项既有 UI 测试超时全部消失；未修改这些测试或提高测试超时。桌面与 renderer 类型检查通过。
- Electron 生产代码构建：8 GiB Node 堆下 main/preload/renderer 构建通过；为操作验证在本地构建 banner 中指定已有隔离试点数据目录，不更改提交代码或实际用户目录。
- WebUI：unit/contract/integration 总计 375 项通过；使用隔离测试 PostgreSQL；types/format 通过。生产构建在 Node 堆上限 8 GiB 下通过（默认堆首次不足），存在既有浏览器依赖/chunk 提示。
- 真实 Dify：新 alpha2 客户端 → 鉴权 Moss → 真实 Nexus Secret → Dify Chatflow，两轮 `42 → 50`；请求幂等、连续会话、历史重载、未鉴权拒绝通过。真实管理/WebUI 界面另完成 10 项生命周期检查，`pageErrors: []`。

| 仓库 | 现有 PR | 目标 |
| --- | --- | --- |
| Moss | https://github.com/sudoprivacy/moss/pull/369 | dev |
| sudostack | https://github.com/sudoprivacy/sudostack/pull/43 | main |
| SudoWork | https://github.com/sudoprivacy/sudowork/pull/1234 | dev |

本轮开始收尾时已 fetch 三仓目标分支，均无尚未包含的新提交，不需要重复 rebase。sudostack HTTPS 拉取受失效本机代理影响时，使用单次命令禁用代理，没有修改全局网络配置。

固定来源链：

- Moss source：`2bae843f5c29e239afa0ff2a3ef7239c3045d134`，`contracts/external-provider/v1/contract.ts`。
- Source digest：`sha256:da0a3662aa77f92d0aae4f5bbea9dade7d2451fb938dbf56e1871cce70112212`。
- sudostack artifact commit：`cced11a2a550846df3957a9035ed0fb293b7a8ec`，`contracts/experimental/external-provider/contract.gen.ts`。
- Artifact digest：`sha256:2d2f9765020d74d02d1ff0b8928a489c6a2c06b3a5b28126bf2d64367681a086`。

合并建议仍为 **Moss → sudostack → SudoWork**。开发与提交无需等待上游合并；合并前必须保证上游来源可复现。若 squash/rebase 导致目标分支上的语义源或产物提交发生变化，需重新固定来源、生成、更新消费者并重跑 CI。当前文档不是合并批准。

## 6. 关键实现与测试位置

- Moss：`src/server/externalProviders/{service,administration,operations,store,difyTransport,routes}.ts`，`src/server/catalog/executionMode.ts`，`admin/components/external-agents-section.tsx`。
- Moss 回归：`src/server/externalProviders/externalProviders.node-test.ts`、`externalProviders.pg-test.ts`、`src/server/testing/externalProviderCrashFixture.ts`、`src/server/catalog/tenantExternalIsolation.node-test.ts`、`admin/tests/external-agents-api.test.ts`。
- sudostack：`contracts/experimental/external-provider/generate.mjs`、`generate.test.mjs`、`.github/workflows/external-provider-contract.yml`。
- SudoWork：`packages/moss-client/src/MossExternalProviderClient.ts`、`packages/renderer/src/pages/external-agents/`、`packages/renderer/src/components/Markdown.tsx`、桌面/WebUI externalProvider 服务、`scripts/check-external-contract.mjs`、`.github/workflows/pr-checks.yml`。
- SudoWork 回归：`externalAgents.dom.test.tsx`、`mossExternalProviderClient.test.ts`、`mossExternalProviders.test.ts`、`externalMarkdown.dom.test.tsx`、`externalLocales.test.ts`、WebUI `externalProviderRoutes.test.ts`、`check-external-contract.test.mjs`。

## 7. 本次实际界面证据

- [管理与 WebUI 验收 JSON](external-provider-pilot/evidence/review-20261013/moss-management-migration-result.json)
- [组织管理员接入与审核页](external-provider-pilot/evidence/review-20261013/moss-exclusive-management.png)
- [本次真实连续对话](external-provider-pilot/evidence/review-20261013/moss-published-client-chat.png)
- [Electron 本次实际对话 JSON](external-provider-pilot/evidence/review-20261013/desktop-result.json)
- [Electron 本次实际对话截图](external-provider-pilot/evidence/review-20261013/desktop-production-chat.png)
- [原验收助手重新审核发布](external-provider-pilot/evidence/review-20261013/original-reapproved.png)

本次新增 CI 曾触发 sudostack 的稳定工作流审核摘要保护。修复方式为恢复原 `contracts.yml`，把实验检查放入独立工作流；12 项 ADR coverage 测试与 2 项生成器测试通过。未改摘要跳过审核，也未放松原稳定契约检查。SudoWork 仍固定原精确产物提交 `cced11a...`，后续 CI 文件整理不改变该产物。

### 补充：干净构建环境暴露的 renderer 导入问题

SudoWork 四个平台 CI 在解析 renderer 的 `@sudowork/moss-client/external-providers` 时失败。本地预先构建出的 workspace `dist` 掩盖了这个问题，不能把本地成功等同于干净 CI 成功。

本轮补齐 `electron.vite.config.ts` renderer 中 moss-client 与 external-provider 合同的源码 alias。生产构建回归扩展为 main/renderer 两个入口：通过真实模块路径导入，禁止加载任何 moss-client/contracts 的 `dist`，确保不依赖预构建缓存。两个入口回归与类型/lint 检查通过；另外临时移走 contracts/moss-client 的全部 dist 后，完整 Electron main/preload/renderer 生产构建仍通过（完成后恢复原 dist）；修复后完整测试 3150 通过、29 跳过；最新 CI 状态记录在最终交付信息中。

## 8. 交付版本

- Moss 业务修复：`92459a2c5f`（语义契约独立提交 `2bae843f5c`）。
- sudostack：`5374a4021f`（消费产物仍固定 `cced11a2a5`，字节相同）。
- SudoWork：`baa0996693`，包含干净 renderer 构建修复。
- 三仓修复均已推送至原 PR，PR 描述已更新；未合并，未做生产部署。
- 试点 Moss / WebUI / Electron 应用保留运行，独立审查用 PostgreSQL 容器已清理，原试点数据库保留。

交付前查询：Moss 7 项成功、1 项跳过；sudostack 7 项成功。SudoWork 最新提交重新触发平台 CI，状态随运行推进；前一提交已通过 30 项检查，四个平台构建曾因缺少 renderer alias 失败，不能把前一提交的结果冒充最新提交全绿。
