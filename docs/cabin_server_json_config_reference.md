# Cabin server.json 配置说明

本文说明 `server.json` 中 `cabin` 节点的全部配置。除特别说明外，配置项都可以不写，系统会使用默认值；但启用对应功能后，部分外部接口地址必须按现场环境配置。

## 精简推荐配置

现场使用本地部署的 ASR、TTS、LLM，通常不需要配置 API Key。建议至少配置：

```json
{
  "cabin": {
    "enabled": true,
    "tokenSecret": "请替换为现场随机长密钥",
    "passengerInfoUrl": "http://对方服务地址/admin-api/cabin/tablet-passenger-info/current",
    "aircraftNo": "现场飞机编号",

    "asrUrl": "http://本地ASR服务/v1/audio/transcriptions",
    "asrModel": "现场ASR模型名",
    "ttsUrl": "http://本地TTS服务/v1/audio/speech",
    "ttsModel": "现场TTS模型名",
    "ttsVoice": "现场TTS音色",
    "ttsLanguage": "chinese",
    "llmBaseUrl": "http://本地LLM服务/v1",
    "llmModel": "现场LLM模型名",

    "controlBaseUrl": "http://对方硬件服务地址",
    "controlAuth": "如对方要求则配置",
    "controlTimeoutMs": 10000,

    "automationEnabled": true,
    "flightStateWsUrl": "ws://对方服务地址/infra/ws",
    "managedSeats": "A,B",

    "broadcastApiBaseUrl": "http://对方硬件服务地址",
    "broadcastApiKey": "对方提供的 hardware api key",
    "broadcastAuth": "如对方要求则配置",
    "broadcastEnabled": true,
    "broadcastTtsCacheDir": "/app/data/cabin-broadcasts",
    "broadcastTtsVersion": "flight-phase-v1",

    "healthReportEnabled": true,
    "healthReportCollectSeconds": 30,
    "healthReportMinSamples": 1,

    "automationLogFile": "/app/data/logs/cabin-automation.jsonl",
    "logEnabled": true,
    "logFile": "/app/data/logs/cabin.jsonl"
  }
}
```

如果容器挂载了 `/app/data` 到宿主机，例如：

```bash
MOSS_HOST_PATH_MAP={"/data/yin/moss-cabin-gateway/moss/data":"/app/data","/data/yin/moss-cabin-gateway/moss/.moss":"/root/.moss"}
```

则建议日志写到 `/app/data/logs/...`，宿主机可在 `/data/yin/moss-cabin-gateway/moss/data/logs/` 查看。

## 配置总表

| 字段 | 默认值 | 是否必须 | 建议配置 | 说明 | 环境变量覆盖 |
| --- | --- | --- | --- | --- | --- |
| `enabled` | `false` | 启用 cabin 时必须为 `true` | `true` | 是否开启 Pad 端 cabin API，例如 `/v1/auth/token`、聊天、语音、生理检测报告接口。 | `CABIN_ENABLED` |
| `tokenSecret` | `dev-cabin-token-secret` | 生产必须改 | 随机长密钥 | Pad cabin access token 签名密钥。生产不能使用默认值。 | `CABIN_TOKEN_SECRET` |
| `tokenTtlSeconds` | `7200` | 否 | `7200` | Pad cabin access token 有效期，单位秒。 | `CABIN_TOKEN_TTL_SECONDS` |
| `passengerInfoUrl` | 无 | cabin 对接真实 Pad 时必须 | 对方乘客/座位上下文接口 | Pad 获取 token、聊天、报告接口会用 tablet token 查询航班、座位、乘客上下文。 | `CABIN_PASSENGER_INFO_URL` |
| `passengerInfoAuth` | 无 | 视对方接口而定 | 对方要求鉴权时配置 | 调用 `passengerInfoUrl` 时携带的 `Authorization`。 | `CABIN_PASSENGER_INFO_AUTH` |
| `passengerInfoPrivacyLevel` | `2` | 否 | `2` | 请求乘客信息时传给对方接口的隐私级别。 | `CABIN_PASSENGER_INFO_PRIVACY_LEVEL` |
| `aircraftNo` | 无 | 自动化/广播建议配置 | 现场飞机编号 | 用于广播、告警、健康报告、托管座位的飞机编号。 | `CABIN_AIRCRAFT_NO` |
| `asrUrl` | `http://127.0.0.1:8002/v1/audio/transcriptions` | 使用语音输入时必须可用 | 本地 ASR 地址 | 语音转文字接口，兼容 OpenAI transcription 风格。 | `CABIN_ASR_URL` |
| `asrModel` | `Qwen/Qwen3-ASR-1.7B` | 否 | 现场 ASR 模型名 | ASR 请求中的模型名。 | `CABIN_ASR_MODEL` |
| `asrApiKey` | 无 | 本地模型通常不需要 | 不配置 | ASR 服务需要 Bearer Key 时配置。 | `CABIN_ASR_API_KEY` |
| `ttsUrl` | `http://127.0.0.1:8004/v1/audio/speech` | 飞行阶段广播必须可用 | 本地 TTS 地址 | 阶段广播生成音频使用的 TTS 接口。 | `CABIN_TTS_URL` |
| `ttsModel` | `qwen3-tts` | 否 | 现场 TTS 模型名 | TTS 请求中的模型名。 | `CABIN_TTS_MODEL` |
| `ttsVoice` | `vivian` | 否 | 客户确认的音色 | TTS 音色。改变音色会生成新的广播缓存。 | `CABIN_TTS_VOICE` |
| `ttsLanguage` | `chinese` | 否 | `chinese` 或现场要求值 | TTS 语言参数。 | `CABIN_TTS_LANGUAGE` |
| `ttsApiKey` | 无 | 本地模型通常不需要 | 不配置 | TTS 服务需要 Bearer Key 时配置。 | `CABIN_TTS_API_KEY` |
| `llmBaseUrl` | `http://127.0.0.1:8000/v1` | 聊天/报告文案生成必须可用 | 本地 LLM `/v1` 地址 | 兼容 OpenAI Chat Completions 的基础地址。健康报告文案生成失败或超时时会使用确定性兜底文案。 | `CABIN_LLM_BASE_URL` |
| `llmModel` | `Qwen3.6-35B-A3B-NVFP4` | 否 | 现场 LLM 模型名 | LLM 请求中的模型名。 | `CABIN_LLM_MODEL` |
| `llmApiKey` | 无 | 本地模型通常不需要 | 不配置 | LLM 服务需要 Bearer Key 时配置。 | `CABIN_LLM_API_KEY` |
| `controlBaseUrl` | 无 | 硬件控制/自动化必须 | 对方硬件服务基础地址 | 用于座椅、桌板、灯光等硬件控制，也作为广播接口默认基础地址。 | `CABIN_CONTROL_BASE_URL` |
| `controlAuth` | 无 | 视对方接口而定 | 对方要求鉴权时配置 | 调用硬件控制和硬件状态接口时携带的 `Authorization`。 | `CABIN_CONTROL_AUTH` |
| `controlTimeoutMs` | `10000` | 否 | `10000` | 外部 HTTP 调用超时时间，当前用于硬件状态、硬件控制、TTS、广播接口、健康报告 LLM。 | `CABIN_CONTROL_TIMEOUT_MS` |
| `automationEnabled` | `false` | 开启飞行状态自动化时必须为 `true` | `true` | 是否启用飞行状态 WS 订阅、阶段广播、座位异常告警和硬件控制。 | `CABIN_AUTOMATION_ENABLED` |
| `flightStateWsUrl` | 无 | `automationEnabled=true` 时必须 | `ws://对方服务地址/infra/ws` | 对方飞行状态/健康遥测 WebSocket 地址。连接建立后会持续接收消息。 | `CABIN_FLIGHT_STATE_WS_URL` |
| `flightStateWsConnectTimeoutMs` | `10000` | 否 | `10000` | WS 握手超时时间。超时会断开并进入重连。 | `CABIN_FLIGHT_STATE_WS_CONNECT_TIMEOUT_MS` |
| `flightStateWsHeartbeatIntervalMs` | `15000` | 否 | `15000` | WS ping 心跳间隔。设为 `0` 可关闭客户端主动 ping。 | `CABIN_FLIGHT_STATE_WS_HEARTBEAT_INTERVAL_MS` |
| `flightStateWsIdleTimeoutMs` | `60000` | 否 | `60000` | 超过该时间没有任何 WS 活动则断开重连。设为 `0` 可关闭空闲检测。 | `CABIN_FLIGHT_STATE_WS_IDLE_TIMEOUT_MS` |
| `flightStateWsReconnectMinMs` | `3000` | 否 | `3000` | WS 断开后的最小重连间隔。 | `CABIN_FLIGHT_STATE_WS_RECONNECT_MIN_MS` |
| `flightStateWsReconnectMaxMs` | `30000` | 否 | `30000` | WS 指数退避的最大重连间隔。 | `CABIN_FLIGHT_STATE_WS_RECONNECT_MAX_MS` |
| `managedSeats` | 无 | 建议配置 | `A,B` 或现场座位号列表 | 自动化托管座位列表，逗号分隔。Pad 获取 token 时也会自动写入托管座位。 | `CABIN_MANAGED_SEATS` |
| `broadcastBaseUrl` | 无 | 通常不必配置 | 不配置或公网/内网可访问音频 URL 前缀 | Moss 对外提供已缓存 TTS 音频时使用的 URL 前缀；未配置时返回 `/v1/cabin/broadcasts/<file>`。 | `CABIN_BROADCAST_BASE_URL` |
| `broadcastApiBaseUrl` | 无 | 使用对方广播接口时建议配置 | 对方硬件/广播服务基础地址 | 调用 `/admin-api/cabin/broadcast/audio-all` 和 `/admin-api/cabin/broadcast/error-seat` 的基础地址。不配置时回退 `controlBaseUrl`。 | `CABIN_BROADCAST_API_BASE_URL` |
| `broadcastApiKey` | 无 | `broadcastEnabled=true` 且要推送对方广播时必须 | 对方提供的 hardware api key | 广播接口请求头 `x-hardware-api-key`。缺失时广播请求会跳过。 | `CABIN_BROADCAST_API_KEY` |
| `broadcastAuth` | 无 | 视对方接口而定 | 对方要求鉴权时配置 | 广播接口独立 `Authorization`。不配置时回退 `controlAuth`。 | `CABIN_BROADCAST_AUTH` |
| `broadcastEnabled` | `true` | 否 | `true` | 是否启用对方广播接口调用。关闭后仍可生成内部告警和硬件控制。 | `CABIN_BROADCAST_ENABLED` |
| `broadcastTtsCacheDir` | 无 | 否 | `/app/data/cabin-broadcasts` | 阶段广播 TTS 音频缓存目录。不配置时默认 `<rootDir>/cabin-broadcasts`。已生成的相同文案/模型/音色/版本会复用。 | `CABIN_BROADCAST_TTS_CACHE_DIR` |
| `broadcastTtsVersion` | `flight-phase-v1` | 否 | 客户文案版本，例如 `flight-phase-v1` | TTS 缓存版本。客户广播文案变更后建议递增，避免复用旧音频。 | `CABIN_BROADCAST_TTS_VERSION` |
| `automationLogFile` | 无 | 否 | `/app/data/logs/cabin-automation.jsonl` | 飞行状态 WS、阶段任务、广播、告警、硬件控制、生理 WS 采样处理等自动化日志。不配置时默认 `<rootDir>/logs/cabin-automation.jsonl`。 | `CABIN_AUTOMATION_LOG_FILE` |
| `healthReportEnabled` | `false` | 开启生理检测报告时必须为 `true` | `true` | 是否启用 Pad 生理检测报告接口。 | `CABIN_HEALTH_REPORT_ENABLED` |
| `healthReportCollectSeconds` | `30` | 否 | `30` | Pad 点击开始后采集 WS 健康遥测的持续时间，单位秒。 | `CABIN_HEALTH_REPORT_COLLECT_SECONDS` |
| `healthReportMinSamples` | `1` | 否 | `1` | 生成报告所需最少有效样本数。低于该值报告失败。 | `CABIN_HEALTH_REPORT_MIN_SAMPLES` |
| `assistantName` | `cabin-ai-flight-attendant` | 否 | 默认值 | cabin AI 乘务员内部 agent 标识。 | `CABIN_ASSISTANT_NAME` |
| `assistantDisplayName` | `客舱 AI 乘务员` | 否 | 默认值 | 展示名称。 | `CABIN_ASSISTANT_DISPLAY_NAME` |
| `createMossSession` | `false` | 否 | `false` | 是否为 cabin 聊天创建完整 Moss session。当前现场建议保持关闭，优先走确定性硬件路由和本地生成逻辑。 | `CABIN_CREATE_MOSS_SESSION` |
| `replyTimeoutMs` | `45000` | 否 | `45000` | cabin 聊天等待模型/会话回复的超时时间。 | 无 |
| `sessionRecoveryEnabled` | `true` | 否 | `true` | cabin Moss session 异常时是否自动恢复。仅 `createMossSession=true` 时相关。 | 无 |
| `sessionRecoveryMaxAttempts` | `1` | 否 | `1` | 单次请求最多恢复 session 次数。仅 `createMossSession=true` 时相关。 | 无 |
| `contextReplayTurns` | `20` | 否 | `20` | session 恢复时回放的历史轮数。仅 `createMossSession=true` 时相关。 | 无 |
| `flightStateDemoEnabled` | `false` | 否 | 生产 `false` | 是否启用 taxiing demo API。生产环境建议关闭。 | `CABIN_FLIGHT_STATE_DEMO_ENABLED` |
| `demoPlaybackUrl` | 无 | demo 使用时配置 | 生产不配置 | demo 播放接口地址。 | `CABIN_DEMO_PLAYBACK_URL` |
| `demoAlertUrl` | 无 | demo 使用时配置 | 生产不配置 | demo 告警接口地址。 | `CABIN_DEMO_ALERT_URL` |
| `logEnabled` | `true` | 否 | `true` | 是否写 cabin API 调用日志。 | `CABIN_LOG_ENABLED` |
| `logFile` | 无 | 否 | `/app/data/logs/cabin.jsonl` | Pad cabin API、外部 passengerInfo、LLM/ASR/TTS 等接口日志。不配置时默认 `<rootDir>/logs/cabin.jsonl`。 | `CABIN_LOG_FILE` |

## 功能依赖关系

- 只启用 Pad 基础接口：需要 `enabled=true`、`tokenSecret`、`passengerInfoUrl`。
- 启用语音聊天：还需要 `asrUrl/asrModel`、`llmBaseUrl/llmModel`。
- 启用硬件控制：还需要 `controlBaseUrl`，如对方接口需要鉴权则配置 `controlAuth`。
- 启用飞行状态自动化：需要 `automationEnabled=true`、`flightStateWsUrl`、`controlBaseUrl`，建议配置 `aircraftNo`、`managedSeats`、`automationLogFile`。
- 启用阶段全机广播和座位异常推送：需要 `broadcastEnabled=true`、`broadcastApiKey`，建议配置 `broadcastApiBaseUrl`、`broadcastTtsCacheDir`。
- 启用生理检测报告：需要 `healthReportEnabled=true`、`llmBaseUrl/llmModel`，并确保 `flightStateWsUrl` 的健康遥测消息中至少带 `seatNo`。

## 运行机制补充

- WS 连接成功后会一直保持连接，收到对方消息即处理。
- WS 握手超时、连接关闭、空闲超时或 ping 失败都会触发重连，重连间隔按 `flightStateWsReconnectMinMs` 到 `flightStateWsReconnectMaxMs` 退避。
- 飞行阶段任务串行执行，避免短时间阶段变化导致广播、告警、硬件控制重叠。
- 健康报告采集按 `aircraftNo + flightId + flightDate + seatNo` 管理；当前对方健康遥测只带 `seatNo` 也兼容，只要同一实例里该座位只有一个正在采集的报告即可。
- 健康遥测原始 WS 内容会写入 `automationLogFile` 的 `ws.message.raw`，便于排查 Pad 报告值与对方推送值是否一致。
- `automationLogFile` 和 `logFile` 默认按 50MB 轮转，轮转文件名会追加时间戳。
