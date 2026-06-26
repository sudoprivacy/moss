# 客舱滑行阶段自动任务演示说明

本文档用于演示飞机进入滑行阶段后，Moss 客舱模块自动生成安全播报、检查座椅/小桌板状态、生成告警并下发硬件控制指令的流程。

## 演示目标

- 模拟飞机状态消息进入 `TAXIING` 滑行阶段。
- 自动生成中英文安全播报音频。
- 检查座位状态：座椅 `position` 是否为 `0`，小桌板是否为 `close`。
- 对不符合滑行安全要求的座位生成告警。
- 自动下发座椅归位和小桌板关闭指令。

## 当前演示边界

客户 Kafka、告警接口、头枕播放器接口暂未提供，因此当前演示使用 HTTP 接口模拟 Kafka 状态推送。

硬件控制接口使用客户联调地址：

```text
http://1.94.107.87:48081
```

TTS 使用 DGX 上的服务：

```text
http://172.16.20.188:8004/v1/audio/speech
```

后续客户接口齐备后，只需要把 HTTP demo 接口替换成 Kafka consumer，并把 demo 告警/播放配置替换成客户正式接口。

## 启动配置

本地演示启动示例：

```bash
cd /Users/yobach/Downloads/moss

MOSS_SERVER_CONFIG=/Users/yobach/Downloads/moss/server.cabin.local.json \
CABIN_PASSENGER_INFO_URL=http://172.16.20.188:48082/admin-api/cabin/tablet-passenger-info/current \
CABIN_PASSENGER_INFO_AUTH=test1 \
CABIN_CONTROL_BASE_URL=http://1.94.107.87:48081 \
CABIN_CONTROL_AUTH=test1 \
CABIN_FLIGHT_STATE_DEMO_ENABLED=true \
node bin/moss-server.mjs
```

如果部署在 DGX 服务器，配置项同理写入 `server.json` 或环境变量：

```json
{
  "cabin": {
    "flightStateDemoEnabled": true,
    "ttsUrl": "http://qwen3-tts:8004/v1/audio/speech",
    "controlBaseUrl": "http://1.94.107.87:48081",
    "controlAuth": "test1"
  }
}
```

可选播放/告警 mock：

```json
{
  "cabin": {
    "demoPlaybackUrl": "http://127.0.0.1:48082/mock/headrest-player/play",
    "demoAlertUrl": "http://127.0.0.1:48082/mock/cabin/alerts"
  }
}
```

不配置也可以演示，接口响应中会返回生成的音频文件路径和告警内容。

## 演示接口

### 1. 推送滑行阶段状态

```bash
curl -X POST 'http://127.0.0.1:43128/v1/cabin-demo/flight-state' \
  -H 'Content-Type: application/json' \
  -d '{
    "flightId": "2",
    "flightNo": "CA8888",
    "flightPhase": "TAXIING",
    "timestamp": "2026-06-26T18:00:00+08:00",
    "seats": [
      {
        "seatNo": "01A",
        "columnNo": "A",
        "position": 20,
        "trayState": "open"
      }
    ]
  }'
```

### 2. 预期返回

```json
{
  "status": "ok",
  "flight_id": "2",
  "flight_no": "CA8888",
  "flight_phase": "TAXIING",
  "broadcast": {
    "audioPath": ".../taxiing-xxx.wav",
    "contentType": "audio/wav",
    "playback": {
      "configured": false,
      "ok": true
    }
  },
  "alerts": [
    {
      "seatNo": "01A",
      "type": "CABIN_DEVICE_NOT_READY",
      "message": "滑行阶段座椅未归位，小桌板未关闭"
    }
  ],
  "commands": [
    {
      "seatNo": "01A",
      "command": "seat.cushion",
      "ok": true
    },
    {
      "seatNo": "01A",
      "command": "seat.tray.close",
      "ok": true
    }
  ]
}
```

### 3. 查询告警记录

```bash
curl 'http://127.0.0.1:43128/v1/cabin-demo/alerts'
```

### 4. 查询播报记录

```bash
curl 'http://127.0.0.1:43128/v1/cabin-demo/broadcasts'
```

返回中的 `audioPath` 是本次生成的播报音频文件路径。

## 演示讲解口径

可以按下面顺序讲：

1. 当前客户的 Kafka 飞机状态、告警上报、头枕播放器接口还未提供，因此本次用 HTTP demo 接口模拟飞机状态消息推送。
2. 当系统收到 `flightPhase=TAXIING` 后，自动触发滑行阶段规则。
3. 系统使用固定安全播报模板生成中英文播报，并调用本地 TTS 服务生成 wav 音频。
4. 系统检查状态消息中的座椅和小桌板状态。
5. 如果座椅 `position != 0`，生成告警并调用座椅归位指令。
6. 如果小桌板不是 `close`，生成告警并调用小桌板关闭指令。
7. 后续正式接入时，把 HTTP demo 状态推送替换成 Kafka consumer，把 demo 告警/播放 URL 替换成客户正式接口即可。

## 当前已验证结果

本地已完成真实链路验证：

- TTS 调用成功，生成 `audio/wav` 文件。
- 告警生成成功。
- 座椅归位指令返回成功。
- 小桌板关闭指令返回成功。

示例硬件控制返回：

```json
{
  "code": 0,
  "msg": "",
  "data": "指令下发成功"
}
```
