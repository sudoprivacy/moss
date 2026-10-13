# Cabin 按飞机与座位获取乘客上下文改造方案

方案版本：1.0 · 2026-10-12

适用代码分支：`codex/cabin-status-mode-tools`。

> 状态：已实现并完成本地模拟验证，尚未部署上线。现场切换前仍需确认正式配置与网络连通性。

## 1. 改造目标

取消 UE 调用 `/v1/auth/token` 和使用 Moss access token 的流程。UE 调用 Moss 业务接口时直接提供 `aircraftNo` 和 `seatNo`，Moss 使用这两个字段调用客户新乘客上下文接口：

```http
GET /admin-api/cabin/public/current-seat-context/get?aircraftNo=B-WITHFLIGHT-01&seatNo=A
Authorization: <服务端配置值>
```

Moss 获得航班、座位、乘客和设备上下文后，继续执行现有 ASR、AI、TTS、硬件控制、历史和健康报告逻辑。

本次改造不改变：

- ASR、LLM、TTS 的上游协议。
- 硬件状态、座椅、灯光、桌板、模式和广播接口协议。
- 飞行阶段及健康遥测 WebSocket 消息格式。
- SSE 回答事件格式。

## 2. 当前流程与目标流程

### 2.1 当前流程

```text
UE 携带原始 tablet token 调 /v1/auth/token
→ Moss 登记托管座位并签发 Moss access token
→ UE 后续请求同时携带：
   Authorization: Bearer <Moss token>
   X-Cabin-Tablet-Token
   X-Cabin-Tablet-Id
→ Moss 校验 Moss token 与两个平板请求头一致
→ Moss 使用原始 tablet token 查询 passengerInfoUrl
→ 进入会话、AI、TTS、硬件或健康报告处理
```

### 2.2 目标流程

```text
UE 不再调用 /v1/auth/token
→ UE 后续请求携带：
   X-Cabin-Aircraft-No
   X-Cabin-Seat-No
→ Moss 调用 get-seat-context
→ 使用请求头座位及返回的航班、乘客信息构建 CabinPassengerContext
→ 登记托管座位
→ 进入原有会话、AI、TTS、硬件或健康报告处理
```

## 3. 新的 UE 公共身份参数

推荐统一使用请求头，而不是将 aircraftNo、seatNo 混入不同接口的请求体。

| 请求头 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `X-Cabin-Aircraft-No` | 是 | `B-WITHFLIGHT-01` | UE 当前所在飞机编号 |
| `X-Cabin-Seat-No` | 是 | `A` | UE 侧座位号；Moss 原样保存并发送给客户上下文接口 |

使用请求头的原因：

- `/v1/voice/query` 是 multipart。
- `/v1/ai-chat/send`、TTS 和报告 start 是 JSON。
- 历史和报告查询是 GET。
- 请求头可以让所有接口使用相同的上下文传递方式。

新模式不要求：

- `/v1/auth/token`
- `Authorization: Bearer <Moss access token>`
- `X-Cabin-Tablet-Token`
- `X-Cabin-Tablet-Id`

由于新模式不做 UE 身份鉴权，部署边界必须限制在可信客舱网络或受控网关内。aircraftNo、seatNo 仍需进行非空、长度和字符格式校验，不能把“不鉴权”等同于“不校验参数”。

## 4. Moss 调用客户新乘客上下文接口

### 4.1 配置建议

只新增流程切换字段，乘客信息地址和鉴权复用原配置：

```json
{
  "cabin": {
    "contextMode": "seat",
    "passengerInfoUrl": "http://192.168.20.2:48081/admin-api/cabin/public/current-seat-context/get",
    "passengerInfoAuth": "test1"
  }
}
```

建议环境变量：

```text
CABIN_CONTEXT_MODE=seat
CABIN_PASSENGER_INFO_URL=http://192.168.20.2:48081/admin-api/cabin/public/current-seat-context/get
CABIN_PASSENGER_INFO_AUTH=test1
```

`contextMode` 值：

| 值 | 行为 |
| --- | --- |
| `tablet-token` | 保留当前 Moss token + 原始 tablet token 流程，作为回退模式 |
| `seat` | 使用 aircraftNo + seatNo，不要求 Moss 或平板 token |

### 4.2 请求

```http
GET <passengerInfoUrl>?aircraftNo=<URL编码值>&seatNo=<URL编码值>
Authorization: <passengerInfoAuth，仅配置时发送>
```

请求不带 JSON body。aircraftNo 和 seatNo 分别取 UE 的 `X-Cabin-Aircraft-No` 和 `X-Cabin-Seat-No`，使用 `URLSearchParams` 编码。

网络异常或超时可沿用当前 passenger-info 策略：10秒超时，第一次网络异常后等待300毫秒再重试一次；已经取得 HTTP 响应时不重试。

### 4.3 响应字段映射

| CabinPassengerContext | 新接口字段 | 必需 | 用途 |
| --- | --- | --- | --- |
| `aircraftNo` | UE 请求头 | 是 | 模式、广播、托管座位和日志 |
| `aircraftId` | `data.aircraftId` | 否 | 内部上下文 |
| `seatId` | UE 请求头 | 是 | 会话、硬件状态、控制、健康报告 |
| `columnNo` | `data.columnNo` | 否 | 工具上下文 |
| `aircraftSeatId` | `data.aircraftSeatId` | 否 | 内部绑定信息 |
| `flightSeatId` | `data.flightSeatId` | 否 | 内部绑定信息 |
| `flightId` | `data.flightId` 或 `data.flight.flightId` | 是 | 会话和健康报告 |
| `flightDate` | `data.flightDate` 或 `data.flight.flightDate` | 是 | 会话和健康报告 |
| `flightNo` | `data.flight.flightNo` | 否 | AI 上下文 |
| `tabletId` | `data.tabletId` | 否 | 日志和会话兜底 |
| `tabletType` | `data.tabletType` | 否 | 托管座位 |
| `bindingId` | `data.bindingId` | 否 | 工具上下文 |
| `contextStatus` | 不读取 | 否 | 不参与业务判断 |
| `passengerId` | `data.passenger.passengerId/id` | 否 | 会话身份首选 |
| `passengerRef` | `data.passenger.passengerRef` | 是 | 乘客身份和会话隔离 |
| `passengerName` | `data.passenger.displayName` | 否 | 称谓；空白字符串视为缺失 |
| `passengerGender` | `data.passenger.gender` | 否 | 称谓 |
| `language` | `data.passenger.language` | 否 | AI/ASR 语言上下文 |

新响应中的 `tabletAccessToken` 不用于本方案，不写入数据库、结构化日志或 AI 提示词。

### 4.4 飞机号和座位号规则

飞机号和座位号以 UE 请求头为唯一业务来源：

- Moss 原样保存 `X-Cabin-Aircraft-No` 和 `X-Cabin-Seat-No`。
- 调用客户接口时将两个值放入 Query。
- 会话、托管座位、硬件控制、广播和健康报告均使用请求头座位号。
- 客户响应中的 `data.aircraftNo` 和 `data.seatNo` 只用于调试记录，不覆盖请求头，也不参与一致性判断。
- `contextStatus` 不参与成功判断。

成功条件为 HTTP 2xx、业务 `code=0`，并且响应包含有效 `data`、flightId、flightDate 和 passengerRef。其他 HTTP 状态、业务码或缺少必需字段均作为乘客上下文异常返回，不继续调用 AI、TTS 或硬件。

### 4.5 查询频率与缓存

为保持与当前乘客信息查询逻辑一致，第一版建议每个 UE 业务请求都重新解析乘客上下文，不使用跨请求的长期缓存。这样换航班、换座或换乘客后能在下一次请求生效，也避免缓存失效规则与现场绑定规则不一致。

代价是一次分步语音交互通常查询三次：voice/query、ai-chat/send、可选 tts/speech 各一次；健康报告轮询也会逐次查询。16台同时运行时，必须压测客户新接口的并发和延迟。

如压测不通过，可以增加按请求头 `aircraftNo + seatNo` 合并的 1～2 秒短缓存：

- 只缓存 `code=0` 且通过字段校验的结果。
- 不缓存 NOT_FOUND、业务失败、网络失败或格式错误。
- 同一个键的并发请求合并为一次上游请求。
- 缓存时间到期后重新请求，不由 UE 主动清缓存。
- 日志标明 cache_hit，排障时仍能区分是否实际调用上游。

短缓存属于性能优化，不应在第一版未压测时默认扩大有效期。有效期过长会延迟乘客换座、换人和航班切换的识别。

## 5. 会话设计

Moss access token 不参与会话键。为了满足“一个航班、一个座位、一个用户、一个会话”，新模式建议使用：

```text
aircraftNo | flightId | flightDate | seatNo | passengerIdentity
```

`passengerIdentity` 选择顺序：

```text
passengerId
否则 passengerRef
否则 tabletId
否则 seat:<aircraftNo>:<seatNo>
```

影响：

- 同一航班、同一日期、同一座位、同一乘客复用会话。
- 座位或乘客变化时创建新会话。
- flightId 被不同日期复用时不会串历史。
- 切换新会话键后，旧 conversation_key 不会自动命中新请求；切换时相当于开始新会话，旧数据仍保留在数据库和管理端。

如果要求保留现有会话行为，可以继续使用当前 `passengerId/passengerRef/tabletId + flightId`，但它不满足严格的“座位参与隔离”。

## 6. 代码改造范围

### 6.1 配置和类型

修改：

- `src/server/types.ts`
- `src/server/config.ts`
- `src/server/cabin/types.ts`

只增加 `contextMode` 用于明确区分两种请求协议；继续复用 `passengerInfoUrl` 和 `passengerInfoAuth`。CabinPassengerContext 中的 aircraftNo 和 seatId 直接使用 UE 请求头。

### 6.2 Cabin API 上下文解析

修改 `src/server/cabin/api.ts`：

1. 新增 `requireSeatHeaders()`。
2. 新增 `fetchSeatContext()`。
3. 新增 `contextFromSeat()`，完成字段映射、请求头座位保留和托管座位登记。
4. 提取统一的 `resolveCabinContext()`：根据 contextMode 选择旧 token 模式或新 seat 模式。
5. 以下接口全部改用统一解析器：
   - `/v1/voice/query`
   - `/v1/ai-chat/send`
   - `/v1/ai-chat/history`
   - `/v1/ai-chat/reset`
   - `/v1/tts/speech`
   - `/v1/health-reports/start`
   - `/v1/health-reports/{report_id}`
6. 代码中存在但现场未使用的 `/v1/voice-chat/send` 同步适配，避免保留不可用分支。
7. seat 模式下 `/v1/auth/token` 返回 `404 AUTH_TOKEN_DISABLED`，或保留但在外部文档中标记不使用。推荐保留旧模式能力，通过配置切换。

### 6.3 托管座位

当前 auth/token 会提前登记 managed-seats。新模式取消该调用后，必须在 `contextFromSeat()` 成功后统一执行：

```ts
store.upsertManagedSeatFromContext(context)
```

这可以覆盖只使用健康报告、尚未创建聊天会话的 UE。

### 6.4 会话键

`src/server/cabin/auth.ts` 的 `buildConversationKey()` 已通过 contextMode 分支启用新键，旧模式会话键保持原行为。

### 6.5 业务服务

ASR、AI、TTS、硬件控制、广播和健康报告服务无需改变接口协议。它们继续读取 `CabinPassengerContext`：

- 普通硬件状态/控制使用请求头 seatNo。
- mode-seat/error-seat 使用请求头 aircraftNo + seatNo。
- 健康报告使用请求头 aircraftNo、seatNo，以及响应中的 flightId、flightDate。
- AI 提示词使用乘客、航班和座位上下文。

## 7. 错误码设计

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `MISSING_AIRCRAFT_NO` | 缺少 X-Cabin-Aircraft-No |
| 400 | `MISSING_SEAT_NO` | 缺少 X-Cabin-Seat-No |
| 400 | `INVALID_AIRCRAFT_NO` | 飞机编号格式不合法 |
| 400 | `INVALID_SEAT_NO` | 座位号格式不合法 |
| 500 | `SEAT_CONTEXT_NOT_CONFIGURED` | 未配置 passengerInfoUrl |
| 502 | `SEAT_CONTEXT_FAILED` | 新接口网络失败或 HTTP 非2xx |
| 502 | `SEAT_CONTEXT_INVALID` | code=0 但缺少必需字段 |

客户接口 HTTP 非2xx或业务 code 非0时统一映射 `SEAT_CONTEXT_FAILED`；`code=0` 但缺少 data、flightId、flightDate 或 passengerRef 时映射 `SEAT_CONTEXT_INVALID`。不要继续沿用旧流程的 `INVALID_TABLET_TOKEN`。

## 8. 测试和验收

### 8.1 单元/接口测试

- seat 模式不要求 Authorization 和 tablet token。
- 缺 aircraftNo 或 seatNo 返回明确400。
- 新接口请求体与 UE 请求头完全对应。
- 数值 ID 正确转为字符串。
- 空白 displayName 不作为乘客姓名。
- 请求头 aircraftNo、seatNo 原样进入上下文和日志。
- 新接口缺 data、flightId、flightDate 或 passengerRef 时中止。
- 相同飞机/航班/日期/座位/乘客复用会话。
- 换座位、换乘客、换航班或日期产生新会话。
- 控制接口使用请求头 seatNo。
- mode-seat 和广播携带正确 aircraftNo。
- 健康 start/get 使用新上下文并匹配 WS 样本。
- 上下文成功后写入 managed-seats。
- tablet-token 模式回归测试通过。

### 8.2 联调顺序

1. 从 Moss 同一容器直接调用 get-seat-context。
2. 核对请求头 seatNo 能被客户 GET 接口、硬件接口和健康 WebSocket 使用。
3. 测试文本 AI，不触发硬件。
4. 测试语音 ASR + AI。
5. 测试状态查询、灯光、桌板和座椅控制。
6. 测试 mode-seat 和广播的 aircraftNo。
7. 测试历史、reset 和 TTS。
8. 测试健康 start、WS 样本和报告轮询。
9. 16台分别验证上下文和会话隔离，再执行并发测试。

### 8.3 通过标准

- UE 不再调用 auth/token，不携带 Moss 或 tablet token。
- 任一业务请求均能用 aircraftNo + seatNo 获得正确上下文。
- 不同座位、乘客、航班之间无历史串线。
- 硬件最终 target 与 UE 请求头 seatNo 一致。
- context 接口失败时不调用 AI、TTS 或硬件。
- 旧模式可通过一项配置回退。

## 9. 上线与回退

1. 先发布支持双模式的 Moss，不修改 UE。
2. 在测试环境设置 `contextMode=seat`，完成全链路验收。
3. UE 发布新版本，改传两个公共请求头并停止调用 auth/token。
4. 现场先切少量座位，观察 context、会话和硬件日志。
5. 全量切换后保留旧 token 模式至少一个发布周期。
6. 出现问题时将 `contextMode` 改回 `tablet-token` 并重启，无需回滚数据库。

切换 contextMode 后建议 UE 重新开始会话。不要在同一次对话过程中混用两种会话键。

## 10. 工作量评估

| 工作项 | 预计工作量 |
| --- | --- |
| 配置、类型和 seat context client | 0.5～1天 |
| 业务路由统一上下文解析 | 0.5～1天 |
| 会话键、托管座位和字段映射 | 0.5～1天 |
| 自动化测试和文档 | 1～1.5天 |
| UE/乘客后台/硬件现场联调 | 1～2天 |

预计总计 **3～5个工作日**。如果需要使用 `lastAmbientMode`、餐食偏好、会员等级等新乘客字段进入 AI 提示词，再增加约1～2天。

## 11. 实施前必须确认

1. 正式环境的服务端 Authorization 配置值。
2. passengerRef 在同一乘客、同一航班期间是否稳定且唯一。
3. 无乘客、未绑定、航班未加载分别返回什么业务 code。
4. 新接口并发容量是否能覆盖语音、聊天、TTS、历史和健康报告轮询。
5. 是否接受 seat 模式下仅靠可信网络隔离，不进行 UE 身份鉴权。
