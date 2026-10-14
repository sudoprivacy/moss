# 客舱 AI 语音与聊天接口文档（飞机编号 + 座位号版）

文档版本：开发验证版 1.1 · 2026-10-14

> 本文描述的接口已实现并通过本地模拟测试，尚未部署上线。现场需配置 `contextMode=seat` 后才启用新流程。

## 1. 本次改造内容

### 1.1 UE 调用变化

| 改造前 | 改造后 |
|---|---|
| UE 先调用 `/v1/auth/token` 获取 Moss access token | UE 不再调用 `/v1/auth/token` |
| 业务请求携带 `Authorization` | 不再携带 `Authorization` |
| 业务请求携带平板 token 和 tablet ID | 不再携带平板 token 和 tablet ID |
| Moss 根据平板 token 查询乘客信息 | UE 每次传 `aircraftNo + seatNo`，Moss 调用客户新接口查询乘客信息 |

改造后所有 UE 业务请求统一携带：

```http
X-Cabin-Aircraft-No: B-WITHFLIGHT-01
X-Cabin-Seat-No: A
```

### 1.2 Moss 服务改造

Moss 需要完成以下调整：

1. 新增按 `aircraftNo + seatNo` 查询乘客上下文的逻辑。
2. 语音、聊天、历史、重置、TTS 和健康报告接口统一使用新的上下文解析逻辑。
3. 使用客户接口返回的航班、乘客和座位信息建立会话。
4. 在成功取得上下文后登记托管座位，不再依赖 `/v1/auth/token` 登记。
5. 保留旧 token 模式作为现场回退能力，通过服务端配置切换。

### 1.3 客户乘客信息接口

Moss 调用客户新接口：

```http
POST /admin-api/cabin/tablet-login/get-seat-context
Content-Type: application/json
Authorization: <服务端配置值，当前联调环境为 test1>

{
  "aircraftNo": "B-WITHFLIGHT-01",
  "seatNo": "A"
}
```

`aircraftNo` 和 `seatNo` 分别取 UE 的两个公共请求头，并放入 JSON Body。Authorization 由 Moss 服务端配置，UE 不传。

最低需要返回：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "aircraftNo": "B-WITHFLIGHT-01",
    "seatNo": "A",
    "flightId": 2,
    "flight": {
      "flightId": 2,
      "flightNo": "CA8888",
      "flightDate": "2026-06-05"
    },
    "passenger": {
      "passengerRef": "REF-01A-2",
      "displayName": "乘客",
      "language": "zh-CN"
    }
  }
}
```

返回的 `tabletAccessToken` 不再使用。

座位号以 UE 传入的 `X-Cabin-Seat-No` 为准。Moss 原样保存，并用于会话、托管座位、硬件控制和健康报告；响应中的 `data.seatNo` 不覆盖请求头座位号。`aircraftNo` 同样以请求头为准。

Moss 只接受 HTTP 2xx、`code=0` 且 `data` 中包含 flightId、flightDate 和 passengerRef 的响应。其他情况统一按乘客上下文异常处理。`contextStatus` 不参与成功判断。

## 2. 接口概述

```text
POST /v1/voice/query                    语音转文字
POST /v1/ai-chat/send                   AI 聊天，SSE 流式返回
GET  /v1/ai-chat/history                查询聊天历史
POST /v1/ai-chat/reset                  重置当前会话
POST /v1/tts/speech                     文本转语音
POST /v1/health-reports/start           开始生成健康报告
GET  /v1/health-reports/{report_id}     查询健康报告
```

推荐调用流程：

```text
语音输入：
UE 录音 → /v1/voice/query → 得到 text → /v1/ai-chat/send
       → 得到 reply_text → 可选 /v1/tts/speech

文本输入：
UE 文本 → /v1/ai-chat/send

健康报告：
UE → /v1/health-reports/start → 保存 report_id
客户 WebSocket → Moss 推送健康样本
UE → /v1/health-reports/{report_id} 轮询报告
```

UE 不需要传会话 ID。Moss 根据飞机、航班日期、座位和乘客身份自动关联会话。

## 3. 公共请求头

所有业务接口都需要携带：

```http
X-Cabin-Aircraft-No: B-WITHFLIGHT-01
X-Cabin-Seat-No: A
```

| Header | 必填 | 说明 |
|---|---:|---|
| `X-Cabin-Aircraft-No` | 是 | 当前飞机编号 |
| `X-Cabin-Seat-No` | 是 | UE 当前座位号，Moss 原样传给客户乘客信息接口 |
| `Content-Type` | 视接口 | JSON 接口使用 `application/json`；语音接口使用 `multipart/form-data` |

服务端响应头包含 `X-Request-Id`。现场排查时建议 UE 记录该值。

新模式不再传：

```http
Authorization: Bearer <access_token>
X-Cabin-Tablet-Token: <tabletAccessToken>
X-Cabin-Tablet-Id: <tabletId>
```

取消 token 后，Moss 不再校验 UE 身份，现场需要使用可信客舱网络或网关限制接口访问。

## 4. 语音转文字

### 4.1 接口地址

```http
POST /v1/voice/query
Content-Type: multipart/form-data
```

### 4.2 请求参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `audio` | file | 是 | WAV 文件，最大 10 MiB；兼容字段名 `file` |
| `language` | string | 否 | 默认 `auto`；可选 `auto/zh/en/fr/ja/ko` |

### 4.3 请求示例

```bash
curl -X POST http://127.0.0.1:18081/v1/voice/query \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A' \
  -F 'audio=@passenger.wav;type=audio/wav' \
  -F 'language=auto'
```

### 4.4 成功响应

```json
{
  "status": "ok",
  "seat_id": "A",
  "language": "zh",
  "text": "请帮我打开阅读灯"
}
```

该接口只做语音识别，不生成 AI 回答。UE 需要将返回的 `text` 再传给 `/v1/ai-chat/send`。

## 5. AI 聊天发送消息

### 5.1 接口地址

```http
POST /v1/ai-chat/send
Content-Type: application/json
Accept: text/event-stream
```

### 5.2 请求体

```json
{
  "content": "请帮我打开阅读灯",
  "source": "voice",
  "language": "zh"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `content` | string | 是 | 用户消息；兼容字段名 `text` |
| `source` | string | 否 | `voice` 或 `text`，默认 `text` |
| `language` | string | 否 | 默认 `auto` |

### 5.3 请求示例

```bash
curl -N -X POST http://127.0.0.1:18081/v1/ai-chat/send \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A' \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"content":"请帮我打开阅读灯","source":"voice","language":"zh"}'
```

### 5.4 SSE 响应

```text
event: start
data: {"status":"ok"}

event: tool_call
data: {"id":"tc-1","name":"cabin.hardware.control","arguments":{"seat_no":"A","command":"seat.light","on":true}}

event: delta
data: {"content":"已为您下发打开阅读灯的指令，请稍候。"}

event: done
data: {"intent":"reading_light_on","slots":{"execution_status":"dispatched"},"reply_text":"已为您下发打开阅读灯的指令，请稍候。"}
```

| 事件 | 说明 |
|---|---|
| `start` | 开始处理，不代表处理成功 |
| `tool_call` | 服务端识别出硬件或业务动作，UE 不需要再次调用硬件接口 |
| `delta` | 回复文本片段或完整文本 |
| `done` | 正常结束，UE 使用 `reply_text` 展示或播报 |
| `error` | 处理失败，UE 停止等待 `done` |

UE 不能只根据 HTTP 200、`start` 或 `tool_call` 判断处理成功。

## 6. AI 聊天历史查询

### 6.1 接口地址

```http
GET /v1/ai-chat/history
```

### 6.2 Query 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `limit` | integer | 否 | 默认 20，最大 100 |
| `before_id` | string | 否 | 查询该消息之前的记录 |
| `after_id` | string | 否 | 未传 `before_id` 时，查询该消息之后的记录 |

### 6.3 请求示例

```bash
curl \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A' \
  'http://127.0.0.1:18081/v1/ai-chat/history?limit=20'
```

### 6.4 成功响应

```json
{
  "status": "ok",
  "mode": "CABIN_AI_CHAT",
  "messages": [
    {
      "id": "msg-1001",
      "role": "user",
      "content": "请帮我打开阅读灯",
      "source": "voice",
      "create_time": "2026-10-12T12:00:00+08:00"
    },
    {
      "id": "msg-1002",
      "role": "assistant",
      "content": "已为您下发打开阅读灯的指令，请稍候。",
      "source": "agent",
      "create_time": "2026-10-12T12:00:01+08:00"
    }
  ],
  "next_cursor": null
}
```

## 7. AI 聊天上下文重置

### 7.1 接口地址

```http
POST /v1/ai-chat/reset
```

### 7.2 请求示例

```bash
curl -X POST http://127.0.0.1:18081/v1/ai-chat/reset \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A'
```

### 7.3 成功响应

```json
{
  "status": "ok",
  "cleared": true
}
```

`cleared=true` 表示会话上下文已重置，不表示数据库历史记录已物理删除。

## 8. 文本转语音

### 8.1 接口地址

```http
POST /v1/tts/speech
Content-Type: application/json
```

### 8.2 请求体

```json
{
  "text": "已为您打开阅读灯。"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `text` | string | 是 | 待合成文本；兼容字段名 `content` |

### 8.3 请求示例

```bash
curl -X POST http://127.0.0.1:18081/v1/tts/speech \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A' \
  -H 'Content-Type: application/json' \
  -d '{"text":"已为您打开阅读灯。"}' \
  -o reply.wav
```

成功时返回音频二进制，通常为 WAV，不返回 JSON 或音频 URL。

## 9. 健康报告

健康报告流程只有报告 start、客户 WebSocket 推送健康数据、UE 查询报告三个步骤。UE 不通过 AI 聊天启动或停止健康采集。

### 9.1 开始报告

```http
POST /v1/health-reports/start
Content-Type: application/json
```

请求体：

```json
{
  "language": "zh"
}
```

请求示例：

```bash
curl -X POST http://127.0.0.1:18081/v1/health-reports/start \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A' \
  -H 'Content-Type: application/json' \
  -d '{"language":"zh"}'
```

成功响应：

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
  }
}
```

### 9.2 查询报告

```http
GET /v1/health-reports/{report_id}
```

请求示例：

```bash
curl \
  -H 'X-Cabin-Aircraft-No: B-WITHFLIGHT-01' \
  -H 'X-Cabin-Seat-No: A' \
  'http://127.0.0.1:18081/v1/health-reports/hr_4f8f7f2c8b1a'
```

| `report_status` | UE 处理 |
|---|---|
| `collecting` | 1～2 秒后继续轮询 |
| `generating` | 继续轮询 |
| `completed` | 停止轮询，展示 `metrics` 和 `summary` |
| `failed` | 停止轮询，展示错误信息 |
| `cancelled` | 停止轮询，切换到最新报告 ID |

客户 WebSocket 推送的健康样本必须包含与报告一致的座位号，建议同时包含 `aircraftNo`、`flightId` 和 `flightDate`。

## 10. 会话关联规则

建议使用以下信息关联同一个会话：

```text
aircraftNo + flightId + flightDate + seatNo + passengerId/passengerRef
```

- 同一航班、日期、座位和乘客复用会话。
- 换乘客、换座位、换航班或跨日期时创建新会话。
- UE 不需要保存或传递 conversation ID。
- 客户接口应提供稳定的 `passengerId` 或 `passengerRef`，否则座位换人时可能继承上一位乘客的会话。

## 11. 错误响应

统一格式：

```json
{
  "status": "error",
  "code": "MISSING_SEAT_NO",
  "message": "X-Cabin-Seat-No is required"
}
```

常见错误码：

| HTTP | code | 说明 |
|---:|---|---|
| 400 | `MISSING_AIRCRAFT_NO` | 缺少飞机编号 |
| 400 | `MISSING_SEAT_NO` | 缺少座位号 |
| 400 | `MISSING_AUDIO` | 缺少音频文件 |
| 400 | `INVALID_AUDIO_FORMAT` | 音频不是 WAV |
| 400 | `MISSING_CONTENT` | 缺少聊天消息 |
| 400 | `MISSING_TEXT` | 缺少 TTS 文本 |
| 502 | `SEAT_CONTEXT_FAILED` | 客户乘客信息接口调用失败 |
| 502 | `SEAT_CONTEXT_INVALID` | 客户乘客信息响应缺少必要字段 |
| 500 | `ASR_FAILED` | 语音识别失败 |
| 500/SSE | `AGENT_FAILED` | AI 处理失败 |

## 12. 上线前确认项

1. 正式环境的服务端 Authorization 配置值。
2. `passengerRef` 是否在一次航班中稳定且唯一。
3. 无乘客、未绑定和航班未加载时的业务 code。
4. 取消 UE token 鉴权后，现场是否通过可信网络或网关限制访问。
5. 新接口能否承受多台平板的并发查询和健康报告轮询。

## 13. 说明

代码中存在 `/v1/voice-chat/send` 一体化语音接口，但现场没有实际使用，因此不列入主流程。现场继续使用：

```text
/v1/voice/query → /v1/ai-chat/send → 可选 /v1/tts/speech
```
