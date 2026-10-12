# Dify 外部智能体试点

2026-10-12，本实现将已发布的 Dify Chatflow 作为外部执行方，通过 Moss 统一任务接口供 SudoWork 选择和调用。Dify 中的定义不复制到本地 Runtime；`reply/actions` 中的 actions 不会自动执行。

## 已实现链路

SudoWork 共用页面 `/app/agents/external` → desktop IPC 或 WebUI Session 代理 → Moss `/api/v1/tasks` → Dify `/v1/chat-messages`。Dify SSE 被归一化并持久化；客户端每 750ms 按 cursor 读取事件及当前任务投影，断开页面不影响执行。

- Agent 注册复用 Catalog，Connection 复用 IdentityRepository；密钥通过现有 Nexus Secret port 加密保存和读取。
- 组织、用户、端点均需明确批准。审批到期最长 7 天，默认未启用。
- 一个 prompt 对应一个 Task；一个 Task 首期仅有一个 durable Attempt；用户 Agent 身份使用既有 `sessionAgentName`；provider IDs 独立保存。
- Task/Attempt/Session/Event 放在 AuthCenter 的 DbDriver 中，仅作为外部试点事实源，原生 transcript 不迁移。
- 事务先保存意图，再 CAS 领取派发；组织×用户×idempotency_key 唯一。同 key 不同请求返回 409。
- 同会话串行，数据库中的 active_task_id 保证互斥，跨进程不能重新领取已经 dispatching 的任务。
- 断流、超时或派发后的进程丢失无法确认远端结果时记为 unknown，保留会话锁，不自动重发。未派发的 accepted 意图超期为 rejected。
- 不提供伪取消：cancel 返回 409 CANCELLATION_UNSUPPORTED；unknown 不能由迟到成功事件覆盖。
- Dify 旧 runtime/enhancement 路径拒绝 external_hosted，组织默认 Dify 连接选择排除这些 App 专用连接。

## 界面操作指南

基础条件：运行本分支的 Moss 与配套 SudoWork，Moss 已连接可写的 Nexus Secret。首次部署 Nexus 属于基础设施配置；每个智能体的接入、发布、停用均在界面完成，不需要编辑环境变量、计算摘要或手工调用接口。

1. 平台管理员登录 SudoWork，进入侧栏 **外部智能体（试点） → 外部智能体管理 → 配置试点范围**。填写允许的 Dify API 地址（例如 `http://10.0.1.158:8089/v1`），启用当前组织并保存。范围持久化到 Moss 数据库，立即生效，无须重启。组织管理员可查看范围；仅 `super_admin` 能修改网络范围。
2. 组织管理员点击 **接入 Dify 智能体**，选择获准的服务地址，输入应用的 **App API Key**，点击 **测试连接并继续**。这里使用 Dify 应用“访问 API”页的 key，不是 Dify 登录密码。
3. 输入 App ID、Workspace ID，上传从 Dify 导出的 YAML / JSON；选择本组织的授权用户、结果格式，并填写审核说明。点击 **保存待审核配置**。服务端解析定义、拒绝非 Start/LLM/Answer 节点、生成摘要，并把 key 写入当前组织的 Nexus Secret。原始定义和明文 key 不写入业务数据库，不回显给客户端。
4. 核对定义与 Dify 当前发布版本、用途及用户范围，点击 **审核发布**，选择 1 / 3 / 7 天有效期并确认。预检通过后，授权用户即可看到此智能体。Dify Service API 不能可靠提供 App/Workspace 身份或锁定发布版本，因此 ID 与发布定义需要管理员核对，不能把连接成功理解为版本已固定。
5. 普通用户进入 **外部智能体（试点）**，选择智能体，输入合成问题，点击 **发送**；页面显示增量结果和任务状态。继续发送使用同一个 Dify conversation；刷新页面可恢复历史。
6. 管理员可 **测试连接、编辑配置、更换密钥、停用、归档**。更改用户范围/名称/结果格式或密钥会撤销发布，重新审核后才允许新任务。更换密钥先验证再写入 Secret；失败不会继续沿用“已发布”的状态。归档隐藏接入条目，保留会话和加密凭据；不是销毁凭据的功能。

配置被其他管理员更新时返回冲突，界面提示刷新后重试。普通用户无管理入口，后端也独立检查权限。停用只阻止新派发，不声称已取消发往 Dify 的任务。

原有 `MOSS_EXTERNAL_PILOT_ORGS` / `MOSS_EXTERNAL_PILOT_ENDPOINTS` 仅保留为没有数据库策略时的兼容初值；界面保存后以组织的数据库策略为准。旧“先存 Secret 引用再 API 注册”的路径保留给自动化接入，日常操作使用以上界面。

## API 与状态

所有接口都需要 Moss Bearer 鉴权；用户 ID、组织 ID 来自令牌，不接受 body 中的 owner。

| 接口 | 用途 |
|---|---|
| GET /api/v1/external-agents | 当前用户可执行的已审批目录 |
| GET /api/v1/external-agents/access | 当前账号的管理权限及凭据服务能力 |
| GET/POST /api/v1/external-agents/admin/policy | 组织试点范围；写入仅限平台管理员 |
| GET /api/v1/external-agents/admin/members | 可选择的当前组织有效成员 |
| GET /api/v1/external-agents/admin/agents | 管理目录，包括待审核配置 |
| POST /api/v1/external-agents/admin/inspect | 使用待保存 App key 验证连接 |
| POST /api/v1/external-agents/admin/onboard | 界面接入：定义、授权、Secret 写入，初始 pending |
| POST /api/v1/external-agents/admin/:id/update、rotate、test、archive | 编辑、替换密钥、测试、归档 |
| POST /api/v1/external-agents | 兼容引用式注册，初始 pending |
| POST /api/v1/external-agents/:id/review | 管理员审批/撤销 |
| POST /api/v1/tasks | body: agent_id、可选 session_id、query、idempotency_key；202 |
| GET /api/v1/tasks/:id | 当前用户拥有的任务 |
| GET /api/v1/tasks/:id/events?cursor=0 | 有序事件（每页100）及任务快照 |
| POST /api/v1/tasks/:id/cancel | 首期明确返回不支持 |
| GET /api/v1/external-sessions | 当前用户最近100个会话 |
| GET /api/v1/external-sessions/:id/tasks | 会话历史，首期每会话最多200个任务 |

默认执行 deadline 为 120 秒。query 最长 8000 字符、结果最多 128000 字符，超限不假设远端已停止。字面 IP 和精确 `/v1` allowlist 禁止 DNS 重绑定和重定向；未来域名接入需由受管 egress 解决，不应取消此约束。

`unknown` 会话首期只读，管理员需结合 provider_refs 到 Dify 查证。这一版没有人工更改 unknown 终态/解锁的 API，不应直接修改数据库或复制原 prompt 当作自动重试。后续实现带证据的 reconciliation 后再开放恢复。

## 契约与仓库

- Moss 语义源：`contracts/external-provider/v1/contract.ts`，版本 `external-provider.sudo.dev/v1alpha1`。
- 语义源固定提交：`c15c9f026b1d8ca25b729d85a9874e028a77fc37`。
- sudostack：`contracts/experimental/external-provider/`，可重生成并按提交和 digest 校验。
- SudoWork：`packages/contracts/src/external-provider.gen.ts`，只读派生；`bun run check:external-contract` 校验。
- 这是首期实验契约，不是宣称 `task.sudo.dev/v1`、ADR-003/004/005 已 Accepted，也不改变 `@sudo/contracts` 稳定 exports。

基线：Moss origin/dev `56ed339`；SudoWork origin/dev `d1d8e49`；sudostack 没有 dev，使用 origin/main `c9f8faa`。分支统一为 `codex/dify-external-pilot-20261012`。

## 真实验证与边界

本轮已从空策略和空接入目录，在真实 Chrome 中完成全程界面操作：启用范围、连接验证、上传定义、选择用户、保存草稿、审核发布、普通用户42→50、刷新恢复、停用、编辑、更换密钥、重新审核、使用已保存凭据测试、归档并读取历史。10组验收检查通过，浏览器 `pageErrors` 为空。

- [管理验收记录](external-provider-pilot/evidence/admin-ui-result.json)
- [接入草稿截图](external-provider-pilot/evidence/admin-draft.png) / [发布截图](external-provider-pilot/evidence/admin-published.png) / [用户结果截图](external-provider-pilot/evidence/user-results.png)
- [Nexus 重启持久化证据](external-provider-pilot/evidence/nexus-persistence.json)：真实 vault 写入、更换凭据后，重启独立 Nexus 仍读取到相同 App key；binding 中无明文 key。验收更换操作使用既有授权 App key 重新写入，没有创建或修改远端 Dify key。


已在 10.0.1.158:8089 的现有发布应用 `6a5b8645-dfdb-4d43-bc24-e8b628ce8b86` 上验证。重新核验节点为 Start/LLM/Answer，发布图摘要：

`sha256:b311fc5b4797376ed378c04d4b372ec14aafbfc67beca287b3211c401ce416f0`

- 共用客户端 → Moss HTTP dispatcher/AuthService/DbDriver → 真实 Dify：42 → 50，同 provider conversation、幂等重试未新增 Task、重新创建客户端后历史恢复、无 Bearer 请求 401。
- 浏览器 → 真实 WebUI Session 解密/requireSession/proxy → 实际 bridgeAdapter → 实际共用页面：两次 POST 均 202，两轮显示42/50，刷新后重新选择历史可恢复；pageErrors 为空。[请求证据](external-provider-pilot/evidence/browser-result.json)、[恢复截图](external-provider-pilot/evidence/browser-restored.png)。
- 前一轮验证使用内存 Secret port；本轮管理验收改用独立的真实 Nexus daemon + vault，并从空策略、空目录开始。数据库、身份、WebUI Session 仍为隔离测试环境，未写入生产服务。
- 桌面验证范围是真实 host transport 的单元测试、共用页面 DOM 测试和类型检查；未启动完整 Electron 应用验收。
- 首期不执行 actions，不支持取消/执行恢复/不可变版本 pin；客户端使用 cursor 轮询增量展示，未实现 Moss→客户端 SSE 推送。
- SQLite 执行了并发与数据库重开恢复测试；PG 复用 DbDriver 与事务/CAS SQL，尚未进行真实 PG/多副本联调。生产启用仍需 Nexus egress、版本变更治理、reconciliation 和部署验收。

可复现真实联调：构建 SudoWork contracts/moss-client；先运行 `bun build --target=node scripts/verify-external-dify-pilot.ts --outfile bin/verify-external-dify-pilot.mjs`。在关闭回显的交互终端运行 `node --import tsx bin/verify-external-dify-pilot.mjs`，向 stdin 输入一行 JSON，字段为 email/password/sudoworkPath，可选 baseUrl/appId/preview；设置 `ui: true` 会用已安装 Chrome + Python Playwright 自动操作完整管理与对话流程。不要把真实凭据写入文件或命令历史。脚本只读取既有应用、已有 App Key，不创建或修改 Dify 应用；preview 会创建临时 `.external-pilot.*` 页面并在退出时清理。


### 质量检查记录

| 检查 | 结果 |
|---|---|
| Moss 外部链路、DbDriver、Dify 回归 | 76项通过，含7个新增管理权限/状态/Secret用例 |
| Moss 全量 Node 测试 | 850通过/3跳过，无失败 |
| Moss Node构建 | 通过；补装admin构建依赖并执行既有vendor安装步骤 |
| Moss typecheck ratchet | 通过，server现有102处低于基线104；不是全仓零类型错误声明 |
| SudoWork workspace构建、desktop/renderer/WebUI类型检查 | 通过 |
| SudoWork 全量测试 | 3182通过/37跳过；bun run test --maxWorkers=2 全量通过 |
| 新功能及受影响desktop登录用例 | 32项通过，含5项管理界面用例 |
| WebUI代理与既有bridge回归 | 91项通过，包含既有bridge、会话隔离与外部管理代理 |
| sudostack 测试/类型检查 | 139项通过，类型检查通过 |
| 契约来源/digest、变更文件lint、diff空白检查 | 通过 |

真实服务复验中曾出现一次 Dify 明确的 `PROVIDER_WORKFLOW_FAILED`，Moss 如实显示 failed 并释放该会话的任务锁。只读算术验收脚本允许对已确认 failed/rejected 的合成问题有限重试；产品不会自动重发，unknown 始终禁止自动重放。

默认高并发全量运行曾出现既有 ontology 慢测试超时；降低执行并发后全量通过，未修改测试超时或跳过用例。另修复了客户端 import 自动整理造成的值导入问题，并通过定向与全量回归。
