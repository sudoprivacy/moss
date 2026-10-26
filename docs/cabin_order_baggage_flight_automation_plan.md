# 客舱订单、行李告警与起降阶段自动控制开发方案

## 1. 方案范围

本方案针对以下需求设计：

1. 乘客通过语音请求毛毯或饮料，Moss识别意图后创建服务订单。
2. 乘客提出取消服务时，Moss查询当前座位的未完成订单并调用取消接口。
3. 飞机状态为 `1` 时检查行李箱是否锁定，未锁定时向指定座位发送告警。
4. 飞机状态为 `15` 时检查座位对应行李架是否有行李，有行李时向指定座位发送带走行李提醒。
5. 起飞、降落阶段自动将座椅调整到 `0%`、收起桌板、关闭阅读灯、关闭客舱顶灯（即氛围灯）。
6. 所有对方接口请求按约定携带 `Authorization`；订单接口额外携带乘客信息接口返回的 `tabletAccessToken`，请求头名称为 `tablet-token`。
7. 行李和飞行安全告警复用已有的指定座位告警接口，暂不依赖对方后续重新提供的告警接口。

订单业务需要识别用户表达的数量，并在创建请求的 `quantities` 字段中传递。一次用户请求只创建一笔订单，数量作为该订单的明细参数，不因为数量拆分成多笔订单。

## 2. 接口结论

对方最新接口文档已经覆盖订单和行李状态的接口类型，现有硬件控制接口已经覆盖座椅、桌板、阅读灯和客舱顶灯控制。当前主要工作是 Moss 侧的 token 传递、意图处理、飞行阶段编排和告警去重。

### 2.1 订单接口

创建订单：

```http
POST /cabin/service-order/create
Content-Type: application/json
Authorization: <configured value>
tablet-token: <tabletAccessToken>
```

订单明细规则：`quantities` 与 `subItemIds` 按位置一一对应。毛毯没有子项，数量直接放在 `quantities[0]`；饮品按饮品子项顺序传递对应数量。

毛毯（示例：两条）：

```json
{
  "serviceTypeId": 1,
  "subItemIds": [],
  "quantities": [2]
}
```

饮品（示例：两杯可乐）：

```json
{
  "serviceTypeId": 3,
  "subItemIds": [1],
  "quantities": [2]
}
```

饮品字典：

| `subItemId` | 名称 |
|---:|---|
| 1 | 可乐 |
| 2 | 鲜榨橙汁 |
| 3 | 手工茉莉拿铁 |

取消订单：

```http
PUT /cabin/service-order/cancel
Content-Type: application/json
Authorization: <configured value>
tablet-token: <tabletAccessToken>
```

```json
{
  "orderId": 1,
  "cancelReason": "不需要了"
}
```

查询当前座位订单：

```http
GET /cabin/service-order/list-by-seat?status=1,2
Authorization: <configured value>
tablet-token: <tabletAccessToken>
```

查询接口通过 `tablet-token` 确定当前座位，不再额外传 `seatNo`。它既用于用户查询订单，也用于取消前定位 `orderId`。取消流程只筛选状态 `1`（已接单）和 `2`（配送中）；普通“查询我的订单”按用户问题查询接口支持的订单状态范围，并展示接口实际返回的订单状态。

返回结果至少需要读取以下字段：`id`、`orderNo`、`serviceTypeName`、`statusName`、`items`、`createTime`、`updateTime`、`deliverTime`。如果 `items` 中没有数量字段，不能从语言或订单号推测数量，只展示接口实际返回的信息。

### 2.2 行李状态接口

```http
GET /tcp/hardware/status?target=<seatNo>&key=bag
Authorization: <configured value>
```

有效响应示例：

```json
{
  "code": 0,
  "data": {
    "target": "1A",
    "key": "bag",
    "data": {
      "higherBag": "true",
      "lowerBag": "false",
      "bagLock": "true"
    },
    "lastUpdateTime": 1729665045123
  }
}
```

Moss必须同时兼容布尔值和字符串布尔值，例如 `true` 与 `"true"`。

### 2.3 复用的硬件控制接口

现有代码已经有以下命令定义：

| 目标 | 接口/命令 | 起降阶段用途 |
|---|---|---|
| 座椅 | `seat.cushion` | `position=0` |
| 桌板 | `seat.tray.close` | 桌板收起 |
| 阅读灯 | `seat.light` | `on=false` |
| 客舱顶灯/氛围灯 | `cabin.ceiling.light` | `on=false` |

状态查询复用硬件状态接口，控制和状态请求均携带 `Authorization`。

### 2.4 复用的指定座位告警接口

```http
POST /admin-api/cabin/broadcast/error-seat
Content-Type: application/json
Authorization: <configured value>
X-Hardware-Api-Key: <configured value>
```

请求体：

```json
{
  "aircraftNo": "B-WITHFLIGHT-01",
  "seatNo": "1A",
  "title": "座位告警",
  "content": "请检查并带走您的随身行李。",
  "contentEN": "Please check and take your personal belongings with you."
}
```

## 3. 现有代码复用与缺口

### 3.1 已有能力

当前代码已经具备：

- 通过 seat context 获取乘客、航班和座位上下文。
- 建立按航班、座位和乘客隔离的会话。
- 通过 WebSocket 接收飞行状态并按阶段排队执行任务。
- 查询安全带、座椅姿态和桌板状态。
- 座椅不在 `0%` 时调用座椅归位。
- 桌板已关闭时跳过桌板关闭接口。
- 复用 `cabin.ceiling.light` 等硬件命令。
- 记录结构化的出站调用和告警。
- 调用 `/admin-api/cabin/broadcast/error-seat`发送指定座位文字告警。

### 3.2 需要新增或调整的能力

1. 解析 seat context 返回的 `data.tabletAccessToken`。
2. 将该 token 只保存在当前乘客上下文中，用于订单请求。
3. 新增订单客户端和统一响应判断。
4. 新增毛毯、饮料的创建订单意图识别，并识别数量。
5. 新增用户查询订单的意图和结果展示。
6. 新增取消订单的查询、匹配、二次确认和取消流程。
7. 在飞行状态任务中增加 `key=bag` 查询。
8. 将状态 `1`和`15`分别映射到行李锁定和带走行李规则。
9. 将行李告警复用已有指定座位告警客户端。
10. 起飞、降落阶段增加阅读灯和客舱顶灯状态检查及关闭。
11. 飞行自动化桌板关闭前增加 `tray_flipped`保护。
12. 控制后复查状态，避免返回成功但硬件未达到目标状态。
13. 增加阶段、座位和告警类型的去重。

## 4. 乘客上下文和认证设计

### 4.1 Token来源

seat context模式下，请求链路为：

```text
UE传 X-Cabin-Aircraft-No、X-Cabin-Seat-No
  -> Moss调用乘客信息接口
  -> 乘客信息接口返回 data.tabletAccessToken
  -> Moss构造当前座位上下文
  -> 订单请求使用 tablet-token: data.tabletAccessToken
```

现有 `tabletToken` 与订单所需的 `tabletAccessToken`用途不同，不能混用。建议在 `CabinPassengerContext`中增加独立字段：

```ts
tabletAccessToken?: string
```

### 4.2 Token安全边界

`tabletAccessToken`只允许出现在：

- 订单创建请求头；
- 订单查询请求头；
- 订单取消请求头。

不得写入：

- LLM prompt；
- 对话消息内容；
- 乘客可见响应；
- 普通业务日志。

日志只记录接口名称、状态码、业务码、座位和订单号，不记录 token原文。

### 4.3 Authorization配置

建议订单、行李、硬件控制和告警调用统一复用现有配置：

```text
controlAuth 或 broadcastAuth
```

实际使用规则：

- 订单接口：`controlAuth`，另加 `tablet-token`。
- 行李和硬件状态/控制：`controlAuth`。
- 告警广播：`broadcastAuth`，没有时回退 `controlAuth`。
- 硬件广播接口继续携带 `X-Hardware-Api-Key`。

如果对方确认所有接口的 Authorization值完全一致，可以继续共用一个现场配置值；如果不一致，再拆分订单认证配置。

## 5. 语音服务订单流程

### 5.1 创建订单

```text
用户语音或文本
  -> ASR得到文本（语音场景）
  -> 获取当前乘客上下文
  -> 判断是否为服务订单请求
  -> 识别毛毯或饮品，以及数量和饮品子项
  -> 映射 serviceTypeId/subItemIds
  -> 按接口规则构造 quantities
  -> 携带 tablet-token 和 Authorization调用创建接口
  -> 校验 HTTP状态和 code=0
  -> 保存订单ID并回复真实结果
```

建议识别：

| 用户表达 | 订单参数 |
|---|---|
| 毛毯、毯子、需要一条毯子 | `serviceTypeId=1`，`subItemIds=[]`，`quantities=[1]` |
| 两条毛毯 | `serviceTypeId=1`，`subItemIds=[]`，`quantities=[2]` |
| 可乐 | `serviceTypeId=3`，`subItemIds=[1]`，`quantities=[1]` |
| 两杯可乐 | `serviceTypeId=3`，`subItemIds=[1]`，`quantities=[2]` |
| 橙汁、鲜榨橙汁 | `serviceTypeId=3`，`subItemIds=[2]`，`quantities=[1]` |
| 茉莉拿铁、手工茉莉拿铁 | `serviceTypeId=3`，`subItemIds=[3]`，`quantities=[1]` |

每次用户请求只创建一笔订单。用户说“可乐两杯和橙汁一杯”时，按子项顺序传 `subItemIds=[1,2]`、`quantities=[2,1]`。数量未表达时默认按 `1`；表达相互冲突或无法可靠解析时应先向用户确认，不能随意提交数量。

创建失败时不能由模型生成成功话术，应返回固定失败结果，并记录对方的 `code`和`msg`。

### 5.2 查询订单

支持以下用户表达：

- “我点了什么？”
- “查一下我的订单。”
- “饮料送到了吗？”

处理流程：

```text
用户表达查询意图
  -> 获取当前座位上下文和 tabletAccessToken
  -> 调用 list-by-seat
  -> 按用户问题筛选服务类型或状态
  -> 展示服务类型、子项、数量（接口有返回时）、状态和时间
```

查询结果必须来自接口真实返回。服务端不得把内部 token、座位标识或未返回的数量发送给乘客；没有订单时直接提示当前座位没有符合条件的订单。

### 5.3 取消订单

```text
用户表达取消意图
  -> 识别取消对象（毛毯或具体饮品）
  -> 查询当前座位 status=1,2 的订单
  -> 按 serviceTypeId/subItemIds和用户指定内容匹配
  -> 一条匹配：调用取消接口
  -> 多条匹配：列出候选订单并反问用户
  -> 无匹配：回复没有可取消的未完成订单
  -> 校验 code=0后回复真实结果
```

取消时不得因为创建时间较新就自动选择订单。规则如下：

- 无匹配：提示当前座位没有可取消的未完成订单。
- 只有一条匹配：直接调用取消接口。
- 多条匹配：不调用取消接口，向用户列出可区分信息并反问要取消哪一笔。
- 用户说“取消刚才的订单”但当前仍有多条候选：仍需反问确认，不能由模型自行决定。

示例：

```text
您有两笔未完成的饮品订单：
1. 可乐，10:15创建，订单号 SV...
2. 橙汁，10:20创建，订单号 SV...
请问要取消哪一笔？
```

反问后需要在当前会话中暂存候选订单列表。下一轮用户选择“第1笔”、饮品名称或订单号时，服务端只能从这份候选列表解析目标，再调用取消接口；不能让模型直接生成任意 `orderId`。取消接口返回成功后才回复取消成功。

## 6. 飞行状态和行李告警

### 6.1 状态1：行李未锁定

```text
收到阶段码1
  -> 对当前管理座位逐座查询 key=bag
  -> bagLock=false或"false"
  -> 记录 BAG_NOT_LOCKED 告警
  -> 调用 error-seat发送“请拉好行李绑带”
```

状态值缺失、查询失败或状态过期时，不应判定为未锁定；应记录 `BAG_STATUS_UNAVAILABLE`，避免误报。

### 6.2 状态15：提醒带走行李

```text
收到阶段码15
  -> 对当前管理座位逐座查询 key=bag
  -> higherBag=true或lowerBag=true
  -> 记录 BAG_LEFT_BEHIND_POSSIBLE 告警
  -> 调用 error-seat发送“请带走随身行李”
```

只要任一层有行李就触发提醒。若上下层均为 `false`，不发送告警。

### 6.3 告警去重

建议使用以下逻辑键：

```text
aircraftNo + flightId + flightDate + seatNo + phaseCode + alertType
```

同一阶段、同一座位、同一告警类型只发送一次。WebSocket重连或重复收到相同阶段消息时不重复发送。

如果下一阶段仍存在同一问题，是否再次提醒由阶段策略决定；默认只在阶段进入时发送一次。

## 7. 起飞、降落阶段自动控制

### 7.1 阶段策略

建议纳入自动收拢控制的阶段：

| 阶段码 | 阶段 | 座椅 | 桌板 | 阅读灯 | 氛围灯 |
|---:|---|---|---|---|---|
| 2 | 起飞前准备 | 归位 | 收起 | 关闭 | 关闭 |
| 3 | 起飞滑跑 | 归位 | 收起 | 关闭 | 关闭 |
| 4 | 起飞抬轮 | 归位 | 收起 | 关闭 | 关闭 |
| 8 | 下降 | 按确认策略 | 按确认策略 | 按确认策略 | 按确认策略 |
| 9～15 | 进近/着陆 | 归位 | 收起 | 关闭 | 关闭 |

状态 `8`是否立即执行完整收拢动作，需要按客户最终飞行阶段定义确认。若“降落”从状态8开始，则纳入；若从状态9开始，则状态8只做安全检查。

### 7.2 单座位执行顺序

每个座位按以下顺序执行：

```text
查询目标状态
  -> 判断状态是否有效、是否过期
  -> 已满足目标：跳过控制
  -> 不满足目标：调用控制接口
  -> 控制成功后再次查询
  -> 复查仍未达到目标：记录控制失败告警
```

### 7.3 座椅

```text
GET status?target={seatNo}&key=posture
```

当 `position != 0`时调用：

```http
POST /admin-api/tcp-client/cmd/seat/cushion?seatNo={seatNo}&position=0
```

### 7.4 桌板

桌板必须同时判断 `tray_state`和`tray_flipped`：

```text
tray_state=closed或close
  -> 不调用收起接口

tray_state未关闭且tray_flipped=true
  -> 不调用收起接口
  -> 发送桌板未折叠告警

tray_state未关闭且tray_flipped=false
  -> 调用 seat.tray.close
```

状态查询失败或状态过期时不应直接下发收起命令。

### 7.5 阅读灯

```text
GET status?target={seatNo}&key=reading_light
```

仅当 `on=true`或`"true"`时调用：

```http
POST /admin-api/tcp-client/cmd/seat/light?seatNo={seatNo}&on=false
```

### 7.6 氛围灯

客舱顶灯已确认就是氛围灯，复用现有客舱灯控制接口：

```http
POST /admin-api/tcp-client/cmd/cabin/ceiling/light?on=false
```

执行前查询客舱灯状态，已关闭时跳过。这里的状态查询参数必须按对方最终硬件状态文档固定，不能在代码中同时猜测多个 key。

## 8. 错误处理

统一按以下规则处理对方接口：

1. HTTP非2xx：视为失败。
2. HTTP成功但业务 `code`不是 `0`：视为失败。
3. 响应缺少必要数据：视为失败。
4. 网络超时：按可重试的出站失败记录。
5. 状态查询失败：不执行有风险的硬件控制，不直接生成“未锁定/有行李”结论。
6. 订单创建失败：不保存为成功订单，不输出成功话术。
7. 订单取消失败：保留对方错误信息到日志，向用户返回取消失败。

日志至少包含：

```text
request_id
aircraft_no
flight_id
seat_no
phase_code
upstream
method
url（不包含 token）
status
business_code
elapsed_ms
error_code/error_message
```

## 9. 开发拆分

### 第一步：上下文和订单客户端

- 解析 `tabletAccessToken`。
- 扩展 `CabinPassengerContext`。
- 新增订单接口客户端。
- 统一注入 `tablet-token`和`Authorization`。
- 实现创建、查询、取消。

### 第二步：订单意图和会话路由

- 增加毛毯和饮品意图解析，包含数量和饮品子项。
- 创建订单优先于普通闲聊和硬件控制。
- 增加查询订单意图。
- 取消订单走查询、匹配和多订单确认。
- 保存待确认订单候选列表，并校验用户选择只指向候选订单。
- 根据真实结果生成固定回复。

### 第三步：行李检查和告警

- 增加 `bag`状态查询。
- 增加状态1和15的规则。
- 复用 `error-seat`告警客户端。
- 增加告警去重。

### 第四步：起降设备控制

- 将座椅和桌板现有逻辑纳入统一阶段策略。
- 增加 `tray_flipped`保护。
- 增加阅读灯状态查询和关闭。
- 增加客舱顶灯/氛围灯状态查询和关闭。
- 增加控制后复查。

### 第五步：测试和现场验证

- 单元测试覆盖订单参数、token头、业务失败。
- 单元测试覆盖毛毯、单饮品和多饮品的数量映射。
- 单元测试覆盖查询订单结果和无订单结果。
- 单元测试覆盖多订单取消时只反问、不调用取消接口，以及用户确认后只取消选中订单。
- 单元测试覆盖行李字符串布尔值。
- 单元测试覆盖状态1、15去重。
- 单元测试覆盖桌板 `tray_flipped=true`时不调用关闭接口。
- 模拟状态2、3、4、8、15的WebSocket消息。
- 现场用真实座位验证订单、行李查询和四类硬件控制。

## 10. 验收标准

### 订单

- 毛毯请求创建一笔 `serviceTypeId=1`订单。
- 饮品请求按字典创建一笔 `serviceTypeId=3`订单。
- “两条毛毯”发送 `quantities=[2]`，只创建一笔订单。
- “两杯可乐”发送 `subItemIds=[1]`、`quantities=[2]`，只创建一笔订单。
- “两杯可乐和一杯橙汁”发送 `subItemIds=[1,2]`、`quantities=[2,1]`。
- 订单请求携带正确的 `tablet-token`和`Authorization`。
- 用户查询订单时能返回当前座位的真实订单、状态和时间。
- 取消请求只操作当前座位状态1、2的订单。
- 多条可取消订单匹配时不直接调用取消接口，而是先向用户反问。
- 用户明确选择后只取消候选列表中的对应订单。
- 对方返回失败时 Moss不输出成功话术。

### 行李告警

- 状态1且 `bagLock=false`时发送一次锁定提醒。
- 状态15且任一行李层为 `true`时发送一次带走行李提醒。
- 状态值为字符串时判断结果正确。
- 查询失败或状态过期时不误报。
- 重复阶段消息不重复发送。

### 起降控制

- 座椅非0时调整到0，已是0时不重复调用。
- 桌板已关闭时不调用关闭接口。
- `tray_flipped=true`时不调用关闭接口。
- 阅读灯开启时关闭，已关闭时跳过。
- 氛围灯开启时关闭，已关闭时跳过。
- 控制失败或复查失败有结构化日志和告警记录。

## 11. 仍需确认的接口契约

这几项不需要新增接口，但在开发前必须确认最终值：

1. 订单接口、行李接口的完整服务地址。
2. 所有接口使用的 `Authorization`是否相同。
3. `data.tabletAccessToken`是否始终由 seat context接口返回。
4. `quantities`是否必填，以及是否严格按 `subItemIds`位置一一对应；本方案按数量识别结果传递，缺省数量传 `[1]`。
5. `list-by-seat`普通查询允许传入的状态集合，以及是否只传 `status`、不再传 `seatNo`。
6. 查询结果 `items` 是否包含可展示的数量字段。
7. 取消多笔订单时允许向用户展示订单号、创建时间和哪些明细字段。
8. 行李状态最终路径是 `/tcp/hardware/status`还是带`/admin-api`前缀。
9. 行李状态是否使用当前上下文中的 `seatNo`作为 `target`。
10. 氛围灯状态查询的最终 `key`和`target`。
11. 状态数据超过多久视为过期。

除上述接口契约确认外，本方案不依赖对方新增功能接口；告警复用已有指定座位告警接口。
