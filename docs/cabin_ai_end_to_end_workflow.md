# Cabin AI 端到端接口工作流与环境切换检查表

客户联调版 · 2026-10-09 · 文档版本 2.0

适用代码：`codex/cabin-status-mode-tools`，提交 `c4800e2610a97be7b911156c8ad8c1cd54248197`。

本文回答三个问题：UE 端先调用哪个接口、每一步传递什么信息、Moss 收到请求后又调用哪个后台接口。接口细节和完整错误码可查阅[《Moss Cabin 接口交互与现场排障手册》](cabin_customer_integration_guide.md)。

## 1. 系统角色

| 角色 | 职责 |
| --- | --- |
| UE 端（客舱平板） | 持有平板原始 token、设备 ID 和座位绑定信息；采集语音、显示回答、播放音频 |
| Moss Cabin 服务 | 签发 Moss token；编排乘客查询、ASR、AI、硬件、TTS；管理会话和健康报告 |
| 乘客信息后台 | 校验平板原始 token，返回当前航班、座位和乘客上下文 |
| ASR/AI/TTS 服务 | 语音识别、生成回答、语音合成；地址和模型由 Moss 配置 |
| 硬件/广播后台 | 查询座位状态、执行座椅/灯光/桌板等控制、发送广播和模式指令 |
| 飞行数据 WebSocket | 向 Moss 推送飞行阶段和健康遥测；由 Moss 主动建立连接 |

Moss 通常不直接访问某台平板的 IP。硬件和广播指令先发给客户后台，再由客户后台路由到对应座位设备。

## 2. UE 端实际主流程

现场确认使用分步语音流程：

```text
UE 登录并取得平板原始 token
    │
    ├─ 1. POST /v1/auth/token
    │     返回 Moss access_token
    │
    ├─ 2. POST /v1/voice/query
    │     Moss → 乘客信息后台 → ASR
    │     返回识别文本 text
    │
    ├─ 3. POST /v1/ai-chat/send
    │     Moss → 乘客信息后台 → AI/工具 → 可选硬件后台
    │     通过 SSE 返回最终 reply_text
    │
    └─ 4. 播放回答（二选一）
          服务端自动模式：Moss → TTS → audio-seat → 当前座位平板
          UE 兼容模式：UE → POST /v1/tts/speech → TTS → UE 播放
```

代码还实现了 `/v1/voice-chat/send` 一体化接口，但现场没有使用，不属于上述主流程。

### 2.1 主流程调用总表

| 步骤 | 调用方 → 接收方 | 接口 | 主要传入 | 主要返回/后续用途 |
| --- | --- | --- | --- | --- |
| 1 | UE → Moss | `POST /v1/auth/token` | 平板原始 token、tablet ID、座位绑定 | Moss access_token，供后续所有 UE 业务接口使用 |
| 2.1 | UE → Moss | `POST /v1/voice/query` | Moss token、平板原始 token、tablet ID、WAV | Moss 开始处理语音请求 |
| 2.2 | Moss → 乘客后台 | `POST passengerInfoUrl` | 平板原始 token、privacyLevel、可选 passengerInfoAuth | flightId/date、seatNo、乘客 ID、语言等上下文 |
| 2.3 | Moss → ASR | `asrUrl` | WAV、ASR 模型、可选语言 | 识别文本 text，返回给 UE |
| 3.1 | UE → Moss | `POST /v1/ai-chat/send` | 上一步 text、source、language 和三项身份头 | 建立 SSE；Moss 开始生成回答 |
| 3.2 | Moss → 乘客后台 | 同上 | 再次传平板原始 token | 重新取得本次请求的乘客上下文 |
| 3.3 | Moss → AI/Runner | `llmBaseUrl` 或 Moss session | 用户文本、乘客上下文、会话历史 | AI 回答或结构化硬件意图 |
| 3.4 | Moss → 硬件后台 | 状态/控制/广播接口，按意图可选 | seatNo、aircraftNo、控制参数、后台鉴权 | 接口接收/状态结果，用于组织最终回答 |
| 3.5 | Moss → UE | `/v1/ai-chat/send` 原 SSE | start/delta/tool_call/done 或 error | UE 使用 `done.reply_text` 展示结果；自动模式同时读取 `done.audio_playback` |
| 4.1 | Moss → TTS → 对方广播服务 | 开启 `conversationSeatAudioEnabled` 后调用 `POST /admin-api/cabin/broadcast/audio-seat` | TTS 音频、title、aircraftNo、seatNo、广播鉴权 | 对方返回 `code=0` 且 `data.sentCount>0` 才表示已发送到目标座位 |
| 4.2 | UE → Moss | 兼容模式下调用 `POST /v1/tts/speech` | reply_text 和三项身份头 | Moss 返回 WAV 音频，由 UE 播放；不能与服务端自动模式同时开启 |

### 2.2 UE 健康监测快速流程

健康监测是独立业务链路，完整参数见第8.3节：

```text
UE POST /v1/health-reports/start 取得 report_id
→ 客户 WS 持续推送 health telemetry
→ UE 每1～2秒 GET /v1/health-reports/{report_id}
→ completed/failed/cancelled 后停止轮询
```

报告 start/get 都会查询乘客信息。当前 UE 健康报告流程不调用 `/v1/ai-chat/send`，也不调用健康硬件 start/stop 接口；健康样本由客户侧现有 WebSocket 链路推送。

## 3. 整条链路传递了什么

| 数据 | 来源 | 传递位置 | 用途 |
| --- | --- | --- | --- |
| 平板原始 token | UE 登录体系 | UE → Moss 的 `X-Cabin-Tablet-Token`；Moss → 乘客后台的 `tablet-token`、`x-cabin-tablet-token` | 识别平板登录身份、查询乘客上下文 |
| 平板设备 ID | UE | `X-Cabin-Tablet-Id` | 设备校验和会话兜底标识 |
| Moss access token | `/v1/auth/token` 返回 | 后续 UE 请求的 `Authorization: Bearer ...` | 校验请求来自已登记的 UE；默认有效 7200 秒 |
| 座位绑定 | UE 调用 auth/token 时提交 | seatNo、columnNo、flightSeatId 等 | 写入 Moss token 和托管座位；乘客后台缺座位时可用 token seatNo 兜底 |
| 航班信息 | 乘客信息后台 | flightId、flightDate、flightNo | 建立会话、隔离航班、匹配健康样本；flightId/date 必须由乘客后台返回 |
| 乘客信息 | 乘客信息后台 | passengerId/ref/name/language 等 | 生成会话键和 AI 上下文 |
| 识别文本 | ASR | Moss → UE 的 `text`；随后 UE → AI 接口的 `content` | 作为用户问题送入 AI |
| AI 最终回答 | AI/硬件处理结果 | SSE `done.reply_text` | UE 展示；需要播报时继续传给 TTS |
| 硬件目标 | 乘客座位上下文 | Moss → 硬件后台的 target/seatNo | 将状态查询或控制发给正确座位 |

这几类凭据不能混用：平板原始 token、Moss access token、`passengerInfoAuth/controlAuth`、`broadcastApiKey` 分别用于不同链路。

## 4. 第一步：UE 领取 Moss access token

### 4.1 UE 调用 Moss

```http
POST /v1/auth/token
Content-Type: application/json
X-Cabin-Tablet-Token: <平板原始token>
X-Cabin-Tablet-Id: <平板设备ID>
```

请求体：

```json
{
  "seatNo": "01A",
  "columnNo": "A",
  "flightSeatId": "20",
  "aircraftSeatId": "120",
  "aircraftNo": "AIRCRAFT-DEMO",
  "flightId": "FLIGHT-DEMO",
  "flightDate": "2026-10-09"
}
```

必填字段只有 `seatNo`、`columnNo`、`flightSeatId`。建议同时传入实际 aircraftNo、flightId 和 flightDate，便于托管座位记录与现场一致。

成功响应：

```json
{
  "status": "ok",
  "access_token": "ai_<Moss签名token>",
  "token_type": "Bearer",
  "expires_in": 7200
}
```

### 4.2 Moss 内部处理

1. 检查两个 UE 请求头和三个必填座位字段。
2. 将座位登记到 managed-seats 数据表。
3. 使用 `tokenSecret` 签发 Moss access token。

这一步不会调用乘客信息后台。因此 auth/token 返回200，只能证明 Moss 本地登记和签名成功，不能证明平板原始 token 能通过乘客后台校验。

## 5. 第二步：UE 上传语音并取得识别文本

### 5.1 UE 调用 Moss

```http
POST /v1/voice/query
Authorization: Bearer <Moss access_token>
X-Cabin-Tablet-Token: <平板原始token>
X-Cabin-Tablet-Id: <平板设备ID>
Content-Type: multipart/form-data
```

| multipart 字段 | 必填 | 说明 |
| --- | --- | --- |
| `audio` | 是 | WAV 文件，单文件不超过10 MiB；兼容字段名 file |
| `language` | 否 | auto/zh/en/fr/ja/ko，默认 auto |

### 5.2 Moss 查询乘客后台

地址来自 `server.json` 的 `cabin.passengerInfoUrl`：

```http
POST <passengerInfoUrl>
Content-Type: application/json
tablet-token: <UE传入的平板原始token>
x-cabin-tablet-token: <同一个平板原始token>
Authorization: <passengerInfoAuth原值，仅配置时发送>
```

```json
{"privacyLevel":2}
```

乘客后台最低成功响应：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "flightId": "FLIGHT-DEMO",
    "flightDate": "2026-10-09",
    "flightSeatId": "20",
    "seatNo": "01A",
    "flight": {"flightNo": "DEMO001"},
    "passenger": {
      "passengerId": "PAX-DEMO-001",
      "displayName": "乘客",
      "language": "zh"
    }
  }
}
```

必须有 `flightId` 和 `flightDate`。seatNo 可缺失，此时 Moss 使用 auth/token 中的 seatNo；这只是单次乘客上下文兜底，与 `managedSeats` 配置没有关系。

### 5.3 Moss 调用 ASR 并返回 UE

乘客上下文有效后，Moss 获取或创建会话，再将 WAV 发给 `asrUrl` 配置的 ASR 服务。成功返回 UE：

```json
{
  "status": "ok",
  "seat_id": "01A",
  "language": "zh",
  "text": "请帮我打开阅读灯"
}
```

此接口只做语音识别，不生成 AI 回答。

## 6. 第三步：UE 请求 AI 回答

### 6.1 UE 调用 Moss

UE 将上一步的 `text` 放入 `content`：

```http
POST /v1/ai-chat/send
Authorization: Bearer <Moss access_token>
X-Cabin-Tablet-Token: <平板原始token>
X-Cabin-Tablet-Id: <平板设备ID>
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "content": "请帮我打开阅读灯",
  "source": "voice",
  "language": "zh"
}
```

`content` 必填；source 为 voice 或 text。用户直接输入文字时，可以跳过 `/v1/voice/query`，直接调用本接口并使用 `source=text`。

### 6.2 Moss 再次查询乘客后台

Moss 会再次执行第5.2节的乘客查询，不复用上一次 ASR 请求取得的结果。因此一次完整语音交互至少会在 voice/query 和 ai-chat/send 阶段分别查询乘客后台。

Moss 使用以下顺序建立会话标识：

```text
passengerId
否则 passengerRef
否则 tablet:<tabletId>
再加 flightId
```

同一乘客在同一航班使用多台平板会共享会话；如果乘客后台错误地给不同平板返回相同 passengerId，可能出现历史串用。

### 6.3 Moss 调用 AI 或硬件后台

Moss 先尝试确定性的硬件控制规则；未命中时再调用 AI/Moss Runner。根据意图可能发生以下调用：

准确来说，不是大模型进程直接请求客户后台。AI 或规则产生意图后，由 Moss 服务端校验参数并发出硬件 HTTP 请求；因此排查时应查看 Moss 的硬件出站日志。

| 场景 | Moss 调用的后台接口 | 关键参数 |
| --- | --- | --- |
| 查询座位状态 | `GET {controlBaseUrl}/admin-api/tcp/hardware/status` | target=seatNo，key=tray/posture/safety/reading_light 等 |
| 座椅、通风、加热、按摩 | `POST {controlBaseUrl}/admin-api/tcp-client/cmd/seat/...` | seatNo 和 position/level |
| 桌板开关 | `POST .../seat/tray/open` 或 `/close` | seatNo |
| 阅读灯 | `POST .../seat/light` 或 `/brightness` | seatNo、on、pwm |
| 顶灯/场景 | `POST .../cabin/ceiling/...`、`/cabin/scene` | seatNo、颜色/亮度/preset |
| 座位模式 | `POST {broadcastApiBaseUrl}/admin-api/cabin/broadcast/mode-seat` | aircraftNo、seatNo、mode |
| 座位提醒 | `POST .../admin-api/cabin/broadcast/error-seat` | aircraftNo、seatNo、中英文内容 |

普通硬件调用可携带配置中的 `controlAuth`。广播/模式接口使用 `x-hardware-api-key: <broadcastApiKey>`，Authorization 优先使用 `broadcastAuth`，否则使用 controlAuth。

硬件响应 HTTP 2xx 且业务 `code=0` 才能作为接口接收成功。“已下发”不代表设备物理动作已经完成，必要时应重新查询状态。

### 6.4 Moss 通过 SSE 返回 UE

```text
event: start
data: {"status":"ok"}

event: tool_call
data: {"id":"...","name":"...","arguments":{}}

event: delta
data: {"content":"已为您下发打开阅读灯的指令，请稍候。"}

event: done
data: {"intent":"reading_light_switch","slots":{},"reply_text":"已为您下发打开阅读灯的指令，请稍候。","audio_playback":{"status":"sent","request_id":"BC-...","matched_count":1,"sent_count":1}}
```

UE 必须持续读取到 `done` 或 `error`。HTTP 200、start 或 tool_call 都不代表整次回答成功；最终展示和 TTS 应使用 `done.reply_text`。

当前分步流程有一个已知行为：voice/query 会保存一次识别文本，ai-chat/send 又会保存 UE 传来的同一文本，因此历史中可能出现两条相同用户消息。这不一定是 UE 重复提交。

## 7. 第四步：对话语音播报

服务端自动座位播报由 `cabin.conversationSeatAudioEnabled=true` 开启，并要求 `broadcastEnabled=true`、`broadcastApiBaseUrl`（或 `controlBaseUrl`）、`broadcastApiKey` 和可用 `ttsUrl`。Moss 在生成最终回答后先调用 TTS，再以当前上下文中的 `aircraftNo`、`seatNo` 调用对方 `POST /admin-api/cabin/broadcast/audio-seat`。SSE `done.audio_playback.status` 可能为 `sent`、`no_online_client`、`failed` 或 `skipped`。该接口没有播放完成回调，`sent` 只表示对方已向目标客户端发送/分发音频。

服务端自动模式开启后，UE 不应再对同一条 `done.reply_text` 调用 `/v1/tts/speech`，否则同一回答会播放两次。

### 7.1 UE 兼容模式

UE 将 `done.reply_text` 传给 Moss：

```http
POST /v1/tts/speech
Authorization: Bearer <Moss access_token>
X-Cabin-Tablet-Token: <平板原始token>
X-Cabin-Tablet-Id: <平板设备ID>
Content-Type: application/json
```

```json
{"text":"已为您下发打开阅读灯的指令，请稍候。"}
```

Moss 会第三次查询乘客后台，再调用 `ttsUrl` 配置的 TTS 服务。成功响应是 WAV 音频二进制，由 UE 负责播放，不是 JSON 或音频 URL。

所以一次完整的“语音识别 → AI 回答 → TTS”交互，正常情况下会调用乘客信息后台三次。

## 8. WebSocket、飞行自动化和健康监测

这部分不在普通 AI 问答的 HTTP 主链上，但环境切换时也要一起检查。

### 8.1 飞行阶段自动化

Moss 作为 WebSocket 客户端连接 `flightStateWsUrl`。需要同时满足：

- `cabin.enabled=true`
- `automationEnabled=true`
- `flightStateWsUrl` 可连接

飞行阶段消息必须为：

```json
{
  "type": "flight_data",
  "content": "{\"id\":1021,\"mavpacktype\":\"CE25_AUTO_GUIDE_DATA\",\"afcs_status_data\":[0,0,0,0,0,0,0,16]}"
}
```

这里的 content 必须是 JSON 字符串。Moss 检测阶段变化后，根据托管座位查询状态、写告警并调用硬件/广播接口。

### 8.2 managedSeats

`managedSeats: "01A,01B"` 用于启动时预置自动化需要处理的座位。UE 调用 auth/token 和建立真实乘客会话时也会登记座位。

managedSeats 不是用于补充某次 UE 请求缺失座位号的白名单。当前自动化会读取全部 active 托管座位，只按 seatNo 去重，没有按当前航班和日期过滤；配置删除后，数据库中的旧 active 记录也不会自动删除。环境切换时必须通过 `/api/v1/cabin/managed-seats` 检查实际列表。

### 8.3 健康报告

当前现场健康监测中，UE 只主动调用两个 Moss 接口：开始报告和查询报告。UE 不通过 `/v1/ai-chat/send` 启动或停止健康采集，也不直接调用客户硬件控制接口。

健康传感器如何开始采集不在当前 UE 调用链中；Moss 的职责是在 start 后建立报告窗口，并消费客户侧 WebSocket 已推送的健康样本。

#### 8.3.1 UE 健康监测完整流程

```text
用户在 UE 点击“开始健康监测”
    │
    ├─ 1. UE → POST /v1/health-reports/start
    │     Moss 查询乘客信息，确定 flightId/date/seatNo
    │     返回 report_id，report_status=collecting
    │
    ├─ 2. 客户 WS → Moss
    │     持续推送 telemetry/topic=health 样本
    │
    └─ 3. UE 每 1～2 秒 GET /v1/health-reports/{report_id}
          collecting/generating：继续轮询
          completed/failed/cancelled：停止轮询
```

#### 8.3.2 UE 创建报告采集窗口

UE 调用：

```http
POST /v1/health-reports/start
Authorization: Bearer <Moss access_token>
X-Cabin-Tablet-Token: <平板原始token>
X-Cabin-Tablet-Id: <平板设备ID>
Content-Type: application/json
```

```json
{"language":"zh"}
```

请求体不传 seatNo、采集时长或最小样本数。Moss 会调用乘客信息后台，以返回的 flightId、flightDate 和 seatNo 创建报告；采集时长取 `healthReportCollectSeconds`，默认30秒。

成功响应：

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "seat_no": "01A",
  "sample_count": 0,
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 0,
    "sample_count": 0
  },
  "started_at": 1791532800000,
  "estimated_completed_at": 1791532830000
}
```

UE 只保存最新的 `report_id`。同一 flightId、flightDate、seatNo 再次调用 start 会取消旧的未完成报告；旧报告进入 cancelled，并返回 `SUPERSEDED_BY_NEW_REPORT`。

#### 8.3.3 客户 WebSocket 推送健康样本

Moss 只从第8.1节同一条 WebSocket 接收样本，因此除了 `healthReportEnabled=true`，还必须配置 `automationEnabled=true` 和有效 `flightStateWsUrl`。报告窗口之外到达的健康样本会被忽略。

健康样本 envelope：

```json
{
  "type": "telemetry",
  "content": {
    "topic": "health",
    "seatNo": "01A",
    "flightId": "FLIGHT-DEMO",
    "flightDate": "2026-10-09",
    "message": {"heart_rate":78,"respiratory_rate":18,"spo2":98,"body_temperature":36.6}
  }
}
```

content 可以是对象或 JSON 字符串。topic 必须是 health，seatNo 必填；消息带 aircraftNo、flightId、flightDate 时必须与活动报告匹配。message 中至少一个指标有效才计为一条 sample：

| 字段 | 程序接受范围 | 正常范围 |
| --- | --- | --- |
| `heart_rate` | 20～180 bpm | 60～100 |
| `respiratory_rate` | 6～30 次/分钟 | 16～20 |
| `spo2` | 80～110% | 95～100% |
| `body_temperature` | 20～45℃ | 36.1～37.2℃ |

范围外的单项被忽略；样本达到 `healthReportMinSamples` 才能生成报告，默认只要求1条。程序接受范围用于数据过滤，不等同医学合理范围。

#### 8.3.4 UE 轮询报告状态

```http
GET /v1/health-reports/{report_id}
Authorization: Bearer <Moss access_token>
X-Cabin-Tablet-Token: <平板原始token>
X-Cabin-Tablet-Id: <平板设备ID>
```

| report_status | UE 处理 |
| --- | --- |
| `collecting` | 显示 progress，1～2秒后继续轮询 |
| `generating` | 显示“报告生成中”，继续轮询 |
| `completed` | 停止轮询，渲染 metrics 和 summary |
| `failed` | 停止轮询，显示 error_code/error_message；常见 `INSUFFICIENT_SAMPLES` |
| `cancelled` | 停止轮询；切换到最新 report_id，常见 `SUPERSEDED_BY_NEW_REPORT` |
| `expired` | 预留状态；当前代码没有自动进入此状态的流程 |

completed 响应的主要结构：

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "completed",
  "seat_no": "01A",
  "flight_id": "FLIGHT-DEMO",
  "flight_date": "2026-10-09",
  "generated_at": 1791532831000,
  "sample_count": 26,
  "metrics": {
    "heart_rate": {"value":78,"unit":"bpm","level":"normal","range":{"min":20,"max":180,"normal_min":60,"normal_max":100}},
    "respiratory_rate": {"value":18,"unit":"breaths_per_min","level":"normal","range":{"min":6,"max":30,"normal_min":16,"normal_max":20}},
    "spo2": {"value":98,"unit":"percent","level":"normal","range":{"min":80,"max":110,"normal_min":95,"normal_max":100}},
    "body_temperature": {"value":36.6,"unit":"celsius","level":"normal","range":{"min":20,"max":45,"normal_min":36.1,"normal_max":37.2}}
  },
  "summary": {
    "score": 100,
    "score_level": "good",
    "emotion_status": "good",
    "physiology_status": "normal",
    "metric_levels": {
      "heart_rate": "normal",
      "respiratory_rate": "normal",
      "spo2": "normal",
      "body_temperature": "normal"
    },
    "overview": "本次检测四项生理指标均在正常范围内。",
    "interpretations": [],
    "suggestions": [],
    "disclaimer": "本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。"
  }
}
```

HTTP 200 只说明查询接口成功。`report_status=failed` 仍是业务失败，UE 不能只看顶层 `status=ok`。

当前实现每一次 start 和每一次 GET 轮询都会重新调用乘客信息后台。按1～2秒轮询，16台同时检测会给乘客后台增加约8～16次/秒的查询量，还不包含其他语音/聊天请求。现场必须验证乘客后台和网络能承受该负载；不能把所有轮询失败简单归因于 UE。

#### 8.3.5 常见失败与责任边界

| 现象 | 含义/排查方向 |
| --- | --- |
| start/get 返回 502 passenger-info 错误 | 本次报告请求查询乘客后台失败；先查网络、原始 token 和 passengerInfoAuth |
| start 返回 400 `MISSING_SEAT_CONTEXT` | 乘客响应和 Moss token 都无法确定 seatNo |
| start/get 返回 404 `HEALTH_REPORT_DISABLED` | `healthReportEnabled` 未开启或实际运行配置未生效 |
| GET 返回 404 `HEALTH_REPORT_NOT_FOUND` | report_id 错误、丢失或查了旧环境中的 ID |
| GET 返回 403 `HEALTH_REPORT_FORBIDDEN` | 当前乘客座位与报告 seatNo 不一致 |
| 一直 collecting 且 sample_count=0 | 硬件未出数、WS未连接、topic/seat/航班不匹配或样本全无效 |
| 最终 `failed/INSUFFICIENT_SAMPLES` | 采集窗口结束时有效样本少于 minSamples |
| 旧报告突然 cancelled | 同座位重复调用 start，新 report_id 已替代旧报告 |

## 9. 环境切换配置清单

每次切换测试、现场或生产环境，双方应共同填写并保存下面的表。不要只确认 server.json 文件；环境变量会覆盖文件配置，必须核对运行进程的实际值。

| 能力 | Moss 配置 | 当前环境实际地址/值 | 责任方 | 验证结果 |
| --- | --- | --- | --- | --- |
| Moss UE 入口 | 对外 IP、端口、HTTPS/路由 | 待填写 | Moss/部署 | 待验证 |
| Moss token 签名 | tokenSecret、tokenTtlSeconds | 待填写（密钥不进文档） | Moss | 待验证 |
| 乘客信息 | passengerInfoUrl、passengerInfoAuth、privacyLevel | 待填写 | 客户后台 | 待验证 |
| ASR | asrUrl、asrApiKey、asrModel | 待填写 | AI/Moss | 待验证 |
| AI | llmBaseUrl、llmApiKey、llmModel、createMossSession | 待填写 | AI/Moss | 待验证 |
| TTS | ttsUrl、ttsApiKey、ttsModel、voice、language | 待填写 | AI/Moss | 待验证 |
| 硬件状态/控制 | controlBaseUrl、controlAuth、controlTimeoutMs | 待填写 | 客户后台 | 待验证 |
| 广播/模式 | broadcastApiBaseUrl、broadcastApiKey、broadcastAuth | 待填写 | 客户后台 | 待验证 |
| 飞行/健康 WS | automationEnabled、flightStateWsUrl、超时/重连 | 待填写 | 客户后台 | 待验证 |
| 托管座位 | aircraftNo、managedSeats、数据库 active 记录 | 待填写 | 双方 | 待验证 |
| 健康报告 | healthReportEnabled、healthReportCollectSeconds、healthReportMinSamples | 待填写 | 双方 | 待验证 |

环境切换的常见影响：

- 修改 `tokenSecret` 后，旧 Moss access token 全部失效，UE 必须重新调用 auth/token。
- 乘客接口地址可访问，但 passengerInfoAuth 或平板原始 token 不匹配时仍会失败。
- 宿主机 curl 成功不代表容器网络成功，必须从 Moss 实际运行环境测试。
- `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 会影响 Node fetch；内网地址通常需要加入 NO_PROXY。
- managedSeats 修改不会自动清除数据库旧记录。
- 只开启 healthReportEnabled 不会建立 WS；还需要 automationEnabled 和 flightStateWsUrl。

## 10. 环境切换后的逐层验收顺序

不要直接从完整 AI 对话开始测试。按下面顺序逐层通过，可以快速判断故障属于哪一方。

| 顺序 | 测试 | 成功标准 | 失败时首先检查 |
| --- | --- | --- | --- |
| 1 | 从 Moss 同一运行环境 POST 乘客信息接口 | HTTP 2xx、code=0、有 flightId/date | 网络、代理、Authorization、平板原始 token、返回结构 |
| 2 | UE 调 `/v1/auth/token` | 返回 access_token | 两个请求头、三个必填座位字段、数据库 |
| 3 | UE 调 `/v1/voice/query` | 返回非空 text | Moss token匹配、乘客接口、ASR |
| 4 | UE 调 `/v1/ai-chat/send` | SSE 以 done 结束 | 第二次乘客查询、AI/Runner、SSE解析、硬件调用 |
| 5 | UE 调 `/v1/tts/speech` | 返回可播放 WAV | 第三次乘客查询、TTS配置 |
| 6 | 直接查硬件状态并控制后复查 | code=0，物理状态一致 | controlBaseUrl/Auth、座位号、客户网关 |
| 7 | 建立 WS 并推合法阶段消息 | Moss 记录阶段变化和座位任务 | WS地址、消息type/content格式、托管座位 |
| 8 | UE 报告 start → WS 推样本 → UE 轮询 | completed 或有明确业务失败 | health开关、WS、座位/航班匹配、样本数、乘客接口轮询负载 |
| 9 | 16台并发场景 | 无身份/历史串线，成功率和延迟达标 | passengerId、连接/模型容量、同会话并发 |

`/v1/auth/token` 成功不能证明乘客接口可用；部分平板成功也不能直接证明 Moss 或客户后台一定无问题。固定平板失败时，应按 tablet ID、原始 token、座位号、时间和 `x-request-id` 对比成功与失败样本。

## 11. 最小现场验证命令

### 11.1 直接验证乘客信息后台

```bash
curl -i -sS --max-time 15 \
  -X POST 'http://192.168.20.2:48081/admin-api/cabin/tablet-passenger-info/current' \
  -H 'Content-Type: application/json' \
  -H 'tablet-token: 替换为平板原始token' \
  -H 'x-cabin-tablet-token: 替换为同一个平板原始token' \
  -H 'Authorization: 替换为passengerInfoAuth完整原值' \
  --data '{"privacyLevel":2}'
```

如果 `passengerInfoAuth` 未配置且客户接口不要求 Authorization，应删除该请求头。直接执行 `curl URL` 发出的是 GET，不能等同于 Moss 的 POST 请求。

### 11.2 验证 AI SSE

```bash
curl -N -i -sS \
  -X POST 'http://<Moss地址>/v1/ai-chat/send' \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'Authorization: Bearer <auth/token返回的Moss access_token>' \
  -H 'X-Cabin-Tablet-Token: <平板原始token>' \
  -H 'X-Cabin-Tablet-Id: <平板设备ID>' \
  --data '{"content":"你好","source":"text","language":"zh"}'
```

### 11.3 创建并查询健康报告

先设置本次 UE 身份变量：

```bash
export MOSS_BASE='http://<Moss地址>'
export MOSS_TOKEN='<auth/token返回的Moss access_token>'
export TABLET_TOKEN='<平板原始token>'
export TABLET_ID='<平板设备ID>'
```

创建报告：

```bash
HEALTH_JSON=$(curl -sS \
  -X POST "$MOSS_BASE/v1/health-reports/start" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $MOSS_TOKEN" \
  -H "X-Cabin-Tablet-Token: $TABLET_TOKEN" \
  -H "X-Cabin-Tablet-Id: $TABLET_ID" \
  --data '{"language":"zh"}')
printf '%s\n' "$HEALTH_JSON"
export REPORT_ID=$(printf '%s' "$HEALTH_JSON" | jq -r '.report_id // empty')
```

轮询报告：

```bash
curl -i -sS \
  "$MOSS_BASE/v1/health-reports/$REPORT_ID" \
  -H "Authorization: Bearer $MOSS_TOKEN" \
  -H "X-Cabin-Tablet-Token: $TABLET_TOKEN" \
  -H "X-Cabin-Tablet-Id: $TABLET_ID"
```

完整 auth、voice、TTS 和硬件 curl 命令见详细排障手册。

## 12. 双方联调时需要保存的信息

每次问题复现至少保存以下信息，避免只提供“接口不好使”：

- 环境名称、Moss 构建提交、测试时间和时区。
- UE tablet ID、座位号；原始 token 只记录脱敏后前后几位。
- 调用的 URL、方法、非敏感请求参数、HTTP 状态、业务 code。
- Moss 响应头 `x-request-id`。
- SSE 最后一个事件是 done 还是 error。
- 乘客后台是否收到请求，以及返回的 flightId、flightDate、seatNo、passengerId 是否对应当前平板。
- 若涉及硬件，保存下发前状态、请求响应和下发后状态。
- 若涉及 WS，保存原始 envelope，重点核对 type、content 类型、seatNo 和航班字段。

Cabin API 日志默认位于 `<rootDir>/logs/cabin.jsonl`，飞行自动化日志默认位于 `<rootDir>/logs/cabin-automation.jsonl`。用时间、tablet ID、seatNo、flightId 和 request ID 串联 UE、Moss 与客户后台日志，才能确定故障落在哪一段。
