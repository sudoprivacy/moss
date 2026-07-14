# 客舱现场更新部署与联调排查说明

更新时间：2026-07-08

本文用于现场更新 Moss 客舱服务时配置 `server.json`，并指导飞行状态自动化、生理检测报告、TTS 广播、告警推送和硬件控制的联调排查。

## 1. 容器挂载与日志目录

当前容器路径映射：

```text
宿主机 /data/yin/moss-cabin-gateway/moss/data  -> 容器 /app/data
宿主机 /data/yin/moss-cabin-gateway/moss/.moss -> 容器 /root/.moss
```

推荐将 Moss 数据根目录配置为：

```json
{
  "storage": {
    "rootDir": "/app/data",
    "dbPath": "/app/data/moss.db",
    "transcriptDir": "/app/data/transcripts",
    "runtimeDir": "/app/data/runtime"
  }
}
```

这样默认日志会写到容器内：

```text
/app/data/logs/cabin.jsonl
/app/data/logs/cabin-automation.jsonl
```

对应宿主机：

```text
/data/yin/moss-cabin-gateway/moss/data/logs/cabin.jsonl
/data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl
```

## 2. 现场精简配置

现场 ASR、TTS、LLM 都是本地模型服务，不需要配置 API Key。`broadcastApiBaseUrl` 可以不配，默认复用 `controlBaseUrl`；`broadcastAuth` 可以不配，默认复用 `controlAuth`。

推荐 `server.json` 中 `cabin` 使用以下配置：

```json
{
  "cabin": {
    "enabled": true,

    "aircraftNo": "B-WITHFLIGHT-01",

    "passengerInfoUrl": "http://对方服务地址/admin-api/cabin/tablet-passenger-info/current",
    "passengerInfoAuth": "test1",
    "passengerInfoPrivacyLevel": 2,

    "asrUrl": "http://本地ASR服务地址/v1/audio/transcriptions",
    "asrModel": "Qwen/Qwen3-ASR-1.7B",

    "ttsUrl": "http://本地TTS服务地址/v1/audio/speech",
    "ttsModel": "qwen3-tts",
    "ttsVoice": "vivian",
    "ttsLanguage": "chinese",

    "llmBaseUrl": "http://本地LLM服务地址/v1",
    "llmModel": "本地模型名称",

    "controlBaseUrl": "http://对方硬件服务地址",
    "controlAuth": "test1",
    "controlTimeoutMs": 10000,

    "automationEnabled": true,
    "flightStateWsUrl": "ws://对方服务地址/infra/ws",
    "flightStateWsConnectTimeoutMs": 10000,
    "flightStateWsHeartbeatIntervalMs": 15000,
    "flightStateWsIdleTimeoutMs": 60000,
    "flightStateWsReconnectMinMs": 3000,
    "flightStateWsReconnectMaxMs": 30000,
    "managedSeats": "A,B",

    "broadcastApiKey": "对方提供的 hardware api key",
    "broadcastEnabled": true,
    "broadcastTtsVersion": "flight-phase-v1",

    "healthReportEnabled": true,
    "healthReportCollectSeconds": 30,
    "healthReportMinSamples": 1,

    "logEnabled": true
  }
}
```

如果希望显式指定日志文件，也可以加上：

```json
{
  "cabin": {
    "logFile": "/app/data/logs/cabin.jsonl",
    "automationLogFile": "/app/data/logs/cabin-automation.jsonl"
  }
}
```

不配置这两个字段时，默认也是写到 `<rootDir>/logs` 下。

## 3. 关键配置含义与默认值

| 配置 | 作用 | 不配置时默认值 |
| --- | --- | --- |
| `enabled` | 是否启用 cabin API。 | `false` |
| `aircraftNo` | 默认飞机编号。托管座位没有飞机号时，用它调用广播接口。 | 空 |
| `passengerInfoUrl` | Pad 上下文/乘客信息接口。 | 空；依赖乘客上下文的接口会失败 |
| `passengerInfoAuth` | 调 passengerInfo 时的 `Authorization`。 | 空 |
| `asrUrl` | 本地 ASR 地址。 | `http://127.0.0.1:8002/v1/audio/transcriptions` |
| `ttsUrl` | 本地 TTS 地址，阶段广播和语音回复都会用。 | `http://127.0.0.1:8004/v1/audio/speech` |
| `llmBaseUrl` | 本地 LLM OpenAI-compatible `/v1` 地址。 | `http://127.0.0.1:8000/v1` |
| `controlBaseUrl` | 对方硬件状态/控制服务地址。 | 空 |
| `controlAuth` | 调硬件接口时的 `Authorization`。 | 空 |
| `controlTimeoutMs` | 硬件控制超时时间，毫秒。 | `10000` |
| `automationEnabled` | 是否启用飞行状态 WS 自动化。 | `false` |
| `flightStateWsUrl` | 飞行状态 WS 地址。 | 空 |
| `flightStateWsConnectTimeoutMs` | WS 建连超时时间，超时后主动断开并进入重连。 | `10000` |
| `flightStateWsHeartbeatIntervalMs` | WS 协议级 ping 间隔；配置为 `0` 可关闭主动 ping。 | `15000` |
| `flightStateWsIdleTimeoutMs` | WS 无消息/无 pong 的空闲超时，超时后主动重连；配置为 `0` 可关闭空闲检测。 | `60000` |
| `flightStateWsReconnectMinMs` | WS 重连最小间隔。 | `3000` |
| `flightStateWsReconnectMaxMs` | WS 退避重连最大间隔。 | `30000` |
| `managedSeats` | 兜底托管座位，逗号分隔。Pad 登录带座位号后也会自动写入托管座位。 | 空 |
| `broadcastApiKey` | 调 `audio-all`、`error-seat` 的 `X-Hardware-Api-Key`。 | 空；外部广播会跳过/失败 |
| `broadcastEnabled` | 是否启用外部广播接口调用。 | `true` |
| `broadcastTtsVersion` | 阶段广播 TTS 缓存版本。修改后会重新生成音频。 | `flight-phase-v1` |
| `broadcastTtsCacheDir` | 阶段广播 TTS 缓存目录。 | `<rootDir>/cabin-broadcasts` |
| `healthReportEnabled` | 是否启用生理检测报告接口。 | `false` |
| `healthReportCollectSeconds` | 生理检测采集时长，秒。 | `30` |
| `healthReportMinSamples` | 最少样本数。 | `1` |
| `logEnabled` | 是否启用 cabin API JSONL 日志。 | `true` |
| `logFile` | cabin API 日志文件。 | `<rootDir>/logs/cabin.jsonl` |
| `automationLogFile` | 飞行状态自动化日志文件。 | `<rootDir>/logs/cabin-automation.jsonl` |

## 4. 日志文件说明

### 4.1 `cabin.jsonl`

记录 Pad 调用 Moss cabin API，以及 Moss 调用 ASR、TTS、LLM、passengerInfo、硬件控制等外部服务的请求结果。

常见字段：

```text
time
level
type: inbound | outbound
request_id
tablet_id
seat_no
flight_id
conversation_id
method
path
upstream
url
status
ok
elapsed_ms
error_code
error_message
model
command
details
```

示例：

```json
{"time":"2026-07-08T10:00:00.000Z","level":"info","type":"inbound","request_id":"req_xxx","method":"POST","path":"/v1/auth/token","status":200,"ok":true,"elapsed_ms":12}
```

```json
{"time":"2026-07-08T10:00:00.000Z","level":"info","type":"outbound","request_id":"req_xxx","upstream":"tts","method":"POST","url":"http://本地TTS服务地址/v1/audio/speech","status":200,"ok":true,"elapsed_ms":120,"model":"qwen3-tts"}
```

### 4.2 `cabin-automation.jsonl`

记录飞行状态 WS 自动化链路，包括 WS 连接、飞行阶段解析、TTS 阶段广播、全机广播、座位硬件状态、内部告警、座位异常推送、硬件控制。

关键事件：

| 事件 | 含义 |
| --- | --- |
| `ws.connect` | 开始连接飞行状态 WS。 |
| `ws.connect.timeout` | WS 建连超时，服务会主动断开并进入重连。 |
| `ws.open` | WS 已连接。 |
| `ws.heartbeat.ping` | 服务端向对方 WS 发送协议级 ping。 |
| `ws.heartbeat.pong` | 收到对方 WS 协议级 pong。 |
| `ws.idle.timeout` | 超过空闲时间未收到消息或 pong，服务主动断开重连。 |
| `ws.reconnect.scheduled` | WS 已安排下一次重连。 |
| `ws.message.raw` | 收到 WS 原始消息。 |
| `ws.message.parsed` | WS 消息解析成功。 |
| `flight.phase.changed` | 飞行阶段发生变化，开始触发阶段任务。 |
| `flight.phase.duplicate` | 飞行阶段重复，跳过。 |
| `seat.registry.loaded` | 已加载托管座位。 |
| `broadcast.tts.cache_hit` | 阶段广播音频命中缓存。 |
| `broadcast.tts.generated` | TTS 生成阶段广播音频成功。 |
| `broadcast.audio_all.success` | 调用全机广播接口成功。 |
| `hardware.status.response` | 硬件状态查询响应。 |
| `alert.created` | 生成内部告警。 |
| `broadcast.error_seat.success` | 指定座位异常推送成功。 |
| `hardware.control.response` | 硬件控制响应。 |
| `phase.task.summary` | 本次阶段任务汇总。 |

## 5. 现场查看日志命令

进入宿主机查看：

```bash
cd /data/yin/moss-cabin-gateway/moss/data/logs
```

实时查看 cabin API 日志：

```bash
tail -f cabin.jsonl
```

实时查看飞行状态自动化日志：

```bash
tail -f cabin-automation.jsonl
```

只看失败日志：

```bash
grep '"ok":false' cabin.jsonl
grep '"ok":false' cabin-automation.jsonl
```

查看飞行阶段变化：

```bash
grep '"event":"flight.phase.changed"' cabin-automation.jsonl
```

查看 TTS 是否生成或命中缓存：

```bash
grep '"event":"broadcast.tts' cabin-automation.jsonl
```

查看全机广播是否成功：

```bash
grep '"event":"broadcast.audio_all' cabin-automation.jsonl
```

查看座位异常是否推送成功：

```bash
grep '"event":"broadcast.error_seat' cabin-automation.jsonl
```

查看内部告警：

```bash
grep '"event":"alert.created"' cabin-automation.jsonl
```

查看硬件控制：

```bash
grep '"event":"hardware.control' cabin-automation.jsonl
```

如果宿主机安装了 `jq`，可以格式化查看最后一条汇总：

```bash
grep '"event":"phase.task.summary"' cabin-automation.jsonl | tail -1 | jq .
```

## 6. 现场联调流程

### 6.1 基础检查

1. 确认容器挂载包含：

```text
/data/yin/moss-cabin-gateway/moss/data -> /app/data
```

2. 确认 `server.json` 中：

```json
{
  "storage": {
    "rootDir": "/app/data"
  },
  "cabin": {
    "enabled": true,
    "automationEnabled": true,
    "healthReportEnabled": true,
    "logEnabled": true
  }
}
```

3. 重启服务后确认日志目录生成：

```bash
ls -la /data/yin/moss-cabin-gateway/moss/data/logs
```

### 6.2 Pad 登录/上下文联调

让 Pad 先调用 `/v1/auth/token`。

检查 `cabin.jsonl`：

```bash
grep '"/v1/auth/token"' /data/yin/moss-cabin-gateway/moss/data/logs/cabin.jsonl | tail -5
```

期望：

```text
type=inbound
path=/v1/auth/token
status=200
ok=true
```

如果失败，优先检查：

```text
passengerInfoUrl
passengerInfoAuth
Pad 是否带 x-cabin-tablet-token / x-cabin-tablet-id
```

### 6.3 飞行状态自动化联调

触发真实飞行状态 WS 消息后，检查：

```bash
tail -f /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl
```

正常链路应依次看到：

```text
ws.open
ws.message.raw
ws.message.parsed
flight.phase.changed
seat.registry.loaded
broadcast.tts.generated 或 broadcast.tts.cache_hit
broadcast.audio_all.success
hardware.status.response
alert.created
broadcast.error_seat.success
hardware.control.response
phase.task.summary
```

如果看不到 `ws.open`：

```text
检查 flightStateWsUrl 是否正确
检查容器网络是否能访问对方 WS
检查对方 WS 服务是否已启动
```

如果只有 `flight.phase.duplicate`：

```text
说明阶段没有变化，自动化会跳过重复处理，这是正常行为。
```

如果没有 `seat.registry.loaded` 或 seats 为空：

```text
Pad 还没有登录写入托管座位，或者 managedSeats 没有配置。
联调阶段建议先配置 managedSeats，例如 "A,B"。
```

### 6.4 全机广播联调

检查：

```bash
grep '"event":"broadcast.audio_all' /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl | tail -10
```

成功时应看到：

```text
broadcast.audio_all.request
broadcast.audio_all.success
```

如果失败，检查：

```text
broadcastApiKey 是否正确
controlBaseUrl 是否就是对方广播接口所在服务
如果广播接口和硬件接口不在同一个服务，需要单独配置 broadcastApiBaseUrl
对方接口是否要求 Authorization；不配置 broadcastAuth 时会复用 controlAuth
TTS 返回的 wav 是否被对方 audio-all 接受
```

TTS 音频默认缓存到：

```text
/app/data/cabin-broadcasts
```

对应宿主机：

```text
/data/yin/moss-cabin-gateway/moss/data/cabin-broadcasts
```

如果客户修改了广播文案、音色或模型策略，可以修改：

```json
{
  "cabin": {
    "broadcastTtsVersion": "flight-phase-v2"
  }
}
```

修改后会重新生成阶段广播音频。

### 6.5 座位异常推送联调

检查：

```bash
grep '"event":"broadcast.error_seat' /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl | tail -10
```

成功时应看到：

```text
broadcast.error_seat.request
broadcast.error_seat.success
```

推送到 Pad 的内容类似：

```text
A 座位安全检查异常：安全带未扣合；座椅未归位；小桌板未收起。
```

如果失败，检查：

```text
broadcastApiKey
aircraftNo
seatNo 是否和 Pad 侧座位号一致
对方 /admin-api/cabin/broadcast/error-seat 是否可访问
```

### 6.6 生理检测报告联调

Pad 点击开始生理检测后，应调用：

```text
POST /v1/health-reports/start
```

接口会立即返回：

```text
report_id
report_status=collecting
```

检查 `cabin.jsonl`：

```bash
grep '"/v1/health-reports/start"' /data/yin/moss-cabin-gateway/moss/data/logs/cabin.jsonl | tail -10
```

Pad 轮询：

```text
GET /v1/health-reports/{report_id}
```

检查：

```bash
grep '"/v1/health-reports' /data/yin/moss-cabin-gateway/moss/data/logs/cabin.jsonl | tail -20
```

如果报告一直 `collecting`：

```text
检查 WS 生理数据是否到达 Moss
检查 WS 消息 type 是否为 telemetry
检查 content.topic 是否为 health
检查 seatNo 是否和 Pad 当前座位一致
检查 healthReportCollectSeconds 是否太长
```

如果报告 `failed`：

```text
检查 healthReportMinSamples 是否满足
检查本地 LLM 服务是否可访问
检查 llmBaseUrl / llmModel 是否正确
```

## 7. 常见问题排查表

| 现象 | 优先看哪里 | 常见原因 |
| --- | --- | --- |
| Pad 接口 401/403 | `cabin.jsonl` | token、tablet id、请求头不正确。 |
| 没有飞行阶段自动化日志 | `cabin-automation.jsonl` | `automationEnabled=false` 或 `flightStateWsUrl` 未配置。 |
| WS 一直连不上 | `ws.connect/ws.error/ws.close` | WS 地址、网络、对方服务状态问题。 |
| 阶段变化后没检查座位 | `seat.registry.loaded` | 没有托管座位，配置 `managedSeats` 或让 Pad 先登录。 |
| TTS 不生成 | `broadcast.tts.failed/error` | `ttsUrl` 不通、TTS 返回错误、模型名不对。 |
| 全机广播失败 | `broadcast.audio_all.failed` | `broadcastApiKey` 不对、接口地址不对、音频格式不被接受。 |
| 座位告警没有到 Pad | `broadcast.error_seat.failed` | `seatNo` 不匹配、接口地址或鉴权错误。 |
| 硬件控制失败 | `hardware.control.response/error` | `controlBaseUrl`、`controlAuth`、硬件接口返回非 0。 |
| 生理报告没有样本 | `cabin.jsonl` 和 WS 原始日志 | 生理 WS 消息未到、seatNo 不匹配、topic/type 不匹配。 |
| 日志宿主机看不到 | 容器挂载 | `rootDir` 没配成 `/app/data`，或日志路径写到了未挂载目录。 |

## 8. 现场最小验收清单

1. Pad 调 `/v1/auth/token` 成功，`cabin.jsonl` 有 `ok=true`。
2. 飞行状态 WS 连接成功，`cabin-automation.jsonl` 有 `ws.open`。
3. 阶段变化时有 `flight.phase.changed`。
4. 阶段广播有 `broadcast.tts.generated` 或 `broadcast.tts.cache_hit`。
5. 全机广播有 `broadcast.audio_all.success`。
6. 硬件状态查询有 `hardware.status.response`。
7. 异常座位有 `alert.created`。
8. Pad 异常推送有 `broadcast.error_seat.success`。
9. 座椅/桌板控制有 `hardware.control.response`。
10. 生理检测能从 `collecting` 变成 `completed`，并返回报告数据。
