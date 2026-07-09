目前联调风险可以重新收敛一下。LLM 这块风险已经降低，重点转到外部接口和现场数据一致性。

**1. WS 连不上或频繁断开**

可能原因：
- `flightStateWsUrl` 配错。
- 对方 WS 服务未启动或网络不通。
- 对方 WS 需要鉴权/header，但我们当前配置是直接连接。
- 中间网络空闲断开。

现象：
- 没有飞行状态、没有健康样本。
- `cabin-automation.jsonl` 里反复出现 `ws.error / ws.close / ws.reconnect_scheduled`。

查看：

```bash
grep 'ws.' /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl | tail -50
```

**2. WS 消息格式和文档不一致**

这是最容易现场碰到的。

飞行状态风险：
- phase code 和文档不一致。
- 字段位置不一致。
- 消息类型不是当前识别的 `flight_data`。
- 数据是字符串而不是数字。

生理检测风险：
- `topic` 不是 `health`。
- 座位字段不是 `seatNo`。
- 指标字段不是 `heart_rate / spo2 / respiratory_rate / body_temperature`。
- 指标值带单位，比如 `"94%"`、`"37.8℃"`。
- 对方一次发多个座位的数组，我们当前主要处理单座位 message。

现象：
- WS raw 日志有消息，但后续没有广播、告警或采样。
- 健康报告 `collecting` 后 `failed`，样本不足。

查看：

```bash
grep 'ws.message.raw\|ws.message.ignored\|health_report.sample' /data/yin/moss-cabin-gateway/moss/data/logs/cabin*.jsonl | tail -80
```

**3. 座位号不一致**

生理检测和告警都依赖座位号。

风险：
- Pad 是 `A`，WS 发 `1A`。
- 硬件接口用 `seat-01`，Pad/WS 用 `A`。
- `managedSeats` 配置和现场座位编码不一致。
- 对方状态接口 target 需要完整座位号，但我们传的是 A/B。

现象：
- 健康样本被忽略：`no_active_report`。
- 告警推到错误座位。
- 状态接口查不到数据。

查看：

```bash
grep 'seat_no\|seatNo\|health_report.sample' /data/yin/moss-cabin-gateway/moss/data/logs/cabin*.jsonl | tail -80
```

**4. Pad 轮询时间不够**

报告耗时是：

```text
30 秒采集 + 模型生成时间
```

千问/讯飞测试约 16 秒，MiniMax 约 20 秒。现场建议 Pad 至少轮询 70-90 秒，或者一直轮询到终态：

- `completed`
- `failed`
- `cancelled`

现象：
- 服务最后生成了报告，但 Pad 页面提前停止等待。

**5. 硬件状态接口字段不一致**

飞行阶段告警会调用硬件状态接口。

风险：
- 状态接口路径或参数和 mock/文档不一致。
- 返回业务 `code` 不是 0。
- 字段值类型不同，例如 `seatbelt: false` vs `"false"` vs `0`。
- 桌板、座椅、调光窗字段名不一致。
- 接口需要额外鉴权 header。

现象：
- `hardware.status.response ok=false`
- 没有 `alert.created`
- 告警内容缺失或不准确。

查看：

```bash
grep 'hardware.status' /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl | tail -80
```

**6. 广播/异常告警接口问题**

已对接：
- `/admin-api/cabin/broadcast/audio-all`
- `/admin-api/cabin/broadcast/error-seat`

风险：
- `broadcastApiBaseUrl` 配错。
- `broadcastApiKey` 不对。
- 对方鉴权字段不只需要 api key。
- 上传音频字段或 content-type 和对方实际实现不一致。
- 返回 HTTP 200 但业务 `code` 非 0。

现象：
- 飞行状态识别到了，TTS 也生成了，但没有广播。
- 告警生成了，但没有推给 Pad。

查看：

```bash
grep 'broadcast.audio_all\|broadcast.error_seat' /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl | tail -80
```

**7. TTS 服务问题**

生产会用 TTS 生成广播音频，并缓存复用。

风险：
- `ttsUrl / ttsModel / ttsVoice` 配置不对。
- TTS 返回格式不是音频流。
- TTS 太慢，超过超时。
- `/app/data/cabin-broadcasts` 不可写。
- 首次生成慢，后续缓存命中才快。

现象：
- `broadcast.tts.failed`
- 没有 `broadcast.ready`
- 音频文件生成失败。

查看：

```bash
grep 'broadcast.tts' /data/yin/moss-cabin-gateway/moss/data/logs/cabin-automation.jsonl | tail -80
```

**8. LLM 报告风险较低，但仍需现场确认**

因为讯飞底层千问已经测过，结构和文案都符合。

仍需确认：
- 现场 `llmBaseUrl` 是 OpenAI-compatible `/v1`。
- `llmModel=qwen3.6-35B-A3B-NVFP4` 名称正确。
- 无 key 时服务端能访问。
- 响应不超过 30 秒。

查看：

```bash
grep 'health_report.model' /data/yin/moss-cabin-gateway/moss/data/logs/cabin.jsonl | tail -30
```

理想情况：
```text
health_report.model.response ok=true
fallback_count=0
```

**9. 配置覆盖问题**

现场更新部署时最怕把调好的 `server.json` 覆盖成包里的默认配置。

重点：
- 保留现场 `server.json`
- 只更新镜像 tag
- 日志路径保持 `/app/data/logs/...`
- 宿主机日志在：
  `/data/yin/moss-cabin-gateway/moss/data/logs/`

**10. 日志量和隐私**

当前为了排查，健康 WS raw 会记录原始心率、体温等值。联调阶段有用，但正式长期运行要确认客户是否接受。

**现场推荐联调顺序**

1. `docker compose ps` 确认服务运行。
2. Pad 调 `/v1/auth/token`，确认 API 通。
3. 看 WS 是否 `ws.open` 和 `ws.heartbeat.pong`。
4. 推飞行状态，确认广播和告警。
5. Pad 点开始生理检测。
6. 对方 WS 推健康数据。
7. Pad 轮询报告到 `completed`。
8. 查 `health_report.model.response ok=true`，确认不是 fallback。
9. 查广播、告警、硬件状态日志是否成功。