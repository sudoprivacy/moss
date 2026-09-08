# Sudowork Server 能力整合到 Moss 设计方案

日期：2026-09-07
状态：已定稿（可进入开工前 Spike）

## 1. 方案摘要

将当前 sudowork-server 承担的全部生产能力迁移并整合到 Moss，使 Moss 成为同时支持 Sudowork 本地模式与企业云端模式的统一企业平台。切换完成后，原 Sudowork 域名指向 Moss，现有 Sudowork 客户端无需修改或强制升级即可继续使用。

最终系统对组织、用户、Agent、Skill、企业配置、Dify、计费、QMS 和企业自动化只保留一套业务实现及一套主数据模型。Moss 原生接口和 Sudowork 兼容接口调用相同的业务模块。兼容接口只转换协议，不保存独立业务状态，不复制 sudowork-server 的业务逻辑。

本地模式的对话、工具、本地定时任务和本地渠道继续由 Sudowork 客户端执行。企业云端模式继续使用 Moss 现有 Session API、WebSocket 和 RuntimeService。普通模式与企业模式共享 Moss 中的组织、用户、Agent、Skill 和企业策略。

## 2. 分析基线

本设计基于以下源码版本：

- Moss dev：bc3125a126ac9cd4e59beaf195e5cf1d632fca36，分析时与 origin/dev 一致。
- Sudowork Server dev：311636c7bbfa4fa1c655aa8bd5c7e898f565f263，分析时与 origin/dev 一致。
- Sudowork 客户端仅作为兼容协议消费者进行检查，本地检查版本为 558668de116e245561f31b6d541aa5474456cab8；本次迁移不修改该仓库。

上述客户端提交只能证明本次分析时检查过的代码状态，不能代替正式兼容范围。开发开始前必须建立并冻结受支持客户端版本矩阵，至少记录产品版本、构建号或 Git 提交、操作系统与架构、认证方式、协议能力和验收状态。只有进入该矩阵的未修改客户端，才构成本项目“无需升级即可继续使用”的验收范围；支持范围变化必须经过书面评审。

最初提供的 Sudowork Server 路径 ~/VSProject/sudowork-server 不存在，实际分析路径为 /Users/yobach/VSCodeProject/sudowork-server。

静态源码扫描得到 204 个 Hono 路由声明。其中 14 个 crash 路由同时挂载在 /api/v1/crash 和 /api/v1/qms/crash。排除根页面路由并计算重复挂载后，对外接口至少包含 216 个 method/path 组合。静态数量无法表达动态响应行为，因此正式开发必须生成机器可读接口清单。

当前测试基线并非全绿：

- Sudowork Server：52 个测试通过，1 个失败。失败原因是授信审批测试 mock 缺少 sudorouterService.pointsToQuota。
- Moss：358 个测试通过，存在 1 个发布 E2E 断言失败及 2 个模块加载错误，分别涉及 Bun 不支持 node:sqlite 和无法解析 @bufbuild/protobuf。

迁移测试成为发布门禁前，必须修复这些问题或形成明确的基线豁免记录。

## 3. 目标

- 切换完成后 Moss 成为唯一生产服务端。
- 在原 Sudowork 域名上保持 sudowork-server 的完整外部接口行为。
- 现有 Sudowork 客户端无需修改或强制升级。
- 本地模式与企业云端模式共享一个 Organization 和 User。
- 本地执行、Moss 云端执行和 Dify 执行共享同一个 Agent、Skill 目录。
- 保持 Moss 现有云端会话执行能力不回退。
- 将 sudowork-server 的管理能力合并到 Moss 管理端。
- 完整迁移生产数据，并提供可重复、可核对的结果。
- 通过维护窗口完成最终迁移，不建立长期双向同步。
- 在生产观察期内保留经过演练的回滚能力。

## 4. 非目标

- 本次不修改 Sudowork 客户端。
- 不把 sudowork-server 作为永久 sidecar 或下游依赖。
- 不在 Moss 内建立第二套 Sudowork 用户、Agent、Skill、配置、调度或渠道业务实现。
- 不把普通模式的本地 Cron 定义和本地 Channel 凭据集中存入 Moss；当前客户端继续拥有这些数据。
- 不把 QMS 时序数据迁入 Moss 主 SQLite。
- 不迁移不安全的开发默认密钥、默认 Token 或验证码绕过逻辑。
- 不借本次迁移重写 Moss 云端 Runtime。

## 5. 领域模型

统一术语记录在仓库根目录 CONTEXT.md。

### 5.1 控制面与执行面

Moss 是统一控制面，负责：

- 用户和组织；
- Agent 与 Skill 目录；
- 可见性和权限策略；
- 企业配置与凭据；
- Dify 等企业集成；
- 计费与额度；
- QMS；
- 企业模式的 Cron 与 Channel。

执行位置按模式区分：

- 本地模式：Sudowork 客户端执行对话、工具、本地 Cron 和本地 Channel。
- 企业云端模式：Moss Runtime 执行对话，Moss 执行企业 Cron 和企业 Channel。
- Dify：作为 Agent 的一种执行 Provider，不拥有独立 Agent 主数据。

### 5.2 数据所有权

正式切换后：

- Moss 是所有已迁移服务端数据的唯一写入者。
- 原 sudowork-server 数据库保持只读，仅作为回滚和审计证据。
- 客户端本地数据库仅继续拥有普通模式本地对话、本地 Cron 和本地 Channel 配置。
- 禁止建立长期表级双向同步。

## 6. 总体架构

~~~mermaid
flowchart TB
    OLD["现有 Sudowork 客户端"] --> LEGACY_HOST["原 Sudowork 域名"]
    MOSS_CLIENT["Moss 客户端和管理端"] --> MOSS_HOST["Moss 域名"]

    LEGACY_HOST --> LEGACY_HTTP["Sudowork HTTP 兼容 Adapter"]
    MOSS_HOST --> NATIVE_HTTP["Moss 原生 HTTP Adapter"]

    LEGACY_HTTP --> APP["Moss 统一模块接口"]
    NATIVE_HTTP --> APP

    APP --> IDENTITY["身份与组织模块"]
    APP --> CATALOG["Agent 与 Skill 模块"]
    APP --> CONVERSATION["对话与云端会话模块"]
    APP --> CONFIG["配置与凭据模块"]
    APP --> BILLING["计费模块"]
    APP --> QUALITY["质量与遥测模块"]
    APP --> AUTOMATION["企业 Cron 与 Channel 模块"]

    CONVERSATION --> RUNTIME["Moss RuntimeService"]
    CATALOG --> PROVIDERS["本地 / Moss Runtime / Dify"]
~~~

### 6.1 HTTP 路由

Moss 保持一个进程和一个平台。在进入路径分发前，根据受信任的 Host 选择 HTTP Adapter：

- 原 Sudowork 域名进入兼容 Adapter。
- Moss 域名进入原生 Adapter。
- 两个 Adapter 调用相同的模块接口和 Repository。

必须按 Host 区分，因为以下路径已经在两个系统中具有不同语义：

- POST /api/v1/auth/login
- GET /api/v1/user/profile
- GET /api/v1/tenant/config
- GET /

仅按路径合并无法同时保持两种接口契约。

反向代理必须保留原始 Host，或者写入只有可信代理能够设置的内部路由信息。不能允许公网请求通过普通转发 Header 自行选择授权上下文。

Moss 原生 Adapter 继续使用现有 `node:http` 实现。Sudowork 兼容 Adapter 内部使用 Hono，并通过 `@hono/node-server` 的 `getRequestListener` 接入同一个 `http.Server`，不启动第二个业务进程或第二个监听端口。`hono` 和 `@hono/node-server` 都必须作为 Moss 的直接生产依赖声明，禁止依赖其他包间接带入的版本。

Host 分流必须发生在全局 CORS、请求体读取和业务路径分发之前。请求只能交给一个 Adapter 消费，禁止先由 Moss 原生处理器读取请求体后再转交 Hono。两个 Adapter 分别维护自己的 CORS、错误序列化和传输行为，避免 Moss 原生默认值改变旧接口契约。

### 6.2 Sudowork 兼容 Adapter

兼容代码集中在清晰的路由目录中，例如：

~~~text
src/server/api/compat/sudowork/
~~~

允许承担的职责：

- 解析旧 query、JSON、multipart、form 和 Header。
- 通过统一身份模块验证旧 Token。
- 将旧数字 ID 解析为 Moss 资源 ID。
- 将旧请求转换为统一命令或查询。
- 将统一结果序列化为旧响应格式。
- 将事件流转换为旧 SSE 格式。

禁止承担的职责：

- 直接执行 SQL。
- 计算余额或修改流水。
- 直接调用 Dify、Sudorouter、Fuiou、SMS、邮件或告警 Webhook。
- 实现 Agent 可见性、用户审批或调度规则。
- 自己持有定时器或后台任务。

它只是协议 Adapter，不是嵌入 Moss 的另一套 sudowork-server。

正式迁移路由前必须完成一个可丢弃的接入验证，至少覆盖：

- 同一 `http.Server` 上按可信 Host 分流；
- Moss 与 Sudowork 重名路径保持各自语义；
- JSON、form 和 multipart 请求体只读取一次；
- SSE 首包、心跳、结束、取消和客户端断开；
- 上传文件大小限制与清理；
- CORS、限流 Header、302 和错误响应；
- Moss 原生 HTTP、WebSocket 和健康检查不受影响。

### 6.3 共享数据库事务边界

Moss Standalone Server 中，主 Store 与 AuthCenter 共享同一个 `DatabaseSync` 连接，因此身份、组织、数字别名和 Billing 数据具备单事务提交的物理条件。风险不在跨数据库，而在多个模块各自执行 `BEGIN`、`COMMIT` 或 `ROLLBACK` 导致嵌套事务或提前提交。

跨模块写操作必须通过统一 UnitOfWork 管理事务。所有需要事务的方法，包括 AuthCenter 当前自行执行 `BEGIN TRANSACTION` 的方法，都必须改用同一个事务执行器：

- 最外层调用在连接未处于事务时执行 `BEGIN IMMEDIATE`，成功后 `COMMIT`，失败后 `ROLLBACK`；
- 嵌套调用不得再次执行 `BEGIN`，必须使用唯一命名的 `SAVEPOINT`，成功后 `RELEASE SAVEPOINT`，失败后 `ROLLBACK TO SAVEPOINT` 并释放该 Savepoint；
- 事务执行器通过显式传递的事务上下文判断嵌套层级，并可使用 `DatabaseSync.isTransaction` 进行防御性校验；
- 参与同一业务命令的 Repository 使用 UnitOfWork 提供的共享连接；
- Repository 和领域方法不得绕过事务执行器直接执行 `BEGIN`、`COMMIT` 或 `ROLLBACK`；
- 新建用户、数字别名和钱包初始化必须由同一个统一命令在同一事务内完成；
- Moss 原生接口、Sudowork 兼容接口和迁移程序都必须调用该统一命令，禁止分别拼装写入步骤；
- UnitOfWork 回调必须是同步函数，事务打开期间禁止 `await`、Promise、网络请求、文件 I/O、定时器或任何可能把控制权交回事件循环的操作；事务执行器必须在类型和运行时拒绝返回 Promise 的回调；
- 数据库事务内不得执行 SMS、支付、Dify 等外部调用；需要可靠副作用时先写 Outbox，再由事务外执行器处理。

事务集成测试必须验证：现有 AuthCenter 事务方法被 UnitOfWork 调用时不出现嵌套 `BEGIN` 错误；内层成功而外层失败时全部写入回滚；内层失败时正确回滚到 Savepoint；异步回调被拒绝且不留下打开的事务；事务完成后连接状态恢复；用户、数字别名和钱包任一步失败时均不留下部分数据。

并发写事务测试是正确性门禁，至少覆盖同一进程内重叠业务命令、两个 `DatabaseSync` 连接对同一 WAL 数据库的写竞争、数字别名唯一分配、钱包余额更新和 `SQLITE_BUSY`。事务执行器必须在开始事务前采用有上限的 busy 等待或重试；不得从事务中间重试，只有具备稳定幂等键的完整业务命令才允许整体重试。

UnitOfWork 仅覆盖 Moss 主 SQLite 中使用同一个 `DatabaseSync` 连接的写入，不提供跨 SQLite、Redis、PostgreSQL/TimescaleDB、Nexus、文件系统或外部服务的全局事务，也不引入两阶段提交。跨存储一致性按场景保证：数据迁移使用分阶段 checkpoint、幂等重试、校验和对账；在线可靠副作用使用 SQLite Outbox；Redis Refresh Token 等无法通过 Outbox 完成的同步操作必须幂等，并在写入失败时禁止返回成功结果。QMS 迁移在 Organization 映射稳定后独立执行并对账。

统一命令必须接收由服务端可信入口构造的执行上下文，至少区分 `online`、`migration` 和 `replay` 来源，以及 `enqueue`、`suppress_external` 副作用策略。HTTP query、Header 或请求体不得选择 `migration`、`replay` 来源或副作用抑制策略。Outbox 事件必须区分维持系统内部一致性的事件与面向外部的投递事件；后者包括短信、邮件、用户推送、Channel 消息、Webhook、支付通知、Dify 写入和其他第三方调用。

迁移上下文必须保留领域校验、审计、账本和必要的内部一致性处理，但不得生成可被执行器投递的外部 Outbox 事件。需要留痕时，应记录带迁移批次、事件类型、资源 ID 和抑制原因的不可投递 `suppressed` 记录，禁止把它伪装为已经成功执行的 `completed` 事件。Nexus 密钥写入、对象存储复制和 QMS 数据导入属于显式迁移步骤，必须通过迁移阶段白名单执行，不受在线外呼抑制规则误伤。

`replay` 默认使用 `suppress_external`，用于重建或回放内部状态时不得重新发送历史短信、邮件、Webhook、支付请求、Dify 写入、推送或 Channel 消息。每个回放命令必须携带原始事件 ID 和稳定幂等键，并按“事件类型 + 原始事件 ID + 目标”去重。确需补发某个外部动作时，必须使用与普通回放分离的运维 `redelivery` 操作，经过显式审批和目标白名单校验，复用原幂等键并记录完整审计；不得通过修改 replay 上下文绕过默认抑制策略。

## 7. 统一业务模块

### 7.1 身份与组织

扩展 Moss 现有认证模块，不创建第二套用户系统。统一模块负责：

- 登录认证；
- 用户创建；
- 邀请与审批；
- 锁定和禁用；
- 角色分配；
- 组织策略；
- 外部身份解析；
- 旧数字 ID 解析。

角色映射：

| Sudowork 角色 | Moss 角色 |
|---|---|
| SUPER_ADMIN | super_admin |
| ENTERPRISE_ADMIN | admin |
| USER | user |

旧库中的 ADMIN 值不被当前 Sudowork 管理员中间件接受。迁移预检必须列出所有 ADMIN 用户供人工确认，禁止自动提升权限。

统一账号状态扩展为：

~~~text
pending | active | locked | disabled
~~~

兼容接口把 pending、active、locked 转换回 Sudowork 的 0、1、2。除明确的账号恢复流程外，只有 active 用户可以登录。

手机号用户使用 Moss 已有的内部合成邮箱能力。公共响应继续隐藏 users.internal.moss 域名。手机号和 CAS 身份进入通用认证身份表，不创建 Sudowork 专用用户表。

### 7.2 Agent 与 Skill

Moss 现有 tenant_assistants、tenant_skills、Agent 制品目录、可见性和审批机制成为唯一主数据。

Agent 增加以下执行元数据：

- provider_type：local、moss_runtime 或 dify。
- supported_modes：local、cloud 或 both。
- 需要时保存 Provider binding。

Skill 仍然只有一份定义：

- 本地模式下载到客户端 Runtime 使用。
- 云端模式注入 Moss Session。
- 两种模式共享版本、归属、可见性、审批状态和 checksum。

资源去重顺序：

1. Hub 或 Provider 永久 ID。
2. 原始资源 ID。
3. 制品 checksum。
4. 名称只能作为冲突提示，不能作为自动合并依据。

### 7.3 对话与云端会话

Moss RuntimeService 继续作为唯一云端会话实现。本次迁移必须保持：

- host、Docker 和 Kubernetes Runtime；
- 每会话和每用户隔离模式；
- Organization、Department 和 User 数据隔离；
- 工作区隔离和文件操作；
- Agent、Skill、Wiki、企业应用、共享记忆和 MCP 注入；
- 可用模型和动态模型切换；
- 权限申请与确认；
- WebSocket 流式事件；
- detach、重连、resume 和 terminate；
- Moss 重启后的 reconcile 与 reattach；
- Runtime 丢失后的恢复；
- idle 和 detached-busy 超时；
- 并发限制、状态转换、transcript 和审计事件。

sudowork-server 的 /api/v1/agents/:assistantId/chat 是 Dify SSE 接口，不是 Moss 云端 Session。它迁移为 Dify 兼容路由，不能替代 RuntimeService。

### 7.4 Dify

Dify 作为统一 Agent 目录后的执行 Provider，负责：

- 连接配置；
- tenant、app 和 dataset binding；
- 对话和消息；
- feedback 和 suggested questions；
- 文件上传；
- speech-to-text；
- text-to-audio；
- SSO。

兼容 Adapter 保持原 SSE 字节流、状态码、302 跳转、媒体 Content-Type 和错误结构。密钥进入 Nexus，任何接口都不能返回真实密钥。

### 7.5 企业配置与凭据

Sudowork config_items/config_entries 合并进 Moss 现有配置和密钥治理能力：

- 配置定义和非敏感元数据保存在 SQLite。
- 密钥值迁入 Nexus。
- 使用 org_id 替代旧 enterprise 关系。
- Auth Proxy 继续作为凭据解析主路径。
- 兼容响应保留旧字段名，但不得增加秘密暴露。

企业品牌和策略必须改为 Organization 级配置。Moss 当前 `getEnterprise()` 和 `updateEnterprise()` 固定读写 `enterprises.id = 'default'`，属于全局单例，无法代表多个组织，不能继续作为主数据。

### 7.6 计费

Moss 当前没有对应能力，因此新增 Moss 原生 Billing 模块，而不是 Sudowork 兼容模块。它负责：

- 组织和用户钱包；
- 只追加流水；
- 授信申请；
- 充值套餐；
- 支付订单和支付记录；
- 退款；
- 对账；
- Fuiou 集成。

所有金额或积分变化必须具备：

- 数据库事务；
- 稳定幂等键；
- 只追加流水；
- 变更前后余额；
- 审计记录；
- 确定性的重试规则。

旧订单号和记录 ID 作为外部别名永久保留。支付回调必须先验签、去重，再执行状态变化。

### 7.7 QMS

QMS 成为 Moss 原生质量与遥测模块，继续使用 PostgreSQL/TimescaleDB，负责：

- 遥测接收；
- 对话指标；
- 安装指标；
- crash 与 source map；
- 告警；
- 聚合；
- 保留策略；
- QMS 审计。

统一 Organization 与旧 QMS tenant code 建立映射。兼容接口继续支持 API Key Header、RSA-OAEP/AES-256-GCM 加密请求、角色限制和原有错误结构。

### 7.8 Cron 与 Channel

本次遵循客户端现有所有权，不新增本地任务下发协议：

- 普通模式 Cron 定义、定时器、会话和运行状态留在客户端。
- 企业模式 Cron 定义、lease、run、Session 和历史记录留在 Moss。
- 普通模式 Channel 配置和进程留在客户端。
- 企业模式 Channel 配置和进程留在 Moss。
- Moss 的 Organization 策略控制客户端是否允许使用本地 Cron。
- 两种模式的用户、Agent、Skill、模型和可见性策略来自 Moss 统一控制面。

这是一套统一产品能力，但本地和云端任务实例有不同的可用性及文件系统环境，因此不合并为同一条任务记录。

## 8. 数据模型

### 8.1 扩展现有表

- organizations：唯一组织主实体。
- users：唯一用户主实体，并扩展账号状态约束。
- tenant_assistants：唯一 Agent 元数据，并增加 Provider 和模式字段。
- tenant_skills：唯一 Skill 元数据，并增加模式可用性。
- sessions、session_attempts、session_events：继续保存云端执行数据。
- config_items 和 config_entries：保存配置定义和组织关系。
- cron_jobs、cron_job_runs 和 event trigger 表：保存企业云端自动化。
- 现有 Channel 表：保存企业云端渠道配置。

### 8.2 新增通用表

organization_profiles：

- org_id 主键；
- 企业唯一 code；
- 品牌字段；
- 登录策略；
- 本地和云端能力开关；
- 旧企业元数据；
- 创建和更新时间。

user_auth_identities：

- id；
- org_id；
- user_id；
- provider；
- issuer；
- normalized_subject；
- provider metadata；
- 创建和更新时间。

provider、issuer、normalized_subject 组合必须唯一。密码摘要继续保存在 Moss 统一用户认证记录中。

resource_numeric_aliases：

- namespace；
- resource_type；
- canonical resource_id；
- numeric_alias；
- 创建时间。

迁移的旧资源保留原数字 ID。所有新建 Organization 和 User 在同一个创建命令内获得后续 Sudowork 数字别名，保证创建完成后即可使用兼容接口。

Organization、User、数字别名和对应钱包的创建遵循 §6.3 的统一事务边界。任一环节失败时不得留下可在 Moss 使用、但无法通过 Sudowork 兼容接口登录的半成品用户。

integration_connections：

- 组织归属；
- provider 类型；
- base URL；
- Nexus secret reference；
- 非敏感配置；
- 启用状态。

assistant_provider_bindings：

- canonical assistant ID；
- connection ID；
- external app/workflow ID；
- Provider 模式；
- Provider 配置。

invitation_codes：

- Organization；
- 邀请码；
- 状态；
- 使用限制；
- 有效期；
- 创建者和使用者。

Billing 新增 account、ledger、application、package、order、payment、refund、outbox 和 reconciliation 表。这些表使用 Moss 领域名称，不使用 sudowork_ 前缀。

### 8.3 存储归属

- Moss SQLite：事务型控制面数据和计费元数据。
- Moss 部署管理的 PostgreSQL/TimescaleDB：QMS 数据。
- Redis：Refresh Token、限流、注册 handoff 和短期缓存。
- Nexus：集成密钥与服务端密钥。
- Moss 管理的上传目录或对象存储：上传制品。

统一平台不等于所有数据必须使用同一个数据库。每种存储只能有一个数据所有者，并且必须有备份恢复流程。

## 9. 登录兼容

Moss JWT 与 Sudowork JWT 虽然都使用 HS256，但 Claim 结构不同。统一身份模块支持两个 Token Profile：

- Moss 原生接口签发 Moss Token。
- Sudowork 兼容接口签发旧结构 Token。

兼容接口使用迁移后的旧 JWT secret 验证切换前签发、尚未过期的 Token。验证后，通过数字别名把 user ID 和 enterprise ID 转换为 Moss Principal。

Redis Refresh Token Key 必须保持 Token 值和 device ID 不变地迁移。兼容登录与刷新响应继续返回原字段、TTL、状态码、模型数据、企业 code、额度、积分和未注册用户信息。

旧 bcrypt 密码摘要继续可验证。用户首次成功登录后，可以在同一事务内升级为 Moss 当前密码摘要，不强制用户重置密码。

生产环境必须显式配置 JWT、SMS、CAS、支付、Dify 和上游服务密钥。开发默认 Token、默认密钥和 SMS 验证码绕过不得迁移。

## 10. 外部接口兼容要求

兼容范围包括：

- HTTP method 和 path；
- query、body 和参数别名；
- JSON 外层结构与字段名；
- 数字 ID 和排序；
- null、字段省略和默认值；
- HTTP 状态码和错误文案；
- 鉴权和权限行为；
- CORS 和限流 Header；
- multipart 限制和文件名；
- SSE 格式、事件顺序、取消和结束事件；
- 302 和 HTML 回调；
- 音频及文件 Content-Type；
- 静态资源和上传文件；
- 副作用和幂等行为。

QMS 的 success:false/error、普通接口的 success:false/msg，以及未注册用户返回 HTTP 200 和 need_register:true 等不一致行为，都属于必须保持的旧契约。

原 Sudowork 域名在切换后提供 Moss 管理端。GET / 可以在服务内部映射到 Moss Admin，但已记录的旧 API、静态文件和上传路径必须继续可用。

## 11. 数据迁移程序

### 11.1 命令模式

在 Moss 仓库提供迁移命令：

~~~bash
node bin/migrate-sudowork.mjs --dry-run
node bin/migrate-sudowork.mjs --execute
node bin/migrate-sudowork.mjs --verify
node bin/migrate-sudowork.mjs --resume
~~~

迁移 CLI 必须随 Moss 的 Node 构建产物生成，并在与生产相同的大版本 Node.js 下执行。Bun 可以继续承担构建任务，但不得作为迁移程序的生产运行时。

迁移程序分为只读 `SudoworkSourceReader` 与 Moss 目标 Repository：

- SourceReader 只读取冻结的 Sudowork SQLite、Redis、PostgreSQL/TimescaleDB 和文件快照；
- SQLite SourceReader 优先使用 Moss 已采用的 `node:sqlite`；确有兼容性要求时可以使用 `better-sqlite3`，但必须作为迁移工具的显式依赖并与 Moss 运行时隔离；
- 目标数据只能通过统一领域服务提供的迁移专用 Import Command 和 Moss Repository 写入，禁止直接复制 Sudowork SQL、绕过约束或直接写目标表；Import Command 与在线命令共享领域校验、Repository 和 UnitOfWork，但具有明确的导入语义，不触发在线用户生命周期；
- 每次 `--execute` 必须生成唯一并持久化的 `migration_run_id`，`--resume` 必须复用对应批次 ID；两者都以 `origin=migration`、`effect_policy=suppress_external` 调用 Import Command，这些值只能由迁移 CLI 内部创建，不能来自迁移数据或外部请求；
- `--dry-run` 和 `--verify` 不得写入目标业务数据或产生任何外部副作用；`--execute` 和 `--resume` 不得产生可投递的欢迎短信、邀请通知、用户推送、支付回调、Webhook、Dify 写入或 Channel 消息；
- 被抑制的外部副作用必须进入迁移报告，包含迁移批次、数量、类型和关联资源，供切换审批核对；
- `--resume` 必须从已持久化 checkpoint 恢复，并再次执行幂等和一致性校验。

要求：

- 源数据只读；
- 支持重复安全执行；
- 按业务域保存 checkpoint；
- ID 映射结果确定；
- 失败记录包含可操作原因；
- 支持从失败阶段继续；
- 同时输出 JSON 和中文 Markdown 报告；
- 遇到未解决冲突立即失败，禁止静默跳过。

### 11.2 用户与组织合并

用户匹配顺序：

1. 已存在且明确的 Provider/external user 映射。
2. 已验证且唯一的手机号。
3. 已验证且唯一的邮箱。
4. 无法唯一判断时生成冲突记录，人工处理后才能执行正式迁移。

名称和昵称不能作为用户身份键。

Organization 先使用明确映射，再使用唯一且已验证的企业 code。已有 ext_org_id 和 ext_user_id 可能属于其他身份提供商，迁移程序不得覆盖。

### 11.3 迁移顺序

1. Organization、Profile 和数字别名。
2. User、认证身份、角色、状态和用户别名。
3. 邀请、操作日志、审计和访问策略。
4. Agent、Skill、制品、可见性和元数据。
5. 企业配置、配置项、密钥和上传文件。
6. Dify connection、app、dataset、ACL 和 metadata binding。
7. 钱包、流水、授信、充值、支付和退款。
8. 服务端拥有的企业 Cron、Event Trigger 和 Channel 配置。
9. QMS tenant、遥测、crash、告警、聚合和保留状态。
10. JWT 配置、Redis Refresh Token 和有效注册 handoff。

客户端本地会话、本地 Cron 和本地 Channel 配置不是服务端迁移输入。

### 11.4 数据校验

以下条件必须全部满足：

- 每个旧企业只映射到一个 Organization。
- 每个旧用户只映射到一个 User 和 Organization。
- 每个需要兼容接口的 Organization 和 User 都有稳定数字别名。
- 不存在孤立邀请、权限、流水、订单、退款、Agent ACL 或 QMS 数据。
- 钱包余额等于有效流水按统一期初规则计算的结果。
- 企业额度、用户积分、充值、退款和订单状态一致。
- Agent/Skill 数量、版本、所有者、可见性和制品 checksum 一致。
- 配置关系一致，所有需要的秘密已写入 Nexus。
- 上传文件数量、大小和 checksum 一致。
- QMS tenant 数量、时间范围、原始事件、聚合和未解决告警一致。
- 抽样旧 JWT、Refresh Token、密码、SMS 和 CAS 登录全部成功。

## 12. 开发工作流拆分

### 12.1 开工前强制验证

领域开发开始前必须依次完成以下准备工作：

1. 冻结受支持客户端版本矩阵、机器可读路由清单和旧接口契约 Fixture。
2. 完成 §6.2 的 Hono 与 Moss 原生 HTTP Server 接入验证。
3. 完成 §6.3 的 UnitOfWork 设计和共享连接事务集成测试。
4. 建立能够按业务域执行的差异测试流水线和合并门禁。

上述验证不承载正式业务实现。任一项未通过时，不得开始批量迁移兼容路由。

### 12.2 领域项目

整体工程不能压成一个实施计划，应拆成九个独立可评审项目：

1. 接口契约基线：路由清单、Fixture、差异测试和现有测试基线修复。
2. 身份与组织：统一 Schema、登录 Provider、邀请、角色、生命周期、别名和 Organization Profile。
3. Agent、Skill 与配置：目录整合、可见性、制品、企业配置、Nexus 和兼容接口。
4. Billing：钱包、流水、授信、充值、支付、退款、对账和回调。
5. Dify：Provider、Agent binding、Dataset、流式响应、文件、音频和 SSO。
6. QMS：接收、加密、遥测、crash、source map、看板、告警、聚合和保留。
7. 企业自动化：Moss Cron、Event Trigger、服务端 Channel 与统一用户及资源集成。
8. 兼容接口与管理端：完成所有旧接口序列化及 Moss 管理页面。
9. 数据迁移与切换：迁移工具、演练、校验、运行手册、监控和回滚。

身份与组织是其他业务的前置依赖。其接口稳定后，Agent/Skill/配置、Billing、Dify 和 QMS 可以并行。兼容接口应随每个领域同步实现，不能最后一次性复制路由。

所有工作流都不修改 Sudowork 客户端。客户端仓库只作为只读协议参考和端到端测试目标。

## 13. 测试方案

### 13.1 特征测试与差异测试

对每个旧接口，把同一份脱敏请求分别发送给 Sudowork Server 和 Moss，然后比较：

- 状态码；
- 相关 Header；
- 归一化后的响应体；
- SSE 事件序列；
- 文件或媒体字节及 Content-Type；
- 数据库结果；
- 计划执行的外部命令。

时间戳、Token 和请求 ID 等动态值按 Schema 和约束比较，不要求字面相等。任何差异必须有书面评审例外。

SMS、积分发放、支付、退款、Dify 写入、上传和告警不能在影子测试中执行两次。相关模块必须提供 Fake Adapter 和命令捕获能力。

迁移模式测试必须验证 Import Command 仍然写入要求的主数据、账本、审计和内部一致性记录，同时不调用任何外部 Adapter，也不产生可投递的外部 Outbox 记录；`suppressed` 记录的迁移批次、类型、资源和原因必须与迁移报告一致。

回放测试必须验证同一原始事件重复执行不会重复改变内部状态或产生外部投递；默认 `replay` 的外部 Adapter 调用数必须为零。运维 `redelivery` 必须验证审批、目标白名单、原幂等键去重和完整审计，并证明同一外部动作最多成功投递一次。

### 13.2 客户端兼容测试

使用未经修改的受支持 Sudowork 客户端版本测试：

- 本地模式登录、注册、企业配置、Agent/Skill 获取和本地执行；
- 云端模式登录、Session 创建、WebSocket、权限、重连、恢复、文件、模型切换和终止；
- 本地 Cron 和 Channel 继续使用客户端数据及执行器；
- 企业 Cron 和 Channel 使用 Moss；
- Dify 对话、历史、反馈、文件、音频和 SSO；
- Token 过期、刷新、退出、锁定用户和越权失败。

受支持客户端版本矩阵必须成为机器可读的测试输入。每个版本至少在其声明支持的操作系统和架构上执行登录、本地模式、企业云端模式及升级前已有 Token 的回归测试。单个本地工作树或单一开发提交不能代替正式发布版本矩阵。

### 13.3 领域合并门禁

每个业务域合并前必须同时满足：

- 该领域全部旧 endpoint 已进入机器可读路由清单；
- 每个 endpoint 都有脱敏请求 Fixture、状态码、相关 Header 和响应基线；
- 新旧服务差异测试通过，所有允许差异都有书面批准；
- 涉及 SSE、上传、下载、音频、302 或 HTML 的接口完成对应传输测试；
- 涉及 SMS、支付、退款、积分、Dify 写入、上传和告警的接口通过 Fake Adapter、副作用命令捕获及幂等测试；
- 具备迁移路径的领域通过 `migration` 执行上下文测试，且外部 Adapter 调用数和可投递外部 Outbox 新增数均为零；
- 统一领域服务及 Moss 原生接口的回归测试通过；
- 兼容路由没有直接 SQL、独立业务状态或外部集成调用。

未通过上述条件的领域不得合并，不能把契约补测推迟到总发布阶段。

### 13.4 发布门禁

生产切换前必须满足：

- 所有范围内旧接口契约用例通过。
- Moss 云端 Session 回归用例通过。
- 两仓现有测试红灯已修复，或有明确批准的非迁移问题记录。
- 使用代表性生产副本至少完成两次全量迁移。
- 两次迁移产生相同的映射和对账结果。
- 财务差异为零。
- 身份和 Organization 冲突全部解决。
- 不存在待同步充值、退款或授信操作。
- 数据恢复和回滚演练成功。
- Staging 监控和告警验证通过。
- 受支持客户端版本矩阵全部通过，且测试使用的客户端二进制或构建摘要已经归档。
- 每个迁移批次的副作用抑制报告已经审核，迁移来源的可投递外部 Outbox 待处理数量为零。

## 14. 正式切换

### 14.1 切换准备

- 至少提前七天使用生产副本演练完整迁移。
- 至少提前一天降低 DNS TTL，并验证备份可恢复。
- 确认第三方回调域名能够切换到 Moss，且签名验证不变。
- 解决所有迁移冲突并清空待处理财务操作。
- 发布维护窗口，并明确上线和回滚决策负责人。

### 14.2 维护窗口步骤

1. 将 Sudowork Server 进入维护状态，拒绝新的写操作。
2. 停止旧系统的调度、对账、QMS 聚合和告警任务。
3. 确认没有进行中的支付、退款、授信、Dify 上传或注册操作。
4. 备份 SQLite、Redis Token、PostgreSQL/TimescaleDB、上传文件和配置。
5. 执行最终迁移。
6. 执行自动数据校验并生成不可修改的结果报告。
7. 审核迁移副作用抑制报告，并确认不存在 `origin=migration` 的可投递外部 Outbox 待处理记录。
8. 启动 Moss，但暂不启动后台任务和用户写入。
9. 执行登录、接口、财务、Dify、QMS、本地模式和云端 Session 冒烟测试。
10. 所有门禁通过后，将原 Sudowork 域名切换到 Moss。
11. 再次确认外部 Outbox 门禁为零，只启动一份 Moss 后台任务，然后开放写入。
12. 持续监控认证失败率、接口错误率、支付回调、余额变化、Session 失败、调度 lease 和 QMS 接收。

### 14.3 回滚

Moss 开放写入前，回滚只需把流量重新切回冻结的旧服务。

Moss 接受新写入后，仅切换 DNS 并不安全。Moss 必须在观察期记录所有变更命令。需要回滚时：

1. 暂停 Moss 写入和后台任务。
2. 将切换后发生的身份、财务、配置、Dify 和自动化变更对账或回放到旧系统。
3. 核对第三方支付与回调状态。
4. 校验通过后再恢复旧服务流量。

回滚工具向旧系统回放状态时同样遵循 §6.3 的 `replay` 默认抑制规则，不得重新触发历史外部动作。必须补发的外部动作只能进入经过审批的 `redelivery` 清单，不能夹带在状态回放中执行。

旧服务在观察期停止流量和任务，但保持可恢复，旧数据保持只读。观察期至少覆盖一个完整的支付对账周期和定时任务周期。经过运维确认后才能彻底删除。

## 15. 运行与安全要求

- 请求日志记录接口类型、Canonical Organization/User ID、旧数字别名、路由、Trace ID 和结果，但不得记录秘密。
- 指标区分 Moss 原生流量与 Sudowork 兼容流量，同时按统一业务模块聚合。
- 后台任务使用 lease，保证集群中只有一个实例执行同一次任务。
- 外部集成重试使用有上限的指数退避和稳定幂等键。
- 生产流量开放前，所有秘密必须迁入 Nexus。
- 生产环境发现 SMS 调试绕过或默认密钥时必须拒绝启动。
- 上传路径必须规范化，并限制在 Organization 所属目录。
- QMS 保留 API Key 轮换和加密请求支持。
- 财务和身份变更必须写审计记录。

## 16. 已确认的取舍

- 为兼容旧客户端，长期保留基于 Host 的旧协议 Adapter，但不复制业务实现。
- 兼容 Adapter 内部使用 Hono，并通过 `@hono/node-server` 接入 Moss 现有 `node:http` 服务；不建立第二个服务进程。
- 跨身份、数字别名和 Billing 的写操作由共享连接上的统一 UnitOfWork 管理。
- 普通模式与企业模式的 Cron/Channel 实例继续分开，因为不修改的客户端仍拥有本地配置和执行。
- QMS 保留 TimescaleDB，由 Moss 统一拥有模块和生命周期；统一平台不要求只有一个数据库。
- 接受维护窗口，以避免长期双写及双向同步冲突。
- 旧数字 ID 作为资源别名永久保留。
- Moss 管理端替代原 Sudowork Server 管理后台，原域名继续保留旧接口和资源访问能力。

## 17. 完成标准

只有全部满足以下条件，迁移才算完成：

- 原 Sudowork 域名已经由 Moss 提供服务。
- 原 sudowork-server 不再接收生产流量，也不运行后台任务。
- 未修改的 Sudowork 客户端通过本地模式和企业云端模式验收。
- 历史用户和 Moss 新建用户都能使用要求的 Sudowork 登录方式。
- 所有迁移能力都由 Moss 统一模块和管理端维护。
- 任何兼容路由都不拥有独立业务数据或业务逻辑。
- 迁移报告和对账报告已经归档。
- 回滚观察期结束，且没有未解决的一级或二级问题。
