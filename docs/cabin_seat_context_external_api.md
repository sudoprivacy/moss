# Moss Cabin 对外接口文档（飞机编号 + 座位号模式）

开发验证版 1.0 · 2026-10-13

适用代码分支：`codex/cabin-status-mode-tools`。

> **状态说明：本文接口已实现并通过本地模拟测试，尚未部署上线。** 默认 `tablet-token` 模式仍使用旧 token 流程；配置为 `seat` 模式后按本文联调。

本文供 UE、Moss 和客户乘客信息后台共同确认。整体实现、测试和回退方案见[《Cabin 按飞机与座位获取乘客上下文改造方案》](cabin_seat_context_migration_plan.md)。

## 1. 接口变化摘要

新模式由 UE 在每次 Moss 业务请求中提供飞机编号和座位号：

```http
X-Cabin-Aircraft-No: B-WITHFLIGHT-01
X-Cabin-Seat-No: A
```

Moss 使用这两个值调用客户新乘客上下文接口：

```http
GET /admin-api/cabin/public/current-seat-context/get?aircraftNo=B-WITHFLIGHT-01&seatNo=A
Authorization: <服务端配置值，当前联调环境为 test1>
```

取得航班和乘客信息后，Moss 使用 UE 请求头中的飞机号、座位号继续执行 ASR、AI、硬件控制、TTS、历史或健康报告处理。

新模式下 UE：

- 不调用 `/v1/auth/token`。
- 不携带 `Authorization: Bearer <Moss access token>`。
- 不携带 `X-Cabin-Tablet-Token`。
- 不携带 `X-Cabin-Tablet-Id`。
- 每个业务请求都携带 `X-Cabin-Aircraft-No` 和 `X-Cabin-Seat-No`。

去掉上述 token 后，Moss 不再校验 UE 身份。生产部署必须由可信客舱网络、网关访问控制或等效措施限制接口访问。Moss 仍校验飞机编号、座位号格式，并核对客户接口返回的上下文。

## 2. 端到端工作流

### 2.1 语音对话主流程

```text
UE
  ├─ POST /v1/voice/query
  │    请求头：aircraftNo + seatNo；表单：WAV、language
  │
  │  Moss → POST get-seat-context
  │       → ASR
  │       ← 返回识别文本 text
  │
  ├─ POST /v1/ai-chat/send
  │    请求头：aircraftNo + seatNo；JSON：text、source、language
  │
  │  Moss → POST get-seat-context
  │       → AI/规则
  │       → 可选调用客户硬件或广播接口
  │       ← SSE 返回 start/delta/tool_call/done 或 error
  │
  └─ 可选 POST /v1/tts/speech
       请求头：aircraftNo + seatNo；JSON：reply_text

     Moss → POST get-seat-context
          → TTS
          ← 返回 WAV 音频，由 UE 播放
```

`/v1/voice/query` 只完成语音识别。UE 必须将其返回的 `text` 再传给 `/v1/ai-chat/send` 才能取得 AI 回答。

### 2.2 文本对话流程

UE 可以跳过语音识别，直接调用 `/v1/ai-chat/send`：

```json
{
  "content": "请帮我打开阅读灯",
  "source": "text",
  "language": "zh"
}
```

### 2.3 健康报告流程

```text
UE POST /v1/health-reports/start
  → Moss 调 get-seat-context，创建 collecting 报告
  ← UE 保存 report_id

客户现有 WebSocket → Moss 持续推送 health telemetry

UE 每 1～2 秒 GET /v1/health-reports/{report_id}
  → Moss 调 get-seat-context，校验当前座位上下文
  ← collecting/generating 时继续轮询
  ← completed/failed/cancelled 时停止轮询
```

当前现场健康流程只有报告 start、WebSocket 健康样本和报告 GET 轮询。UE 不通过 `/v1/ai-chat/send` 启动或停止健康采集，也不调用健康硬件 start/stop 接口。

## 3. 公共约定

### 3.1 服务地址

示例：

```text
http://<Moss服务地址>:<端口>
```

下文 curl 使用：

```bash
MOSS_BASE='http://192.168.20.10:3000'
AIRCRAFT_NO='B-WITHFLIGHT-01'
SEAT_NO='A'
```

### 3.2 公共请求头

除特别说明外，本文所有 UE 业务接口都要求以下请求头：

| 请求头 | 类型 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- | --- |
| `X-Cabin-Aircraft-No` | string | 是 | `B-WITHFLIGHT-01` | UE 当前飞机编号；Moss 原样传给客户上下文接口 |
| `X-Cabin-Seat-No` | string | 是 | `A` | UE 当前座位号；Moss 原样保存并传给客户上下文接口 |
| `Content-Type` | string | 视接口而定 | `application/json` | JSON、multipart 或无请求体 |
| `Accept` | string | 否 | `text/event-stream` | SSE 接口建议显式传入 |

建议 UE 每次从当前设备绑定状态读取飞机和座位，不要把上一个航班的值长期缓存在应用配置中。

### 3.3 通用 JSON 错误

在发送 SSE 响应头之前发生的错误，以及普通 JSON 接口错误，统一返回：

```json
{
  "status": "error",
  "code": "MISSING_SEAT_NO",
  "message": "X-Cabin-Seat-No is required"
}
```

所有响应包含：

```http
X-Request-Id: <Moss请求ID>
```

现场排查时应记录 HTTP 状态、`code` 和 `X-Request-Id`。

### 3.4 语言参数

涉及 `language` 的接口接受：

```text
auto / zh / en / fr / ja / ko
```

不传时默认 `auto`。健康报告建议传 `zh`；该接口还会按乘客语言、`zh` 的顺序回退。

## 4. UE 对外接口总表

| 方法 | 路径 | 请求体 | 响应 | 用途 |
| --- | --- | --- | --- | --- |
| POST | `/v1/voice/query` | multipart WAV | JSON | 语音识别 |
| POST | `/v1/ai-chat/send` | JSON | SSE | 文本/语音识别结果进入 AI 对话 |
| GET | `/v1/ai-chat/history` | 无 | JSON | 查询当前会话历史 |
| POST | `/v1/ai-chat/reset` | 无业务参数 | JSON | 重置当前会话运行状态 |
| POST | `/v1/tts/speech` | JSON | 音频二进制 | 将回答合成为语音 |
| POST | `/v1/health-reports/start` | JSON | JSON | 创建健康报告采集窗口 |
| GET | `/v1/health-reports/{report_id}` | 无 | JSON | 查询健康报告状态/结果 |

`/v1/auth/token` 不属于新模式对外流程。代码中还有 `/v1/voice-chat/send` 一体化接口，但现场确认未使用，见附录 A。

## 5. POST /v1/voice/query

上传 WAV 并返回识别文本，不生成 AI 回答。

### 5.1 请求

```http
POST /v1/voice/query
X-Cabin-Aircraft-No: B-WITHFLIGHT-01
X-Cabin-Seat-No: A
Content-Type: multipart/form-data
```

| multipart 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `audio` | WAV file | 是 | 单文件不超过 10 MiB；兼容字段名 `file` |
| `language` | string | 否 | 默认 `auto` |

### 5.2 成功响应

```json
{
  "status": "ok",
  "seat_id": "A",
  "language": "zh",
  "text": "请帮我打开阅读灯"
}
```

`seat_id` 使用 UE 请求头中的座位号，不由客户上下文响应覆盖。

### 5.3 curl

```bash
curl --request POST "$MOSS_BASE/v1/voice/query" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO" \
  --form 'audio=@/tmp/test.wav;type=audio/wav' \
  --form 'language=zh'
```

## 6. POST /v1/ai-chat/send

发送文本并以 SSE 返回回答。语音流程中，`content` 使用 `/v1/voice/query` 返回的 `text`。

### 6.1 请求

```http
POST /v1/ai-chat/send
X-Cabin-Aircraft-No: B-WITHFLIGHT-01
X-Cabin-Seat-No: A
Content-Type: application/json
Accept: text/event-stream
```

| JSON 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 是 | 非空用户文本；兼容字段名 `text`，`content` 优先 |
| `source` | string | 否 | `voice` 或 `text`；默认 `text` |
| `language` | string | 否 | 语言枚举；默认 `auto` |

请求示例：

```json
{
  "content": "请帮我打开阅读灯",
  "source": "voice",
  "language": "zh"
}
```

### 6.2 SSE 事件

| 事件 | data | UE 处理 |
| --- | --- | --- |
| `start` | `status` | 流已建立，不代表回答完成 |
| `tool_call` | `id`、`name`、`arguments` | 可选；记录工具意图，不能单独判定硬件完成 |
| `delta` | `content` | 追加文本；部分路径一次返回完整文本 |
| `done` | `intent`、`slots`、`reply_text` | 正常结束；使用 `reply_text` 作为最终回答 |
| `error` | `code`、`message`、可选 `retriable` | 失败结束；停止等待 `done` |

示例：

```text
event: start
data: {"status":"ok"}

event: tool_call
data: {"id":"call_1","name":"reading_light_switch","arguments":{"on":true}}

event: delta
data: {"content":"已为您下发打开阅读灯的指令，请稍候。"}

event: done
data: {"intent":"reading_light_switch","slots":{"execution_status":"dispatched"},"reply_text":"已为您下发打开阅读灯的指令，请稍候。"}
```

SSE 建立前失败时返回实际 4xx/5xx JSON；建立后通常保持 HTTP 200，通过 `error` 事件报告失败。UE 不能只凭 HTTP 200 或 `start` 判定成功。

### 6.3 curl

```bash
curl --no-buffer --request POST "$MOSS_BASE/v1/ai-chat/send" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO" \
  --header 'Content-Type: application/json' \
  --header 'Accept: text/event-stream' \
  --data '{"content":"请帮我打开阅读灯","source":"text","language":"zh"}'
```

## 7. GET /v1/ai-chat/history

查询 `aircraftNo + flightId + flightDate + 请求头座位 + 乘客身份` 对应的当前会话历史。

### 7.1 Query 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer | 否 | 默认 20，范围 1～100；无效值回退 20 |
| `before_id` | string | 否 | 查询该消息之前的记录；优先于 `after_id` |
| `after_id` | string | 否 | 未传 `before_id` 时生效 |

### 7.2 成功响应

```json
{
  "status": "ok",
  "mode": "CABIN_AI_CHAT",
  "messages": [
    {
      "id": "msg_01",
      "role": "user",
      "content": "请帮我打开阅读灯",
      "source": "text",
      "create_time": "2026-10-12T10:30:00+08:00"
    },
    {
      "id": "msg_02",
      "role": "assistant",
      "content": "已为您下发打开阅读灯的指令，请稍候。",
      "source": "agent",
      "intent": "reading_light_switch",
      "slots": {},
      "tool_calls": [],
      "create_time": "2026-10-12T10:30:01+08:00"
    }
  ],
  "next_cursor": null
}
```

`intent`、`slots` 和 `tool_calls` 只在有值时返回。系统消息不返回给 UE。

### 7.3 curl

```bash
curl --get "$MOSS_BASE/v1/ai-chat/history" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO" \
  --data-urlencode 'limit=20'
```

下一页示例：

```bash
curl --get "$MOSS_BASE/v1/ai-chat/history" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO" \
  --data-urlencode 'limit=20' \
  --data-urlencode 'before_id=msg_01'
```

## 8. POST /v1/ai-chat/reset

重置当前上下文对应的会话运行状态。

### 8.1 请求与响应

无业务请求体参数。

```json
{
  "status": "ok",
  "cleared": true
}
```

`cleared=true` 表示重置完成，不表示数据库中的历史消息已物理删除。

### 8.2 curl

```bash
curl --request POST "$MOSS_BASE/v1/ai-chat/reset" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO"
```

## 9. POST /v1/tts/speech

将文本合成为音频。一般将 `/v1/ai-chat/send` 的 `done.reply_text` 传入。

### 9.1 请求

| JSON 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 非空待合成文本；兼容字段名 `content`，`text` 优先 |

```json
{
  "text": "已为您打开阅读灯。"
}
```

### 9.2 成功响应

返回音频二进制，不是 JSON：

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
Content-Length: <bytes>
```

模型、音色、语言和输出格式由 Moss 服务端配置，UE 不能通过本接口覆盖。

### 9.3 curl

```bash
curl --fail-with-body --request POST "$MOSS_BASE/v1/tts/speech" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO" \
  --header 'Content-Type: application/json' \
  --data '{"text":"已为您打开阅读灯。"}' \
  --output /tmp/cabin-reply.wav
```

## 10. POST /v1/health-reports/start

创建健康报告采集窗口。要求 Moss 配置 `healthReportEnabled=true`，并已连接客户健康遥测 WebSocket。

### 10.1 请求

| JSON 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `language` | string | 否 | 报告语言；建议 `zh` |

```json
{
  "language": "zh"
}
```

请求体不传 seatNo、采集时长或最小样本数。座位来自公共请求头并由客户上下文接口确认；采集时长和最小样本数由 Moss 配置。

### 10.2 成功响应

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "seat_no": "A",
  "sample_count": 0,
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 0,
    "sample_count": 0
  },
  "started_at": 1791772200000,
  "estimated_completed_at": 1791772230000
}
```

同一航班、日期和请求头座位再次调用 start，会取消旧的未完成报告；UE 应保存最新 `report_id`。

### 10.3 curl

```bash
curl --request POST "$MOSS_BASE/v1/health-reports/start" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO" \
  --header 'Content-Type: application/json' \
  --data '{"language":"zh"}'
```

## 11. GET /v1/health-reports/{report_id}

查询报告状态。`report_id` 使用 start 返回的完整值，并作为路径段进行 URL 编码；没有业务 Query 参数。

### 11.1 状态处理

| `report_status` | UE 处理 |
| --- | --- |
| `collecting` | 显示 progress，1～2 秒后继续轮询 |
| `generating` | 显示“报告生成中”，继续轮询 |
| `completed` | 停止轮询，展示 metrics 和 summary |
| `failed` | 停止轮询，展示 `error_code/error_message` |
| `cancelled` | 停止轮询；切换到最新 `report_id` |
| `expired` | 预留状态；停止轮询并提示重新开始 |

### 11.2 completed 响应

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "completed",
  "seat_no": "A",
  "sample_count": 26,
  "flight_id": "2",
  "flight_date": "2026-06-05",
  "generated_at": 1791772231000,
  "metrics": {
    "heart_rate": {
      "value": 78,
      "unit": "bpm",
      "level": "normal",
      "range": {"min": 20, "max": 180, "normal_min": 60, "normal_max": 100}
    },
    "respiratory_rate": {
      "value": 18,
      "unit": "breaths_per_min",
      "level": "normal",
      "range": {"min": 6, "max": 30, "normal_min": 16, "normal_max": 20}
    },
    "spo2": {
      "value": 98,
      "unit": "percent",
      "level": "normal",
      "range": {"min": 80, "max": 110, "normal_min": 95, "normal_max": 100}
    },
    "body_temperature": {
      "value": 36.6,
      "unit": "celsius",
      "level": "normal",
      "range": {"min": 20, "max": 45, "normal_min": 36.1, "normal_max": 37.2}
    }
  },
  "summary": {
    "score": 100,
    "score_level": "normal",
    "emotion_status": "normal",
    "physiology_status": "normal",
    "metric_levels": {
      "heart_rate": "normal",
      "respiratory_rate": "normal",
      "spo2": "normal",
      "body_temperature": "normal"
    },
    "overview": "当前采集指标整体平稳。",
    "interpretations": [],
    "suggestions": [],
    "disclaimer": "本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。"
  }
}
```

### 11.3 curl

```bash
REPORT_ID='hr_4f8f7f2c8b1a'

curl --get "$MOSS_BASE/v1/health-reports/$REPORT_ID" \
  --header "X-Cabin-Aircraft-No: $AIRCRAFT_NO" \
  --header "X-Cabin-Seat-No: $SEAT_NO"
```

## 12. 客户 WebSocket 健康样本

这部分不是 UE HTTP 接口，但必须与健康报告联调。Moss 主动连接客户配置的 WebSocket，客户侧通过现有链路推送：

```json
{
  "type": "telemetry",
  "content": {
    "topic": "health",
    "aircraftNo": "B-WITHFLIGHT-01",
    "seatNo": "A",
    "flightId": "2",
    "flightDate": "2026-06-05",
    "message": {
      "heart_rate": 78,
      "respiratory_rate": 18,
      "spo2": 98,
      "body_temperature": 36.6
    }
  }
}
```

匹配规则：

- `type` 必须为 `telemetry`，`content.topic` 必须为 `health`。
- `content` 可以是对象或 JSON 字符串。
- `seatNo` 必填，且必须与活动报告保存的 UE 请求头座位号一致。
- 传入 `aircraftNo/flightId/flightDate` 时，必须与报告上下文一致。
- 报告窗口之外的样本被忽略。
- `message` 至少有一个有效指标才计入样本数。

健康报告始终绑定 UE 请求头座位号，因此客户 WebSocket 也必须发送该座位号。客户上下文响应中的 `data.seatNo` 不参与报告匹配。

## 13. Moss 调客户新乘客上下文接口

### 13.1 请求契约

Moss 在处理 UE 业务接口前调用：

```http
GET http://<客户后台>/admin-api/cabin/public/current-seat-context/get?aircraftNo=B-WITHFLIGHT-01&seatNo=A
Authorization: <服务端配置值，当前联调环境为 test1>
```

| 字段 | 类型 | 必填 | 来源 |
| --- | --- | --- | --- |
| `aircraftNo` | string | 是 | `X-Cabin-Aircraft-No` |
| `seatNo` | string | 是 | `X-Cabin-Seat-No` |

该接口不要求 tablet token。Authorization 由 Moss 服务端配置并原样发送，UE 不传；当前联调环境的配置值为 `test1`，正式环境使用其独立配置值。

### 13.2 成功响应最低要求

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "aircraftNo": "B-WITHFLIGHT-01",
    "seatNo": "A",
    "columnNo": "A",
    "flightId": 2,
    "flight": {
      "flightId": 2,
      "flightNo": "CA8888",
      "flightDate": "2026-06-05",
      "flightPhase": "boarding"
    },
    "passenger": {
      "passengerRef": "REF-01A-2",
      "displayName": "乘客",
      "gender": "MALE",
      "language": "zh-CN"
    }
  }
}
```

Moss 继续处理所需的最低字段：

| 字段 | 必填 | 用途 |
| --- | --- | --- |
| UE 请求头 aircraftNo | 是 | 飞机、模式和广播目标 |
| UE 请求头 seatNo | 是 | 会话、硬件和健康报告目标 |
| `data.flightId` 或 `data.flight.flightId` | 是 | 会话与健康报告 |
| `data.flightDate` 或 `data.flight.flightDate` | 是 | 会话与健康报告 |
| `data.passenger.passengerRef` | 是 | 区分乘客和建立会话 |

`data.tabletAccessToken` 即使返回，也不参与本方案，不写入数据库、日志或 AI 提示词。

### 13.3 飞机号和座位号处理

Moss 以 UE 请求头为准：

- 原样保存 `X-Cabin-Aircraft-No` 和 `X-Cabin-Seat-No`。
- 将两个值作为客户 GET 接口 Query。
- 会话、托管座位、硬件、广播、健康报告和 WebSocket 匹配均使用请求头值。
- 响应中的 `data.aircraftNo`、`data.seatNo` 和 `contextStatus` 不覆盖请求头，也不参与成功判断。

成功条件为 HTTP 2xx、`code=0`，并且存在有效 data、flightId、flightDate 和 passengerRef。其他情况统一按上下文异常返回，不继续调用 AI、TTS 或硬件。

### 13.4 直接联调 curl

```bash
SEAT_CONTEXT_URL='http://192.168.20.2:48081/admin-api/cabin/public/current-seat-context/get'

curl --verbose --get "$SEAT_CONTEXT_URL" \
  --header 'Authorization: test1' \
  --data-urlencode 'aircraftNo=B-WITHFLIGHT-01' \
  --data-urlencode 'seatNo=A'
```

如果客户确认还需要后台固定鉴权，再增加对应请求头；该值属于 Moss 服务端配置，不由 UE 传入。

## 14. 会话与隔离规则

Moss access token 本身不用于生成会话键。新模式建议用以下字段建立会话：

```text
aircraftNo | flightId | flightDate | seatNo | passengerIdentity
```

`passengerIdentity` 依次选择：

```text
passengerId
否则 passengerRef
否则 tabletId
否则 seat:<aircraftNo>:<seatNo>
```

因此：

- 同一飞机、航班、日期、座位和乘客复用同一会话。
- 换乘客、换座、换航班或跨日期后创建新会话。
- UE 不需要保存或传递 conversation ID。
- 切换到新会话键后不会自动命中旧版本的会话，旧历史仍保留在数据库和管理端。

如果客户上下文没有稳定的 passengerId/passengerRef，只能按座位退化隔离。此时同一航班中座位换人后可能继承上一位乘客的会话，不能宣称已经满足“一个用户一个会话”。客户接口应至少提供在一次航班中稳定且唯一的 passengerRef。

## 15. 错误码

### 15.1 新上下文错误

| HTTP | code | 说明 | UE 处理 |
| --- | --- | --- | --- |
| 400 | `MISSING_AIRCRAFT_NO` | 缺少飞机编号头 | 修正请求，不重试 |
| 400 | `MISSING_SEAT_NO` | 缺少座位号头 | 修正请求，不重试 |
| 400 | `INVALID_AIRCRAFT_NO` | 飞机编号格式不合法 | 修正绑定数据 |
| 400 | `INVALID_SEAT_NO` | 座位号格式不合法 | 修正绑定数据 |
| 500 | `SEAT_CONTEXT_NOT_CONFIGURED` | Moss 未配置客户接口 | 通知服务端运维 |
| 502 | `SEAT_CONTEXT_FAILED` | 客户接口网络、HTTP 或业务失败 | 可有限重试并记录 request ID |
| 502 | `SEAT_CONTEXT_INVALID` | 成功响应缺少必要字段 | 通知客户接口方排查 |

### 15.2 业务常见错误

| HTTP/位置 | code | 说明 |
| --- | --- | --- |
| 400 | `MISSING_AUDIO` | multipart 缺少音频 |
| 400 | `INVALID_AUDIO_FORMAT` | 音频不是 WAV |
| 400 | `ASR_NO_SPEECH` | 未识别出有效语音 |
| 400 | `MISSING_CONTENT` | AI 对话缺少文本 |
| 400 | `MISSING_TEXT` | TTS 缺少文本 |
| 404 | `HEALTH_REPORT_DISABLED` | 环境未启用健康报告 |
| 404 | `HEALTH_REPORT_NOT_FOUND` | 报告 ID 不存在 |
| 403 | `HEALTH_REPORT_FORBIDDEN` | 当前请求头座位与报告座位不一致 |
| SSE `error` | `AGENT_FAILED` 等 | AI/Runner 处理失败 |

客户上下文接口 HTTP 非2xx或业务 code 非0时统一映射为 `SEAT_CONTEXT_FAILED`，不能继续返回旧流程的 `INVALID_TABLET_TOKEN`。`code=0` 但缺少必需字段时返回 `SEAT_CONTEXT_INVALID`。

## 16. UE 接入检查表

1. 删除启动时调用 `/v1/auth/token` 的逻辑。
2. 删除 Moss access token 的保存、刷新和 Authorization 请求头。
3. 删除 `X-Cabin-Tablet-Token` 和 `X-Cabin-Tablet-Id`。
4. 为全部 Cabin 业务接口统一增加 `X-Cabin-Aircraft-No` 和 `X-Cabin-Seat-No`。
5. 保证环境或航班切换时更新两个请求头。
6. 保持语音分步流程：voice/query → ai-chat/send → 可选 tts/speech。
7. SSE 以 `done` 或 `error` 为终态，不能以 HTTP 200、`start` 或 `tool_call` 为成功终态。
8. 健康报告只调用 start 和 GET；保留现有 WebSocket 样本链路。
9. 将 `X-Request-Id` 写入 UE 日志，便于三方对齐。
10. 用 16 个座位验证历史、硬件目标和健康样本不串座。

## 17. 上线前必须确认

以下问题没有确认前，本文不能作为最终生产契约：

1. 正式环境使用的服务端 Authorization 配置值。
2. `passengerRef` 是否在同一乘客、同一航班内稳定且唯一。
3. 无乘客、未绑定、航班未加载分别返回哪些 HTTP 状态和业务 code。
4. 客户新接口能否承受语音、聊天、TTS、历史和健康轮询产生的并发查询。
5. 现场是否接受去掉 UE 身份鉴权，并由网络或网关限制访问。

## 附录 A：代码存在但现场未使用的接口

### POST /v1/voice-chat/send

该接口把 WAV 识别和 AI 对话合并为一个 SSE。现场已确认未实际使用，因此不属于 UE 必调流程，也不能用它的测试结果替代 `/v1/voice/query` 和 `/v1/ai-chat/send` 的分步验证。

实施 seat 模式时，服务端仍应同步适配该路由，避免代码中留下只能使用旧 token 的分支。
