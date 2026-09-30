# 组织共享 SudoRouter 账户：实现与联调说明

## 代码范围

只修改 Moss 与 Sudowork。两个独立 worktree 使用分支 `codex/org-router-shared-billing`，创建时基于已拉取的 `origin/dev`：Moss `403594d`，Sudowork `6e277a4e`。

- Moss：组织账户、成员 Key、管理/用量 API、富友组织订单、凭据解析、管理员页面、本地 Router 模拟器。
- Sudowork：用户中心的限额和用量、组织管理员充值中心、权限菜单、美元订单、移除对话积分估算。
- 不改动 SudoRouter/new-api、sudostack、sudowork-server。没有迁移生产资金、推送或部署。

## 实现行为

创建新组织时设置初始 USD 额度及默认成员限额。组织对应一个 Router User，初始密码沿用 Router 账户名（不足 8 字符在末尾补 `1`），不绑定某个成员的用户名；服务器使用独立默认服务 Key，成员和组织管理员各有自己的 Key。默认服务 Key 的初始限额为 $1，可单独调整。现有 Router 注册赠额计入初始目标，只补不足部分；后续登录、重试或新建成员不补组织余额。

后台创建成员可选“组织默认”“设置限额”“不限额”。邀请码注册只继承组织服务端默认值；旧邀请码赠额不写入新个人钱包，也不提高成员限额。有限 Key 可增加/减少剩余限额，不限额模式创建后不切换。调整限额不改变组织资金，不自动恢复停用 Key。

停用/删除成员先禁用远端 Key；停用组织模型服务同时停止所有成员使用。恢复用户身份不会自动解除独立的 Key 停用，需要管理员明确启用 Key。现有原生用户不允许跨组织迁移，兼容入口对共享账户成员同样拒绝迁移。包含模型账户和资金记录的组织不能直接删除。

组织模型账户的凭据不能回退为成员凭据。云端运行时使用会话所属成员的 Key；本地配置下发遵循已有 Local 授权并使用该成员 Key。独立配置的其他 Provider 保持自己的计费与凭据。

## 金额与充值

新数据使用独立 `organization_model_*` 表，不把 USD 写入旧积分字段：

- USD 输入是小数文本，最多两位；展示可保留 quota 对应的小数精度。
- `$1 = 500000 quota`；内部资金更新使用整数 quota。
- 沿用 `systemConfig.recharge.usdToCnyRate` 配置；订单独立固化购买 USD 微单位、赠送 USD 微单位、人民币分、汇率、quota 换算系数、组织收款账户、付款人和测试支付标志。
- 保留等值优惠：$5 + $0.50、$10 + $1、$20 + $3、$50 + $10。
- 充值菜单同时检查支付服务是否已配置并启用；仅当前组织角色为 `admin` 的用户可以创建/查询/支付组织订单；超管身份本身不授予充值权限。组织各管理员可查看同一组织订单，普通成员不能访问。
- 保留富友 RSA/GBK 回调协议校验和查单；新的 Moss 回调为 `POST /api/v1/model-billing/callback`，支持 JSON 和表单封装，不接受客户端直接声明“已支付”。
- Router 入账继续复用 `PUT /api/user/quota`，不需要新的 Router 充值接口。
- 订单收款账户在创建时冻结；测试/正式环境变化后拒绝继续支付原订单，必须取消后重新创建；付款人以后离职、变更角色或组织，不改变已支付订单归属。取消/过期后收到合法支付结果仍按原订单入账。
- 已成功的订单不会重复入账。旧接口超时、进程中断等结果不确定时进入 `needs_review`，禁止盲目重发；不能用当前余额或未搜到备注推断“未入账”。核对上游账务事实后再处理本地操作记录。

旧个人资产/订单保留原始单位与归属，历史回调、补单、退款、模拟支付均读取旧个人绑定，不使用新组织账户。共享组织关闭旧个人充值、积分调整、积分申请和旧额度同步入口。原积分页面退出当前用户流程；Moss 的历史个人账务页面保留原始记录。既有组织资金归并另行迁移，本次不自动把个人资金变成组织共有资金。

## Moss 新接口

所有非回调接口都使用现有 Moss 身份认证及当前组织上下文。客户端不传 Router User ID 或任意 Token ID。

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/model-account` | 当前成员限额；管理员额外获得组织余额、管理能力 |
| `GET /api/v1/model-account/members` | 管理员查看成员/服务 Key 的掩码、状态和限额 |
| `GET /api/v1/model-account/logs?page=1&page_size=20` | 成员仅自己的 Token 消费记录；管理员组织记录 |
| `PATCH /api/v1/model-account/defaults` | 设置后续成员默认限额 |
| `PATCH /api/v1/model-account/status` | 停用/恢复整个组织模型服务 |
| `POST /api/v1/model-account/retry` | 继续已记录的开户步骤，不重复不确定的旧接口写操作 |
| `POST /api/v1/model-account/members/{userId}/provision` | 补开成员 Key，使用已记录限额或组织默认 |
| `PATCH /api/v1/model-account/members/{userId}/status` | 停用/启用成员 Key |
| `POST /api/v1/model-account/members/{userId}/limit` | 增加/减少有限成员的剩余限额 |
| `PATCH /api/v1/model-account/service/status` | 停用/启用默认服务 Key |
| `POST /api/v1/model-account/service/limit` | 调整默认服务 Key 限额 |
| `GET /api/v1/model-billing/packages` | USD 购买/赠送套餐及 CNY 应付 |
| `GET /api/v1/model-billing/orders?page=1&page_size=20` | 组织订单分页 |
| `POST /api/v1/model-billing/orders` | 创建固定收款组织的订单 |
| `GET /api/v1/model-billing/orders/{orderNo}` | 查看订单 |
| `POST /api/v1/model-billing/orders/{orderNo}/pay` | 获取富友支付二维码 |
| `POST /api/v1/model-billing/orders/{orderNo}/sync` | 查询支付状态；合法结果按原订单入账 |
| `POST /api/v1/model-billing/orders/{orderNo}/cancel` | 取消本地待支付订单 |

创建订单与 Key/账户状态、限额调整请求使用稳定 `Idempotency-Key`。创建原生组织增加 `initial_amount_usd`、`default_member_limit_usd`；创建原生成员增加 `member_limit_usd`，省略继承默认，`null` 为不限额。

请求示例：

```http
POST /api/v1/model-billing/orders
Authorization: Bearer <Moss access token>
Idempotency-Key: <stable order request UUID>
Content-Type: application/json

{"purchase_amount_usd":"10.00","payment_method":"ALIPAY"}
```

```http
POST /api/v1/model-account/members/<Moss user UUID>/limit
Idempotency-Key: <stable adjustment UUID>
Content-Type: application/json

{"amount_usd":"5.00","direction":"increase"}
```

## SudoRouter 接口边界

继续使用既有创建 User、创建 Token、账户读取、User 状态、管理员日志和 `PUT /api/user/quota`，既有路由与请求语义不变。

新增供应方接口仍只有已批准的三类：

1. N01 `GET /api/integration/v1/users/{user_id}/tokens`
2. N02 `PATCH /api/integration/v1/users/{user_id}/tokens/{token_id}/status`
3. N03 `POST /api/integration/v1/users/{user_id}/tokens/{token_id}/quota-adjustments`

N02/N03 使用持久 `reference` 与请求指纹，拒绝同 reference 的不同操作。具体供应方字段以本目录的 integration-api-draft 为准。

Moss 日志接口复用管理员 `GET /api/log/`，只返回可信绑定范围内的消费记录和过滤后的总数；最多扫描最近 10000 条组织日志，超限明确返回 `truncated: true`，UI 显示范围提示。它不修复 Router 旧成员日志入口直接访问同账户其他 Key 日志的问题。真实多成员环境上线前仍须供应方确认旧入口隔离；本地模拟通过不代表真实隔离已解决。

## 本地模拟与混合联调

独立模拟，不连接远端 Router：

```sh
node --import tsx scripts/mock-sudorouter.ts
```

监听 `127.0.0.1:3301`。默认管理员凭据是虚构测试值 `local-router-test` / `1`。Moss 沿用已有开发启动配置（数据库、Nexus 和支付配置），将 Router 连接设置为：

```dotenv
SUDOROUTER_BASE_URL=http://127.0.0.1:3301
SUDOROUTER_API_TOKEN=local-router-test
SUDOROUTER_ADMIN_USER_ID=1
```

共享组织模型设为 `mock-model` 可验证模拟消费。模拟器返回固定 OpenAI chat-completion，不模拟完整模型能力；支持共享扣额、成员限额和停用检查。`POST /__mock/consume` 仅存在于回环模拟器且需模拟管理员认证，供确定性测试使用，不是 Moss 接口。

混合模式：旧接口代理到用户授权的旧测试环境，N01–N03 由本地记录模拟：

```sh
ROUTER_MOCK_UPSTREAM_ENV_FILE=/absolute/private/router-test.env node --import tsx scripts/mock-sudorouter.ts
```

私密文件仅在本机包含 `SUDOROUTER_BASE_URL`、`SUDOROUTER_API_TOKEN`、`SUDOROUTER_ADMIN_USER_ID`。不要提交文件或复制真实 Token 到命令日志。Moss 仍连接上述回环地址，代理会替换为上游认证并记录经它创建的测试账户和 Key。

模拟状态默认保存到 `~/.local/state/moss-router-mock/standalone.json` 或 `hybrid.json`，权限 0600；其中含测试 Key，不能加入版本控制。通过 `ROUTER_MOCK_PORT` / `ROUTER_MOCK_STATE_FILE` 可改端口与状态文件。不要把两种模式的状态混用。

混合模式不执行模型推理：本地模拟的停用/限额不会约束真实 Router 推理，因此此模式返回明确错误，避免把模拟验证误当作真实执行。`GET /health` 可确认模式。

真实 N01–N03 测试接口就绪后，使用独立测试配置将 Moss 指向该环境；若新接口有单独根地址，设置 `SUDOROUTER_INTEGRATION_BASE_URL`。不要把尚未真实执行过的混合模拟限额当作线上状态。重新验证：资源归属、reference 重放/冲突、并发扣费、启停、有限/不限额、旧日志隔离、富友回调协议校验及超时核对。

## 富友本地模拟与充值复测

新增开发模拟服务，复用实际 `FuiouAdapter` 的 RSA 加解密、GBK、下单/查单字段和表单回调解析。支付成功后经 Moss 的组织订单入账逻辑调用现有 Router `PUT /api/user/quota`，不直接修改订单数据库，也不需要 Router 新增充值接口。

```sh
node --import tsx scripts/mock-fuiou.ts
```

默认监听 `http://127.0.0.1:3303`，回调 `http://127.0.0.1:43127/api/v1/model-billing/callback`。可通过 `FUIOU_MOCK_PORT`、`FUIOU_MOCK_CALLBACK_URL`、`FUIOU_MOCK_DIR` 调整；仅接受回环地址。自动生成的测试密钥、控制凭据、订单状态和 Moss 环境文件保存在私密目录 `~/.local/state/moss-fuiou-mock`，不要提交。

将生成的 `moss.env` 加载到独立开发 Moss 进程，并在开发配置中设置 `systemConfig.rechargeMode = "pay"` 后重启。环境文件提供支付开关、测试商户、测试密钥路径及回环支付 URL。当前预览使用 `/Users/yobach/.local/state/org-router-preview/fuiou/moss.env`；这是本地环境配置，不改已有支付平台配置的语义。只有真实组织管理员且支付已启用时，`GET /api/v1/model-account` 才返回 `can_recharge: true`，客户端展示“设置 → 组织充值中心”。

验证步骤：

1. 在 Sudowork 使用组织管理员创建充值订单，等待支付二维码出现。
2. 打开 `http://127.0.0.1:3303`，找到对应订单，点击“模拟支付并回调”；客户端轮询后显示“已到账组织账户”和更新后的 USD 余额。
3. 点击“重复发送回调”，组织余额应保持不变。
4. 另建订单，点击“仅支付，等待查单”，在客户端刷新或等待轮询；查单成功应补入一次，之后收到回调不能再入账。
5. 普通成员不展示充值入口；直接访问充值页面应提示无权限，充值接口返回 403。

模拟环境不产生真实扣款。当前预览采用既有富友测试模式，订单应付固定为 ¥0.01，购买/赠送美元金额仍按订单入账；套餐展示的人民币为正常汇率报价，二维码区域标明测试支付和实际测试金额。不要扫描二维码向真实商户付款。富友真实环境仍须独立联调。

本轮页面测试发现并修复跨域预检遗漏 `Idempotency-Key`：此前桌面客户端下单会出现 `Failed to fetch`。原 HTTP CORS 处理独立为 `httpCors.ts` 并加入真实 HTTP 预检回归，确保浏览器允许带稳定操作标识的下单请求。

2026-09-30 实际 HTTP / 桌面验证：支付宝 $10 + $1 赠送到账后余额 $10 → $21；5 个并发重复回调未重复入账；微信 $5 + $0.50 在无回调时经查单到账 $26.50，随后回调不重复；已取消的 $1 订单收到晚到支付回调后到账 $27.50。组织成员限额始终为 $5。普通成员客户端隐藏充值菜单，直接进入充值路由显示权限提示；套餐、订单列表、创建、详情、支付、查单、取消共 7 个接口均返回 403，无效密文回调被拒绝。所有入账均落到授权旧测试环境中的组织账户；没有真实支付。

本轮回归：`node scripts/run-node-tests.js billing src/server/httpCors.node-test.ts` 78/78 通过；`bun run build:node` 通过；类型棘轮 104/105 通过，现有仓库其他类型错误仍存在，没有提高基线。预览桌面的独立目录补齐已有 Node 运行时后，再次验证成员登录、菜单隐藏和直达路由拦截。

## 已验证与待外部验证

### 验收边界清单（2026-09-30）

当前是混合联调：组织/成员与订单保存在真实 Moss 开发数据库，旧 Router 接口转发到授权测试环境，新增 N01–N03 在本地模拟，富友在本地模拟。下表的“保留实现”表示当前没有已知的重做需求，不代表省略切换环境后的回归。

| 能力 | 已有验证 | 后续工作 |
| --- | --- | --- |
| 创建 Router 组织账户、按账户名生成初始密码 | 旧测试环境实际开户和登录通过 | 保留旧接口与 Adapter；新环境核对权限及注册赠额配置 |
| 创建默认/成员 Key，指定同一 user_id 和有限/不限额 | 旧测试环境实际创建通过；Moss 身份入口与邀请集成自动测试通过 | 保留创建接口；新接口就绪后复测完整开户、邀请流程 |
| 组织余额读取、初始补额、充值入账 | 真实旧接口通过；三笔模拟付款实际入账，余额 $10 → $27.50 | 保留 GET user / PUT quota；不要求 Router 新增充值接口 |
| 整个组织账户停用 | 真实旧接口停用通过 | 保留接口；真实推理时复测所有成员均被阻止及恢复行为 |
| N01 Key 列表、状态、剩余限额、用量 | 本地模拟通过；当前成员状态并非远端实时消费结果 | 供应方提供真实接口，验证停用 Key 可查、归属、分页及消费后数值 |
| N02 成员/默认 Key 启停 | 本地模拟通过 | 验证真实 Key 请求被允许/拒绝、持久幂等和重放冲突；复测成员停用/删除流程 |
| N03 有限 Key 限额增减 | 本地模拟通过 | 验证真实限额、并发消费时原子增减、持久幂等、不能改变组织余额或自动启用 Key |
| 所有成员共享余额、独立限额、余额耗尽阻止调用 | 仅全模拟消费通过；混合模式主动禁止真实推理 | 使用真实成员 Key 调模型，覆盖普通/流式请求、并发、限额耗尽和组织余额耗尽 |
| 成员日志隔离 | Moss 按可信 user_id/token_id 过滤的自动测试通过 | 有真实消费后核对日志字段/分页；供应方处理旧成员日志入口直接访问其他 Key 日志的问题 |
| 富友下单、回调、查单与 Moss 入账 | RSA/GBK 本地模拟 + 实际 HTTP + 桌面通过，Router 加额是真实调用 | 接真实富友商户、支付地址、密钥、回调地址做小额付款联调；不依赖 Router 新接口 |
| USD/CNY/quota 计算、订单归属冻结、成功订单防重、异常待核对 | 本地自动测试通过；防重、漏回调补账、晚到回调另有 HTTP 验证 | 保留业务实现；未知旧接口结果仍需人工核对，不宣称自动补账已覆盖一切故障 |
| 充值菜单与权限、充值不提高成员限额 | 实际桌面与 HTTP 通过；普通成员 7 个充值接口均 403 | 保留实现；环境启用支付后回归 |
| 去积分、组织/成员绑定、默认限额继承与前端参数 | 自动测试与页面验证通过 | 保留实现；涉及 N01–N03 的外部执行行为仍需真实接口复验 |

供应方本期仍只需补充 N01、N02、N03 三个管理接口。共享模型消费和旧日志隔离属于既有行为的验收/修复，不因此增加第四个充值或日志接口。真实服务若遵循已约定契约，主要工作是切换配置并回归；若路径、鉴权、字段或错误码存在差异，优先调整 Moss Router Adapter。若幂等、权限或扣额语义不满足约定，则需要供应方修复，不能只靠客户端映射解决。

正式环境还需确认 `$1 = 500000 quota` 与组织使用钱包余额计费的配置，避免订阅优先等现有配置改变共享余额扣费路径。历史资产归并和生产迁移不在已完成范围内。

2026-09-30 已在授权旧环境用独立账户 `9879`、Token `275` 验证创建账户、创建 Key、账户查询、quota 增加 10000 再扣回、账户停用。净余额变动 0，测试账户已停用；没有真实推理或真实支付。N01–N03 混合模拟的查询、停用、限额幂等通过。

自动测试覆盖精确金额、共享消费、独立限额、默认值、邀请码注册、权限、状态重放、日志过滤、重复回调、响应丢失、晚到支付和支付测试模式冻结。新测试加入 Moss 标准测试入口；Sudowork 增加 USD 请求及订单状态测试。

真实新接口的执行语义、旧成员日志入口隔离和富友支付环境回调仍需外部测试环境验证。已有个人资产不自动迁移。`needs_review` 需要远端证据核对，不自动补钱。

## 本次验证记录

- Moss 新增领域与身份专项 14/14 通过，覆盖组织/邀请真实身份入口和充值配置边界。
- Moss 全量测试通过：1317 passed / 7 skipped / 0 failed（Bun 与各 Node 阶段合计）。类型棘轮 105/105 通过，属于现有基线，并非整个仓库零类型错误。管理端 tsc 和生产构建通过。
- Sudowork 新客户端和充值组件测试 5/5 通过；桌面与共享 renderer 类型检查通过，修改文件 ESLint 通过（既有 DashboardStatsContext 两项 any 警告）。
- Sudowork 全量最后一轮 2675 passed / 1 timeout / 12 skipped。超时在未改动的 ontologyWorkbench.dom.test.tsx；该文件独立复测 53/53 通过。没有把全量回归报告为全绿。
- Chrome 无头浏览器使用真实 Moss 管理页面、模拟 HTTP 响应，验证创建组织 USD 参数、有限/不限额成员、限额调整和停用 Key、幂等标识及无积分列；未出现页面错误。此项是页面交互验证，不代表真实支付端到端通过。
- 独立 HTTP 模拟器验证共享扣额、有限/不限额、限额重放不重复、组织停用。固定模拟模型响应仅支持非流式 chat completion。
- 私密测试凭据未进入改动文件。未提交、推送、部署或迁移任何生产数据。
