# Dify 外部智能体试点

2026-10-13 更新。本实现将已发布的 Dify Chatflow 作为外部执行方，通过 Moss 统一任务接口供 SudoWork 选择和调用。Dify 中的定义不复制到本地 Runtime；`reply/actions` 中的 actions 不会自动执行。

## 已实现链路

Moss **智能体管理 → 专属智能体** 接入发布；SudoWork **智能体列表 → 专属智能体 → 开始对话**（`/conversation/external%3A<session-id>`）→ desktop IPC 或 WebUI Session 代理 → Moss `/api/v1/tasks` → Dify `/v1/chat-messages`。Dify SSE 被归一化并持久化；客户端每 750ms 按 cursor 读取事件及当前任务投影，断开页面不影响执行。

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

当前命名：SudoWork 桌面端与 WebUI 共用 **智能体库 / 专属智能体 / 我的智能体** 页签。专属页和 Moss 专属管理页均分为 **外部托管 / 内部托管**。Moss 的 **接入外部智能体** 位于外部托管分区；**创建智能体** 及内部类型、可见性筛选位于内部托管分区。文中历史“原生模板”对应当前界面的“内部托管”，本次命名与布局调整不改变执行契约或审批权限。

1. 平台管理员登录 Moss 管理后台，进入 **智能体管理 → 专属智能体 → 外部托管 → 配置接入范围**。填写允许的 Dify API 地址（例如 `http://10.0.1.158:8089/v1`），启用当前组织并保存。范围持久化到 Moss 数据库，立即生效，无须重启。组织管理员可查看范围；仅 `super_admin` 能修改网络范围。
2. 组织管理员在 Moss 的 **外部托管** 分区点击 **接入外部智能体**，选择 **外部托管 / Dify** 和获准的服务地址，输入应用的 **App API Key**，点击 **测试连接并继续**。这里使用 Dify 应用“访问 API”页的 key，不是 Dify 登录密码。
3. 输入 App ID、Workspace ID，上传从 Dify 导出的 YAML / JSON；选择本组织的授权用户、结果格式，并填写审核说明。点击 **保存待审核配置**。服务端解析定义、拒绝非 Start/LLM/Answer 节点、生成摘要，并把 key 写入当前组织的 Nexus Secret。原始定义和明文 key 不写入业务数据库，不回显给客户端。
4. 核对定义与 Dify 当前发布版本、用途及用户范围，点击 **审核发布**，选择 1 / 3 / 7 天有效期并确认。预检通过后，授权用户即可看到此智能体。Dify Service API 不能可靠提供 App/Workspace 身份或锁定发布版本，因此 ID 与发布定义需要管理员核对，不能把连接成功理解为版本已固定。
5. 普通用户进入 **智能体列表 → 专属智能体 → 外部托管**，点击 **开始对话**。在统一对话页底部输入合成问题，Enter 或点击 **发送**；Shift+Enter 换行。页面显示增量回答及任务状态；继续追问复用同一个 Dify conversation。左侧 **对话 → 最近 / 时间分组** 可找回会话，刷新或跨 WebUI/桌面端登录同一账号可恢复历史。
6. 管理员可 **测试连接、编辑配置、更换密钥、停用、归档**。更改用户范围/名称/结果格式或密钥会撤销发布，重新审核后才允许新任务。更换密钥先验证再写入 Secret；失败不会继续沿用“已发布”的状态。归档隐藏接入条目，保留会话和加密凭据；不是销毁凭据的功能。

组织发布的智能体不进入 **我的 Agent**，也不进入目录的 **我的智能体 / 已安装模板** 页签；组织管理权和个人会话归属分开。旧 `/app/agents/external?session=<id>` 自动跳转统一对话；无 session 的旧地址跳转智能体列表。独立试点侧栏入口已移除。管理功能已迁移至 Moss，SudoWork 只保留用户目录和统一对话。

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
- 语义源固定提交：`5034b39feaa770d72e7cdfc36362d149f76fd617`。
- sudostack：`contracts/experimental/external-provider/`，可重生成并按提交和 digest 校验。
- SudoWork：`packages/contracts/src/external-provider.gen.ts`，只读派生；`bun run check:external-contract` 校验。
- 这是首期实验契约，不是宣称 `task.sudo.dev/v1`、ADR-003/004/005 已 Accepted，也不改变 `@sudo/contracts` 稳定 exports。

2026-10-13 rebase 后基线：Moss origin/dev `586fa29`；SudoWork origin/dev `aad96f70`；sudostack origin/main `d856bd7`。分支统一为 `codex/dify-external-pilot-20261012`。

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
- 桌面最初验证了真实 host transport 的单元测试、共用页面 DOM 测试和类型检查。2026-10-12 后续已启动完整 Electron 开发应用，并经正式密码登录、管理页面、已保存凭据的 Dify 连接测试验证；发布与对话操作留给用户本轮人工验收。renderer 生产打包曾内存不足，不能据此声称安装包验证通过。
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

### 2026-10-12 完整应用启动记录（历史状态）

已启动独立 Nexus、完整 Moss server（43128）、WebUI 前端/后端（26808/26809）和完整 Electron 开发应用。WebUI 会话使用本地 PostgreSQL；Moss 任务数据库仍为独立 SQLite。两端使用正式登录流程，管理员管理页面及 Dify 连接测试通过；普通用户 WebUI 登录通过，无管理入口、看不到待审核条目。

本地数据目录 `~/.local/share/dify-pilot-20261012`；详细操作见该目录的 `manual-verification.md`。10月12日交付时预置“Dify 验收助手”为待审核，桌面停留在管理员页面。10月13日复验时该智能体已由用户发布；当前服务状态与验证结果以下节为准。

启动修复：补齐 Electron main 的 `@sudowork/moss-client/external-providers` 精确路径别名，安装开发 Electron 和内置 Node 运行时资源。桌面类型检查、定向 lint 与 main/preload 开发编译通过。原生本地凭据清理存在 `password-vault.secret_delete: method not found` 兼容性告警，本次外部链路使用 Moss 的独立凭据服务并已连接测试成功；此验收不覆盖原生本地执行全功能。

### 2026-10-13 组织目录与统一对话验收

此节记录当天较早的实现。管理员发布的智能体从 **智能体列表 → 组织发布的智能体** 开始对话，复用 ChatLayout、左侧时间线、底部输入和消息展示。组织智能体不进入 **我的 Agent** 或目录的个人/已安装页签；当时管理入口在目录内以抽屉打开，仅管理员可见，现已迁移至 Moss（见下文）。Moss 旧模板列表、详情和 enhancement 绑定排除 `external_hosted`，避免重复安装入口。

客户端为外部 Session 创建 `external:<id>` 命名空间的只读展示投影，合并到最近8条与完整时间分组；Moss 仍保存外部 Session/Task 的唯一事实源，原生会话数据库、个人智能体归属、定时任务及原生操作接口不变。旧会话链接可继续使用，授权撤销后的个人历史仍可读取。

真实链路证据：

- 完整 WebUI → Moss → 已发布 Dify：从目录开始对话，42→50、Enter 续聊、左侧找回、刷新恢复、旧地址跳转、普通用户目录可见但不可管理且不能读取管理员会话，7组检查通过，`pageErrors=[]`。[记录](external-provider-pilot/evidence/unified-ui-result.json) / [对话截图](external-provider-pilot/evidence/unified-chat-webui.png) / [目录截图](external-provider-pilot/evidence/unified-agent-directory.png)。
- 完整 Electron 开发应用 → 正式 desktop IPC → Moss → Dify：验证个人/已安装页签不显示组织智能体、目录进入统一对话、读取同一 WebUI 会话42/50、继续追问得到51、刷新恢复三轮历史，6组检查通过，`pageErrors=[]`。[记录](external-provider-pilot/evidence/unified-desktop-result.json) / [桌面对话截图](external-provider-pilot/evidence/unified-chat-desktop.png)。
- 本轮使用现有“Dify 验收助手”的已发布配置和已保存凭据，仅增加合成测试会话，没有修改远端 Dify 定义/密钥，也没有重新发布接入配置。

外部会话当前只提供查看、续聊、新建和复制回答；暂无重命名、置顶、删除、批量删除或导出接口，批量操作时不可选。模型、工具由 Dify 发布配置决定，界面不提供不支持的模型选择、附件、工作区、本地工具或停止执行按钮。provider 返回内容不解释为本地 action/file 标记，不自动加载远端图片。提交结果不明保持同一幂等 key，事件读取失败只重读；unknown 仍锁定、只读。

本轮验证沿用隔离数据目录 `~/.local/share/dify-pilot-20261012`，临时启动服务，结束后恢复停止，保留数据。完整 Electron 开发应用已验证，生产安装包仍未验证；Moss 任务数据库仍使用 SQLite，WebUI 使用 PostgreSQL 不代表 Moss 任务库已完成 PG/多副本验收。其他试点限制继续适用。

本轮最终自动检查：SudoWork全量334个测试文件通过、8个跳过，3192项通过、36项跳过；含组织资源不进入个人页签的新增回归。renderer/desktop/WebUI三处`tsc --noEmit`通过，契约digest校验通过。Moss外部任务与兼容目录31项通过，`build:node`通过；变更文件lint与diff空白检查通过（renderer保留1条既有`any`警告）。10月12日全量Moss/sudostack记录属于上一轮，本轮未重复宣称全量复验。

### 专属目录 404 修正

2026-10-13 用户界面复验发现：`/api/v1/agents/tenant`（`agent-templates/tenant`别名）仍把Catalog中的Dify外部条目当作原生模板，点击详情会请求不存在的`/rules`文件并返回404。此前只覆盖Hub兼容目录过滤，遗漏了这条原生专属路径。

现已在原生模板Store的列表与按ID读取入口排除`external_hosted`，避免错误的下载/规则编辑/原生审批入口；Catalog原始记录与外部执行接口保留。新增隔离回归与相关外部测试32项通过，原生专属HTTP路由10项通过，Node构建、变更lint与现有类型基线检查通过。实际管理员和普通用户的两种模板别名均排除Dify，已发布外部目录仍保留该智能体。完整WebUI复验专属页仅有一张正常外部Dify卡片，不再有原生模板重复条目；本地Moss已重启生效，其他服务保持运行。

当时提出的管理入口调整已在下一节落实：Moss组织管理员在“智能体管理 → 专属智能体”统一接入和发布，按原生模板/外部托管类型分开表单与操作，外部接入沿用既有`external-agents/admin`及review接口；SudoWork保留获准目录和对话。原生“创建原生模板”表单不能代替外部接入审批。

### 2026-10-13 管理入口迁至 Moss

最终入口：**Moss → 智能体管理 → 专属智能体**。组织管理员在“外部托管”分区完成Dify连接测试、定义上传、成员授权、审核发布、编辑、换密钥、停用、归档。平台管理员额外可配置当前组织的端点范围；普通用户无外部管理区。原生模板单独展示、单独操作，不共用原生自动审批和规则文件接口。

SudoWork仅在 **智能体列表 → 专属智能体 → 外部托管** 展示当前用户可执行的条目。智能体库与个人/已安装页签不展示外部托管；删除客户端管理组件，保留已有transport兼容接口。外部契约与数据事实源不变，既有智能体、凭据和会话直接沿用。

Moss管理API直接消费同仓契约类型。页面按用户与当前组织重建，关闭表单清空明文key；离开页面或切换组织中止请求并丢弃迟到响应。结构化服务端错误码映射为可操作的提示，不回显provider原始错误。

真实界面通过10组检查：平台管理员保存端点范围；真实组织管理员（role=admin）不可修改范围但能接入；错误key不能进入下一步、关闭后key清空；完整接入保存待审核；明确审批后SudoWork用户42→50；编辑撤销发布；换密钥后重新审核；停用保留只读历史；归档退出目录并保留历史；普通Moss用户没有管理区。浏览器pageErrors为空。

- [管理迁移验收记录](external-provider-pilot/evidence/moss-management-migration-result.json)
- [Moss专属智能体管理截图](external-provider-pilot/evidence/moss-exclusive-management.png)
- [最终组织管理员页面](external-provider-pilot/evidence/moss-exclusive-management-final.png)
- [SudoWork真实对话截图](external-provider-pilot/evidence/moss-published-client-chat.png)
- [完整Electron验收](external-provider-pilot/evidence/moss-management-desktop-result.json)
- [Electron真实对话截图](external-provider-pilot/evidence/moss-management-desktop-chat.png)

完整Electron开发应用另行验证专属目录与其他页签隔离、无客户端管理入口、IPC → Moss → Dify执行7×8得到56，以及刷新后恢复历史；pageErrors为空。完成后桌面应用停留在专属智能体列表。

测试仅在本地隔离组织新建并最终归档一条验收接入，使用已有Dify应用及已有App key，没有创建或修改远端Dify应用和key。原有“Dify 验收助手”保持发布且配置不变。增加本地组织管理员pilot-org-admin供人工验证。

自动检查：SudoWork全量3187通过/36跳过（客户端5项旧管理组件测试随组件迁移移除），Moss管理API与已有凭据/组织客户端回归13项通过；admin/renderer/desktop/WebUI类型检查通过，Moss Node与admin生产资源构建通过。已有试点边界继续适用，未宣称Electron生产安装包或Moss任务库PG多副本验收。

按用户要求先停服务实施，完成后重新启动完整Moss/WebUI/Electron/Nexus和测试PG并保持运行。入口和测试账号见本地manual-verification.md。前文2026-10-12及10-13早期管理入口属于历史记录，以本节和开头操作指南为准。


### 2026-10-13 rebase 后交付验证

三个仓库已 rebase 到上述基线。冲突处理保留上游共享原生会话上下文、“最近”默认折叠、版本及包管理器字段，并保留外部会话只读展示投影；新增回归覆盖外部历史不污染原生数据源。契约摘要未变，派生来源提交同步为 `5034b39feaa770d72e7cdfc36362d149f76fd617`。

本次 Moss Node 套件 902 通过 / 3 跳过，admin 回归 13 通过，构建、server lint 及类型基线检查通过（104 / 104，非全仓零错误）。SudoWork 全量单 worker 复跑 3136 通过 / 30 跳过，WebUI 单元 239 通过，workspace 构建和各端类型检查通过；首轮已有 ontology DOM 用例超时，未修改时限，复跑通过。sudostack 测试 139 通过，类型、生成及契约来源检查通过。

重新运行真实 Moss 管理和 WebUI Dify 链路，10 组检查通过，42→50、停用/归档后历史保留，`pageErrors=[]`。验收脚本末尾旧名称“原生模板”已按当前“内部托管”修正，并完整复跑通过。完整 Electron 开发应用再次得到 56，刷新恢复且外部历史进入统一时间线，4 组检查通过，`pageErrors=[]`。临时接入已归档，原有智能体和远端 Dify 应用/密钥未改动。服务保持运行。

- [rebase 后管理与 WebUI 验收](external-provider-pilot/evidence/moss-management-migration-result.json)
- [rebase 后 Electron 验收](external-provider-pilot/evidence/rebase-desktop-result.json) / [截图](external-provider-pilot/evidence/rebase-desktop-chat.png)
- [本次开发测试及 PR 交付总结](dify-development-test-summary-2026-10-13.md)

本节为最新验收结果，前文测试数量和截图保留为各阶段记录。生产安装包、Moss TaskStore PostgreSQL/多副本与生产出口治理仍未验收。
