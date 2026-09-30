# SudoRouter 组织共享账户：接口复用与最小补充方案

日期：2026-09-29。依据 new-api 本地代码 `sudo/rc24 / 4a0a94f9`。本轮仅更新文档，未实现接口或调用生产服务；线上部署是否一致尚未核实。

**创建账户、创建 Key、充值更新账户额度都有现成接口，不需要重复提供。** 已核对旧 sudowork-server 的富友支付链路，本版仅建议补充 **3 个成员 Key 管理接口**；此前 13 项清单及其后保留的第 4 项充值接口均已撤回。新增路径和响应为待实现的建议契约；已有接口的路径、参数、响应、鉴权和行为全部不变。

业务关系保持不变：一个 Moss 组织对应一个 Router User；组织默认 Key 和成员 Key 都属于该 User，共享组织余额。成员只有消费限额，不持有独立资金。已确认全面取消积分：新业务的模型余额、消费限额、费用、购买及赠送额度统一 USD，内部保留 quota；富友继续由 Moss 对接并收取 CNY，仅组织管理员在 Sudowork 为组织账户充值。整体流程见[已修订的主方案](/Users/yobach/VSCodeProject/moss/docs/plans/2026-09-23-organization-router-account-member-token-design.md)，源码证据及改造位置见[现状核查](/Users/yobach/VSCodeProject/moss/docs/plans/2026-09-29-organization-shared-router-account-review.md)。

创建组织时配置初始额度，后台建成员可选择限额或不限额，邀请注册继承组织默认设置。UI 保留“限额”名称；充值与收费规则沿用既有设计，额度不足只提示“额度不足”。这些产品决策不增加 Router 接口数量。

## 金额与单位约定

- SudoRouter 的旧接口和下列 3 个新增管理接口都使用整数 quota，不新增美元充值接口，不把 quota 字段的含义改成美元。当前基准是 1 USD=500000 quota、1 quota=$0.000002；上线核实部署系数并保存订单换算快照。
- Moss 的新产品/API/账本不使用积分。模型余额、成员限额及费用为 quota 直接转换的 USD；新金额字段明确带 usd/cny/quota 单位，USD API 值用定点字符串，购买/赠送在后台用整数微美元存储。模型账余额以 quota 为准，支付账以 CNY 分为准；币种不是任意互换的标签。
- 管理员输入充值/限额金额首版按两位 USD 小数校验，避免浮点误差；消费和余额保留原始 quota 精度，六位 USD 小数可表达当前最小单位。汇总不能先把每笔消费四舍五入到美分；UI 不把非零小额余额显示为已耗尽。
- 富友继续实际收人民币，订单保存购买 USD、赠送 USD、CNY 实付分、汇率和 quota。人民币应付按购买 USD×订单汇率四舍五入到分并固化；回调核验固化值，不从人民币舍入值反推美元额度。汇率只确定本笔支付价格，不改变已入账余额/限额。赠送额度不计入实付款，不因去积分重新向 Router 加钱。
- 新 Moss 请求/响应不继续输出或接收 points/bonus_points 等积分字段，也不把旧字段原地改单位；明确版本并升级客户端。旧记录只作历史/迁移依据，旧积分写入口关闭。原 Router API 的兼容约束保持不变。

## 1. 直接复用的已有接口

| 业务 | 已有接口 | 如何使用 |
|---|---|---|
| 创建组织对应的 Router 账户 | `POST /api/user/` | 创建普通 User；Moss 保存 orgId → Router User ID |
| 查找开户结果、查询组织余额/状态 | `GET /api/user/search`、`GET /api/user/:id` | 使用稳定用户名核对开户结果；按 ID 查询真实余额 |
| 停用/恢复整个组织账户 | `POST /api/user/manage` | 复用现有 disable / enable，不新增账户状态接口 |
| 创建组织默认 Key、成员 Key | `POST /api/token/` | 管理员指定同一个 user_id；已支持有限额及返回 Token ID/Key |
| 组织初始补额、富友付款后更新组织余额 | `PUT /api/user/quota` | 继续发送 id、quota、comment；初始化按持久化开通任务、充值按固定组织订单取目标和变动值 |
| 成员查看自己的额度 | `GET /api/usage/token/` | 使用成员 Key；成功字段为 code:true，total_available / total_used 对应剩余额度/消费 |
| 基本用量明细 | `GET /api/log/` | Moss 用管理员身份按组织 username 取日志，再按 user_id/token_id 过滤并映射成员 |
| 模型目录、推理 | 现有模型 API | 继续使用对应默认/成员 Key |

组织与成员的业务绑定保存在 Moss，不要求 Router 新建组织表、external_ref 绑定表或另一套开户服务。开户与发 Key 是两个持久化步骤，不能因创建组织本地成功就宣告模型服务就绪。

充值由 Moss 的订单/支付服务处理，Router 只负责按现有 `PUT /api/user/quota` 更新账户余额。旧服务已这样实现，无需新增 Router 充值、订单或富友回调接口。成功订单去重及异常核对由 Moss 承担；旧额度接口没有请求幂等，具体恢复边界见下面的充值示例。

注意：现有成员额度查询不能读取人工停用的 Key；既有 Token 列表、修改、删除等按当前登录 User 校验所有权，平台管理员不能像代创建一样直接管理组织账户下的 Token。修改 New-Api-User 请求头不能冒充目标 User。这才是需要补充管理能力的原因。

## 2. 现有接口即可完成的开户示例

以下路径已存在，示例使用虚构数据。管理请求均由 Moss 服务端发起，管理凭据不下发 Sudowork：

```http
Authorization: Bearer <ROUTER_ADMIN_ACCESS_TOKEN>
New-Api-User: <ADMIN_USER_ID>
Content-Type: application/json
```

### 创建组织账户

```http
POST /api/user/
```

```json
{
  "username": "moss_org_001",
  "password": "moss_org_001",
  "display_name": "示例组织",
  "role": 1
}
```

当前成功响应：

```json
{
  "success": true,
  "message": "",
  "data": { "id": 1001, "username": "moss_org_001" }
}
```

初始密码沿用既有 `sudorouterInitialPassword` 规则：取组织的 Router 账户名，不足 8 字符时在末尾补 `1`（例如 `test` → `test1111`）。组织账户不对应某一个 Moss 成员，不能用成员名决定组织密码。现有校验要求密码 8–20 字符、用户名最多 20 字符。Moss 使用稳定且避免碰撞的组织用户名并持久化映射；组织更名不更换账户；登录、补开 Key 或开户重试均不重置已有密码。

创建响应没有 quota，需再查账户。旧注册逻辑可能赠送初始额度，应记录实际到账，不能假定初始余额为零、自动重复补赠，也不为此修改全局赠额规则。组织应确认使用 wallet_only 或等效的钱包计费设置；当前默认可能是 subscription_first，不能在此创建请求中虚构一个可生效的 billing_preference 字段。

组织创建表单的初始额度由 Moss 保存，不能把 quota 填入 POST /api/user/ 就认为会生效：当前控制器创建 cleanUser 时未复制此字段。沿用现有初始补额算法，在新账户尚无消费且凭据未开放时计算一次 `max(0, 目标 quota - 已有 quota)`，持久化差额并调用已有 PUT /api/user/quota；已有额度超过目标时保留实际额度，不自动扣回。登录、成员加入及任务恢复不按实时余额重新补足，结果未知按下方充值恢复边界核对。

例如组织初始目标 $100、Router 已赠送 $10，补额请求如下；确认成功后为 $100，而不是 $110。此处为初始化分配，不是富友付款订单。

```http
PUT /api/user/quota
```

```json
{
  "id": 1001,
  "quota": 45000000,
  "comment": "组织初始额度: org_001，目标 $100.00，已有 $10.00，补足 $90.00"
}
```

### 在该账户下创建成员 Key

```http
POST /api/token/
```

```json
{
  "user_id": 1001,
  "name": "member-user_001",
  "expired_time": -1,
  "unlimited_quota": false,
  "remain_quota": 5000000
}
```

当前成功响应中的关键字段（其他字段省略）：

```json
{
  "success": true,
  "message": "",
  "data": {
    "id": 2001,
    "user_id": 1001,
    "key": "EXAMPLE-RAW-KEY-NOT-REAL",
    "remain_quota": 5000000,
    "unlimited_quota": false,
    "used_quota": 0
  }
}
```

组织默认 Key 用同一接口、同一个 user_id，修改 name 和服务预算即可。Moss 保存响应的 id、user_id 和 Key 秘密引用，按现有规则补齐推理 Key 的 sk- 前缀；用途和成员归属保存在 Moss。Moss Adapter 目前仅返回 Key 字符串，需要扩展为保存这些已有返回字段，无需 Router 增加创建接口。

当前 500000 quota = $1.00；示例 5000000 是成员 $10.00 的剩余消费限额，不会增加组织资金。默认 Key 的预算由组织服务配置确定，不能作为成员无 Key/限额不足时的兜底。普通 /v1/models 会拒绝零剩余额度的有限 Key，“默认 Key”也不天然只读。

创建时已有 model_limits_enabled、model_limits 等字段可用；旧接口的 model_limits 是字符串，不改成数组。有限/不限额模式在创建时选定，首版不新增运行中的模式切换功能。

后台创建成员时可直接填写 USD 限额；选择“不限额”则复用同一路径，传 unlimited_quota=true，remain_quota 不作为个人消费上限，例如：

```json
{
  "user_id": 1001,
  "name": "member-user_002",
  "expired_time": -1,
  "unlimited_quota": true,
  "remain_quota": 0
}
```

不限额仍受组织余额约束。邀请码注册由 Moss 使用组织配置的有限/不限额默认值，不能信任注册者传入的限额字段；修改默认配置不影响已有成员。创建者若同时是组织成员，也使用自己的成员 Key。

### 复用旧创建接口的恢复边界

Moss 持久化开户任务及成员唯一绑定，串行处理同一组织/成员的开通，已完成步骤不重复执行。创建账户超时后可用稳定用户名查找，再核对本地任务与 Router ID；不能遇到任意同名账户就自动认领。

**旧创建 Key 接口没有业务幂等，Key 名称也不是唯一约束。** 发出请求后超时或丢失 Key 秘密，应把任务标为“待核对”，停止自动重新创建，使用新增列表核对候选 Token，必要时人工处理。不能仅凭名称绑定、不能认为一次空列表证明原请求没执行；撤销孤立 Token 后也要确认原请求不再可能延迟完成。普通成员在凭据未就绪前不能使用默认 Key 回退。

首版接受上述异常需要核对的限制。若以后要求“开户和发 Key 在任意超时后都自动恢复”，再增加幂等发 Key 能力；不能把这项增强当作已有能力，也不在本期重复建立整套开户接口。

### 富友充值：复用 PUT /api/user/quota

已核对旧项目 `/Users/yobach/VSCodeProject/sudowork-server` 当前 `comac / d2f7fd4`：

```text
富友回调 /api/v1/recharge/callback
  → RechargeService.handleCallback：检查商户/回调数据、金额与支付状态，已成功订单跳过
  → processRecharge：读取用户绑定，调用 updateUserQuotaWithLog
  → PUT /api/user/quota：更新 Router 账户额度
  → 写本地充值记录、账本及订单成功状态
```

新组织订单继续这条业务链路，调用现有接口：

```http
PUT /api/user/quota
Authorization: Bearer <ROUTER_ADMIN_ACCESS_TOKEN>
New-Api-User: <ADMIN_USER_ID>
Content-Type: application/json
```

```json
{
  "id": 1001,
  "quota": 5500000,
  "comment": "组织充值订单: order_001，购买 $10.00，赠送 $1.00"
}
```

```json
{
  "success": true,
  "message": ""
}
```

本例购买 $10.00，赠送 $1.00，合计到账 $11.00=5500000 quota。若订单汇率为 7.30（示例），富友实付为 ¥73.00=7300 分；购买、赠送及实付款分别保存，回调核验的是 7300 分。

id 是订单固化的组织 Router User ID，不是付款管理员的个人账户；quota 是变动值，正数增加，负数减少，支付入账只传已核验订单对应的正数。comment 继续记录订单号便于核对，**它不是 Router 的去重键**。充值只增加组织资金，成员 Token 限额不变；负数能力保留，不等于自动完成现金退款。

Moss 下单时固化 org_id、router_user_id、付款管理员、USD 购买/赠送金额、CNY 实付分、汇率/定价快照和 quota；回调和补单使用原收款绑定，不能按付款人当前组织解析。旧充值订单虽保存 enterprise_id，入账时仍读取 users.sudorouter_user_id，且会更新个人 quota/balance；组织模式要调整这两点，不能把个人钱包同步原样复制过来。

仅组织管理员可在 Sudowork 展示和使用组织充值中心，Moss 后端检查组织权限；富友处理、订单、审计及已付款结果处理保留，历史个人订单沿用原归属，不因管理员离职/降权丢弃已收款事件。

**已有去重与异常边界：** 旧 handleCallback 在本地事务中跳过 SUCCESS 订单，然后先请求 Router、再提交本地成功状态。Router 已加额但响应丢失，或本地写入失败回滚时，本地事务无法撤销 Router 加额。旧 retryFailedOrder 和付款查单同步又会调用相同额度接口；不能把这些路径视为已保证任何异常都只入账一次。

复用接口时，Moss 应在外部调用前持久化支付确认和入账尝试，按订单做数据库级排他处理，区分未发送、处理中、已确认到账与结果未知。已到账的重复回调直接完成；确定未发送/未生效的失败才能重试。请求超时、进程中断或远端成功后本地落库失败进入待核对，所有回调、补单和任务恢复均不得直接再加额。核对需要可确认的外部结果/审计证据；一次当前余额查询或暂未查到订单备注都不足以证明没有入账，无法确认时保持待处理并人工介入。本地状态机可避免盲目补发，不等于给旧远程接口增加幂等。

因此，正常付款仍自动到账；不确定结果需要核对。这是 Moss 支付迁移的异常处理要求，本期不要求 Router 新增充值接口。

源码：[回调及本地成功检查](/Users/yobach/VSCodeProject/sudowork-server/src/services/RechargeService.ts:239)、[实际入账调用](/Users/yobach/VSCodeProject/sudowork-server/src/services/RechargeService.ts:326)、[原额度客户端](/Users/yobach/VSCodeProject/sudowork-server/src/services/SudorouterService.ts:440)、[Router 原实现](/Users/yobach/VSCodeProject/new-api/controller/sudowork.go:18)。

## 3. 建议新增的 3 个接口

以下统一省略 `/api/integration/v1` 前缀。N01–N03 分别对应查询、状态和成员限额，全部与 Key 管理有关。

| 编号 | 建议新增接口 | 实际缺口 |
|---|---|---|
| N01 | `GET /users/{user_id}/tokens` | 管理员查询指定账户的 Key、状态、限额和消费；含停用/过期/耗尽；支持 token_id 精确过滤 |
| N02 | `PATCH /users/{user_id}/tokens/{token_id}/status` | 管理员停用/恢复成员 Key，只改状态，不覆盖并发消费中的余额 |
| N03 | `POST /users/{user_id}/tokens/{token_id}/quota-adjustments` | 原子增减成员剩余限额，支持重试去重，不改组织余额和历史消费 |

开户、发 Key、查询账户、整账户启停、充值均不在新增清单中。共享账户不改变 Router User 资金接口的业务能力，所需变化是 Moss 的账户归属、组织权限和订单处理。

### N01：组织 Key 列表与单把 Key 查询

```http
GET /api/integration/v1/users/1001/tokens?token_id=2001&page=1&page_size=50
```

token_id 可省略。不另设详情接口，精确过滤仍返回同一种列表结构。按稳定 Token ID 排序分页；不存在的过滤目标返回空列表，越权目标按权限规则拒绝。

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 2001,
        "user_id": 1001,
        "name": "member-user_001",
        "key_masked": "sk-EXA…KEY",
        "status": "enabled",
        "unlimited_quota": false,
        "remain_quota": 4200000,
        "used_quota": 800000,
        "expired_time": -1,
        "model_limits_enabled": false,
        "model_limits": "",
        "created_time": 1790668800
      }
    ],
    "total": 1,
    "page": 1,
    "page_size": 50
  }
}
```

不返回明文 Key。Moss 从已有秘密存储提供有权限、有审计的复制，不需要新增 Router 取明文接口。这里是余额快照，不是某笔充值/调整已执行的凭证，也不承诺分页期间的固定快照。

### N02：停用/恢复

```http
PATCH /api/integration/v1/users/1001/tokens/2001/status
```

```json
{
  "reference": "moss:token-status:change_001",
  "status": "disabled",
  "reason": "管理员暂停该成员使用"
}
```

成功返回 success、reference、idempotent_replay，以及 data 中的 user_id、token_id、status。只接受 enabled / disabled；读取可另含 exhausted / expired。启用前检查有效期和有限额 Key 的剩余额度，无效则拒绝并说明原因。恢复 Token 不恢复已停用的组织账户。

更新只写状态并同步相关缓存；成功后新鉴权请求不能继续使用已停用 Key，已开始的请求允许完成结算。不能使用旧 status_only 的完整 Token.Update 路径，因为它会一并写回 remain_quota，可能覆盖并发消费。

### N03：增加或减少成员剩余限额

```http
POST /api/integration/v1/users/1001/tokens/2001/quota-adjustments
```

```json
{
  "reference": "moss:member-limit:adjustment_001",
  "delta_quota": 2500000,
  "reason": "追加 $5.00 消费限额"
}
```

```json
{
  "success": true,
  "reference": "moss:member-limit:adjustment_001",
  "idempotent_replay": false,
  "data": {
    "user_id": 1001,
    "token_id": 2001,
    "delta_quota": 2500000,
    "remain_quota_before": 4200000,
    "remain_quota_after": 6700000,
    "used_quota": 800000,
    "status": "disabled"
  }
}
```

本例在剩余 $8.40（4200000 quota）、已用 $1.60（800000 quota）的基础上追加 $5.00（2500000 quota），剩余成为 $13.40（6700000 quota）；已用金额和组织资金不变。示例延续上一步人工停用状态，调限额不解除人工冻结。原子执行 remain_quota += delta_quota；负数减少可用限额，必须原子检查足额；拒绝零、小数、溢出和超出允许范围的值。不改 User.quota 或 Token.used_quota，不使用同时减少 used_quota 的内部 IncreaseTokenQuota 退款函数。

只用于有限额 Token；不限额 Key 返回 QUOTA_MODE_CONFLICT。耗尽状态在追加后有正余额、且未过期时可恢复；人工 disabled 和过期状态不因加额恢复。此接口调整“还能花多少”，不接受“总预算”绝对值；前端不能读余额后自行计算 delta 来假装实现无竞态的总上限设置。

## 4. 新接口的必要约束

- 鉴权沿用服务端管理员凭据，并检查相应管理权限；Moss 校验当前组织权限，从可信绑定解析目标 ID。Router 校验目标资源的访问权限及 Token 属于路径 User，不信任前端提交的任意 Router ID。这里不要求新建托管账户注册体系。
- 仅新增 N02/N03 用 reference 同时作为业务标识和幂等键。Moss 在本地持久化成员管理操作后发送，重试不得换值。Router 以“经过认证的集成调用方、操作类型、reference”建唯一约束，目标 ID 不进入唯一键，而进入请求指纹；同键同请求重放原结果，同键改目标/参数返回 409 / IDEMPOTENCY_CONFLICT。reference 不作为权限证明。
- 数据变更、去重记录和结果必须事务提交或有持久化可恢复状态，相关缓存同步完成后才报告成功。并发重发也只执行一次，去重记录需持久保留。不能只加请求头或内存去重。这是新增成员管理接口的要求，不是旧资金接口已有的保证。
- 首版无需独立操作查询接口。响应丢失后重发原命令，返回保存的成功结果及 idempotent_replay=true；原操作未完成则返回 HTTP 202、success=false、status=processing，不再次执行。未知结果不能被报告为确定失败；幂等重放不把旧状态重新写回，不返回“当前余额”冒充原操作结果。
- 成功为 HTTP 200；请求无效 400，未认证/无权限 401/403，目标不存在或 Token 不属于目标账户 404，幂等/额度模式冲突 409，额度不足/过期/耗尽无法启用 422，临时故障 503。错误统一含 success=false、error.code、error.message；写请求附 reference。遇到超时、202 或 503 保留原 reference 重试。

上述 reference、重放结果和错误约定只适用于新增成员管理接口。旧接口不强制这些字段或规则，也不改变默认值；组织支付继续使用原 PUT /api/user/quota，不能把 N02/N03 的幂等保障套在旧充值请求上。

## 5. 本期不新增的能力与实际限制

账户创建/详情/状态、Key 创建、充值更新额度、基本日志都复用现有接口；取消此前重复包装。不为统一响应格式新增接口，也不要求新增完整事件账本、独立操作查询或外部绑定体系。

后续按需求再做：Key 轮换、运行中切换有限/不限额、模型策略编辑、周期预算、批量调整、成员多 Key、自动恢复发 Key、完整增量结算事件。首版停用覆盖撤销；创建时选好策略，有限额 Key 通过 N03 增减剩余限额。暂停这些增强也意味着首版不应展示相应可操作按钮。

基本日志可先复用管理员 /api/log/。Moss 必须按可信 Token ID 过滤后再向成员返回、计算成员统计/分页，不能直接透传组织日志或其 total；不能拿当前页过滤结果冒充完整历史。旧日志接口不是永久金融流水，保留期、退款记录和不同存储后端（尤其 ClickHouse）展示 ID 稳定性有限，首版不承诺全量无遗漏增量对账。

N01 的 token_id 参数只过滤 Key 记录，不是新日志查询接口。按 Token 过滤能保证该查询返回正确成员的数据；它不会改变其他可达接口的鉴权范围。因此此前精简掉的独立日志接口不默认为仍在本期清单，也不因下面的旧入口问题自动加回。

仍有一个与接口数量无关的上线问题：**现有 /api/v1/logs/ 用成员 Key 鉴权后只限定 User ID，没有限定 Token ID。** 因此原始成员 Key 可直连旧 Router 时，成员能读取同一组织其他成员的日志；Moss 页面过滤或另建日志接口都不会堵住这个入口。“旧接口行为不变、原始 Key 下发直连、成员日志严格隔离”三者目前不能同时成立。须另行确定凭据/访问边界，不能把这 3 项接口完成视为已解决。若采用不下发真实 Router Key 的受控代理，会涉及客户端架构变化；本稿没有默认采用或实施该方案。

最后，现有限额存在预扣和最终结算，不能承诺零超额；组织还需确认钱包计费设置、每账户默认 1000 个 Token 的容量及账户级限流。这些是部署/计费条件，不是新增开户接口的理由。

验收重点：两个成员 Key 属于同一组织 User；增减成员限额不改组织余额/历史消费；充值不改成员限额；重复回调不重发已确认到账订单，未知入账结果进入核对、不盲目补发；停用不覆盖并发消费；越权管理失败；创建超时进入核对而非盲目重发；已有 API 保持原契约。

源码依据：[创建 User](/Users/yobach/VSCodeProject/new-api/controller/user.go:1003)、[代创建 Token](/Users/yobach/VSCodeProject/new-api/controller/token.go:275)、[管理员日志](/Users/yobach/VSCodeProject/new-api/controller/log.go:13)、[旧成员日志范围](/Users/yobach/VSCodeProject/new-api/controller/v1/logs.go:85)。
